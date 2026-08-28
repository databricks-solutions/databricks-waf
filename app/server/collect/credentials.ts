// How a collector obtains the authority to call anything.
//
// The reason this is an interface and not an Express request: the same checks have
// to run two ways. On demand, they run as the signed-in account admin via
// on-behalf-of-user, and see exactly what that person may see. On a schedule, they
// run as a service principal with no request in sight. Those are the same checks
// against the same estate, and if the collectors take a request object then the
// scheduled path needs its own copy of all of them.
//
// Establishing this before the collectors exist is the whole point. Retrofitting it
// across four of them later means changing every call site in all four, plus
// whatever tests were written against the request-shaped version.

/**
 * Which identity a scan ran as. Recorded on the scan, because results are not comparable across the two.
 *
 * The two are not two doors. A scheduled run reaches this app through the same on-behalf-of proxy a
 * browser does — ADR 0021 measured it — so this records *whose* eyes the estate was read through,
 * not which mechanism carried the token. `modeFor` below is how it is decided.
 */
export type ExecutionMode = 'on-behalf-of-user' | 'service-principal';

export interface DatabricksCredentials {
  readonly mode: ExecutionMode;
  /**
   * Stable identifier for the executing identity — a username or a service
   * principal application id. Recorded so a result can be attributed, and so a
   * trend line refuses to compare two scans that saw different estates.
   */
  readonly actor: string;
  /**
   * What that identity calls itself, where it is worth showing instead of the id.
   *
   * Only ever set for an identity whose `actor` is an application id, which is a UUID and reads as
   * noise in a column of email addresses. Never a substitute for `actor`: a display name can be
   * changed and duplicated, so the attribution and the comparability both stay on the id.
   */
  readonly actorName?: string;
  readonly host: string;
  /**
   * Fetched per call rather than held, because a service principal token expires
   * mid-scan on any scan long enough to matter. Implementations are expected to
   * cache internally and refresh near expiry; callers should not.
   */
  readonly token: () => Promise<string>;
}

/**
 * Short-lived cloud credentials vended by Unity Catalog for a service credential.
 *
 * Null is a first-class answer: most installations will not have configured one,
 * and the twelve controls that need cloud APIs must then report as unmeasurable
 * rather than failing. Absence of evidence is not evidence of a problem, and a tool
 * that scores it as one teaches people to distrust its findings.
 */
export interface CloudCredentials {
  readonly provider: 'aws' | 'azure' | 'gcp';
  readonly expiresAt: Date;
  readonly aws?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken: string;
  };
  readonly azure?: { readonly aadToken: string };
  readonly gcp?: { readonly oauthToken: string };
}

export interface CredentialProvider {
  readonly mode: ExecutionMode;
  databricks(): Promise<DatabricksCredentials>;
  /**
   * Vend cloud credentials for a named Unity Catalog service credential, or return
   * null when none is configured or the identity may not use it.
   */
  cloud(serviceCredentialName?: string): Promise<CloudCredentials | null>;
}

/**
 * The header Databricks Apps injects when a request carries a user token.
 *
 * Named here rather than inline at the call site because it is the entire
 * mechanism by which on-behalf-of-user works, and a typo in it degrades silently to
 * the app's own identity — which would still work, would return more data than the
 * user is entitled to, and would pass every test that did not check whose eyes the
 * results came from.
 */
export const USER_TOKEN_HEADER = 'x-forwarded-access-token';

/**
 * Headers the Apps proxy sets alongside the token, naming who it belongs to.
 *
 * Preferred over asking the SCIM current-user endpoint, which is a network round
 * trip on the scan path to learn something already in the request, and which needs
 * a scope this app does not request. The first live scan stamped its actor as
 * "unknown" for exactly that reason: the call was made, was refused, and the
 * failure was swallowed by design.
 *
 * Email first because it is the identity a workspace admin recognises in an audit
 * log; the preferred username is the fallback for identities without one.
 */
export const USER_IDENTITY_HEADERS = ['x-forwarded-email', 'x-forwarded-preferred-username'] as const;

/**
 * The workspace URL, as an absolute URL whatever form the environment supplied.
 *
 * The Apps runtime sets `DATABRICKS_HOST` to a bare hostname —
 * `dbc-….cloud.databricks.com`, no scheme — while the CLI and the SDKs set it with
 * `https://`. Both are "the host", and `fetch` accepts only one of them: the bare form
 * fails with "Failed to parse URL", which surfaced as every check in a live scan
 * reporting that it could not be measured. Normalising once at the edge means no caller
 * has to know which runtime it is in.
 */
export function workspaceHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.DATABRICKS_HOST ?? env.DATABRICKS_WORKSPACE_URL ?? '').trim();
  if (raw === '') return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

export interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

/** Who the forwarded token belongs to, according to the proxy that forwarded it. */
export function actorFromHeaders(request: RequestLike): string | undefined {
  for (const header of USER_IDENTITY_HEADERS) {
    const value = headerValue(request, header)?.trim();
    if (value != null && value !== '') return value;
  }
  return undefined;
}

/**
 * A service principal's forwarded identity, which is its application id and so a UUID.
 *
 * Measured rather than assumed, on labs, 2026-08-10: of the twenty stored scans, the nine scheduled
 * runs all carry `5af463d1-8cb9-4417-b2a5-725cea64cce5` as their actor and the eleven interactive
 * ones all carry `operator@example.com`. The two forms do not overlap in either
 * direction — an email cannot be a UUID, and an application id is nothing else.
 *
 * The client reached the same rule from the other end and for the same reason, in
 * `pages/run-language.ts`, where three surfaces had inferred "a person" from an execution mode that
 * was always `on-behalf-of-user`. `credentials.test.ts` holds the two copies to the same answers.
 */
const APPLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which kind of identity the proxy forwarded, from the identity itself.
 *
 * `fromRequest` used to write `on-behalf-of-user` unconditionally, so every scan ever recorded said
 * it — including eight scheduled runs with no person anywhere in them. The field is not decorative:
 * `comparable()` refuses to compare two runs across a change of execution mode, and that refusal
 * could not fire while the value never varied.
 *
 * Nothing rewrites what is already stored. A stamp records what the app believed when it wrote it.
 */
export function modeFor(actor: string): ExecutionMode {
  return APPLICATION_ID.test(actor.trim()) ? 'service-principal' : 'on-behalf-of-user';
}

export class MissingUserTokenError extends Error {
  constructor() {
    super(
      `No ${USER_TOKEN_HEADER} header on the request. On-behalf-of-user scans require it, and ` +
        'falling back to the app identity is refused deliberately: it would return more than the ' +
        'caller is entitled to see.'
    );
    this.name = 'MissingUserTokenError';
  }
}

function headerValue(request: RequestLike, name: string): string | undefined {
  const raw = request.headers[name] ?? request.headers[name.toLowerCase()];
  if (raw == null) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Named Unity Catalog service credential this install may vend cloud keys from. */
export const SERVICE_CREDENTIAL_ENV = 'WAF_SERVICE_CREDENTIAL';

export function envServiceCredential(env: NodeJS.ProcessEnv = process.env): string {
  return (env[SERVICE_CREDENTIAL_ENV] ?? '').trim();
}

/**
 * Short-lived cloud keys for a named service credential, or null if the workspace refused.
 *
 * Null on every failure: a 403, a 404, a network blip, a body this build does not
 * recognise. The cloud collector treats null as unmeasurable, so inventing keys here
 * would be the one way to turn a missing grant into a fabricated bill.
 */
export async function vendServiceCredential(
  host: string,
  token: string,
  name: string,
  post: typeof fetch = fetch
): Promise<CloudCredentials | null> {
  if (name.trim() === '') return null;
  try {
    const response = await post(`${host}/api/2.1/unity-catalog/temporary-service-credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential_name: name }),
    });
    if (!response.ok) return null;
    return cloudCredentialsFrom(await response.json());
  } catch {
    return null;
  }
}

function cloudCredentialsFrom(body: unknown): CloudCredentials | null {
  if (body == null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const expiresAt = expiresAtOf(record.expiration_time);
  const aws = record.aws_temp_credentials;
  if (aws != null && typeof aws === 'object') {
    const keys = aws as Record<string, unknown>;
    const accessKeyId = text(keys.access_key_id);
    const secretAccessKey = text(keys.secret_access_key);
    const sessionToken = text(keys.session_token);
    if (accessKeyId != null && secretAccessKey != null && sessionToken != null) {
      return { provider: 'aws', expiresAt, aws: { accessKeyId, secretAccessKey, sessionToken } };
    }
  }
  const azure = text(record.azure_aad_token);
  if (azure != null) return { provider: 'azure', expiresAt, azure: { aadToken: azure } };
  const gcp = text(record.gcp_oauth_token);
  if (gcp != null) return { provider: 'gcp', expiresAt, gcp: { oauthToken: gcp } };
  return null;
}

function expiresAtOf(value: unknown): Date {
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Credentials taken from the request, whoever the proxy says they belong to.
 *
 * There is deliberately no fallback to the app's own identity. A scan that quietly
 * ran as the service principal because a header was missing would report an estate
 * the signed-in user cannot see, and the failure would look like success.
 *
 * The mode is read off the actor rather than fixed, so a scheduled run is stamped as the service
 * principal it is. That is a statement about the identity and not about this door: everything here
 * still comes through the forwarded token, which is the only door there is.
 */
export function fromRequest(
  request: RequestLike,
  host: string,
  actor: string,
  actorName?: string
): CredentialProvider {
  const token = headerValue(request, USER_TOKEN_HEADER);
  if (token == null || token === '') throw new MissingUserTokenError();

  const mode = modeFor(actor);

  return {
    mode,
    // Promise-returning without being async: the token is already in hand here, and
    // the signature is a promise because the service principal implementation has to
    // refresh, not because this one does.
    databricks(): Promise<DatabricksCredentials> {
      return Promise.resolve({
        mode,
        actor,
        ...(actorName != null && actorName !== '' ? { actorName } : {}),
        host,
        token: () => Promise.resolve(token),
      });
    },
    cloud(serviceCredentialName?: string): Promise<CloudCredentials | null> {
      // Named, never implied. Labs has no service credential (one Databricks-managed
      // storage credential, purpose STORAGE, read 2026-08-19), and most installs
      // will not configure one. Absence is the common case and a first-class answer:
      // the cloud collector degrades to unmeasurable rather than inventing a bill.
      const name = (serviceCredentialName ?? envServiceCredential()).trim();
      if (name === '') return Promise.resolve(null);
      return vendServiceCredential(host, token, name);
    },
  };
}
