#!/usr/bin/env node
// Detect drift between the catalogue and the published Well-Architected Framework.
//
// When Databricks adds, removes or retitles a best practice, this catalogue
// silently stops representing the framework it claims to represent. That is a
// correctness failure rather than a staleness one, so this exits non-zero.
//
// Matching is keyed on the documentation anchor, not the control id. Control ids
// are positional (CO-03-04 is the fourth practice under the third principle), so
// inserting one practice upstream would renumber everything after it and every
// control would look changed. The anchor is derived from the heading text and
// survives reordering.
//
// Scoped to provenance:waf-docs. Extension controls have no anchor to diff and
// would otherwise be reported as deletions on every run. They are checked in the
// opposite direction instead: if a doc revision introduces a practice matching an
// extension we authored, that extension should be promoted rather than maintained
// as a fork.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';
import * as yaml from 'js-yaml';
import { harvest } from './harvest-waf-docs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLS_DIR = join(HERE, '..', 'config', 'controls');

function normaliseTitle(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadCatalogue() {
  const documented = new Map(); // anchor -> { id, title, pillar }
  const extensions = [];
  for (const file of readdirSync(CONTROLS_DIR).filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(readFileSync(join(CONTROLS_DIR, file), 'utf8'));
    for (const principle of doc.principles ?? []) {
      for (const control of principle.controls ?? []) {
        if (control.provenance === 'waf-docs' && control.source_anchor) {
          documented.set(control.source_anchor, {
            id: control.id,
            title: control.title,
            pillar: doc.pillar.code,
          });
        } else if (control.provenance === 'extension') {
          extensions.push({ id: control.id, title: control.title, pillar: doc.pillar.code });
        }
      }
    }
  }
  return { documented, extensions };
}

const { documented, extensions } = loadCatalogue();
const harvested = await harvest();

const live = new Map();
for (const pillar of harvested.pillars) {
  for (const principle of pillar.principles) {
    for (const bp of principle.best_practices) {
      live.set(bp.source_anchor, { title: bp.title, pillar: pillar.code, principle: principle.id });
    }
  }
}

const added = [];
const removed = [];
const retitled = [];

for (const [anchor, liveBp] of live) {
  const known = documented.get(anchor);
  if (!known) {
    added.push({ anchor, ...liveBp });
  } else if (known.title !== liveBp.title) {
    retitled.push({ anchor, id: known.id, from: known.title, to: liveBp.title });
  }
}
for (const [anchor, known] of documented) {
  if (!live.has(anchor)) removed.push({ anchor, ...known });
}

// Reverse direction: has an addition upstream made one of our extensions
// redundant? Promoting beats maintaining a fork.
const promotable = [];
for (const ext of extensions) {
  const extNorm = normaliseTitle(ext.title);
  for (const a of added) {
    const addNorm = normaliseTitle(a.title);
    if (addNorm === extNorm || addNorm.includes(extNorm) || extNorm.includes(addNorm)) {
      promotable.push({ extension: ext, documented: a });
    }
  }
}

const drifted = added.length + removed.length + retitled.length > 0;

const lines = [];
lines.push('# Documentation drift report', '');
lines.push(`Harvested ${harvested.harvested_at}.`, '');
lines.push(
  `Catalogue holds ${documented.size} documented controls; the published pages currently carry ${live.size} best practices.`,
  ''
);

if (!drifted) {
  lines.push('No drift. Every documented control matches a published best practice, and every');
  lines.push('published best practice is represented in the catalogue.');
} else {
  if (added.length) {
    lines.push(`## ${added.length} best practice(s) published but not in the catalogue`, '');
    lines.push('Re-run `npm run seed:catalogue` to pick these up, then enrich them.', '');
    for (const a of added) lines.push(`- **${a.pillar}** ${a.title}`, `  <${a.anchor}>`);
    lines.push('');
  }
  if (removed.length) {
    lines.push(`## ${removed.length} catalogue control(s) no longer published`, '');
    lines.push(
      'These assert documented guidance that no longer exists. Either the practice was',
      'withdrawn, in which case remove the control, or it was retitled such that its anchor',
      'changed, in which case the anchor needs updating rather than the control deleting.',
      ''
    );
    for (const r of removed) lines.push(`- **${r.pillar}** ${r.id} — ${r.title}`, `  <${r.anchor}>`);
    lines.push('');
  }
  if (retitled.length) {
    lines.push(`## ${retitled.length} best practice(s) retitled upstream`, '');
    for (const t of retitled) {
      lines.push(`- ${t.id}`, `  - was: ${t.from}`, `  - now: ${t.to}`);
    }
    lines.push('');
  }
}

if (promotable.length) {
  lines.push(`## ${promotable.length} extension(s) now covered by published guidance`, '');
  lines.push(
    'The documentation appears to have adopted something this project added. Promoting the',
    'control to `provenance: waf-docs` with the published anchor is preferable to keeping a',
    'parallel extension.',
    ''
  );
  for (const p of promotable) {
    lines.push(
      `- ${p.extension.id} (${p.extension.title})`,
      `  now published as: ${p.documented.title}`,
      `  <${p.documented.anchor}>`
    );
  }
  lines.push('');
}

const report = lines.join('\n');
const reportIdx = argv.indexOf('--report');
if (reportIdx >= 0 && argv[reportIdx + 1]) {
  writeFileSync(argv[reportIdx + 1], `${report}\n`);
}
console.log(report);

if (drifted) {
  console.error(`\nDrift detected: ${added.length} added, ${removed.length} removed, ${retitled.length} retitled.`);
  process.exit(1);
}
