/*
 * The two properties that stop the flake described in `test-servers.ts` coming back.
 *
 * Both are here rather than in a check script because neither needs one: the first is a behaviour, so a
 * test can demand it, and the second is a fact about this directory that a test can read as easily as a
 * script could — and unlike a script, it is already in CI.
 */
import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

describe('a server a route test is given', () => {
  it('owns the address its URL names, so nothing else can answer for it', async () => {
    // The property, stated as the thing that was actually wrong: a wildcard bind coexists with a
    // specific bind on the same port and loses the traffic to it. Asserting the URL's shape would not
    // catch that — the URL said 127.0.0.1 all along, while the socket was listening on `::`. So the
    // assertion is that the loopback port is genuinely taken, which only an owned socket makes true.
    const base = await servedAt((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"mine":true}');
    }, servers);

    const port = Number(new URL(base).port);
    const intruder = createServer(() => undefined);
    const refused = await new Promise<string>((resolve) => {
      intruder.once('error', (error: NodeJS.ErrnoException) => resolve(String(error.code)));
      intruder.once('listening', () => {
        intruder.close();
        resolve('bound anyway');
      });
      intruder.listen(port, '127.0.0.1');
    });

    expect(refused).toBe('EADDRINUSE');
  });

  it('answers the fetch the test makes, which is the whole point of the above', async () => {
    const base = await servedAt((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"mine":true}');
    }, servers);

    expect(await (await fetch(`${base}/anything`)).json()).toEqual({ mine: true });
  });

  it('is handed out on a port of its own', async () => {
    const app = (_request: unknown, response: { end: () => void }) => response.end();
    const ports = await Promise.all(
      [1, 2, 3].map(async () => new URL(await servedAt(app as never, servers)).port)
    );

    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe('the route tests in this directory', () => {
  it('let this file do the binding, so the address cannot be forgotten again', () => {
    // A grep, and deliberately a blunt one. The fault it guards against was invisible for weeks in nine
    // files that each looked reasonable on their own, and the only durable defence is that there is one
    // place where a port is bound. A file that needs something this helper does not do should widen the
    // helper.
    const here = dirname(fileURLToPath(import.meta.url));
    const own = new Set(['test-servers.ts', 'test-servers.test.ts']);

    const binding = readdirSync(here)
      .filter((name) => name.endsWith('.test.ts') && !own.has(name))
      .filter((name) => /\.listen\(/.test(readFileSync(join(here, name), 'utf8')));

    expect(binding).toEqual([]);
  });

  it('closes what they opened, so nothing outlives the file that made it', () => {
    const here = dirname(fileURLToPath(import.meta.url));

    const opening = readdirSync(here).filter(
      (name) =>
        name.endsWith('.test.ts') &&
        name !== 'test-servers.test.ts' &&
        /\bservedAt\(/.test(readFileSync(join(here, name), 'utf8'))
    );

    for (const name of opening) {
      expect(readFileSync(join(here, name), 'utf8'), name).toContain('closeServed(servers)');
    }
    // A guard on the guard: if the helper is ever renamed and this stops matching anything, the loop
    // above passes by vacuity and says nothing.
    expect(opening.length).toBeGreaterThan(10);
  });
});