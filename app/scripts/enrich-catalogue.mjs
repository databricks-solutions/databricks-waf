#!/usr/bin/env node
// Applies config/controls/enrichment.mjs into the pillar catalogue files.
//
// The pillar files are generated from the published documentation and then enriched
// with this project's evaluation metadata. Keeping the enrichment in one table rather
// than editing seven generated files by hand means the seeder can regenerate from the
// docs without losing it, and CI can prove the two are still in agreement.
//
//   node scripts/enrich-catalogue.mjs           apply
//   node scripts/enrich-catalogue.mjs --check   fail if the catalogue is out of date
//
// --check is what runs in CI. A drifting catalogue would change scores without any
// code change, which is exactly the class of change that has to be visible in review.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { ENRICHMENT, IMPLEMENTED_DELEGATED, IMPLEMENTED_EXTENSIONS } from '../config/controls/enrichment.mjs';
import { QUESTIONS } from '../config/controls/questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLS = join(HERE, '..', 'config', 'controls');

const PILLAR_FILES = [
  'cost-optimization.yaml',
  'data-and-ai-governance.yaml',
  'interoperability-and-usability.yaml',
  'operational-excellence.yaml',
  'performance-efficiency.yaml',
  'reliability.yaml',
  'security-compliance-and-privacy.yaml',
];

/**
 * Fields the enrichment table owns. Anything here is replaced wholesale when the table
 * has a value and removed when it does not, so deleting an entry from the table
 * actually reverts the control rather than leaving a stale threshold behind.
 */
const OWNED = [
  'measurability',
  'collector',
  'severity',
  'criteria',
  'thresholds',
  'alias_group',
  'applicability',
  // Owned because it follows from the collector, which this table assigns. A control read
  // from a per-table sample that did not declare itself sampled would have its passes
  // scored as estate-wide compliance, which is the one error the coverage model exists to
  // prevent.
  'coverage_mode',
  'remediation',
];

const check = process.argv.includes('--check');
const applied = [];
const asked = [];
const problems = [];
const changed = [];

for (const file of PILLAR_FILES) {
  const path = join(CONTROLS, file);
  const before = readFileSync(path, 'utf8');
  const doc = yaml.load(before);

  for (const principle of doc.principles ?? []) {
    for (const control of principle.controls ?? []) {
      const enrichment = ENRICHMENT[control.id];

      if (enrichment != null) {
        if (control.provenance === 'extension') {
          // An extension carries its own metadata by construction. Enriching it from
          // here would put the same control in two places with no rule for which wins.
          problems.push(`${control.id} is an extension and must not appear in the enrichment table.`);
          continue;
        }
        apply(control, enrichment);
        applied.push(control.id);
        continue;
      }

      if (IMPLEMENTED_EXTENSIONS.includes(control.id) || IMPLEMENTED_DELEGATED.includes(control.id)) {
        control.evaluator_status = 'implemented';
        applied.push(control.id);
      }

      if (control.measurability === 'attestation') ask(control);
    }
  }

  // js-yaml drops comments, and the header is what tells the next reader the file is
  // generated. Carrying it across by hand is uglier than a comment-preserving parser
  // and considerably less likely to reformat the whole file on a library upgrade.
  const after = leadingComment(before) + yaml.dump(doc, { lineWidth: 100, noRefs: true, sortKeys: false });
  if (after !== before) {
    changed.push(file);
    if (!check) writeFileSync(path, after);
  }
}

const unknown = Object.keys(ENRICHMENT).filter((id) => !applied.includes(id));
if (unknown.length > 0) {
  problems.push(`Enrichment names controls that are not in the catalogue: ${unknown.join(', ')}`);
}

const unasked = Object.keys(QUESTIONS).filter((id) => !asked.includes(id));
if (unasked.length > 0) {
  problems.push(
    'The question table names controls that are not asked of anyone — either they are not in the ' +
      `catalogue, or the app now measures them: ${unasked.join(', ')}`
  );
}

if (problems.length > 0) {
  console.error('Catalogue enrichment is inconsistent:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (check) {
  if (changed.length > 0) {
    console.error(
      `Catalogue is out of date with config/controls/enrichment.mjs: ${changed.join(', ')}\n` +
        'Run `npm run enrich:catalogue` and commit the result.'
    );
    process.exit(1);
  }
  console.log(`Catalogue enrichment is current (${applied.length} controls).`);
} else {
  console.log(
    changed.length === 0
      ? `Catalogue already current (${applied.length} controls enriched).`
      : `Enriched ${applied.length} controls across ${changed.length} file(s): ${changed.join(', ')}`
  );
}

function leadingComment(contents) {
  const lines = contents.split('\n');
  const header = [];
  for (const line of lines) {
    if (!line.startsWith('#')) break;
    header.push(line);
  }
  return header.length === 0 ? '' : `${header.join('\n')}\n`;
}

/**
 * Writes the enrichment onto a control.
 *
 * Ordering is deliberate: the evaluation fields are inserted in a fixed order so that
 * re-running produces a byte-identical file and a real change shows as a small diff
 * rather than a reshuffle.
 */
function apply(control, enrichment) {
  for (const field of OWNED) delete control[field];

  control.measurability = enrichment.measurability;
  if (enrichment.collector != null) control.collector = enrichment.collector;
  control.severity = enrichment.severity;
  control.evaluator_status = 'implemented';
  if (enrichment.alias_group != null) control.alias_group = enrichment.alias_group;
  if (enrichment.criteria != null) control.criteria = enrichment.criteria;
  if (enrichment.thresholds != null) control.thresholds = enrichment.thresholds;
  if (enrichment.applicability != null) control.applicability = enrichment.applicability;
  if (enrichment.coverage_mode != null) control.coverage_mode = enrichment.coverage_mode;
  if (enrichment.remediation != null) control.remediation = enrichment.remediation;

  // A control the app now measures no longer needs to be asked about. Leaving the
  // question behind would put the same control in front of the user twice, once
  // answered by evidence and once as a form to fill in.
  if (enrichment.measurability !== 'attestation') delete control.attestation;
}

/**
 * Writes the authored question onto an attestation-class control.
 *
 * The seeder fills these in from the title — `"<title>: is this practice in place?"` — which
 * is a placeholder, not a question: a well-run organisation and a badly-run one answer it
 * identically. Anything still carrying that shape is reported as missing rather than
 * accepted, because an unanswerable question that nonetheless moves the score is worse than
 * an unmeasured requirement, which at least reports itself as unknown.
 */
function ask(control) {
  const authored = QUESTIONS[control.id];
  if (authored == null) {
    problems.push(
      `${control.id} is answered by a person but has no authored question in ` +
        'config/controls/questions.mjs. Write one; the generated placeholder is not usable.'
    );
    return;
  }

  // Refused rather than defaulted, for the same reason the question itself is. A question with no
  // recorded reason for existing is one nobody has checked against the platform, and the failure that
  // matters is silent: the telemetry to answer it arrives, and the question goes on being asked
  // because nothing ever said what it was standing in for.
  if (authored.asked_because == null) {
    problems.push(
      `${control.id} is asked of a person with no recorded reason. Add asked_because to its entry in ` +
        'config/controls/questions.mjs, saying what a machine would have to observe and whether ' +
        'anything records it. See docs/decisions/0071-*.md.'
    );
    return;
  }

  control.attestation = {
    question: authored.question,
    evidence_guidance: authored.evidence,
    cadence_days: authored.cadence_days,
    asked_because: {
      verdict: authored.asked_because.verdict,
      why: authored.asked_because.why,
      ...(authored.asked_because.signal != null ? { signal: authored.asked_because.signal } : {}),
    },
  };
  asked.push(control.id);
}
