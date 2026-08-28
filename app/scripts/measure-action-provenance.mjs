// What an advisor finding carries, of the four things an action made from it would have to keep.
//
// `44a` is `44b`'s premise. An action created from a finding without retyping can only preserve what
// the payload in front of the reader already holds: the rule that fired, the version of the rules it
// fired under, the resource it fired on, and the measured number it fired because of. The four
// advisors were built at different times — `H6`, `33c`, `33i` — and the row was written expecting
// them not to agree. This is the apparatus that says how they differ, rather than a reading of them.
//
// It parses `shared/api/contract.ts` with the TypeScript compiler and walks down from
// `AdvisoryPayload`, so the population is what a client is served rather than what a server module
// happens to hold. Two things are declared here rather than measured, and both are printed with the
// table so a reader can disagree with them:
//
//   - A **finding** is an object type carrying a property named `rule` or `ruleId`. That is the
//     identity an action would store, so a type without one is not a finding an action can be made
//     from.
//   - A finding's **narrative** properties are `headline`, `detail`, `docUrl` and `rationale`. They
//     are prose for a reader. Everything else on a finding is data, and it is the data that decides
//     what the four columns say.
//
// Everything else is derived. A baseline is a number reachable on the finding — directly or through
// an array of objects — because that is what a later reading could be compared against. A field that
// is a free `string` is prose whatever it is called, which is how `observed` is reported: it holds
// this estate's measurement, and it holds it as "8.0 days".
//
//   node scripts/measure-action-provenance.mjs            write the recording
//   node scripts/measure-action-provenance.mjs --publish  rewrite the table in docs/plan/42-…md
//   node scripts/measure-action-provenance.mjs --check     fail if either is stale
//
// `--check` is what `npm run verify` runs, and it is meant to fail when `44b` adds a field: the row
// after this one changes these payloads, and the table saying what they were missing has to move
// with them.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..');
const CONTRACT = join(APP, 'shared', 'api', 'contract.ts');
const RECORDING = join(HERE, 'recordings', 'action-provenance.json');
const DOC = join(ROOT, 'docs', 'plan', '42-customer-operating-product.md');

const START =
  '<!-- generated: advisor provenance census. Run `node app/scripts/measure-action-provenance.mjs --publish`. -->';
const END = '<!-- end generated -->';

/** Where a walk starts: the payload one advisory run is served as. */
const RUN = 'AdvisoryPayload';

/** The property names that make an object type a finding. */
const IDENTITY = ['rule', 'ruleId'];

/** Prose for a reader rather than data an action would keep. */
const NARRATIVE = ['headline', 'detail', 'docUrl', 'rationale'];

export { RECORDING, DOC, RUN, IDENTITY, NARRATIVE };

/**
 * @typedef {{ readonly kind: 'named'; readonly name: string }
 *   | { readonly kind: 'array'; readonly of: TypeRef }
 *   | { readonly kind: 'primitive'; readonly name: string }
 *   | { readonly kind: 'enumeration'; readonly members: readonly string[] }
 *   | { readonly kind: 'other'; readonly text: string }} TypeRef
 * @typedef {{ readonly name: string; readonly optional: boolean; readonly type: TypeRef }} Property
 * @typedef {{ readonly name: string; readonly properties: readonly Property[] }} Shape
 * @typedef {{ readonly property: string; readonly type: string; readonly repeated: boolean }} Level
 * @typedef {{
 *   readonly advisor: string;
 *   readonly finding: string;
 *   readonly levels: readonly Level[];
 *   readonly identity: { readonly property: string; readonly closed: boolean };
 *   readonly version: readonly { readonly property: string; readonly at: string }[];
 *   readonly resource: readonly { readonly property: string; readonly at: string }[];
 *   readonly baseline: readonly { readonly property: string; readonly through: string | null }[];
 *   readonly prose: readonly string[];
 * }} Chain
 * @typedef {{
 *   readonly measuredAt?: string;
 *   readonly source: string;
 *   readonly run: string;
 *   readonly declared: { readonly identity: readonly string[]; readonly narrative: readonly string[] };
 *   readonly chains: readonly Chain[];
 *   readonly totals: {
 *     readonly advisors: number;
 *     readonly withIdentityOnTheFinding: number;
 *     readonly withVersionAnywhere: number;
 *     readonly withVersionOnTheFinding: number;
 *     readonly withResourceAnywhere: number;
 *     readonly withResourceOnTheFinding: number;
 *     readonly withNumericBaseline: number;
 *     readonly withAllFourOnTheFinding: number;
 *   };
 * }} Census
 */

/**
 * Every interface in a TypeScript source, by name.
 *
 * Read from the syntax rather than a type checker: the question here is what the contract declares,
 * and a declaration is what a reader of the contract sees.
 *
 * @param {string} source
 * @returns {Map<string, Shape>}
 */
export function shapesFrom(source) {
  const file = ts.createSourceFile('contract.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {Map<string, Shape>} */
  const shapes = new Map();
  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    /** @type {Property[]} */
    const properties = [];
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || member.type == null) continue;
      properties.push({
        name: member.name.text,
        optional: member.questionToken != null,
        type: typeRef(member.type),
      });
    }
    shapes.set(statement.name.text, { name: statement.name.text, properties });
  }
  return shapes;
}

/**
 * @param {import('typescript').TypeNode} node
 * @returns {TypeRef}
 */
function typeRef(node) {
  if (ts.isParenthesizedTypeNode(node)) return typeRef(node.type);
  // `readonly T[]`, which is how every list in this contract is written.
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return typeRef(node.type);
  if (ts.isArrayTypeNode(node)) return { kind: 'array', of: typeRef(node.elementType) };
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.getText();
    if (name === 'ReadonlyArray' && node.typeArguments?.length === 1) {
      return { kind: 'array', of: typeRef(node.typeArguments[0]) };
    }
    return { kind: 'named', name };
  }
  if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: 'primitive', name: 'string' };
  if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: 'primitive', name: 'number' };
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: 'primitive', name: 'boolean' };
  if (ts.isUnionTypeNode(node)) {
    const members = node.types.map((one) => (ts.isLiteralTypeNode(one) && ts.isStringLiteral(one.literal) ? one.literal.text : null));
    if (members.every((one) => one != null)) return { kind: 'enumeration', members: /** @type {string[]} */ (members) };
    return { kind: 'other', text: node.getText().replace(/\s+/g, ' ') };
  }
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return { kind: 'enumeration', members: [node.literal.text] };
  }
  return { kind: 'other', text: node.getText().replace(/\s+/g, ' ') };
}

/** The interface a property leads to, and whether it leads to many of them. */
function leadsTo(type) {
  if (type.kind === 'array') {
    const inner = leadsTo(type.of);
    return inner == null ? null : { name: inner.name, repeated: true };
  }
  if (type.kind === 'named') return { name: type.name, repeated: false };
  return null;
}

/**
 * The chains from the run payload down to every finding under it, one per advisor.
 *
 * @param {Map<string, Shape>} shapes
 * @returns {readonly Chain[]}
 */
export function chainsFrom(shapes) {
  const run = shapes.get(RUN);
  if (run == null) throw new Error(`${RUN} is not an interface in the contract, so there is no run to walk from.`);

  /** @type {Chain[]} */
  const chains = [];
  for (const advisor of run.properties) {
    const analysis = leadsTo(advisor.type);
    if (analysis == null || !shapes.has(analysis.name)) continue;
    for (const found of findingsUnder(shapes, analysis.name, [
      { property: advisor.name, type: analysis.name, repeated: analysis.repeated },
    ])) {
      chains.push(chain(shapes, advisor.name, found));
    }
  }
  chains.sort((a, b) => a.advisor.localeCompare(b.advisor) || a.finding.localeCompare(b.finding));
  return chains;
}

/**
 * Every finding reachable below one analysis, with the path taken to it.
 *
 * Depth-first through named object types and arrays of them, refusing to revisit a type on the same
 * path so a payload that refers to itself cannot make the walk run for ever.
 */
function findingsUnder(shapes, name, levels) {
  /** @type {(readonly Level[])[]} */
  const found = [];
  const shape = shapes.get(name);
  if (shape == null) return found;
  if (identityOf(shape) != null) return [levels];
  for (const property of shape.properties) {
    const next = leadsTo(property.type);
    if (next == null || !shapes.has(next.name)) continue;
    if (levels.some((level) => level.type === next.name)) continue;
    found.push(
      ...findingsUnder(shapes, next.name, [
        ...levels,
        { property: property.name, type: next.name, repeated: next.repeated },
      ])
    );
  }
  return found;
}

function identityOf(shape) {
  return shape.properties.find((property) => IDENTITY.includes(property.name)) ?? null;
}

/**
 * @param {Map<string, Shape>} shapes
 * @param {string} advisor
 * @param {readonly Level[]} levels
 * @returns {Chain}
 */
function chain(shapes, advisor, levels) {
  const finding = shapes.get(levels[levels.length - 1].type);
  if (finding == null) throw new Error(`The walk reached ${levels[levels.length - 1].type}, which is not an interface.`);
  const identity = identityOf(finding);
  if (identity == null) throw new Error(`${finding.name} was walked to as a finding and carries no identity.`);

  return {
    advisor,
    finding: finding.name,
    levels,
    identity: { property: identity.name, closed: identity.type.kind === 'enumeration' },
    version: versionIn(shapes, levels),
    resource: resourceIn(shapes, levels),
    baseline: baselineOn(shapes, finding),
    prose: proseOn(finding).map((property) => property.name),
  };
}

/**
 * Every version declared on the chain — `rulesVersion`, `rankingVersion` — nearest the finding first.
 *
 * All of them rather than the first: the workload advisor declares two, they move independently, and
 * an action that kept one of the two would be citing half of what its advice was produced under.
 */
function versionIn(shapes, levels) {
  /** @type {{ property: string; at: string }[]} */
  const found = [];
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    const shape = shapes.get(levels[i].type);
    for (const property of shape?.properties ?? []) {
      if (/version$/i.test(property.name)) found.push({ property: property.name, at: levels[i].type });
    }
  }
  return found;
}

/**
 * The identifiers naming what a finding was found on, wherever they sit.
 *
 * Anything ending in `Id` that is not the rule's own identity, plus `shape`, which is the workload
 * advisor's identifier for a query shape and is the one resource here whose name does not say `Id`.
 */
function resourceIn(shapes, levels) {
  /** @type {{ property: string; at: string }[]} */
  const found = [];
  for (const level of levels) {
    const shape = shapes.get(level.type);
    for (const property of shape?.properties ?? []) {
      if (IDENTITY.includes(property.name)) continue;
      if (!/Id$/.test(property.name) && property.name !== 'shape') continue;
      found.push({ property: property.name, at: level.type });
    }
  }
  return found;
}

/** A number an action could compare a later reading against, on the finding itself. */
function baselineOn(shapes, finding) {
  /** @type {{ property: string; through: string | null }[]} */
  const found = [];
  for (const property of dataOn(finding)) {
    if (property.type.kind === 'primitive' && property.type.name === 'number') {
      found.push({ property: property.name, through: null });
      continue;
    }
    const next = leadsTo(property.type);
    const shape = next == null ? undefined : shapes.get(next.name);
    if (shape == null) continue;
    if (shape.properties.some((one) => one.type.kind === 'primitive' && one.type.name === 'number')) {
      found.push({ property: property.name, through: shape.name });
    }
  }
  return found;
}

/** Data on the finding that is a free string: a measurement already rendered into a sentence. */
function proseOn(finding) {
  return dataOn(finding).filter((property) => property.type.kind === 'primitive' && property.type.name === 'string');
}

function dataOn(finding) {
  return finding.properties.filter(
    (property) => !NARRATIVE.includes(property.name) && !IDENTITY.includes(property.name)
  );
}

/** @returns {Census} */
export function measure() {
  const chains = chainsFrom(shapesFrom(readFileSync(CONTRACT, 'utf8')));
  return {
    source: `app/shared/api/contract.ts, from ${RUN}`,
    run: RUN,
    declared: { identity: IDENTITY, narrative: NARRATIVE },
    chains,
    totals: totalsOf(chains),
  };
}

function totalsOf(chains) {
  const on = (chain, at) => at === chain.finding;
  return {
    advisors: new Set(chains.map((chain) => chain.advisor)).size,
    withIdentityOnTheFinding: chains.length,
    withVersionAnywhere: chains.filter((chain) => chain.version.length > 0).length,
    withVersionOnTheFinding: chains.filter((chain) => chain.version.some((one) => on(chain, one.at))).length,
    withResourceAnywhere: chains.filter((chain) => chain.resource.length > 0).length,
    withResourceOnTheFinding: chains.filter((chain) => chain.resource.some((one) => on(chain, one.at))).length,
    withNumericBaseline: chains.filter((chain) => chain.baseline.length > 0).length,
    withAllFourOnTheFinding: chains.filter(
      (chain) =>
        chain.version.some((one) => on(chain, one.at)) &&
        chain.resource.some((one) => on(chain, one.at)) &&
        chain.baseline.length > 0
    ).length,
  };
}

function table(census) {
  const lines = [
    START,
    '',
    `Recording: [\`app/scripts/recordings/action-provenance.json\`](../../app/scripts/recordings/action-provenance.json), measured ${census.measuredAt}.`,
    `Source: \`${census.source}\`. A finding is an object type carrying ${quoted(census.declared.identity, ' or ')}; ` +
      `its narrative properties — ${quoted(census.declared.narrative, ', ')} — are prose, and the rest is data.`,
    '',
    '| Where a finding sits | Finding | Rule identity | Rules version | Resource | Baseline |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const chain of census.chains) {
    lines.push(
      `| \`${pathOf(chain)}\` | \`${chain.finding}\` | ${identityCell(chain)} | ${versionCell(chain)} ` +
        `| ${resourceCell(chain)} | ${baselineCell(chain)} |`
    );
  }

  const totals = census.totals;
  lines.push(
    `| **Total** | ${String(totals.advisors)} advisors | ${String(totals.withIdentityOnTheFinding)} on the finding ` +
      `| ${String(totals.withVersionOnTheFinding)} on the finding, ${String(totals.withVersionAnywhere)} anywhere ` +
      `| ${String(totals.withResourceOnTheFinding)} on the finding, ${String(totals.withResourceAnywhere)} anywhere ` +
      `| ${String(totals.withNumericBaseline)} numeric |`
  );
  lines.push('');
  lines.push(
    `All four on the finding itself: **${String(totals.withAllFourOnTheFinding)} of ${String(census.chains.length)}**.`
  );
  lines.push('');
  lines.push(END);
  return `${lines.join('\n')}\n`;
}

/** Names in markdown code spans, joined by whatever the sentence around them needs. */
function quoted(names, join) {
  return names.map((name) => `\`${name}\``).join(join);
}

/** `serverless.jobs[].reasons[]`, so two places the same type is reached are two rows a reader can tell apart. */
function pathOf(chain) {
  return chain.levels.map((level) => `${level.property}${level.repeated ? '[]' : ''}`).join('.');
}

function identityCell(chain) {
  return `\`${chain.identity.property}\`, ${chain.identity.closed ? 'a closed set' : 'any string'}`;
}

function versionCell(chain) {
  if (chain.version.length === 0) return 'absent';
  const at = [...new Set(chain.version.map((one) => one.at))];
  return `${chain.version.map((one) => `\`${one.property}\``).join(', ')} on ${at.map((one) => `\`${one}\``).join(', ')}`;
}

function resourceCell(chain) {
  if (chain.resource.length === 0) return 'absent';
  const at = [...new Set(chain.resource.map((one) => one.at))];
  return `${chain.resource.map((one) => `\`${one.property}\``).join(', ')} on ${at.map((one) => `\`${one}\``).join(', ')}`;
}

function baselineCell(chain) {
  if (chain.baseline.length > 0) {
    return chain.baseline
      .map((one) => (one.through == null ? `\`${one.property}\`` : `\`${one.property}\` of \`${one.through}\``))
      .join(', ');
  }
  if (chain.prose.length > 0) return `prose only: ${chain.prose.map((one) => `\`${one}\``).join(', ')}`;
  return 'absent';
}

function replaceBlock(doc, block) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`${relative(ROOT, DOC)} is missing the generated-table markers ${START}`);
  }
  return `${doc.slice(0, start)}${block}${doc.slice(end + END.length).replace(/^\n/, '')}`;
}

function writeRecording(census) {
  mkdirSync(dirname(RECORDING), { recursive: true });
  writeFileSync(RECORDING, `${JSON.stringify(census, null, 2)}\n`);
}

function check(census) {
  if (!existsSync(RECORDING)) throw new Error(`No recording at ${RECORDING}; run without --check first.`);
  const recorded = JSON.parse(readFileSync(RECORDING, 'utf8'));
  if (
    JSON.stringify(census.chains) !== JSON.stringify(recorded.chains) ||
    JSON.stringify(census.totals) !== JSON.stringify(recorded.totals) ||
    JSON.stringify(census.declared) !== JSON.stringify(recorded.declared)
  ) {
    throw new Error(
      'app/scripts/recordings/action-provenance.json is stale against the contract. Run ' +
        '`node app/scripts/measure-action-provenance.mjs --publish` and commit both.'
    );
  }
  const doc = readFileSync(DOC, 'utf8');
  const expected = table(recorded);
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) throw new Error(`${relative(ROOT, DOC)} is missing the generated-table markers.`);
  if (`${doc.slice(start, end + END.length)}\n` !== expected) {
    throw new Error(
      `The census table in ${relative(ROOT, DOC)} is stale against the recording. Run ` +
        '`node app/scripts/measure-action-provenance.mjs --publish`.'
    );
  }
}

function isMain() {
  return process.argv[1]?.endsWith('measure-action-provenance.mjs') === true;
}

if (isMain()) {
  const flags = new Set(process.argv.slice(2));
  const census = { ...measure(), measuredAt: new Date().toISOString() };
  const summary =
    `${String(census.totals.advisors)} advisors, ${String(census.chains.length)} findings: ` +
    `${String(census.totals.withAllFourOnTheFinding)} carry all four on the finding, ` +
    `${String(census.totals.withNumericBaseline)} carry a numeric baseline.\n`;
  if (flags.has('--check')) {
    check(census);
    process.stdout.write(`Advisor provenance: ${summary}`);
  } else {
    if (existsSync(RECORDING)) {
      const previous = JSON.parse(readFileSync(RECORDING, 'utf8'));
      const same =
        JSON.stringify({ ...census, measuredAt: null }) === JSON.stringify({ ...previous, measuredAt: null });
      if (same) census.measuredAt = previous.measuredAt;
    }
    writeRecording(census);
    if (flags.has('--publish')) {
      if (!existsSync(DOC)) throw new Error(`No plan file at ${DOC}`);
      writeFileSync(DOC, replaceBlock(readFileSync(DOC, 'utf8'), table(census)));
    }
    process.stdout.write(`Wrote ${relative(ROOT, RECORDING)}: ${summary}`);
  }
}
