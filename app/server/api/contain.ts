/**
 * Forward a rejected route handler to express's error path, because the express serving these
 * routes does not do it.
 *
 * This app declares `express` 5.2.1, and under express 5 a rejected async handler becomes a 500 on
 * one request. That is not the express these routes run on. `@databricks/appkit` carries its own
 * nested `express` at 4.22.2 and `createApp` comes from AppKit, so the object routes are registered
 * on is express **4**, which lets a rejected promise reach Node's default `unhandledRejection` —
 * and that terminates the process. Measured on labs on 2026-08-17: one `TypeError` reading one
 * stored scan took the whole app down for every reader, 502 on every route, no self-recovery, and a
 * hand redeploy to come back. Row 89 records it.
 *
 * **If AppKit ever serves on express 5, everything here becomes redundant.** Deleting it then is
 * correct. Deleting it before then is not, and the reason is not visible from the app's own
 * `package.json`, which names the version that would have contained this. `contain.test.ts` asserts
 * which major AppKit actually resolves, so that day announces itself rather than being noticed.
 *
 * Forcing express 5 with an `overrides` entry was tried first and is the cheaper fix if it ever
 * works: it resolved, passed all of `npm run verify`, and then the app would not boot, because
 * `path-to-regexp` 8 rejects the bare `'*'` route AppKit registers for its SPA catch-all.
 */
import type { Application } from 'express';

/**
 * The methods on an express application that take route handlers.
 *
 * `use` and `all` are here with the verbs because middleware faults are handler faults — the app's
 * `nosniff` middleware and its error middleware both arrive through `use`. `head` and `options` are
 * here because express registers them, not because this app uses them today: a method left out is a
 * registration path with no containment on it, and the omission would be invisible.
 */
export const ROUTING_METHODS = [
  'use',
  'all',
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;

/**
 * Anything express will accept as a handler.
 *
 * Deliberately loose. This wrapper's whole job is to be indifferent to a handler's signature, and a
 * type that described the four express shapes precisely would need a cast at every call below to
 * get back to the one thing being done to all of them.
 */
type Handler = (...args: unknown[]) => unknown;

/** Whether a property name is one of the routing methods above. */
function isRoutingMethod(property: string | symbol): boolean {
  return typeof property === 'string' && (ROUTING_METHODS as readonly string[]).includes(property);
}

/**
 * Run a handler and send anything it throws or rejects with to `next`.
 *
 * Both paths, because the two failures are not the same one. A synchronous throw is already caught
 * by express 4 and would reach the error path without help; a rejection is not, and is the one that
 * ends the process. Catching both means the wrapper does not have to know which kind of function it
 * was given.
 */
function settle(call: () => unknown, next: unknown): unknown {
  const forward = (cause: unknown): void => {
    // No `next` to forward to means this is not a route fault at all — express always passes one.
    // Rethrowing puts it where it would have gone anyway, which is the process handler in server.ts,
    // rather than swallowing it into a request that then hangs.
    if (typeof next !== 'function') throw cause;
    (next as (cause: unknown) => void)(cause);
  };

  try {
    const result = call();
    // `instanceof Promise` rather than a thenable check: an async function returns a native promise,
    // and a duck-typed `then` here would wrap objects that routes legitimately return.
    if (result instanceof Promise) {
      return result.catch(forward);
    }
    return result;
  } catch (cause) {
    forward(cause);
    return undefined;
  }
}

/**
 * One handler, wrapped.
 *
 * The arity is preserved because express reads it: a function of four parameters is error
 * middleware and anything else is a route handler, so a wrapper that normalised every handler to
 * three parameters would silently stop the error middleware below from ever being called.
 */
function contain(handler: Handler): Handler {
  if (handler.length >= 4) {
    return function contained(
      error: unknown,
      request: unknown,
      response: unknown,
      next: unknown
    ): unknown {
      return settle(() => handler(error, request, response, next), next);
    };
  }

  // Three parameters regardless of what the handler declares, because express passes `next` whether
  // or not the handler asked for it — which is what lets a two-parameter handler's rejection be
  // forwarded rather than lost.
  return function contained(request: unknown, response: unknown, next: unknown): unknown {
    return settle(() => handler(request, response, next), next);
  };
}

/** A handler, an array of handlers, or something that is neither — a path, a regexp, a setting. */
function containArgument(argument: unknown): unknown {
  if (typeof argument === 'function') return contain(argument as Handler);
  if (Array.isArray(argument)) return argument.map(containArgument);
  return argument;
}

/**
 * The same express application, with every handler registered through it contained.
 *
 * A proxy rather than 87 hand edits. The point is not brevity: a wrapper applied by hand is a thing
 * the next handler can be added without, it works in every test, and it takes the app down once, in
 * production, on an input nobody had. Applied here, a new route cannot opt out by being forgotten —
 * and `check-contained-handlers.mjs` holds the two ways it could still be bypassed, which are a
 * route module building its own `Router` and a second `server.extend` that skips this function.
 *
 * Non-routing members pass through untouched, including `app.get('etag')` reading a setting rather
 * than registering a route — that call has no function argument, so there is nothing to wrap.
 */
export function contained(app: Application): Application {
  return new Proxy(app, {
    get(target, property): unknown {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function' || !isRoutingMethod(property)) return value;

      const method = value as Handler;
      return function registerContained(...args: unknown[]): unknown {
        return Reflect.apply(method, target, args.map(containArgument));
      };
    },
  });
}
