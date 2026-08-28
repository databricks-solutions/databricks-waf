// The SDK client the REST collector calls through, built from whoever the scan runs as.
//
// The identity question is settled here and nowhere else. REST checks read the
// workspace's security configuration — token policies, admin protections, init scripts,
// secret scopes — and the temptation is to read them as the app's own service principal,
// because a service principal can be granted admin once and then always works. That
// would make the app a privilege escalation route: any user who can open it would see
// the workspace's security posture through admin eyes, and a finding would describe an
// estate the reader has no right to see. So the client is built from the scan's
// credentials, which under on-behalf-of are the signed-in user's, and a check the user
// may not perform reports as unmeasurable rather than being answered by a stronger
// identity.
//
// Built per scan rather than per call, since the SDK holds a connection pool and
// re-creating it per request would discard it. The token is fetched once per client
// because a scan is short compared with token lifetime; the credential provider is the
// thing that knows about refresh, and it is asked again on the next scan.

import { WorkspaceClient } from '@databricks/sdk-experimental';
import type { CredentialProvider } from '../credentials.js';

export type WorkspaceClientFactory = () => Promise<WorkspaceClient>;

/**
 * A factory that builds the client once and hands the same one to every probe.
 *
 * Not eager, because a scan that collects no REST signals should not mint a token or
 * open a pool for nothing.
 */
export function clientFor(credentials: CredentialProvider): WorkspaceClientFactory {
  let client: Promise<WorkspaceClient> | undefined;

  return () => {
    client ??= build(credentials);
    return client;
  };
}

async function build(credentials: CredentialProvider): Promise<WorkspaceClient> {
  const identity = await credentials.databricks();
  const token = await identity.token();

  return new WorkspaceClient({
    host: identity.host,
    token,
    // Named explicitly because the SDK otherwise walks its own resolution chain —
    // environment variables, then the CLI config file, then the metadata service. In the
    // Apps container that chain ends at the app's own service principal credentials,
    // which are present in the environment. A typo in the host or token above would
    // therefore not fail: it would silently succeed as the wrong identity, and every
    // finding would describe more of the estate than the signed-in user may see.
    authType: 'pat',
  });
}
