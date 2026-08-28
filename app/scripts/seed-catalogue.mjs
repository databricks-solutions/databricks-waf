#!/usr/bin/env node
// Seed or refresh the control catalogue from its upstream sources.
//
// Two sources, deliberately kept distinguishable:
//
//   waf-docs        the best practices published on the seven WAF pillar pages,
//                   harvested with real titles and real deep-link anchors.
//   security-guide  the security controls that the WAF security pillar page
//                   formally delegates to. The pillar page itself carries only
//                   four best practices and points elsewhere, so taking the
//                   pillar page alone would ship a near-empty security
//                   assessment. These come from SAT's published check
//                   definitions, which also supply severity, per-cloud
//                   applicability, pass criteria and the API call for each.
//
// A third provenance, `extension`, is authored by hand and is never produced
// here, because generating it would defeat the point of requiring a rationale.
//
// This script MERGES. Titles, anchors and upstream-owned fields are refreshed
// from source; anything enriched by hand is preserved. Re-running it after
// editing a threshold must not silently discard that edit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { PILLARS, harvest } from './harvest-waf-docs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLS_DIR = join(HERE, '..', 'config', 'controls');

const SAT_CSV =
  'https://raw.githubusercontent.com/databricks-industry-solutions/security-analysis-tool/main/configs/security_best_practices.csv';
const SAT_DASF_CSV =
  'https://raw.githubusercontent.com/databricks-industry-solutions/security-analysis-tool/main/configs/sat_dasf_mapping.csv';

// SAT groups its checks into five categories. Mapping them onto the WAF security
// principles is this project's editorial arrangement, not something either source
// states, so it is declared here in one place rather than inferred per control.
const SAT_CATEGORY_TO_PRINCIPLE = {
  'Identity & Access': 'SCP-01',
  'Data Protection': 'SCP-02',
  'Network Security': 'SCP-03',
  Governance: 'SCP-04',
  Informational: 'SCP-05',
};

const SAT_SEVERITY = { High: 'high', Medium: 'medium', Low: 'low' };

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows
    .filter((r) => r.length > 1 && r[0] !== '')
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// One signal should serve many controls. SAT records the API call each check
// needs, so deriving the signal id from that endpoint groups checks by the
// request that answers them instead of inventing a signal per control.
export function signalFromApi(api) {
  if (!api) return null;
  const m = api.match(/\/api\/2\.\d+\/([^\s'"?]+)/);
  if (!m) return null;
  const path = m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
  if (!path) return null;
  const scope = /accounts\.(cloud\.)?databricks\.com/.test(api) ? 'account' : 'workspace';
  return `rest:${scope}:${path.replace(/\//g, '.')}`;
}

function cloudsFor(row) {
  const clouds = ['aws', 'azure', 'gcp'].filter((c) => row[c] === '1');
  return clouds.length ? clouds : ['aws', 'azure', 'gcp'];
}

function firstDocUrl(row) {
  for (const key of ['aws_doc_url', 'azure_doc_url', 'gcp_doc_url']) {
    const v = row[key];
    if (v && v !== 'N/A' && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

function satToControl(row, index, dasfByCheck) {
  const principle = SAT_CATEGORY_TO_PRINCIPLE[row.category];
  if (!principle) return null;
  const docUrl = firstDocUrl(row);
  if (!docUrl) return null; // security-guide provenance requires a citable link.

  const collector = signalFromApi(row.api);
  const control = {
    id: `${principle}-${String(index).padStart(2, '0')}`,
    title: row.check,
    provenance: 'security-guide',
    source_anchor: docUrl,
    source_ref: row.check_id,
    // Every SAT check is answered by a REST call. Where the endpoint could not be
    // parsed the control still exists but must be resolved by attestation rather
    // than claiming automated coverage it does not have.
    measurability: collector ? 'rest-api' : 'attestation',
    severity: row.category === 'Informational' ? 'informational' : (SAT_SEVERITY[row.severity] ?? 'medium'),
    evaluator_status: 'planned',
    clouds: cloudsFor(row),
  };
  if (collector) control.collector = collector;
  if (row.logic) control.criteria = row.logic;
  if (!collector) {
    control.attestation = {
      question: `${row.check}: is this in place across the workspace?`,
      evidence_guidance: row.recommendation || undefined,
    };
  }
  if (row.recommendation) {
    control.remediation = { summary: row.recommendation, doc_url: docUrl };
  }
  const dasf = dasfByCheck.get(row.check_id);
  if (dasf?.length) control.dasf = dasf;
  return control;
}

// Preserve hand enrichment. Only fields this script owns are overwritten; every
// other key on an existing control survives a re-seed.
const UPSTREAM_OWNED = new Set(['title', 'source_anchor', 'source_ref', 'provenance']);

function mergeControl(existing, fresh) {
  if (!existing) return fresh;
  const merged = { ...existing };
  for (const [k, v] of Object.entries(fresh)) {
    if (UPSTREAM_OWNED.has(k) || !(k in existing)) merged[k] = v;
  }
  return merged;
}

function loadExisting(path) {
  if (!existsSync(path)) return null;
  return yaml.load(readFileSync(path, 'utf8'));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'databricks-waf-assessment/seed' } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

async function loadDasfMap() {
  const map = new Map();
  try {
    const rows = parseCsv(await fetchText(SAT_DASF_CSV));
    for (const row of rows) {
      const check = row.check_id ?? row.sat_check_id ?? row.id;
      const dasf = row.dasf_control_id ?? row.dasf_id ?? row.dasf;
      if (!check || !dasf) continue;
      if (!map.has(check)) map.set(check, []);
      map.get(check).push(dasf);
    }
  } catch (err) {
    console.warn(`  DASF mapping unavailable (${err.message}); continuing without it.`);
  }
  return map;
}

async function main() {
  console.log('Harvesting WAF documentation...');
  const harvested = await harvest();

  console.log('Fetching delegated security guidance (SAT check definitions)...');
  const satRows = parseCsv(await fetchText(SAT_CSV));
  const dasfByCheck = await loadDasfMap();

  // Assign SAT checks to WAF security principles, numbering within each.
  const satByPrinciple = new Map();
  for (const row of satRows) {
    const principle = SAT_CATEGORY_TO_PRINCIPLE[row.category];
    if (!principle) {
      console.warn(`  Unmapped SAT category "${row.category}" (${row.check_id}); skipped.`);
      continue;
    }
    if (!satByPrinciple.has(principle)) satByPrinciple.set(principle, []);
    satByPrinciple.get(principle).push(row);
  }

  mkdirSync(CONTROLS_DIR, { recursive: true });
  const summary = [];

  for (const pillarMeta of PILLARS) {
    const harvestedPillar = harvested.pillars.find((p) => p.code === pillarMeta.code);
    const path = join(CONTROLS_DIR, `${pillarMeta.id}.yaml`);
    const existing = loadExisting(path);
    const existingControls = new Map();
    for (const pr of existing?.principles ?? []) {
      for (const c of pr.controls ?? []) existingControls.set(c.id, c);
    }

    const principles = harvestedPillar.principles.map((pr) => {
      const controls = pr.best_practices.map((bp) =>
        mergeControl(existingControls.get(bp.id), {
          id: bp.id,
          title: bp.title,
          provenance: 'waf-docs',
          source_anchor: bp.source_anchor,
          measurability: 'attestation',
          severity: 'medium',
          evaluator_status: 'unimplemented',
          // No question invented from the title. This used to emit
          // `"<title>: is this practice in place?"`, which reads like a question while being
          // unanswerable — a well-run organisation and a badly-run one answer it the same way,
          // and the answer then moves the score. Questions are authored in
          // config/controls/questions.mjs, and the enricher fails on a control that has none,
          // so a newly harvested best practice shows up as work to do rather than as a filled
          // form field.
        })
      );

      // Append the delegated security controls to their assigned principle,
      // after the documented ones so numbering stays stable.
      const delegated = satByPrinciple.get(pr.id) ?? [];
      let next = controls.length + 1;
      for (const row of delegated) {
        const fresh = satToControl(row, next, dasfByCheck);
        if (!fresh) continue;
        controls.push(mergeControl(existingControls.get(fresh.id), fresh));
        next++;
      }

      return {
        id: pr.id,
        title: pr.title,
        source_anchor: pr.source_anchor,
        controls,
      };
    });

    // Carry forward hand-authored extension controls, which have no upstream to
    // be rediscovered from and would otherwise be dropped on every re-seed.
    for (const pr of existing?.principles ?? []) {
      const target = principles.find((p) => p.id === pr.id);
      if (!target) continue;
      for (const c of pr.controls ?? []) {
        if (c.provenance === 'extension' && !target.controls.some((x) => x.id === c.id)) {
          target.controls.push(c);
        }
      }
      target.controls.sort((a, b) => a.id.localeCompare(b.id));
    }

    const doc = {
      pillar: {
        id: pillarMeta.id,
        code: pillarMeta.code,
        title: pillarMeta.title,
        page: harvestedPillar.page,
      },
      principles,
    };

    writeFileSync(
      path,
      `# Generated by scripts/seed-catalogue.mjs from published sources.\n` +
        `# Hand-authored fields are preserved across re-seeds; titles and source\n` +
        `# anchors are refreshed from upstream. Do not add extension controls by\n` +
        `# editing generated entries -- add them as new controls with a rationale.\n` +
        yaml.dump(doc, { lineWidth: 100, noRefs: true, sortKeys: false })
    );

    const counts = { 'waf-docs': 0, 'security-guide': 0, extension: 0 };
    for (const pr of principles) for (const c of pr.controls) counts[c.provenance]++;
    summary.push({ code: pillarMeta.code, principles: principles.length, ...counts });
  }

  console.log('\nCatalogue seeded:\n');
  console.log('  pillar  principles  waf-docs  security-guide  extension  total');
  const totals = { principles: 0, 'waf-docs': 0, 'security-guide': 0, extension: 0 };
  for (const s of summary) {
    const total = s['waf-docs'] + s['security-guide'] + s.extension;
    console.log(
      `  ${s.code.padEnd(6)}  ${String(s.principles).padStart(10)}  ${String(s['waf-docs']).padStart(8)}  ${String(s['security-guide']).padStart(14)}  ${String(s.extension).padStart(9)}  ${String(total).padStart(5)}`
    );
    totals.principles += s.principles;
    totals['waf-docs'] += s['waf-docs'];
    totals['security-guide'] += s['security-guide'];
    totals.extension += s.extension;
  }
  const grand = totals['waf-docs'] + totals['security-guide'] + totals.extension;
  console.log(
    `  ${'TOTAL'.padEnd(6)}  ${String(totals.principles).padStart(10)}  ${String(totals['waf-docs']).padStart(8)}  ${String(totals['security-guide']).padStart(14)}  ${String(totals.extension).padStart(9)}  ${String(grand).padStart(5)}`
  );
}

await main();
