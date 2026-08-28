// Classify a failure into the handful of kinds the scheduler reacts to differently.
//
// The scheduler needs to distinguish four responses: back off (throttled), retry
// (transient), record and carry on (the identity is not allowed to see this), and
// stop (something is actually wrong). Everything else is detail.

export type FailureKind =
  /** Throttled. Reduce concurrency and respect Retry-After. */
  | 'rate-limited'
  /**
   * Timed out. Treated as a throttling signal rather than a transport fault,
   * because on a warehouse under load that is usually what it is.
   */
  | 'timeout'
  /**
   * This app stopped waiting and cancelled the statement. Distinct from `timeout`,
   * which the platform decides: a deadline says nothing about the warehouse's
   * capacity, so concurrency does not move for it, and the second attempt would
   * cost exactly what the first one did, so there is not one.
   */
  | 'deadline'
  /**
   * The executing identity may not see this. Expected under on-behalf-of-user
   * execution and not a fault: the control degrades to unmeasurable and the scan
   * continues. Retrying cannot help.
   */
  | 'permission-denied'
  /** The object is gone or was never there. Not retryable, not a fault. */
  | 'not-found'
  /** Transient and worth another attempt. */
  | 'transient'
  /** Everything else. Not retryable. */
  | 'fatal';

export interface ClassifiedFailure {
  readonly kind: FailureKind;
  /** Honoured verbatim when the server sent one. */
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly message: string;
}

export const RETRYABLE: readonly FailureKind[] = ['rate-limited', 'timeout', 'transient'];

/**
 * Whether the control this task was collecting should degrade rather than fail the
 * scan. A permission denial says something true about the estate as this identity
 * sees it, so it is data, not breakage.
 */
export function isDegradation(kind: FailureKind): boolean {
  return kind === 'permission-denied' || kind === 'not-found';
}

/**
 * Read `Retry-After`, which is specified as either a number of seconds or an
 * HTTP-date, and is sent in both forms in practice.
 *
 * Returns undefined rather than a default for anything unparseable. A wrong delay
 * is worse than no delay, because the caller's own backoff is at least
 * deliberately chosen.
 */
export function parseRetryAfter(value: string | undefined | null, now = Date.now()): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    // A date already in the past means retry now, not retry in negative time.
    return Math.max(0, asDate - now);
  }

  return undefined;
}

function headerOf(error: unknown, name: string): string | undefined {
  const headers = (error as { headers?: unknown })?.headers;
  if (headers == null) return undefined;

  // Undici and the Fetch standard give a Headers object; the SDKs give a plain one.
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }

  const record = headers as Record<string, unknown>;
  const hit = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit == null ? undefined : String(record[hit]);
}

/**
 * How long the server asked us to wait, from whichever shape the thrower used.
 *
 * Three shapes because three throwers. The SDKs and fetch attach the raw response
 * headers; the statement executor has already read the header and keeps it as seconds,
 * because it discards the response once it has an error to throw. Reading only headers
 * would silently ignore a `Retry-After` the app had already parsed, and the scan would
 * back off on its own jittered guess instead of the interval the warehouse named.
 */
function retryAfterOf(error: unknown, now: number): number | undefined {
  const e = error as { retryAfterMs?: unknown; retryAfterSeconds?: unknown };
  if (typeof e?.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)) return e.retryAfterMs;
  if (typeof e?.retryAfterSeconds === 'number' && Number.isFinite(e.retryAfterSeconds)) {
    return e.retryAfterSeconds * 1000;
  }
  return parseRetryAfter(headerOf(error, 'retry-after'), now);
}

function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

/**
 * Classify by status code first and message text only as a fallback.
 *
 * Message matching is here because it has to be — a Node socket timeout arrives as
 * a bare `ETIMEDOUT` with no status, and the SQL execution API reports permission
 * failures in the statement result rather than as an HTTP error. But it is
 * checked second, so a server that says 429 is believed over a message that
 * happens to contain the word "limit".
 */
export function classify(error: unknown, now = Date.now()): ClassifiedFailure {
  // Ahead of the status check, and ahead of the message matching below, which would read
  // "did not finish within 600s" as the platform having timed out. Nothing here is a
  // response: this is the app's own decision to stop waiting, and only the thrower knows it.
  if ((error as { name?: unknown })?.name === 'StatementDeadlineError') {
    return { kind: 'deadline', message: error instanceof Error ? error.message : String(error) };
  }

  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const retryAfterMs = retryAfterOf(error, now);

  if (status === 429) return { kind: 'rate-limited', retryAfterMs, status, message };
  if (status === 403 || status === 401) return { kind: 'permission-denied', status, message };
  if (status === 404) return { kind: 'not-found', status, message };
  if (status === 408 || status === 504) return { kind: 'timeout', retryAfterMs, status, message };
  if (status === 503) return { kind: 'rate-limited', retryAfterMs, status, message };
  if (status != null && status >= 500) return { kind: 'transient', retryAfterMs, status, message };
  if (status != null && status >= 400) return { kind: 'fatal', status, message };

  const lower = message.toLowerCase();
  // Type-checked rather than coerced: a non-string `code` stringifies to
  // "[object Object]", which would match none of the comparisons below and quietly
  // reclassify a transport error as fatal.
  const rawCode = (error as { code?: unknown })?.code;
  const code = typeof rawCode === 'string' ? rawCode : '';

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || lower.includes('timed out') || lower.includes('timeout')) {
    return { kind: 'timeout', retryAfterMs, message };
  }
  if (lower.includes('too many requests') || lower.includes('rate limit') || lower.includes('throttl')) {
    return { kind: 'rate-limited', retryAfterMs, message };
  }
  // Unity Catalog denials surface as PERMISSION_DENIED in the statement result
  // rather than as an HTTP status, so this is the only way to see them.
  if (lower.includes('permission_denied') || lower.includes('does not have') || lower.includes('access denied')) {
    return { kind: 'permission-denied', message };
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
    return { kind: 'transient', message };
  }

  return { kind: 'fatal', message };
}
