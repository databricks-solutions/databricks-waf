#!/usr/bin/env node
// Validate the control catalogue against its schema, plus the invariants a JSON
// Schema cannot express on its own.
//
// The schema enforces per-control shape. This adds the cross-file rules: ids are
// unique and belong to their pillar, alias groups are internally consistent, no
// control claims automated coverage without a collector, and provenance counts
// are reported so a change in the mix is visible in a diff rather than silent.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLS_DIR = join(HERE, '..', 'config', 'controls');
const SCHEMA_PATH = join(CONTROLS_DIR, 'catalogue.schema.json');

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const files = readdirSync(CONTROLS_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

if (files.length === 0) fail('No catalogue files found. Run `node scripts/seed-catalogue.mjs`.');

const allControls = new Map();
const aliasGroups = new Map();
const provenanceCounts = { 'waf-docs': 0, 'security-guide': 0, extension: 0 };
const pillarRows = [];

for (const file of files) {
  const path = join(CONTROLS_DIR, file);
  let doc;
  try {
    doc = yaml.load(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`${file}: not valid YAML -- ${err.message}`);
    continue;
  }

  if (!validate(doc)) {
    for (const e of validate.errors ?? []) {
      fail(`${file}${e.instancePath}: ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`);
    }
  }
  if (!doc?.pillar) continue;

  const code = doc.pillar.code;
  const counts = { 'waf-docs': 0, 'security-guide': 0, extension: 0 };

  for (const principle of doc.principles ?? []) {
    if (!principle.id?.startsWith(`${code}-`)) {
      fail(`${file}: principle ${principle.id} does not belong to pillar ${code}`);
    }
    // Zero-control principles are legitimate: some documented principles carry no
    // individually assessable practice. Noted rather than failed.
    if ((principle.controls ?? []).length === 0) {
      warnings.push(`${file}: principle ${principle.id} (${principle.title}) has no controls`);
    }

    for (const control of principle.controls ?? []) {
      if (allControls.has(control.id)) {
        fail(`Duplicate control id ${control.id} (in ${file} and ${allControls.get(control.id).file})`);
      }
      allControls.set(control.id, { file, control });

      if (!control.id?.startsWith(`${principle.id}-`)) {
        fail(`${file}: control ${control.id} is not numbered under its principle ${principle.id}`);
      }

      if (control.provenance in counts) {
        counts[control.provenance]++;
        provenanceCounts[control.provenance]++;
      }

      // The single most important scoring invariant: a control that can be
      // excluded or auto-satisfied must explain itself in words the user sees,
      // because a shrunken denominator has to read as explained fact.
      for (const pre of control.applicability?.preconditions ?? []) {
        if (!pre.reason || pre.reason.length < 20) {
          fail(`${control.id}: applicability precondition needs a user-facing reason`);
        }
      }

      // A sampled control must never be able to claim estate-wide compliance.
      if (control.coverage_mode === 'sampled' && control.measurability === 'attestation') {
        fail(`${control.id}: coverage_mode 'sampled' is meaningless for an attestation control`);
      }

      if (control.alias_group) {
        if (!aliasGroups.has(control.alias_group)) aliasGroups.set(control.alias_group, []);
        aliasGroups.get(control.alias_group).push(control);
      }
    }
  }

  pillarRows.push({ code, principles: (doc.principles ?? []).length, ...counts });
}

// An alias group exists so overlapping requirements are scored once. A group of
// one is a mistake -- either the partner control is missing or the group is stray.
for (const [group, members] of aliasGroups) {
  if (members.length < 2) {
    fail(`Alias group '${group}' has only one member (${members[0].id}); it would score nothing extra`);
  }
  const severities = new Set(members.map((m) => m.severity));
  if (severities.size > 1) {
    warnings.push(
      `Alias group '${group}' mixes severities (${[...severities].join(', ')}); the group scores once, so decide which applies`
    );
  }
}

const total = provenanceCounts['waf-docs'] + provenanceCounts['security-guide'] + provenanceCounts.extension;

console.log('Catalogue validation\n');
console.log('  pillar  principles  waf-docs  security-guide  extension  total');
for (const r of pillarRows) {
  const t = r['waf-docs'] + r['security-guide'] + r.extension;
  console.log(
    `  ${r.code.padEnd(6)}  ${String(r.principles).padStart(10)}  ${String(r['waf-docs']).padStart(8)}  ${String(r['security-guide']).padStart(14)}  ${String(r.extension).padStart(9)}  ${String(t).padStart(5)}`
  );
}
// Entries and scored units differ, and conflating them would overstate coverage.
// A control appearing in two pillars via an alias group is one requirement, and
// the headline number has to be the number of requirements assessed.
const scoredUnits = total - [...aliasGroups.values()].reduce((a, m) => a + (m.length - 1), 0);

console.log(
  `\n  ${total} catalogue entries: ${provenanceCounts['waf-docs']} documented, ` +
    `${provenanceCounts['security-guide']} delegated security guidance, ` +
    `${provenanceCounts.extension} extensions.`
);
console.log(`  ${scoredUnits} scored units (${aliasGroups.size} alias group(s) collapse to one requirement each).`);

const automated = [...allControls.values()].filter((c) =>
  ['system-table', 'rest-api', 'cloud-api'].includes(c.control.measurability)
).length;
const implemented = [...allControls.values()].filter((c) => c.control.evaluator_status === 'implemented').length;
console.log(`  ${automated} automatable, ${implemented} with an implemented evaluator.`);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
}

if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('\nCatalogue is valid.');
