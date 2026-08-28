#!/usr/bin/env node
// Every route handler is registered through the containment proxy.
//
// Row 89: the express AppKit serves on is 4.22.2, which lets a rejected async handler reach Node's
// default `unhandledRejection` and terminate the process. One `TypeError` reading one stored scan
// took the app down for every reader on labs, with a hand redeploy to come back. `api/contain.ts`
// wraps handlers at the single point where `registerApi` hands the app to sixteen route modules, so
// the containment cannot be forgotten by whoever adds the eighty-eighth handler.
//
// **What this check holds is not "did you remember the wrapper".** The proxy makes that unforgettable
// for anything registered through `registerApi`. What it holds are the three ways that arrangement
// can still be bypassed, each of which restores the outage silently:
//
//   1. `registerApi` stops applying `contained` to the app it was given.
//   2. A route module builds its own `Router` or `express()` and registers handlers on that, so the
//      handlers never pass through the proxy.
//   3. A second `server.extend` in server.ts registers routes on the raw AppKit app.
//
// All three work in every test, pass review, and take the app down once, in production, on an input
// nobody had. That is the asymmetry `AGENTS.md` asks for: a rule fails the build so it cannot be lost
// under time pressure, and a component opting out quietly is what is being prevented.
//
// What this cannot check is whether the proxy's wrapper is correct — that is `contain.test.ts`, which
// resolves express the way the running app does rather than the way this package declares it.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const API = join(APP, 'server', 'api');
const SERVER = join(APP, 'server', 'server.ts');
const CONTAIN = join(API, 'contain.ts');

const failures = [];

/** Source files under server/api, excluding tests and the containment module itself. */
function routeModules() {
  return readdirSync(API)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'contain.ts')
    .map((name) => join(API, name));
}

// 1. registerApi applies the proxy to the application it is handed, before registering anything.
//
// Read as "the parameter is not called `app`, and something named `app` is assigned from
// `contained(...)`". Checking for the call alone would pass a file that called it and then registered
// on the raw parameter anyway, which is the mistake worth catching: both names in scope, one wrapped.
const routes = readFileSync(join(API, 'routes.ts'), 'utf8');
const signature = /export function registerApi\(\s*(?<parameter>[A-Za-z_][A-Za-z0-9_]*)\s*:/u.exec(routes);

if (signature == null) {
  failures.push('server/api/routes.ts: no `export function registerApi(` found to check.');
} else {
  const parameter = signature.groups.parameter;
  if (parameter === 'app') {
    failures.push(
      "server/api/routes.ts: registerApi's parameter is named `app`, so `app.get(...)` registers on " +
        'the raw application. Name the parameter for what it is — the served app — and assign ' +
        '`const app = contained(served)` from it.'
    );
  }
  if (!new RegExp(String.raw`const app = contained\(${parameter}\)`, 'u').test(routes)) {
    failures.push(
      `server/api/routes.ts: registerApi does not assign \`const app = contained(${parameter})\`. ` +
        'Without it every handler below is registered on express 4 directly, and one rejection ends ' +
        'the process — see server/api/contain.ts.'
    );
  }
}

// 2. No route module builds its own router or application.
//
// A `Router()` is registered on the app by `use`, and the proxy wraps the router itself rather than
// the handlers inside it — so a rejection from one of those handlers is not forwarded. This is the
// bypass that looks most like ordinary express.
for (const file of routeModules()) {
  const source = readFileSync(file, 'utf8');
  const where = relative(APP, file);

  // `import type { Application }` is how every route module names its parameter and is fine. A value
  // import from express is what allows constructing one.
  const valueImport = /^import\s+(?!type\b)[^;]*from\s+'express'/mu.exec(source);
  if (valueImport != null) {
    failures.push(
      `${where}: imports a value from 'express'. Route modules take the app as a parameter and ` +
        'import only types, so every registration passes through the containment proxy.'
    );
  }

  for (const match of source.matchAll(/\b(?<call>Router|express)\s*\(\s*\)/gu)) {
    failures.push(
      `${where}: builds its own \`${match.groups.call}()\`. Handlers registered on it never pass ` +
        'through the containment proxy, so their rejections end the process. Register on the app ' +
        'parameter instead.'
    );
  }
}

// 3. Exactly one server.extend, so no second registration path skips registerApi.
const server = readFileSync(SERVER, 'utf8');
const extensions = [...server.matchAll(/server\.extend\(/gu)].length;
if (extensions !== 1) {
  failures.push(
    `server/server.ts: ${String(extensions)} \`server.extend(\` call(s), expected 1. Every route ` +
      'reaches express through registerApi so that one proxy covers all of them. A second extend is ' +
      'a registration path with no containment on it.'
  );
}

// And the module the whole arrangement rests on is still there.
let contain;
try {
  contain = readFileSync(CONTAIN, 'utf8');
} catch {
  failures.push('server/api/contain.ts is missing, and nothing else forwards a rejected handler.');
}

// The arity branch is load-bearing and not obviously so: express identifies error middleware by
// `length === 4`, so a wrapper that normalised every handler to three parameters would stop the error
// middleware at the end of registerApi from ever being called, while every route test still passed.
if (contain != null && !/handler\.length >= 4/u.test(contain)) {
  failures.push(
    'server/api/contain.ts no longer branches on `handler.length >= 4`. Express recognises error ' +
      'middleware by its arity, so a wrapper that changes it silently disables the error path.'
  );
}

if (failures.length > 0) {
  console.error(`${failures.length} containment problem(s):\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    'Row 89 measured what this prevents: one rejected handler, 502 on every route, app_status\n' +
      'CRASHED with healthy compute, and no self-recovery without a redeploy by hand.\n'
  );
  process.exit(1);
}

const modules = routeModules().length;
console.log(
  `Every handler reaches express through the containment proxy: registerApi wraps once, ` +
    `${String(modules)} route modules register on the app it passes them, and server.ts extends once.`
);
