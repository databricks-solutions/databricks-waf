// What the token this app is handed can actually authorise, read from the token itself.
//
// ADR 0016 concluded that 17 security requirements are unreachable, from the outside in: the
// scope registry refused the names, so the calls must fail. That is an inference, and the
// same reasoning already proved wrong once — `serving.serving-endpoints:read` validated at
// registration and then granted nothing, and `model-serving` later started working without a
// redeploy. Both times the inference and the token disagreed, and the token was right.
//
// So ask the token. An OAuth access token names its own scopes, and comparing that list
// against what was declared distinguishes three situations a refusal cannot:
//
//   - declared, carried, still refused   the scope name is not what governs that API
//   - declared but not carried           consent has not happened, or was downscoped
//   - carried but never declared         the platform grants more than was asked for
//
// The second is the one worth knowing about, because it is temporary and fixes itself, and
// an app that reported it as a permanent platform limit would be lying to the customer.

/**
 * Scopes named by an OAuth access token, or nothing if it does not say.
 *
 * The signature is deliberately not `verify`. This decodes without checking anything, which
 * is unsafe for an authorisation decision and fine for the only use here: reporting to the
 * signed-in user what the token they supplied claims to permit. Nothing branches on the
 * result except a diagnostic page — the authority to make each call is decided by the
 * platform when the call is made, as it must be.
 *
 * Returns nothing rather than throwing for an opaque token, since a non-JWT token is a
 * legitimate thing for the platform to issue and not an error to report.
 */
export function scopesOf(token: string): readonly string[] | undefined {
  const payload = claimsOf(token);
  if (payload == null) return undefined;

  const scope = payload['scope'] ?? payload['scp'];
  if (typeof scope === 'string') return scope.split(/[\s,]+/u).filter((part) => part !== '');
  if (Array.isArray(scope)) return scope.filter((part): part is string => typeof part === 'string');
  return undefined;
}

/** Unverified claims of a JWT, or nothing if it is not one. */
export function claimsOf(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;

  const body = parts[1];
  if (body == null) return undefined;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof decoded === 'object' && decoded !== null ? (decoded as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface TokenReport {
  /** Whether the token names its scopes at all. An opaque token is not a fault. */
  readonly readable: boolean;
  readonly scopes?: readonly string[];
  /** Seconds until expiry, for telling a stale token from an unscoped one. */
  readonly expiresIn?: number;
  /** What the token says it is for, which says whether it is workspace or account scoped. */
  readonly audience?: string;
}

export function reportOn(token: string, now: Date = new Date()): TokenReport {
  const claims = claimsOf(token);
  if (claims == null) return { readable: false };

  const scopes = scopesOf(token);
  const expiry = typeof claims['exp'] === 'number' ? claims['exp'] : undefined;
  const audience = claims['aud'];

  return {
    readable: true,
    ...(scopes != null ? { scopes } : {}),
    ...(expiry != null ? { expiresIn: Math.round(expiry - now.getTime() / 1000) } : {}),
    ...(typeof audience === 'string' ? { audience } : {}),
  };
}
