// The route table, read from the router, for every check that needs to know what the app serves.
//
// Two checks need it and they need it for opposite reasons. `check-routes.mjs` asks whether every link
// lands on a route that exists; `drive-labs.mjs` asks whether every route that exists has been opened.
// A list in either file would be a second copy of the table, and a copy can drift from the thing it
// copies — which is how `/jobs` came to ship without the served-app sweep ever loading it, and how the
// sweep went on reporting that every page rendered.
//
// So the table is read, once, here.
//
// The layout and accessibility sweeps kept their own arrays anyway, because each row carries something
// the table cannot hold — a name for the screenshot, a `tall` flag for the printable report, a query
// string for a view that shares a route with another. Those arrays drifted exactly as this file's own
// comment predicted: on 2026-08-13 the accessibility sweep was checking twenty-two of thirty-one served
// routes and reporting that it "renders every route", with `/warehouses`, `/jobs`, `/exceptions` and
// `/improvements` among the nine it had never opened. `coverageProblems` is the answer to that — the
// arrays stay, because the metadata is real, and the router decides whether they are complete.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the router is, so a caller does not have to know the client's layout. */
export const ROUTER = join(HERE, '..', 'client', 'src', 'App.tsx');

export function routerSource() {
  if (!existsSync(ROUTER)) throw new Error(`No router at ${ROUTER}`);
  return readFileSync(ROUTER, 'utf8');
}

/**
 * The declared routes and the page each one renders, read from the router rather than restated here.
 *
 * A list in a check would be a second copy of the route table, and a check whose copy of the truth can
 * drift from the truth is worse than no check: it would pass a link to a route that had been renamed,
 * which is the exact failure `check-routes.mjs` exists to catch.
 */
export function declaredRoutes(source) {
  const eager = [...source.matchAll(/path:\s*'([^']+)'\s*,\s*element:\s*<(\w+)/g)].map((match) => ({
    path: match[1],
    component: match[2],
  }));

  /*
   * Lazily-declared routes count too.
   *
   * Development galleries and acceptance previews are lazy so they stay outside the production bundle.
   * To a check anchored on `element:` they would not exist, so a route the router serves still counts
   * whichever way it names its component.
   */
  const lazy = [...source.matchAll(/path:\s*'([^']+)'\s*,\s*\n?\s*lazy:[\s\S]*?import\('([^']+)'\)/g)].map((match) => ({
    path: match[1],
    component: match[2].split('/').pop() ?? match[2],
  }));

  return [...eager, ...lazy];
}

/**
 * Routes guarded by Vite's development constant, and therefore absent from the production bundle.
 *
 * Reading the guard matters as much as reading the route objects. A production drive used to count
 * `/design-system` and `/preview/acceptance` as served because the source parser saw their objects while
 * the built router did not; both URLs reached the catch-all, painted a healthy panel and passed as the
 * pages the production app had deliberately excluded.
 */
export function developmentOnlyRoutes(source) {
  const guarded = [...source.matchAll(/const\s+\w+\s*=\s*import\.meta\.env\.DEV\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[\];/g)];
  return guarded.flatMap((match) => declaredRoutes(match[1] ?? ''));
}

/** Routes the production router can actually serve. */
export function productionRoutes(source) {
  const development = new Set(developmentOnlyRoutes(source).map(({ path }) => path));
  return declaredRoutes(source).filter(({ path }) => !development.has(path));
}

/** A route with a `:param` in it, which cannot be visited without an instance to put there. */
export const isParameterised = (path) => path.includes(':');

/**
 * Stable diagnostic filename for one route pattern.
 *
 * `/` used to be called `overview`, which is also the name of `/overview`. The second visit silently
 * replaced the first screenshot and the route drive still reported both as covered. A filename is
 * release evidence here, so its identity must be as exact as the route identity it records.
 */
export function routeScreenshotName(path) {
  if (path === '/') return 'landing';
  if (path === '*') return 'not-found';
  return path.slice(1).replace(/[/:]/g, '-');
}

/** Any diagnostic screenshot name claimed by more than one route. */
export function screenshotNameProblems(paths) {
  const byName = new Map();
  for (const path of paths) {
    const name = routeScreenshotName(path);
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  return [...byName.entries()]
    .filter(([, routes]) => routes.length > 1)
    .map(([name, routes]) => `${routes.join(', ')} all write ${name}.png.`);
}

/**
 * The pattern a parameterised route matches, so a link can be recognised as an instance of it.
 *
 * `/history/:scanId` is served by `/history/abc123`, and one segment is all a parameter takes — a
 * pattern of `.*` would let `/history/abc/def` stand in for a route that does not serve it.
 */
export function routePattern(path) {
  const source = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

/**
 * Which served routes a sweep's own list of paths leaves out.
 *
 * For the sweeps that cannot generate their list, because each row carries a name, a flag or a query
 * string the router does not know about. They keep the list; this decides whether it covers the app.
 *
 * A route counts as covered when a swept path matches it — so `/pillars/security-compliance-and-privacy`
 * covers `/pillars/:pillarId`, which is how the one parameterised route with a fixed instance was
 * already being handled. Anything else has to be named in `exempt` with a reason, and the reason is the
 * point: `/history/:scanId` needs a run that exists, which a sweep of static paths cannot conjure, and
 * that is a different fact about the check from nobody having thought about it. A route in neither is
 * what fails.
 *
 * Returns sentences, so a caller reports them the way it reports its own failures.
 */
export function coverageProblems(
  swept,
  { exempt = new Map(), what = 'swept', routes = declaredRoutes(routerSource()) } = {}
) {
  const paths = [...swept].map((one) => (typeof one === 'string' ? one : one.path));
  const bare = paths.map((path) => path.split('?')[0]);
  const problems = [];

  for (const { path } of routes) {
    if (path === '*' || exempt.has(path)) continue;
    if (bare.some((candidate) => routePattern(path).test(candidate))) continue;
    problems.push(
      `The router serves ${path} and it is not ${what}. Add it, or name it with the reason it cannot be — ` +
        'a sweep that reports on every route has to have opened every route.'
    );
  }

  // The other direction, so an exemption outlives the route it was written for and says so. A stale
  // reason reads as a considered decision about the app as it is now, and it is the opposite.
  for (const path of exempt.keys()) {
    if (!routes.some((route) => route.path === path)) {
      problems.push(`${path} is exempted from being ${what}, and the router no longer serves it. Drop the exemption.`);
    }
  }

  return problems;
}
