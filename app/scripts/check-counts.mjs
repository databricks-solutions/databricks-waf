#!/usr/bin/env node
// Keep the documented control counts in step with the catalogue.
//
// The README previously claimed 189 controls, a number carried over from an
// estimate rather than counted. Harvesting the real documentation showed the true
// figure, and the lesson is that a hand-maintained count drifts silently. This
// derives the numbers and either rewrites the README (--write) or fails when they
// disagree (default, used in CI).

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLS_DIR = join(HERE, '..', 'config', 'controls');
const README = join(HERE, '..', '..', 'README.md');

const MARKER_START = '<!-- catalogue-counts:start -->';
const MARKER_END = '<!-- catalogue-counts:end -->';

const AUTOMATABLE = ['system-table', 'rest-api', 'cloud-api'];

export function tally() {
  const provenance = { 'waf-docs': 0, 'security-guide': 0, extension: 0 };
  const aliasGroups = new Map();
  const pillars = [];
  let automatable = 0;
  let principles = 0;

  for (const file of readdirSync(CONTROLS_DIR).filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(readFileSync(join(CONTROLS_DIR, file), 'utf8'));
    let count = 0;
    for (const pr of doc.principles ?? []) {
      principles++;
      for (const c of pr.controls ?? []) {
        count++;
        if (c.provenance in provenance) provenance[c.provenance]++;
        if (AUTOMATABLE.includes(c.measurability)) automatable++;
        if (c.alias_group) {
          if (!aliasGroups.has(c.alias_group)) aliasGroups.set(c.alias_group, []);
          aliasGroups.get(c.alias_group).push(c.measurability);
        }
      }
    }
    pillars.push({ title: doc.pillar.title, code: doc.pillar.code, count });
  }

  const entries = provenance['waf-docs'] + provenance['security-guide'] + provenance.extension;
  const collapsed = [...aliasGroups.values()].reduce((a, group) => a + (group.length - 1), 0);
  // Counted in the same space as `scored`, which it did not used to be. The sentence pairs the two —
  // "167 scored controls, of which 119 are automatable" — and the second number was over all 184
  // entries, so it read as a subset of a total it was not a subset of. Nothing downstream was wrong;
  // the sentence was, by 17 requirements, and building the coverage ledger is what surfaced it.
  //
  // Collapsing is a subtraction only while every member of a group declares the same measurability,
  // which is true today and is not an invariant anything else enforces — so it is checked here rather
  // than assumed. A group that split would make this count silently arbitrary, since which member
  // survives the collapse is not a decision anybody makes.
  const split = [...aliasGroups.entries()].filter(
    ([, group]) => new Set(group.map((measurability) => AUTOMATABLE.includes(measurability))).size > 1
  );
  if (split.length > 0) {
    console.error(
      `Alias group${split.length === 1 ? '' : 's'} ${split.map(([group]) => group).join(', ')} ` +
        'declare more than one measurability class.\n' +
        'One requirement filed under two pillars is one requirement, so its members have to agree on ' +
        'whether\na machine can answer it. Fix the catalogue, or this count has to stop being a subtraction.'
    );
    process.exit(1);
  }

  const collapsedAutomatable = [...aliasGroups.values()].reduce(
    (a, group) => a + (AUTOMATABLE.includes(group[0]) ? group.length - 1 : 0),
    0
  );

  return {
    provenance,
    entries,
    scored: entries - collapsed,
    automatable: automatable - collapsedAutomatable,
    entryAutomatable: automatable,
    principles,
    pillars,
  };
}

function render(t) {
  return [
    MARKER_START,
    '',
    `**${t.scored} scored controls** across 7 pillars and ${t.principles} principles, of which ${t.automatable} are automatable.`,
    '',
    'Every control declares where it came from, so the app can answer "is this the actual',
    'Well-Architected Framework?" without hedging:',
    '',
    '| Provenance | Controls | Meaning |',
    '| --- | --- | --- |',
    `| \`waf-docs\` | ${t.provenance['waf-docs']} | A best practice published on a WAF pillar page, carrying a deep link to it. |`,
    `| \`security-guide\` | ${t.provenance['security-guide']} | A control from the Databricks security guidance that the WAF security pillar page formally delegates to. The pillar page itself documents only four practices and points elsewhere. |`,
    `| \`extension\` | ${t.provenance.extension} | Authored by this project, not published Databricks guidance. Each carries a rationale and is labelled as an extension in the UI. |`,
    '',
    ...(t.entries === t.scored
      ? []
      : [
          `The table counts ${t.entries} catalogue entries against ${t.scored} scored controls. The` +
            ' difference is requirements that belong to more than one pillar — Delta history',
          ' retention is both a cost concern and a recovery concern — which appear in each and are',
          ' scored once, so overlap cannot inflate the total. The automatable figure above is counted',
          ` the same way; over all ${t.entries} entries it is ${t.entryAutomatable}.`,
          '',
        ]),
    MARKER_END,
  ].join('\n');
}

const t = tally();
const readme = readFileSync(README, 'utf8');
const start = readme.indexOf(MARKER_START);
const end = readme.indexOf(MARKER_END);

if (start === -1 || end === -1) {
  console.error(`README is missing the ${MARKER_START} / ${MARKER_END} block.`);
  process.exit(1);
}

const current = readme.slice(start, end + MARKER_END.length);
const expected = render(t);

if (process.argv.includes('--write')) {
  writeFileSync(README, readme.slice(0, start) + expected + readme.slice(end + MARKER_END.length));
  console.log(`README updated: ${t.scored} scored controls (${t.entries} entries).`);
} else if (current !== expected) {
  console.error('README control counts are out of date. Run `npm run check:counts -- --write`.\n');
  console.error('Expected:\n');
  console.error(expected);
  process.exit(1);
} else {
  console.log(`README counts match the catalogue: ${t.scored} scored controls.`);
}
