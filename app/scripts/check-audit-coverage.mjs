#!/usr/bin/env node
// Every route that changes something writes down that somebody tried.
//
// The audit log is the one table whose value comes from what is *not* in it. A reader who finds no
// event for last Tuesday concludes nothing happened last Tuesday, and that conclusion is only sound
// if the app cannot mutate anything without recording the attempt. One route added without an act
// makes every absence in the table meaningless — not for that route, for all of them — and it is the
// kind of omission nothing else here would catch: the feature works, the tests pass, the response is
// correct, and the only symptom is a silence that reads like innocence.
//
// So the rule is structural rather than remembered. A `post`, `put`, `patch` or `delete` handler must
// open an act through the gate, close it on the path that succeeds, and close it on the path that
// throws. All three, because each absence is its own wrong answer: no act at all is the silence
// above, no `performed` is an act that shows as attempted forever, and no `failed` is nine broken
// attempts reading exactly like nobody trying.
//
// The check also refuses an action nobody emits. `AuditAction` is a closed vocabulary so that a
// person can ask the log a question, and a member no route ever writes is a question that returns
// nothing while looking answerable — worse than a missing member, which at least cannot be asked.
//
// What this cannot check is whether the act names the right target, or whether a mutation happens
// somewhere other than an HTTP route. The first is what the route tests are for. The second is why
// the store interfaces are only reachable from `server/api` and the scanner.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const API = join(APP, 'server', 'api');
const EVENT = join(APP, 'server', 'audit', 'event.ts');

const MUTATING = ['post', 'put', 'patch', 'delete'];

/**
 * Route paths that mutate nothing and are deliberately not recorded.
 *
 * Empty, and kept as the place an exemption would have to be argued rather than assumed. A route
 * arriving here needs a sentence saying why the act it performs is not worth a row, and "it only
 * reads" is not that sentence for a `post` — a read somebody had to be permitted to make is
 * exactly what the `draft.read` and `scope.preview` actions exist for.
 */
const UNRECORDED = new Map();

/** Source with strings, template literals and comments blanked, so brace counting is not fooled. */
function skeleton(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const here = text[index];
    const next = text[index + 1];

    if (here === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    if (here === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      // Newlines are kept so a line number computed from an offset stays right.
      out += text.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
      continue;
    }
    if (here === "'" || here === '"' || here === '`') {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text[cursor] === here) break;
        cursor += 1;
      }
      const stop = Math.min(cursor + 1, text.length);
      out += text.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
      continue;
    }

    out += here;
    index += 1;
  }
  return out;
}

/** The text from a `{` to the `}` that closes it, taken from the source rather than the skeleton. */
function block(text, bare, open) {
  let depth = 0;
  for (let index = open; index < bare.length; index += 1) {
    if (bare[index] === '{') depth += 1;
    if (bare[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return undefined;
}

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

/**
 * The body a route registration runs.
 *
 * Two shapes, because both are in use and the second is the one a naive reader misses: `/api/scan`
 * and `/api/scan/scheduled` are both `runScanFor(trigger)`, so a check that only understood an
 * inline arrow would find no act on the two most consequential routes in the app and pass.
 */
function handlerBody(text, bare, after, file) {
  const inline = /^\s*(?:async\s*)?\(/.exec(bare.slice(after));
  if (inline != null) {
    const open = bare.indexOf('{', after + inline[0].length);
    if (open === -1) return undefined;
    return block(text, bare, open);
  }

  const named = /^\s*([A-Za-z_$][\w$]*)/.exec(bare.slice(after));
  if (named == null) return undefined;

  // The declaration in the same module. A handler imported from elsewhere would return undefined
  // here and be reported as unreadable rather than silently passing, which is the right way round.
  const declaration = new RegExp(`\\b(?:const|function)\\s+${named[1]}\\b`).exec(bare);
  if (declaration == null) return undefined;
  const open = bare.indexOf('{', declaration.index);
  if (open === -1) return undefined;
  return { body: block(text, bare, open), through: named[1], file };
}

function apiFiles(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...apiFiles(full));
      continue;
    }
    if (/\.ts$/u.test(entry) && !/\.test\.ts$/u.test(entry)) out.push(full);
  }
  return out;
}

/** The declared vocabulary, read from the declaration rather than restated here. */
function declaredActions(source) {
  const declared = /export const AUDIT_ACTIONS = \[([\s\S]*?)\] as const;/.exec(source);
  if (declared == null) return [];
  return [...declared[1].matchAll(/'([a-z]+(?:\.[a-z]+)+)'/g)].map((match) => match[1]);
}

const actions = declaredActions(readFileSync(EVENT, 'utf8'));
if (actions.length === 0) {
  console.error(
    `check-audit-coverage found no actions in ${relative(APP, EVENT)}, so it proved nothing.\n` +
      '`AUDIT_ACTIONS` moved, or it is no longer a literal array.'
  );
  process.exit(1);
}

const problems = [];
const emitted = new Set();
let routes = 0;

for (const file of apiFiles(API)) {
  const rel = relative(APP, file).split('\\').join('/');
  const text = readFileSync(file, 'utf8');
  const bare = skeleton(text);

  for (const action of actions) {
    if (text.includes(`'${action}'`)) emitted.add(action);
  }

  for (const match of bare.matchAll(/\bapp\.(post|put|patch|delete)\(\s*$|\bapp\.(post|put|patch|delete)\(/g)) {
    const method = match[1] ?? match[2];
    if (!MUTATING.includes(method)) continue;

    const path = /^\s*'([^']*)'/.exec(text.slice(match.index + match[0].length));
    // The path lives in the source, not the skeleton, which blanked it.
    const route = path?.[1];
    if (route == null) continue;

    routes += 1;
    const where = `${rel}:${lineOf(text, match.index)}`;
    const said = UNRECORDED.get(route);
    if (said != null) continue;

    const after = match.index + match[0].length + (path[0].length + 1);
    const found = handlerBody(text, bare, after, rel);
    const body = typeof found === 'string' ? found : found?.body;
    const through = typeof found === 'string' ? undefined : found?.through;

    if (body == null) {
      problems.push({
        where,
        route,
        detail:
          'the handler could not be read, so nothing here establishes that the act is recorded. ' +
          'Either it is registered in a shape this check does not know, or its declaration is in ' +
          'another module.',
      });
      continue;
    }

    const via = through == null ? '' : ` (through \`${through}\`)`;
    if (!/\bpermitted\(/.test(body)) {
      problems.push({
        where,
        route,
        detail: `opens no act${via}: nothing calls \`permitted\`, so a caller changes something and the log says nobody did.`,
      });
      continue;
    }
    if (!/\.performed\(/.test(body)) {
      problems.push({
        where,
        route,
        detail: `never calls \`performed\`${via}: the act is opened and left open, so the log shows it attempted and never done.`,
      });
    }
    if (!/\.failed\(/.test(body)) {
      problems.push({
        where,
        route,
        detail: `never calls \`failed\`${via}: an attempt that got past the gate and broke leaves no row, and nine of them read as nobody trying.`,
      });
    }
  }
}

if (routes === 0) {
  console.error(
    'check-audit-coverage found no mutating route registrations, so it proved nothing.\n' +
      "The registration syntax changed, or the routes moved out of server/api. Expected `app.post('/x', ...)`."
  );
  process.exit(1);
}

const unused = actions.filter((action) => !emitted.has(action));

if (problems.length > 0) {
  console.error(`${problems.length} mutating route(s) do not record the act:\n`);
  for (const { where, route, detail } of problems) console.error(`  ${where}  ${route}\n    ${detail}\n`);
  console.error(
    'A mutation with no event is a hole in the one table whose value comes from what is absent\n' +
      'from it. The shape to follow is `permitted(...)` for the act, `await act.performed(target)`\n' +
      'where it worked, and `await act?.failed(cause)` in the catch — see the handlers in\n' +
      'server/api/routes.ts. A route that genuinely changes nothing goes in UNRECORDED with the\n' +
      'sentence saying why.\n'
  );
  process.exit(1);
}

if (unused.length > 0) {
  console.error(`${unused.length} declared audit action(s) are emitted by no route:\n`);
  for (const action of unused) console.error(`  ${action}`);
  console.error(
    '\nA member of the vocabulary no route writes is a question the log looks able to answer and\n' +
      'always answers with nothing. Either the surface that should emit it is missing, or the\n' +
      'action should not be declared yet.\n'
  );
  process.exit(1);
}

console.log(
  `All ${routes} mutating routes open an act and close it both ways, ` +
    `and all ${actions.length} declared audit actions are emitted.`
);
