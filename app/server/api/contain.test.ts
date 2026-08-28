/**
 * That a failing handler costs one request rather than the process.
 *
 * **The apparatus is the point of this file.** `import express from 'express'` here resolves the
 * app's own declared 5.2.1, and express 5 forwards a rejected handler natively — so a test written
 * that way passes whether or not `contain.ts` exists, and would have passed on the arrangement that
 * took labs down on 2026-08-17. Row 89's own lesson, and `AGENTS.md`'s: a premise replaced by a
 * measurement is only as good as the thing the measurement was taken with.
 *
 * So these tests resolve express the way the running app does — from inside `@databricks/appkit`,
 * which carries its own nested copy — and the first test asserts which major that is. When AppKit
 * moves to express 5 that assertion fails, which is the signal that everything in `contain.ts` has
 * become redundant and can go.
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Server } from 'node:http';
import type { Application, ErrorRequestHandler, Request, Response } from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { contained } from './contain.js';
import { closeServed, servedAt } from './test-servers.js';

const require = createRequire(import.meta.url);

/** The express `createApp` builds on, rather than the one this package declares. */
const appkitRoot = dirname(require.resolve('@databricks/appkit/package.json'));
const expressPath = require.resolve('express', { paths: [appkitRoot] });
const expressVersion = (
  require(require.resolve('express/package.json', { paths: [appkitRoot] })) as { version: string }
).version;

// Typed with the express 5 types this package declares while being the express 4 runtime AppKit
// serves on. That mismatch is the subject of these tests rather than a problem with them: the two
// majors agree on the surface used here, and the version assertion below is what keeps the pairing
// honest if they ever stop agreeing.
const express = require(expressPath) as () => Application;

const servers: Server[] = [];

afterAll(() => closeServed(servers));

/** What a request came back with. */
interface Answer {
  readonly status: number;
  readonly body: string;
}

/**
 * A contained app on a port of its own, and a way to call it.
 *
 * Binding goes through `test-servers.ts` rather than `createServer` here, which
 * `test-servers.test.ts` holds this directory to: a wildcard bind coexists with a specific bind on
 * the same port and loses the traffic to it, and that was invisible across nine files for weeks.
 */
async function serve(build: (app: Application) => void): Promise<(path: string) => Promise<Answer>> {
  const app = contained(express());
  build(app);
  const base = await servedAt(app as never, servers);

  return async (path: string): Promise<Answer> => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.text() };
  };
}

/** A handler that rejects the way the labs outage did — after an await, with nobody owning it. */
function rejects(message: string): () => Promise<never> {
  return async (): Promise<never> => {
    await Promise.resolve();
    throw new Error(message);
  };
}

describe('the express these routes are served on', () => {
  /**
   * Not a test of this app's code. It is the reason the rest of this file exists, and it is written
   * as an assertion so that the day it stops being true is a failing build rather than a discovery.
   */
  it('is express 4, which does not contain a rejected handler', () => {
    expect(expressVersion.startsWith('4.')).toBe(true);
  });
});

describe('contained', () => {
  it('turns a rejecting handler into one failed request', async () => {
    const get = await serve((app) => {
      app.get('/throws', rejects('the fault row 89 measured'));
    });

    expect((await get('/throws')).status).toBe(500);
  });

  /**
   * The assertion that fails against the arrangement this row replaced. Without it, the test above
   * passes on a process that is already dying: the status arrives while the rejection is still
   * unowned, and the death comes after the response.
   */
  it('leaves the app answering the next request', async () => {
    const get = await serve((app) => {
      app.get('/throws', rejects('the fault row 89 measured'));
      app.get('/after', (_request: Request, response: Response) => {
        response.send('still here');
      });
    });

    await get('/throws');

    expect(await get('/after')).toEqual({ status: 200, body: 'still here' });
  });

  it('sends the rejection to error middleware rather than to the default handler', async () => {
    const seen: string[] = [];

    const get = await serve((app) => {
      app.get('/throws', rejects('named for the assertion'));

      // Four parameters, which is how express recognises error middleware. A wrapper that
      // normalised arity would leave this never called while the test above still passed.
      const caught: ErrorRequestHandler = (cause, _request, response, _next) => {
        seen.push(cause instanceof Error ? cause.message : String(cause));
        response.status(503).json({ error: 'caught' });
      };
      app.use(caught);
    });

    expect((await get('/throws')).status).toBe(503);
    expect(seen).toEqual(['named for the assertion']);
  });

  it('carries a synchronous throw down the same path', async () => {
    const get = await serve((app) => {
      app.get('/throws', () => {
        throw new Error('synchronous');
      });
    });

    expect((await get('/throws')).status).toBe(500);
  });

  it('leaves a handler that succeeds alone', async () => {
    const get = await serve((app) => {
      app.get('/fine', async (_request: Request, response: Response) => {
        await Promise.resolve();
        response.json({ ok: true });
      });
    });

    const { status, body } = await get('/fine');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });
  });

  /**
   * `app.get('etag')` reads a setting rather than registering a route, and shares its name with the
   * verb. The proxy has to leave it alone, or every `app.get` with one argument would be treated as
   * a registration and return the wrong thing.
   */
  it('still reads a setting through the method that shares its name', () => {
    const app = contained(express());
    app.set('etag', 'strong');
    expect(app.get('etag')).toBe('strong');
  });
});
