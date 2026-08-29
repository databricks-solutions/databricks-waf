// What the app serves when it cannot start.
//
// AppKit's `createApp` throws when a resource it declares is not bound — no SQL
// warehouse, most commonly. The default consequence is that the process exits, the
// platform shows a stopped app, and the only explanation is a stack trace in a log the
// person who installed the app may not be able to read. For an app somebody else deploys
// that is the wrong failure: the most likely error in an install is a mis-bound resource, and
// the person making it did not write this app and has no reason to know that
// `DATABRICKS_WAREHOUSE_ID` is what "resource not found" meant.
//
// So the process stays up, every request answers with what is missing and how to fix it,
// and the real app is retried in the background. When the admin binds the warehouse and
// the retry succeeds, the fallback stops and the app takes over without a redeploy.

import { createServer, type Server } from 'node:http';

export interface FallbackOptions {
  readonly port?: number;
  /** Retried until it succeeds, so fixing the binding does not need a redeploy. */
  readonly retry?: () => Promise<unknown>;
  readonly retryIntervalMs?: number;
}

/**
 * What kind of problem this is, which decides who can fix it.
 *
 * The distinction that carries weight is `app-incomplete` against everything else. A
 * missing warehouse is the admin's to fix in a form; a missing file inside the app is not
 * fixable by any amount of binding, and sending an admin to check their resources for it
 * would have them looking for something that was never their doing. It is also the one
 * kind that must never pass a packaging check, which is why it is a value rather than
 * prose.
 */
export type FailureKind =
  | 'no-warehouse'
  | 'no-database'
  | 'database-schema'
  | 'no-assessor-group'
  | 'permission'
  | 'app-incomplete'
  | 'unknown';

export interface Explanation {
  readonly kind: FailureKind;
  readonly summary: string;
  readonly action: string;
  readonly detail: string;
}

/** A file or module the app ships is not where it should be: a packaging fault, not a configuration one. */
const INCOMPLETE_INSTALL =
  /ENOENT|no such file or directory|Cannot find (?:module|package)|MODULE_NOT_FOUND|config[/\\]controls/i;

/**
 * The likely cause, in the words of someone who has to fix it.
 *
 * Pattern-matched on the message because AppKit's startup errors are not a typed
 * hierarchy. A match produces a specific instruction; no match falls through to the
 * original message, which is still better than an exited process.
 */
export function explain(cause: unknown): Explanation {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const lower = detail.toLowerCase();
  const deniedSchema = /permission denied for schema ([a-z_][a-z0-9_]*)\b/i.exec(detail)?.[1];

  if (INCOMPLETE_INSTALL.test(detail)) {
    return {
      kind: 'app-incomplete',
      summary: 'This installation of the app is missing part of itself.',
      action:
        'No workspace setting will fix this: a file or module the app ships is absent from the deployed tree. ' +
        'Reinstall or redeploy the app. If it persists, it is a fault in the released package rather than in this ' +
        'workspace, and worth reporting with the detail below.',
      detail,
    };
  }

  /*
   * The one failure here that no amount of binding fixes and that is nevertheless the admin's.
   *
   * It is matched on the variable's name rather than on prose, because the name is the thing they
   * have to go and edit. It is also the only kind whose fix needs a redeploy: the retry loop below
   * re-runs startup every thirty seconds, which recovers a resource bound in the workspace UI and
   * can never recover an environment variable, so the action says so instead of letting the page's
   * standing "no redeploy needed" note apply to a case where it is false.
   */
  if (detail.includes('WAF_ASSESSOR_GROUP')) {
    return {
      kind: 'no-assessor-group',
      summary: 'This app does not know who is allowed to change an assessment.',
      action:
        'Set `assessor_group` in databricks.yml to the name of a Databricks group in this workspace, then ' +
        'redeploy. ' +
        'Its members may start scans, answer the requirements only a person can answer, and accept or defer a ' +
        'risk; everyone else can still read everything. The group has to hold its members directly, because a ' +
        'group nested inside another is not reported as a membership. Unlike a missing resource, this one is not ' +
        'fixable from the workspace UI and the retry below will not clear it.',
      detail,
    };
  }

  /*
   * A bound database can still contain a schema or table owned by another identity. PostgreSQL's
   * real error is only "permission denied for schema waf"; it does not contain "postgres" or
   * "lakebase". Matching only those product names sent the reader to grant CAN USE on a warehouse
   * that was already bound correctly, while the app kept failing on the database.
   *
   * Table and sequence forms are the same ownership fault one statement later. The app creates
   * indexes during startup, so DML grants alone cannot repair them: its service principal must own
   * the App schema and the objects inside it.
   */
  if (
    deniedSchema != null ||
    /permission denied for (?:table|sequence)\b/i.test(detail) ||
    /must be owner of (?:table|sequence)\b/i.test(detail)
  ) {
    const object = deniedSchema == null ? 'the affected App schema' : `only the \`${deniedSchema}\` schema`;
    return {
      kind: 'database-schema',
      summary: 'The App schema belongs to a different database identity.',
      action:
        'The bound Lakebase database already contains the App schema, but this App service principal does not own ' +
        'it. If those records matter, stop and back them up before changing the schema. If this is intentionally ' +
        `an empty install, have the Lakebase project owner remove ${object}; this page will retry and ` +
        'the current App service principal will recreate it. Granting CAN USE on the SQL warehouse will not fix ' +
        'this database ownership error.',
      detail,
    };
  }

  // Before the warehouse branch and before the permission one, because a Lakebase failure can
  // mention both: an unbound endpoint reads as a missing resource, and a role without
  // CAN_CONNECT_AND_CREATE fails with a permission error that the generic permission text would
  // send an admin to the warehouse to fix.
  if (lower.includes('lakebase') || lower.includes('postgres')) {
    return {
      kind: 'no-database',
      summary: 'This app has no Lakebase database bound to it.',
      action:
        'Open the app in your workspace, choose Edit, and add a database resource with CAN_CONNECT_AND_CREATE. ' +
        'The app keeps scan history, attested answers and risk decisions there, so it will not start without one. ' +
        'If a database is already bound, the app service principal needs CAN_CONNECT_AND_CREATE on it rather than ' +
        'read-only access: the app creates its own schema on first boot.',
      detail,
    };
  }

  if (lower.includes('warehouse')) {
    return {
      kind: 'no-warehouse',
      summary: 'This app has no SQL warehouse bound to it.',
      action:
        'Open the app in your workspace, choose Edit, and add a SQL warehouse resource with CAN USE permission. ' +
        'The assessment reads Unity Catalog system tables through that warehouse, so it cannot run without one. ' +
        'A serverless warehouse on the smallest size is sufficient.',
      detail,
    };
  }

  if (lower.includes('permission') || lower.includes('403') || lower.includes('forbidden')) {
    return {
      kind: 'permission',
      summary: 'The app service principal is missing a permission it needs to start.',
      action:
        'Grant the app service principal CAN USE on the bound SQL warehouse. The app then reads system tables as ' +
        'whoever started the run, not as itself, so no further data grants are needed for the service principal.',
      detail,
    };
  }

  return {
    kind: 'unknown',
    summary: 'The app could not start.',
    action:
      'The underlying error is shown below. The most common cause is a resource declared by the app but not bound ' +
      'to it at install time; check the app\u2019s resources in the workspace UI.',
    detail,
  };
}

function page(cause: unknown): string {
  const { summary, action, detail } = explain(cause);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Setup needed</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; background: #f7f7f8; color: #1b1b1f; }
  main { max-width: 46rem; margin: 0 auto; background: #fff; border: 1px solid #e3e3e7; border-radius: 12px; padding: 2rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  pre { background: #f2f2f4; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; }
  .muted { color: #5a5a63; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(summary)}</h1>
  <p>${escapeHtml(action)}</p>
  <p class="muted">This page is retrying in the background. Once the resource is bound, the app starts on its own \u2014 no redeploy needed.</p>
  <pre>${escapeHtml(detail)}</pre>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character
  );
}

export interface FallbackHandle {
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Serves the explanation on every path and keeps retrying the real startup.
 *
 * Every path, including the API routes, because a client that has the page cached will
 * call `/api/scans` first and a 404 there would read as an empty app rather than an
 * unconfigured one. The status is 503 so monitoring sees a service that is not ready,
 * rather than one that is fine and happens to be useless.
 */
export function startFallbackServer(cause: unknown, options: FallbackOptions = {}): FallbackHandle {
  const port = options.port ?? Number(process.env.DATABRICKS_APP_PORT ?? process.env.PORT ?? 8000);
  const body = page(cause);
  const { kind, summary, action, detail } = explain(cause);

  const server = createServer((request, response) => {
    const wantsJson = request.url?.startsWith('/api/') === true;
    response.writeHead(503, {
      'content-type': wantsJson ? 'application/json' : 'text/html; charset=utf-8',
      'retry-after': '30',
    });
    response.end(wantsJson ? JSON.stringify({ error: 'not-configured', kind, summary, action, detail }) : body);
  });

  server.listen(port, () => {
    console.error(`[startup] ${summary} Serving an explanation on port ${String(port)} and retrying.`);
  });

  const handle: FallbackHandle = {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error != null ? reject(error) : resolve()));
      }),
  };

  if (options.retry != null) scheduleRetry(handle, options.retry, options.retryIntervalMs ?? 30_000);
  return handle;
}

function scheduleRetry(handle: FallbackHandle, retry: () => Promise<unknown>, intervalMs: number): void {
  const timer = setTimeout(() => {
    // The fallback holds the port, so it has to let go before the real server can bind
    // it. Closing first means a failed retry leaves nothing listening for one interval —
    // accepted deliberately, because the alternative is never being able to recover
    // without a redeploy, and the platform's own health checks tolerate a gap far
    // shorter than the retry interval.
    handle
      .close()
      .then(retry)
      .catch((cause: unknown) => {
        console.error('[startup] Retry failed; continuing to serve the explanation.', cause);
        const next = startFallbackServer(cause, { retry, retryIntervalMs: intervalMs });
        void next;
      });
  }, intervalMs);

  // Never a reason to hold the process open on its own; the server already does that.
  timer.unref();
}
