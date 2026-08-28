// Asking the Query History service for one statement's plan.
//
// The SDK cannot do this. `WorkspaceClient.queryHistory` exposes `list` and nothing else, and the plan
// lives behind `GET /api/2.0/sql/history/queries/{id}` — a get-by-id the service has and the generated
// client does not. So this is a raw `fetch`, and it is the only place in the app that calls Databricks
// without an SDK underneath it.
//
// That fact is load-bearing rather than incidental, because of what it means for retries. ADR 0010 puts
// retry under exactly one layer and has each surface declare which: `clientRetries` true means the client
// beneath retries and the scheduler must not, false means the scheduler must. Every surface except `ai`
// declares true on the strength of the SDK being underneath. There is no SDK underneath this one, so the
// `plans` surface declares false and the scheduler is the retrying layer — which is what makes
// `Retry-After` on a 429 actually slept on rather than merely recorded.
//
// ## What this throws on, and what it does not
//
// A 404 is returned, not thrown. It is the expected answer for a statement the workspace cannot see, and
// `33k` measured 3.10% of a real estate's statements reaching it that way; `parse.ts` reads it as
// `not-retrievable`, which is a finding rather than a failure. `retrievable.ts` removes the predictable
// share of those before a call is spent, so what arrives here is the residue.
//
// Everything else that is not a 200 throws, carrying its status and `Retry-After`, because those are what
// the scheduler classifies on. A generic `Error` would collapse 403 and 429 into one thing: the first
// means stop asking and the second means ask again shortly.

import type { PlanResponseBody } from './parse.js';

/**
 * The rung of the ladder this asks for.
 *
 * `33b` walked five rungs and measured what each returns. The two above this one add
 * `include_debug_info` and then `include_json_plans`, and the richest is 110% of the 8 MB ceiling the
 * advisor sets on a profile response — so the ladder ends here not because the rungs above carry nothing
 * but because they do not fit. This rung came back at 29% of that ceiling on the same statement.
 *
 * `include_metrics` is not also requested. It is a rung *below* this one rather than an orthogonal flag,
 * and the capture in `fixtures/metrics-only.json` is what it returns on its own: `plans_state: EXISTS`
 * and no `plans` field at all.
 */
const LADDER_RUNG = 'include_plans=true';

/** An HTTP failure that keeps what the scheduler classifies on. Shaped like `StatementHttpError`. */
export class PlanHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'PlanHttpError';
  }
}

export interface PlanFetcherOptions {
  readonly host: string;
  /** Fetched per call rather than held, since a scheduled run's token expires mid-run. */
  readonly token: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * One plan response: the status the parser interprets, and the body where there was one.
 *
 * Both, rather than the body alone, because `parsePlanResponse` takes both and the status is what
 * separates its two absences — a 404 is no plan record, and a 200 with `plans_state: EMPTY` is a plan
 * record reporting no plan. Only the second licenses saying a plan was absent.
 */
export interface PlanResponse {
  readonly status: number;
  readonly body: PlanResponseBody | null;
}

/**
 * The one method a caller needs, named so it can depend on that rather than on the class.
 *
 * `PlanFetcher` satisfies it. What this buys is that a test stands one up in a line, and that nothing
 * downstream acquires a dependency on the transport: `retrievePlans` cares that a plan can be asked for
 * and not that it arrives over HTTP.
 */
export interface PlanSource {
  plan: (statementId: string, signal?: AbortSignal) => Promise<PlanResponse>;
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  if (header == null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function summarise(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

export class PlanFetcher implements PlanSource {
  private readonly doFetch: typeof globalThis.fetch;

  constructor(private readonly options: PlanFetcherOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * Fetches one statement's plan, returning what the parser can read and throwing what the scheduler
   * must see.
   *
   * The `signal` is the scan's, so a cancelled run stops fetching rather than finishing its queue.
   */
  async plan(statementId: string, signal?: AbortSignal): Promise<PlanResponse> {
    const token = await this.options.token();
    const host = this.options.host.replace(/\/+$/, '');
    const url = `${host}/api/2.0/sql/history/queries/${encodeURIComponent(statementId)}?${LADDER_RUNG}`;

    const response = await this.doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      ...(signal != null ? { signal } : {}),
    });

    if (response.status === 404) {
      // Read and discarded rather than left unread: an undrained body holds the connection in the pool
      // this fetch shares, and 404 is the one non-200 common enough for that to accumulate.
      await response.text().catch(() => '');
      return { status: 404, body: null };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PlanHttpError(
        response.status,
        `The query history service refused the plan request with ${String(response.status)}: ${summarise(body)}`,
        retryAfterSeconds(response)
      );
    }

    // A 200 whose body is not JSON is a platform change rather than a failure of this statement, and the
    // parser has an outcome for it: `unknown-state`. Throwing here would take a scan down for it.
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as PlanResponseBody };
    } catch {
      return { status: response.status, body: null };
    }
  }
}
