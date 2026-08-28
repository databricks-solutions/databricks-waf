// How this app talks to a model, when an install has opted in.
//
// Phase 6a. The assessment is fully usable with this file doing nothing: every
// deterministic verdict stands without a model, and L1 refuses a model-produced
// verdict any effect on the published score. What this file owns is the route those
// later phases will use — an approved endpoint behind Unity AI Gateway — and the
// four controls the plan named so a call cannot quietly become unbounded.
//
//   - Off unless `WAF_AI_ENDPOINT` names one. Absence is not a misconfiguration.
//   - A token budget that refuses further completions once spent.
//   - Exponential backoff on 429, and concurrency halved after the first one.
//   - An explanation cache keyed by the packet digest, so a replay costs nothing.
//
// Nothing here chooses a model, writes a verdict, or leaves the install's tenancy
// on its own. Those are L1d–L1f, and they are deferred until the six product
// decisions they need are taken.

export const ENDPOINT_ENV = 'WAF_AI_ENDPOINT';
export const TOKEN_BUDGET_ENV = 'WAF_AI_TOKEN_BUDGET';

/** Conservative default: enough for a handful of reviews, not a sweep of the catalogue. */
export const DEFAULT_TOKEN_BUDGET = 50_000;

/** Surfaces.ts gives the `ai` surface concurrency 2; this is the same number, owned here. */
export const INITIAL_CONCURRENCY = 2;

export class RateLimitedError extends Error {
  constructor(message = 'The model endpoint returned 429.') {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export interface CompletionRequest {
  /** Stable digest of the packet. The cache key; two packets that hash the same share an answer. */
  readonly digest: string;
  readonly prompt: string;
}

export type CompletionKind = 'ok' | 'disabled' | 'budget' | 'rate-limited' | 'failed';

export interface CompletionResult {
  readonly kind: CompletionKind;
  readonly text?: string;
  readonly tokensUsed?: number;
  readonly cached?: boolean;
}

export interface ModelAnswer {
  readonly text: string;
  readonly tokens: number;
}

export type Invoke = (prompt: string) => Promise<ModelAnswer>;

export interface GatewayOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly invoke?: Invoke;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface Gateway {
  readonly available: boolean;
  /** Tokens still inside the budget. Zero once spent, including against cached hits that were counted. */
  readonly remaining: number;
  /** In-flight ceiling after any 429. Starts at `INITIAL_CONCURRENCY`. */
  readonly concurrency: number;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export function openGateway(options: GatewayOptions = {}): Gateway {
  const env = options.env ?? process.env;
  const endpoint = (env[ENDPOINT_ENV] ?? '').trim();
  const budget = budgetOf(env[TOKEN_BUDGET_ENV]);
  const invoke = options.invoke;
  const sleep = options.sleep ?? defaultSleep;

  const cache = new Map<string, ModelAnswer>();
  let spent = 0;
  let concurrency = INITIAL_CONCURRENCY;
  let inFlight = 0;

  const available = endpoint !== '' && invoke != null;

  return {
    get available() {
      return available;
    },
    get remaining() {
      return Math.max(0, budget - spent);
    },
    get concurrency() {
      return concurrency;
    },
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      if (!available || invoke == null) return { kind: 'disabled' };

      const cached = cache.get(request.digest);
      if (cached != null) {
        return { kind: 'ok', text: cached.text, tokensUsed: cached.tokens, cached: true };
      }

      if (spent >= budget) return { kind: 'budget' };

      // Wait for a slot rather than reject: a burst of reviews should queue, not drop.
      while (inFlight >= concurrency) {
        await sleep(10);
      }

      inFlight += 1;
      try {
        const answer = await invokeWithBackoff(invoke, request.prompt, sleep, () => {
          concurrency = Math.max(1, Math.floor(concurrency / 2));
        });
        if (answer == null) return { kind: 'rate-limited' };
        if (spent + answer.tokens > budget) {
          // Count the spend we would have made so a later call does not sneak through.
          spent = budget;
          return { kind: 'budget' };
        }
        spent += answer.tokens;
        cache.set(request.digest, answer);
        return { kind: 'ok', text: answer.text, tokensUsed: answer.tokens };
      } catch {
        return { kind: 'failed' };
      } finally {
        inFlight -= 1;
      }
    },
  };
}

function budgetOf(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_TOKEN_BUDGET;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TOKEN_BUDGET;
  return Math.floor(parsed);
}

async function invokeWithBackoff(
  invoke: Invoke,
  prompt: string,
  sleep: (ms: number) => Promise<void>,
  onRateLimit: () => void
): Promise<ModelAnswer | undefined> {
  let delay = 200;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await invoke(prompt);
    } catch (cause) {
      if (!(cause instanceof RateLimitedError)) throw cause;
      onRateLimit();
      if (attempt === 2) return undefined;
      await sleep(delay);
      delay *= 2;
    }
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
