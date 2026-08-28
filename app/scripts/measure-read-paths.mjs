// The read paths 42c reworks, counted from the TypeScript that issues them.
//
// `56` exists because the first attempt at this count published no apparatus, so its total could not
// be reproduced and three of its structural claims were wrong. This file is that apparatus: it parses
// with the TypeScript compiler, so a comment that mentions `select` is not a read, and it reports the
// reads it cannot place rather than dropping them.
//
// The population is `RESET_TABLES` in `server/admin/reset.ts` — the eleven `scoped` tables and the
// `by-parent` tables that reach them. Restating that list here is how it would drift from `42b`.
//
//   node scripts/measure-read-paths.mjs              write the recording
//   node scripts/measure-read-paths.mjs --publish    rewrite the figure table in docs/plan/56-read-paths.md
//   node scripts/measure-read-paths.mjs --check      fail if either is stale
//
// `--check` is what `npm run verify` runs. `52` will generalise this shape; until it lands, this
// measurement holds its own table.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..');
const RESET = join(APP, 'server', 'admin', 'reset.ts');
const SERVER = join(APP, 'server');
const RECORDING = join(HERE, 'recordings', 'read-paths.json');
const DOC = join(ROOT, 'docs', 'plan', '56-read-paths.md');

const START = '<!-- generated: read-path census. Run `node app/scripts/measure-read-paths.mjs --publish`. -->';
const END = '<!-- end generated -->';

/** Sentinel standing in for a template interpolation, so the SQL tokenizer can see the hole. */
const HOLE = '\u0000';

/**
 * @typedef {{ readonly scoped: readonly string[]; readonly byParent: readonly { readonly table: string; readonly parent: string }[] }} Population
 * @typedef {{
 *   readonly file: string;
 *   readonly line: number;
 *   readonly table: string | null;
 *   readonly class: 'scoped' | 'by-parent' | null;
 *   readonly shape: 'predicate' | 'join' | 'unclassified';
 *   readonly alreadyFiltersDefinition: boolean;
 *   readonly reason: string | null;
 *   readonly sql: string;
 * }} Read
 * @typedef {{
 *   readonly measuredAt: string;
 *   readonly source: string;
 *   readonly population: Population;
 *   readonly reads: readonly Read[];
 *   readonly totals: {
 *     readonly reads: number;
 *     readonly predicate: number;
 *     readonly join: number;
 *     readonly unclassified: number;
 *     readonly alreadyFiltersDefinition: number;
 *     readonly byTable: Readonly<Record<string, number>>;
 *   };
 * }} Census
 */

export { RECORDING, DOC };

/**
 * The scoped and by-parent tables declared on `RESET_TABLES`.
 *
 * Parsed from the TypeScript, not imported, so a test can hand a fixture and so a comment inside
 * the array cannot become a table.
 *
 * @param {string} source
 * @returns {Population}
 */
export function populationFromReset(source) {
  const file = ts.createSourceFile('reset.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {Population | null} */
  let found = null;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'RESET_TABLES') {
      const array = arrayOf(node.initializer);
      if (array == null) throw new Error('RESET_TABLES was not found as an array, so the population cannot be read.');
      found = tablesFrom(array, file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (found == null) throw new Error('RESET_TABLES was not found as an array, so the population cannot be read.');
  return found;
}

/**
 * Every SELECT of a population table in one TypeScript file, plus the SELECTs whose table cannot be
 * named.
 *
 * @param {string} source
 * @param {string} file
 * @param {Population} population
 * @returns {readonly Read[]}
 */
export function readsFromSource(source, file, population) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const named = new Map();
  for (const table of population.scoped) named.set(table, 'scoped');
  for (const one of population.byParent) named.set(one.table, 'by-parent');

  /** @type {Read[]} */
  const reads = [];
  function visit(node) {
    if (isSqlRoot(node)) {
      const flattened = flattenSql(node);
      if (flattened != null) {
        const read = classify(flattened, file, sf, node, named);
        if (read != null) reads.push(read);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return reads;
}

/**
 * Walk `app/server` excluding tests, against the committed `RESET_TABLES`.
 *
 * @returns {Omit<Census, 'measuredAt'> & { measuredAt?: string }}
 */
export function measure() {
  const population = populationFromReset(readFileSync(RESET, 'utf8'));
  /** @type {Read[]} */
  const reads = [];
  for (const file of serverFiles(SERVER)) {
    const rel = relative(APP, file).split('\\').join('/');
    reads.push(...readsFromSource(readFileSync(file, 'utf8'), rel, population));
  }
  reads.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || (a.table ?? '').localeCompare(b.table ?? ''));
  return {
    source: 'app/server/**/*.ts excluding tests',
    population,
    reads,
    totals: totalsOf(reads),
  };
}

function totalsOf(reads) {
  /** @type {Record<string, number>} */
  const byTable = {};
  let predicate = 0;
  let join = 0;
  let unclassified = 0;
  let alreadyFiltersDefinition = 0;
  for (const read of reads) {
    if (read.shape === 'predicate') predicate += 1;
    else if (read.shape === 'join') join += 1;
    else unclassified += 1;
    if (read.alreadyFiltersDefinition) alreadyFiltersDefinition += 1;
    if (read.table != null) byTable[read.table] = (byTable[read.table] ?? 0) + 1;
  }
  const ordered = Object.fromEntries(Object.entries(byTable).sort(([a], [b]) => a.localeCompare(b)));
  return {
    reads: reads.length,
    predicate,
    join,
    unclassified,
    alreadyFiltersDefinition,
    byTable: ordered,
  };
}

function arrayOf(node) {
  if (node == null) return null;
  const inner = unwrap(node);
  return ts.isArrayLiteralExpression(inner) ? inner : null;
}

function tablesFrom(array, file) {
  /** @type {string[]} */
  const scoped = [];
  /** @type {{ table: string; parent: string }[]} */
  const byParent = [];
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const table = stringProp(element, 'table', file);
    const context = prop(element, 'context');
    if (table == null || context == null || !ts.isObjectLiteralExpression(context)) continue;
    const kind = stringProp(context, 'kind', file);
    if (kind === 'scoped') scoped.push(table);
    else if (kind === 'by-parent') {
      const parent = stringProp(context, 'parent', file);
      if (parent == null) throw new Error(`RESET_TABLES entry ${table} is by-parent and names no parent.`);
      byParent.push({ table, parent });
    }
  }
  return { scoped, byParent };
}

function prop(object, name) {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === name) {
      return member.initializer;
    }
  }
  return undefined;
}

function stringProp(object, name, file) {
  const value = prop(object, name);
  if (value == null) return undefined;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  throw new Error(`RESET_TABLES field ${name} is not a string literal in ${file.fileName}.`);
}

function isSqlRoot(node) {
  if (!isStringy(node) && !isConcat(node)) return false;
  const parent = node.parent;
  if (parent == null) return true;
  if (ts.isParenthesizedExpression(parent)) return false;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return false;
  return true;
}

function isStringy(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}

function isConcat(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (isStringyOrConcat(node.left) || isStringyOrConcat(node.right))
  );
}

function isStringyOrConcat(node) {
  const inner = unwrap(node);
  return isStringy(inner) || isConcat(inner);
}

function unwrap(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) current = current.expression;
  return current;
}

/**
 * @returns {{ sql: string } | null}
 */
function flattenSql(node) {
  const parts = [];
  if (!collect(unwrap(node), parts)) return null;
  const sql = parts.join('');
  if (!/^\s*select\b/i.test(sql.replaceAll(HOLE, ' '))) return null;
  return { sql };
}

function collect(node, parts) {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    parts.push(inner.text);
    return true;
  }
  if (ts.isTemplateExpression(inner)) {
    parts.push(inner.head.text);
    for (const span of inner.templateSpans) {
      parts.push(HOLE);
      parts.push(span.literal.text);
    }
    return true;
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return collect(inner.left, parts) && collect(inner.right, parts);
  }
  return false;
}

function classify(flattened, file, sf, node, named) {
  const tables = tablesIn(flattened.sql);
  const alreadyFiltersDefinition = filtersDefinition(flattened.sql);
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const sql = preview(flattened.sql);

  if (tables.dynamic) {
    return {
      file,
      line,
      table: null,
      class: null,
      shape: 'unclassified',
      alreadyFiltersDefinition,
      reason: 'dynamic table interpolation',
      sql,
    };
  }

  const inPopulation = tables.names.filter((name) => named.has(name));
  if (inPopulation.length === 0) return null;

  const join = inPopulation.some((name) => named.get(name) === 'by-parent');
  const table = join
    ? inPopulation.find((name) => named.get(name) === 'by-parent')
    : inPopulation[0];
  return {
    file,
    line,
    table,
    class: named.get(table) ?? null,
    shape: join ? 'join' : 'predicate',
    alreadyFiltersDefinition,
    reason: null,
    sql,
  };
}

/** True only when `definition_id` is a predicate, not merely a selected column. */
function filtersDefinition(sql) {
  const text = sql.replaceAll(HOLE, ' ');
  return /\bwhere\b[\s\S]*\bdefinition_id\b/i.test(text) || /\bon\b[\s\S]*\bdefinition_id\b/i.test(text);
}

function tablesIn(sql) {
  const tokens = tokenise(sql);
  /** @type {string[]} */
  const names = [];
  let dynamic = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'word') continue;
    if (token.value !== 'from' && token.value !== 'join') continue;
    const relation = relationAfter(tokens, i + 1);
    if (relation.dynamic) dynamic = true;
    if (relation.name != null) names.push(relation.name);
  }
  return { names, dynamic };
}

const CLAUSE = new Set([
  'where',
  'order',
  'group',
  'limit',
  'having',
  'union',
  'except',
  'intersect',
  'returning',
  'on',
  'set',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'as',
  'using',
]);

function relationAfter(tokens, start) {
  let i = start;
  while (
    i < tokens.length &&
    tokens[i].kind === 'word' &&
    (tokens[i].value === 'only' ||
      tokens[i].value === 'inner' ||
      tokens[i].value === 'left' ||
      tokens[i].value === 'right' ||
      tokens[i].value === 'outer' ||
      tokens[i].value === 'cross')
  ) {
    i += 1;
  }
  let sawHole = false;
  let name = null;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === 'hole') {
      sawHole = true;
      i += 1;
      continue;
    }
    if (token.kind === 'punct' && token.value === '.') {
      i += 1;
      continue;
    }
    if (token.kind === 'word' && CLAUSE.has(token.value)) break;
    if (token.kind === 'word') {
      name = token.value;
      break;
    }
    break;
  }
  if (name == null && sawHole) return { name: null, dynamic: true };
  return { name, dynamic: false };
}

function tokenise(sql) {
  const text = sql;
  /** @type {{ kind: 'word' | 'punct' | 'hole'; value: string }[]} */
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === HOLE) {
      tokens.push({ kind: 'hole', value: '' });
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      tokens.push({ kind: 'word', value: text.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

function preview(sql) {
  return sql.replaceAll(HOLE, '${}').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function serverFiles(root) {
  /** @type {string[]} */
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.live.test.ts')) continue;
      files.push(path);
    }
  }
  walk(root);
  return files.sort();
}

function figureTable(census) {
  const pop = new Set([...census.population.scoped, ...census.population.byParent.map((one) => one.table)]);
  const classOf = new Map();
  for (const table of census.population.scoped) classOf.set(table, 'scoped');
  for (const one of census.population.byParent) classOf.set(one.table, 'by-parent');

  const lines = [
    START,
    '',
    `Recording: [\`app/scripts/recordings/read-paths.json\`](../../app/scripts/recordings/read-paths.json), measured ${census.measuredAt}.`,
    `Source: \`${census.source}\`. Population: \`RESET_TABLES\` — ${String(census.population.scoped.length)} scoped, ${String(census.population.byParent.length)} by-parent.`,
    '',
    '| Table | Class | Reads | Already filters `definition_id` | Shape |',
    '| --- | --- | ---: | ---: | --- |',
  ];

  const tables = [...pop].sort();
  for (const table of tables) {
    const ofTable = census.reads.filter((read) => read.table === table);
    const filtered = ofTable.filter((read) => read.alreadyFiltersDefinition).length;
    const shape = classOf.get(table) === 'by-parent' ? 'join' : 'predicate';
    lines.push(
      `| \`${table}\` | ${classOf.get(table)} | ${String(ofTable.length)} | ${String(filtered)} | ${shape} |`
    );
  }
  lines.push(
    `| **Total** | | **${String(census.totals.reads)}** | **${String(census.totals.alreadyFiltersDefinition)}** | predicate ${String(census.totals.predicate)}, join ${String(census.totals.join)}, unclassified ${String(census.totals.unclassified)} |`
  );
  lines.push('');

  const unclassified = census.reads.filter((read) => read.shape === 'unclassified');
  if (unclassified.length > 0) {
    lines.push('| Unclassified read | Line | Reason |');
    lines.push('| --- | ---: | --- |');
    for (const read of unclassified) {
      lines.push(`| \`${read.file}\` | ${String(read.line)} | ${read.reason ?? 'unclassified'} |`);
    }
    lines.push('');
  }
  lines.push(END);
  return `${lines.join('\n')}\n`;
}

function replaceBlock(doc, block) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`docs/plan/56-read-paths.md is missing the generated-table markers ${START}`);
  }
  return `${doc.slice(0, start)}${block}${doc.slice(end + END.length).replace(/^\n/, '')}`;
}

function writeRecording(census) {
  mkdirSync(dirname(RECORDING), { recursive: true });
  writeFileSync(RECORDING, `${JSON.stringify(census, null, 2)}\n`);
}

function publish(census) {
  if (!existsSync(DOC)) throw new Error(`No plan file at ${DOC}`);
  const next = replaceBlock(readFileSync(DOC, 'utf8'), figureTable(census));
  writeFileSync(DOC, next);
}

function check(census) {
  if (!existsSync(RECORDING)) throw new Error(`No recording at ${RECORDING}; run without --check first.`);
  const recorded = JSON.parse(readFileSync(RECORDING, 'utf8'));
  const fresh = { ...census, measuredAt: recorded.measuredAt };
  if (
    JSON.stringify(fresh.reads) !== JSON.stringify(recorded.reads) ||
    JSON.stringify(fresh.totals) !== JSON.stringify(recorded.totals) ||
    JSON.stringify(fresh.population) !== JSON.stringify(recorded.population)
  ) {
    throw new Error(
      'app/scripts/recordings/read-paths.json is stale against the tree. Run `node app/scripts/measure-read-paths.mjs` and commit the recording.'
    );
  }
  const doc = readFileSync(DOC, 'utf8');
  const expected = figureTable(recorded);
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) throw new Error('docs/plan/56-read-paths.md is missing the generated-table markers.');
  const actual = doc.slice(start, end + END.length) + '\n';
  if (actual !== expected) {
    throw new Error(
      'The figure table in docs/plan/56-read-paths.md is stale against the recording. Run `node app/scripts/measure-read-paths.mjs --publish`.'
    );
  }
}

function isMain() {
  const entry = process.argv[1] ? decodeURIComponent(new URL(`file://${process.argv[1]}`).pathname) : '';
  return fileURLToPath(import.meta.url) === entry || process.argv[1]?.endsWith('measure-read-paths.mjs');
}

if (isMain()) {
  const flags = new Set(process.argv.slice(2));
  const census = { ...measure(), measuredAt: new Date().toISOString() };
  if (flags.has('--check')) {
    check(census);
    process.stdout.write(
      `Read paths: ${String(census.totals.reads)} (${String(census.totals.predicate)} predicate, ${String(census.totals.join)} join, ${String(census.totals.unclassified)} unclassified).\n`
    );
  } else {
    if (existsSync(RECORDING)) {
      const previous = JSON.parse(readFileSync(RECORDING, 'utf8'));
      census.measuredAt = previous.measuredAt;
      if (
        JSON.stringify({ ...census, measuredAt: null }) !==
        JSON.stringify({ ...previous, measuredAt: null })
      ) {
        census.measuredAt = new Date().toISOString();
      }
    }
    writeRecording(census);
    if (flags.has('--publish')) publish(census);
    process.stdout.write(
      `Wrote ${relative(ROOT, RECORDING)}: ${String(census.totals.reads)} reads ` +
        `(${String(census.totals.predicate)} predicate, ${String(census.totals.join)} join, ${String(census.totals.unclassified)} unclassified).\n`
    );
  }
}
