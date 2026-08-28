// The app's own client, which is the only one in this codebase that is not the signed-in user's.
//
// Separate from `collect/rest/client.ts` on purpose, and the two should stay hard to confuse. That one
// is built from the caller's token so that a finding can never describe more of the estate than the
// reader may see, and its comment is the argument. This one is the app's service principal, and the
// only thing it is allowed to touch is the app's own scheduled job — `schedule/schedule.ts` has the
// case, and `resources/scheduled-scan.yml` holds the grant that makes it true rather than promised.
//
// The identity resolution is the SDK's default chain, deliberately, because the two environments this
// runs in resolve differently and both are wanted. On the platform the chain finds
// `DATABRICKS_CLIENT_ID` and the OAuth secret the Apps runtime injects, so the client is the app's
// service principal. Locally it finds the CLI profile, so a developer gets themselves — which is what
// makes the schedule panel work against a real workspace without the app being deployed. This is the
// same resolution the store uses to reach Lakebase (`store/postgres.ts`), and it is reached through the
// same helper so there is one answer to "who is the app" rather than two.

import { getWorkspaceClient } from '@databricks/lakebase';
import type { Workspace, WorkspaceFactory } from './port.js';

/**
 * The app's client, built once, or undefined where this install has no identity of its own.
 *
 * Undefined is a supported state rather than a fault: a container with no credentials in its
 * environment and no CLI config is what a reviewer running the app with `WAF_DEMO_NO_PERSISTENCE` has,
 * and the schedule surface reports `unreadable` rather than failing the page. So construction failure is
 * caught here rather than left to the first call, which would turn a missing credential into a 500 on a
 * route that had a truthful answer available.
 */
export function machineClient(): WorkspaceFactory | undefined {
  let client: Workspace | undefined;

  try {
    // Built eagerly, so that "this install has no machine identity" is answered before a route needs it
    // rather than as that route's error. The client itself is cheap — it resolves configuration and
    // holds a pool; it does not authenticate until something is asked of it.
    client = getWorkspaceClient({});
  } catch {
    return undefined;
  }

  const built = client;
  return () => Promise.resolve(built);
}
