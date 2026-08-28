#!/usr/bin/env node
// Every in-app link goes somewhere the router serves, with a filter the page it lands on applies.
//
// The path half of this exists because of a link that shipped pointing at `/attestations`, which is
// the *API* path for the answers page. The route is `/answers`. Clicking it did not degrade — React
// Router's default boundary replaced the whole application with "Unexpected Application Error!
// 404 Not Found", losing the shell, the navigation and the way back. On a page whose entire
// purpose is to tell a reader what to do next, the one clickable thing destroyed the app.
//
// Nothing else could have caught it. It typechecks: `to` is a string. It passes lint. It passed
// the component test, because the assertion had been written by reading the component instead of
// the route table, so the test pinned the broken path and would have kept it broken through any
// number of green runs. Only clicking it finds this, and nothing clicks every link.
//
// The query half exists because the drill-through work made the query string load-bearing. A link
// reading "3 critical" now carries `?pillar=security&severity=critical&outcome=unmet`, and a page
// that does not read one of those three serves a list that silently disagrees with the number the
// reader clicked — no error, no 404, just the wrong answer under the right heading. That is a worse
// failure than the 404 above, because nothing about it looks broken. So a named parameter must be
// one the destination page reads, and a literal value must be one it handles.
//
// The route table is the authority for both. Parameterised routes are matched by shape, since
// `/history/:scanId` is served by a link to `/history/abc123`.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTER, declaredRoutes, routerSource as readRouter } from './routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const CLIENT = join(APP, 'client', 'src');

/** Stands in for `${expression}` in a template literal: a value this check cannot read. */
const DYNAMIC = '\u0000';

/**
 * Parameters whose values are a closed vocabulary, and so can be held against the page.
 *
 * The rest name a row or carry free text — `control`, `job`, `pillar`, `principle`, `q` — and their
 * values are catalogue data or whatever somebody typed. Checking those would mean asserting that
 * `?control=IU-01-02` appears somewhere in the findings page's source, which is nonsense: the page
 * handles every control id and knows none of them.
 *
 * A vocabulary parameter missing from this list is only an unchecked one, so the cost of forgetting
 * to add one is a check that proves slightly less, not a build that fails for the wrong reason.
 */
const VOCABULARY = new Set(['outcome', 'severity', 'state', 'standing', 'verdict', 'because']);

/** Which file each imported name comes from, so a route can be followed to the page it renders. */
function importedFrom(source, from) {
  const files = new Map();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    const target = moduleFile(dirname(from), match[2]);
    if (target == null) continue;
    for (const clause of match[1].split(',')) {
      const name = clause.trim().split(/\s+as\s+/u).pop();
      if (name != null && name !== '') files.set(name, target);
    }
  }
  return files;
}

function moduleFile(from, specifier) {
  const base = resolve(from, specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A page's own source plus the modules it imports from the client.
 *
 * One level, because that is where the values live: `ServerlessPage` reads `verdict` and compares it
 * against `VERDICTS`, which is declared in `serverless-language.ts` beside it. Searching only the
 * page would reject `?verdict=blocked` as unhandled, and a check that has to be worked around is a
 * check that gets deleted.
 */
function reachableSource(file) {
  const own = readFileSync(file, 'utf8');
  let text = own;
  for (const target of new Set(importedFrom(own, file).values())) {
    text += `\n${readFileSync(target, 'utf8')}`;
  }
  return text;
}

/**
 * Destinations a link, a redirect or a URL-building helper names.
 *
 * Two passes, and both are needed. The first reads `to=` and `navigate(` directly, which is the only
 * way to catch a path the router does not serve at all — `/attestations` would be invisible to a
 * pass anchored on the route table. The second takes any string whose first segment is a declared
 * route, which is how the template literals and the little `to(outcome)` helpers get seen: those
 * carry the query strings, and before this they were out of reach of a grep for `to="`.
 */
function linkTargets(line, firstSegments) {
  const targets = new Set();

  // to="/x", to='/x', to={'/x'}, to={`/x`}, to: '/x', to: `/x`, navigate('/x'), navigate(`/x`).
  for (const match of line.matchAll(/\b(?:to=\{?|to:\s*|navigate\()\s*(['"`])(\/[^'"`]*)\1/g)) {
    targets.add(normalise(match[2]));
  }

  // Anything route-rooted, wherever it is built. Skipped on comment lines, where a path is prose.
  if (!isComment(line)) {
    for (const match of line.matchAll(/(['"`])(\/[^'"`\s]*)\1/g)) {
      const path = normalise(match[2]);
      const first = path.split('?')[0]?.split('/').filter((part) => part !== '')[0] ?? '';
      if (firstSegments.has(first)) targets.add(path);
    }
  }

  return [...targets];
}

/** `${expression}` becomes a marker, so a path's shape survives without inventing its values. */
function normalise(raw) {
  return raw.replace(/\$\{[^}]*\}/g, DYNAMIC);
}

function isComment(line) {
  return /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line);
}

/** The marker back as source, so a reported destination reads the way it was written. */
function shown(destination) {
  return destination.split(DYNAMIC).join('${…}');
}

/**
 * The route that serves a destination.
 *
 * The query string and the fragment are dropped first: `/findings?outcome=unmeasurable` is served
 * by `/findings`, and a check that compared the whole string would reject every filtered link in
 * the app. Segments beginning `:` match anything non-empty, which is what the router does, and so
 * does a segment the link interpolates.
 */
function served(destination, routes) {
  const path = (destination.split('?')[0] ?? '').split('#')[0] ?? '';
  const wanted = segments(path);

  return routes.find((route) => {
    const pattern = segments(route.path);
    if (pattern.length !== wanted.length) return false;
    return pattern.every((part, index) => part.startsWith(':') || wanted[index] === DYNAMIC || part === wanted[index]);
  });
}

function segments(path) {
  return path.split('/').filter((part) => part !== '');
}

/** The `name=value` pairs a destination carries, with interpolated values left unknown. */
function filters(destination) {
  const query = destination.split('?')[1];
  if (query == null || query === '') return [];

  return query
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      return { name: name ?? '', value: value.includes(DYNAMIC) || value === '' ? undefined : value };
    });
}

function readsParam(source, name) {
  return new RegExp(`(?:searchParams|params)\\.get\\(\\s*['"\`]${name}['"\`]`).test(source);
}

/** A value the page handles appears in its source as a string: in a union, a constant or a compare. */
function handlesValue(source, value) {
  return new RegExp(`['"\`]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(source);
}

function sourceFiles(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/u.test(entry)) out.push(full);
  }
  return out;
}

const routerSource = readRouter();
const routes = declaredRoutes(routerSource);
const pages = importedFrom(routerSource, ROUTER);

if (routes.length === 0) {
  console.error(
    `check-routes found no route declarations in ${relative(APP, ROUTER)}, so it proved nothing.\n` +
      "The router moved, or it no longer declares routes as `path: '/x', element: <Page />`."
  );
  process.exit(1);
}

const firstSegments = new Set(routes.map((route) => segments(route.path)[0] ?? '').filter((part) => part !== ''));
const sources = new Map();

/** A page's searchable source, read once. */
function pageSource(component) {
  const file = pages.get(component);
  if (file == null) return undefined;
  if (!sources.has(file)) sources.set(file, reachableSource(file));
  return sources.get(file);
}

const dead = [];
const ignored = [];
let links = 0;
let checked = 0;

for (const file of sourceFiles(CLIENT)) {
  const rel = relative(APP, file).split('\\').join('/');
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, index) => {
    for (const destination of linkTargets(line, firstSegments)) {
      links += 1;
      const where = `${rel}:${index + 1}`;
      const route = served(destination, routes);
      if (route == null) {
        dead.push({ where, destination });
        continue;
      }

      const source = pageSource(route.component);
      if (source == null) continue;

      for (const { name, value } of filters(destination)) {
        checked += 1;
        if (!readsParam(source, name)) {
          ignored.push({ where, destination, detail: `${route.component} never reads the \`${name}\` parameter` });
          continue;
        }
        if (value != null && VOCABULARY.has(name) && !handlesValue(source, value)) {
          ignored.push({
            where,
            destination,
            detail: `${route.component} reads \`${name}\` but handles no value \`${value}\``,
          });
        }
      }
    }
  });
}

if (links === 0) {
  console.error('check-routes found no in-app links, so it proved nothing. The link syntax changed.');
  process.exit(1);
}

if (dead.length > 0) {
  console.error(`${dead.length} in-app link(s) point at a route the router does not serve:\n`);
  for (const { where, destination } of dead) console.error(`  ${where}\n    ${shown(destination)}\n`);
  console.error(
    `Routes the app serves: ${routes.map((route) => route.path).join(', ')}\n\n` +
      'A dead link here does not degrade. React Router replaces the whole application with its\n' +
      'default 404 boundary, so the reader loses the shell and the navigation along with the page\n' +
      'they wanted. Check the route table rather than the nearest similar-looking string: the API\n' +
      'paths and the route paths are deliberately not the same.\n'
  );
  process.exit(1);
}

if (ignored.length > 0) {
  console.error(`${ignored.length} in-app link(s) carry a filter the destination page ignores:\n`);
  for (const { where, destination, detail } of ignored) {
    console.error(`  ${where}\n    ${shown(destination)}\n    ${detail}\n`);
  }
  console.error(
    'An ignored filter is a silent wrong answer. The reader clicks a number, the page opens\n' +
      'unfiltered or empty, and the list disagrees with the figure that sent them there — with no\n' +
      'error to explain it. Either the page should read the parameter, or the link should not send\n' +
      'one. A union like `outcome=unmet` has to be defined on the page that filters by it.\n'
  );
  process.exit(1);
}

console.log(
  `All ${links} in-app links resolve against ${routes.length} declared routes, ` +
    `and all ${checked} link filters are read by the page they land on.`
);
