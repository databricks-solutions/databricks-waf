// Running one statement as the signed-in user, against the Statement Execution API.
//
// The intended route was AppKit's analytics plugin, whose `asUser(req)` proxy exists
// for exactly this. It does not work programmatically in 0.50.0: the plugin's
// `exports()` returns `{ query: this.query }` unbound, and while the
// service-principal path binds those functions before handing them out, the
// user-scoped path wraps them without binding. The result is that
// `analytics.asUser(req).query(...)` rejects with "Cannot read properties of
// undefined (reading 'queryProcessor')" — every check reporting unmeasurable against
// a workspace that was perfectly readable. The plugin's own HTTP route works, because
// it reaches `query` through a different proxy trap.
//
// Rather than wait on an upstream fix or reach behind the plugin for its instance,
// collection talks to the API directly. Three things about this scan want that anyway:
//
//   - No caching. AppKit caches analytics results for an hour, which is right for a
//     dashboard and wrong for a measurement — a scan must observe the estate as it is
//     now, not as it was for whoever scanned before.
//   - No retries. The scheduler owns retry and concurrency per surface (ADR 0010), and
//     a second retry layer underneath it would multiply the load the budgets exist to
//     bound.
//   - Rejections that keep their shape. The scheduler classifies on HTTP status and
//     `Retry-After`; a wrapper that flattened those into a message string would make a
//     throttle indistinguishable from a permission denial.
//
// The analytics plugin stays registered regardless: it declares the warehouse resource
// requirement and performs the startup handshake that tells a misconfigured install
// what it is missing.

import type { SqlParameters } from './collector.js';
import type { Row } from './rows.js';
import { mark, SELF_TAGS } from './self.js';

/** A status the API returns while a statement is still going. */
const PENDING = new Set(['PENDING', 'RUNNING']);

export interface StatementExecutorOptions {
  readonly host: string;
  readonly warehouseId: string;
  /** Fetched per call rather than held, since a scheduled scan's token expires mid-scan. */
  readonly token: () => Promise<string>;
  /**
   * How long the submit call itself waits for a result before the executor starts
   * polling. The API caps this at 50s. Waiting inline is strictly cheaper than
   * polling, and most of these statements are aggregates that finish well inside it;
   * the poll loop is for a cold warehouse.
   */
  readonly waitSeconds?: number;
  readonly pollIntervalMs?: number;
  /**
   * The longest this scan will wait for one statement before cancelling it.
   *
   * A chosen number, and written as one: nothing measured says ten minutes is right and
   * eleven is wrong. What it is chosen against is the labs recording, where the slowest
   * statement is two orders of magnitude inside it, so a calibration run cannot reach it.
   *
   * It exists because the loop below had no bound at all, and `61a` measured what that
   * costs: one statement of one scan held it for 67 minutes on an estate of 495,135
   * relations, and the operator had no way to stop waiting short of cancelling the scan.
   */
  readonly deadlineMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Ten minutes. See `deadlineMs` for why this is a preference rather than a reading. */
export const STATEMENT_DEADLINE_MS = 10 * 60 * 1000;

/**
 * An HTTP failure that keeps its status and `Retry-After` for the scheduler to read.
 *
 * The scheduler decides whether a surface backs off, halves its concurrency or gives
 * up, and it decides on the status. A generic Error here would collapse 403 and 429
 * into the same thing: one means stop asking, the other means ask again shortly.
 */
export class StatementHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'StatementHttpError';
  }
}

/**
 * A statement this app stopped waiting for, and cancelled on the warehouse.
 *
 * Its own class rather than a message, because two things read it and neither should read
 * prose: `classify` decides what the scan does about it, and it has to tell this apart from
 * the platform timing something out. The difference matters in both directions — this is not
 * a throttle, so concurrency should not halve for it, and it is not worth another attempt,
 * because the second one costs what the first one did.
 */
export class StatementDeadlineError extends Error {
  constructor(
    readonly statementId: string,
    readonly waitedMs: number,
    readonly cancelled: boolean
  ) {
    super(
      `The statement did not finish within ${Math.round(waitedMs / 1000)}s, so the scan stopped waiting for it ` +
        `and ${cancelled ? 'cancelled it on the warehouse' : 'could not confirm it was cancelled on the warehouse'}.`
    );
    this.name = 'StatementDeadlineError';
  }
}

/** A statement that ran and failed, as opposed to one the transport refused. */
export class StatementFailedError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string
  ) {
    super(message);
    this.name = 'StatementFailedError';
  }
}

interface Manifest {
  readonly schema?: {
    readonly columns?: readonly { readonly name?: string; readonly type_name?: string }[];
  };
  readonly total_byte_count?: number;
  readonly total_row_count?: number;
  readonly truncated?: boolean;
}

/**
 * The result size past which the warehouse trims the result instead of refusing it.
 *
 * An `INLINE` result over 25 MiB is aborted: `status.state` comes back `FAILED` and there is no result
 * at all, which is how a large estate came to get no serverless analysis rather than a smaller one.
 * `byte_limit` changes the failure into a fact — the rows stop and `manifest.truncated` says they were
 * stopped — and a fact is something the caller can act on. `sliced.ts` acts on it by re-executing the
 * slice as hash buckets; the collector acts on it, for a statement that cannot be sliced, by reporting
 * the signal unmeasured rather than presenting a trimmed result as an estate.
 *
 * Twenty of the twenty-five, not twenty-five: the cap is enforced on the API's internal
 * representation, `byte_limit` is documented as measured the same way, and neither is the size of the
 * JSON that comes back. A limit set at the cap would be a limit set at approximately the cap, and the
 * failure it exists to prevent is what happens when the approximation is high.
 */
const BYTE_LIMIT = 20 * 1024 * 1024;

/**
 * The manifest's column types, keyed by column name.
 *
 * Undefined rather than an empty object when the manifest carries none, so a caller can tell "this
 * response did not say" from "this response said nothing is numeric" — the first falls back to
 * inference and the second would silently sort every count as text.
 */
function typesOf(manifest: Manifest | undefined): Readonly<Record<string, string>> | undefined {
  const named = (manifest?.schema?.columns ?? []).flatMap((column) =>
    column.name != null && column.type_name != null ? [[column.name, column.type_name] as const] : []
  );
  return named.length > 0 ? Object.fromEntries(named) : undefined;
}

/**
 * One statement's rows and what producing them cost.
 *
 * The byte and row counts come from the manifest the warehouse returns with the
 * result, so they are exact and cost nothing extra to collect. They are the honest
 * half of the scan footprint: DBUs for the same work do not appear in the billing
 * tables for up to a day, so they are resolved later against the statement ids rather
 * than estimated here.
 */
export interface StatementOutcome {
  readonly data: Row[];
  readonly statementId?: string;
  readonly bytesRead?: number;
  readonly rowCount?: number;
  /**
   * Each column's declared type, which the values do not reveal.
   *
   * `JSON_ARRAY` stringifies everything, so a BIGINT count and a STRING id holding digits arrive
   * identically and sort differently — one numerically, one byte by byte. Only the sliced path needs
   * this, to put a concatenation back in the order one response would have had; see concat.ts.
   */
  readonly columnTypes?: Readonly<Record<string, string>>;
  /**
   * Whether the warehouse stopped sending rows before the end of the result set.
   *
   * True means `data` is a prefix of the answer and not the answer. Nothing may treat these rows as a
   * population: every caller either subdivides the statement and asks again, or reports the signal
   * unmeasured. See `BYTE_LIMIT`.
   */
  readonly truncated?: boolean;
}

interface Chunk {
  readonly data_array?: readonly (readonly (string | null)[])[];
  readonly next_chunk_internal_link?: string;
}

interface StatementResponse {
  readonly statement_id?: string;
  readonly status?: {
    readonly state?: string;
    readonly error?: { readonly message?: string; readonly error_code?: string };
  };
  readonly manifest?: Manifest;
  readonly result?: Chunk;
}

export class StatementExecutor {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly waitSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly deadlineMs: number;

  constructor(private readonly options: StatementExecutorOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.waitSeconds = options.waitSeconds ?? 30;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.deadlineMs = options.deadlineMs ?? STATEMENT_DEADLINE_MS;
  }

  /**
   * Runs the statement and resolves to `{ data }` with rows keyed by column name.
   *
   * Named rather than positional because that is what the shape parsers read, and
   * because a positional row silently survives a column being added to the middle of
   * a query while meaning something different afterwards.
   */
  async query(statement: string, parameters: SqlParameters, signal?: AbortSignal): Promise<StatementOutcome> {
    const started = Date.now();
    let response = await this.submit(statement, parameters, signal);

    const statementId = response.statement_id;
    while (PENDING.has(response.status?.state ?? '')) {
      if (statementId == null) {
        throw new StatementFailedError('The warehouse reported a pending statement with no id to poll.');
      }

      // Both actions, in this order, because they are not the same action: giving up on the
      // wait frees the scan, and cancelling frees the warehouse. A deadline without the cancel
      // leaves the customer paying for an answer nobody is now going to read — which is what
      // `70`'s own measurement did to a shared estate for three hours.
      const waited = Date.now() - started;
      if (waited >= this.deadlineMs) {
        throw new StatementDeadlineError(statementId, waited, await this.cancel(statementId));
      }

      await this.pause(signal, statementId);
      response = await this.get(`/api/2.0/sql/statements/${statementId}`, signal);
    }

    const state = response.status?.state;
    if (state !== 'SUCCEEDED') {
      const detail = response.status?.error;
      throw new StatementFailedError(
        detail?.message ?? `The statement finished in state ${state ?? 'UNKNOWN'} without an error message.`,
        detail?.error_code
      );
    }

    const columnTypes = typesOf(response.manifest);
    return {
      data: await this.rows(response, signal),
      ...(statementId != null ? { statementId } : {}),
      ...(columnTypes == null ? {} : { columnTypes }),
      ...(typeof response.manifest?.total_byte_count === 'number'
        ? { bytesRead: response.manifest.total_byte_count }
        : {}),
      ...(typeof response.manifest?.total_row_count === 'number'
        ? { rowCount: response.manifest.total_row_count }
        : {}),
      ...(response.manifest?.truncated === true ? { truncated: true } : {}),
    };
  }

  private async rows(response: StatementResponse, signal?: AbortSignal): Promise<Row[]> {
    const columns = (response.manifest?.schema?.columns ?? []).map((column, index) => column.name ?? `col_${index}`);

    const rows: Row[] = [];
    let chunk = response.result;
    while (chunk != null) {
      for (const values of chunk.data_array ?? []) {
        const row: Row = {};
        // Indexed against the manifest rather than zipped, so a row shorter than the
        // schema yields undefined for the missing columns instead of shifting values
        // one column to the left.
        columns.forEach((name, index) => {
          row[name] = values[index] ?? null;
        });
        rows.push(row);
      }

      const next = chunk.next_chunk_internal_link;
      if (next == null) break;
      chunk = (await this.get(next, signal)).result;
    }
    return rows;
  }

  private async submit(statement: string, parameters: SqlParameters, signal?: AbortSignal): Promise<StatementResponse> {
    return this.call('/api/2.0/sql/statements', signal, {
      method: 'POST',
      body: JSON.stringify({
        // Marked as ours, in the text and in the tags, so the workload advisor can leave the tool out of
        // the estate it is describing. `self.ts` says why both marks exist and what each covers.
        statement: mark(statement),
        query_tags: SELF_TAGS,
        warehouse_id: this.options.warehouseId,
        // INLINE + JSON_ARRAY, and read the next paragraph before treating that as settled.
        //
        // This comment used to justify itself by saying Arrow and external links "exist for result
        // sets far larger than a scan should ever ask a customer's warehouse to produce". That is a
        // preference written in the grammar of a constraint, and it cost two phases of plan: knowing
        // the cap was 25 MiB, the remedy looked like making the statements return less, and designs
        // for aggregating and for sampling were both worked up before anyone asked why the ceiling was
        // 25 MiB at all. It is 25 MiB because of this line. `EXTERNAL_LINKS` is 100 GiB, and the eight
        // statements it applied to were never near a limit that was actually forced.
        //
        // INLINE is still the right choice, for a reason the original comment did not give: external
        // links are presigned URLs to the workspace's own storage bucket, so fetching them means
        // outbound requests to cloud storage carrying an embedded credential, from an app whose
        // audience is customers with locked-down egress. H1c slices instead — one execution per
        // workspace, concatenated — which keeps every row without a new network path. See
        // docs/plan-status.md.
        //
        // "Meant to be" rather than "are". This comment used to assert it as fact, and eight of
        // nineteen statements did not hold — `jobs_inventory` returns a row per job and
        // `compute_cluster_inventory` a row per cluster, neither capped. That matters more here than
        // anywhere else in the scan, because an inline result is capped at 25 MiB and **fails** past
        // the cap rather than truncating: the larger the estate, the likelier the customer gets no
        // assessment at all. Every statement now declares its own ceiling in a `-- Rows:` header,
        // `bounds.ts` explains the mechanism, and `scripts/check-statement-bounds.mjs` refuses a
        // ninth.
        //
        // `scale.test.ts` then measured what those eight cost at the declared estate, and one of them
        // is already past the cap: `serverless_job_readiness` is 27.6 MiB at 100,000 jobs, 110% of an
        // inline result, and fails at 90,606 — under the estate this app claims to assess, so a
        // customer that size gets no serverless analysis rather than a partial one. Three more fit and
        // fail on growth, inside a factor of two of the target. All four are sliced now (H1d) and
        // sub-divided when a slice is still too large (H1e), and `byte_limit` below is what makes the
        // second of those possible: it converts the overrun from a failure into a flag.
        disposition: 'INLINE',
        format: 'JSON_ARRAY',
        byte_limit: BYTE_LIMIT,
        wait_timeout: `${this.waitSeconds}s`,
        on_wait_timeout: 'CONTINUE',
        parameters: Object.entries(parameters).map(([name, marker]) => ({
          name,
          value: marker.value,
          type: marker.__sql_type,
        })),
      }),
    });
  }

  private get(path: string, signal?: AbortSignal): Promise<StatementResponse> {
    return this.call(path, signal, { method: 'GET' });
  }

  private async call(path: string, signal: AbortSignal | undefined, init: RequestInit): Promise<StatementResponse> {
    const token = await this.options.token();
    const response = await this.doFetch(`${this.options.host.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(signal != null ? { signal } : {}),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new StatementHttpError(
        response.status,
        `The warehouse refused the request with ${response.status}: ${summarise(body)}`,
        retryAfter(response)
      );
    }

    return (await response.json()) as StatementResponse;
  }

  /**
   * Waits between polls, and cancels the statement if the scan was abandoned.
   *
   * Cancelling matters more than it looks: without it, a cancelled scan leaves its
   * statements running on the customer's warehouse, which is the opposite of what
   * cancelling a scan is for.
   */
  private async pause(signal: AbortSignal | undefined, statementId: string): Promise<void> {
    if (signal?.aborted === true) {
      await this.cancel(statementId);
      throw new Error('The scan was cancelled while a statement was still running.');
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, this.pollIntervalMs);

      const onAbort = () => {
        clearTimeout(timer);
        void this.cancel(statementId);
        reject(new Error('The scan was cancelled while a statement was still running.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Asks the warehouse to stop, and says whether it accepted.
   *
   * Best effort by design on the cancellation path — the scan is already being torn down, and a
   * failure to cancel is not worth replacing the cancellation error the caller is waiting for. On
   * the deadline path the caller reports what happened to a reader, so the boolean is the
   * difference between "we stopped it" and "we stopped waiting", and only one of those is true
   * when the POST fails.
   */
  private async cancel(statementId: string): Promise<boolean> {
    try {
      await this.call(`/api/2.0/sql/statements/${statementId}/cancel`, undefined, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  }
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw == null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Enough of an error body to act on, without pasting a page of HTML into a finding. */
function summarise(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return 'no detail was returned';
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown; error_code?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON; fall through to the truncated text.
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}
