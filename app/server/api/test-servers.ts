// Opening and letting go of a route test's servers.
//
// Every route test in this directory binds a real server, because what those tests are for is the part
// only HTTP can get wrong: status codes, headers, what a body looks like on the wire. Thirteen files
// each grew their own three lines for starting one and their own `afterAll` for stopping it, and the
// starting lines had a bug in nine of them.
//
// # Why the address is named, and not left to Node
//
// `server.listen(0)` binds the wildcard address — `::`, dual-stack — and the tests then fetch
// `http://127.0.0.1:<port>`. Those are not the same socket, and the difference is not academic: a
// wildcard bind does not conflict with an existing bind on a specific address, so the OS will hand
// `listen(0)` a port that something else already holds on `127.0.0.1`, report no error, and route
// every connection arriving on the IPv4 loopback to the *more specific* socket. The test's server is
// listening on a port it does not own for the address the test is calling, and never sees the request.
//
// On this project it was Google Chrome, which keeps a shifting set of `127.0.0.1` listeners for its own
// internal services, in the same ephemeral range. Its unmatched-route answer is `404` with
// `content-length: 0` and `content-type: text/html` — no `date`, no `connection`, no `x-powered-by`,
// because it is not Node and not Express. Read through `await response.json()` that is
// `SyntaxError: Unexpected end of JSON input`; read through a test that indexes the parsed body it is
// `Cannot read properties of undefined`; and when it lands on a route whose absence is meaningful it is
// a bare 404 where a 200 was expected. All three were seen, all three were filed as separate flakes,
// and none of them pointed here.
//
// So the port is asked for on the address the tests actually call. That makes the collision impossible
// rather than unlikely: an explicit `127.0.0.1` bind on a port already held there fails with
// `EADDRINUSE`, so the OS's own allocator will not offer one, and a genuine conflict becomes a loud
// error at startup instead of a wrong answer three assertions later.
//
// The evidence, since the previous explanation in this file was confident and wrong. Instrumenting
// every request in every worker showed the anomalous answers arriving on ports this process had bound,
// carrying headers no Node server sends; `lsof` showed Chrome holding those exact ports; and a
// standalone reproduction binds a specific socket, binds the wildcard on the same port without error,
// and watches the specific socket answer. There is also a natural experiment in the tests' own history:
// four of the thirteen files already named `127.0.0.1`, and those four are the only four that never
// produced one of these flakes.
//
// # Why the connections are cut and not just the listener
//
// `server.close()` stops a server accepting new connections and leaves the ones it has, which is right
// for a production server — in-flight requests should finish — and wrong here, where nothing should
// outlive the file that opened it. `closeAllConnections` cuts them.
//
// That much was worth keeping from the first attempt at this file, which reached for it as a fix for
// the flakes above and did not get one: the rate moved, which is what a change with no bearing on an
// intermittent fault looks like when it is measured across a few dozen runs. Cutting connections on the
// way out is good hygiene and was never the bug.

import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The address these tests call, and therefore the address they bind.
 *
 * Named once so the two cannot drift apart, which is the whole fault described above.
 */
const LOOPBACK = '127.0.0.1';

/**
 * Start `app` on a port of its own and answer with the base URL to call it on.
 *
 * Pass the file's own `servers` list; the server is added to it, so `closeServed` in `afterAll` is all
 * the teardown a file needs.
 */
export async function servedAt(app: RequestListener, opened: Server[]): Promise<string> {
  const server = createServer(app);
  opened.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK, resolve);
  });
  return `http://${LOOPBACK}:${String((server.address() as AddressInfo).port)}`;
}

/**
 * Close every server a test file opened, and every connection into them.
 *
 * Call from `afterAll`, passing the file's own list. Stops listening first so nothing new arrives,
 * then cuts what is already connected.
 *
 * Empties the list, so a file that closes twice does not report the same server twice.
 */
export async function closeServed(servers: Server[]): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error != null) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        })
    )
  );
}
