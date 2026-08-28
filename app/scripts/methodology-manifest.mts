#!/usr/bin/env -S npx tsx
// Generate the complete customer methodology candidate from the contracts that execute it.
//
// `config/controls/version.json` is intentionally narrower: it fingerprints the fields that make
// two scan scores comparable. A released customer methodology has a wider job. It has to say which
// evidence answers every requirement, every question a person may be asked, how long that answer
// counts, how answers become outcomes and how those outcomes become a score. Those semantics live in
// several executable modules, so a hand-authored manifest would be a second methodology that drifted
// from the first. This generator imports the real modules and CI compares their output byte for byte.
//
// Usage:
//   npm run methodology:manifest             # write the candidate
//   npm run check:methodology-manifest        # refuse drift

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, type CatalogueControl } from '../server/catalogue/catalogue.js';
import { ANSWERS, DUE_WINDOW_DAYS, cadenceDaysFor } from '../server/attest/attestation.js';
import { BLOCKED_QUESTIONS } from '../server/attest/blocked-questions.js';
import { INCONCLUSIVE_QUESTIONS } from '../server/attest/inconclusive-questions.js';
import { judgmentRoutes } from '../server/judge/route.js';
import { beyondAnyInstall, descriptorsById } from '../server/plan/plan.js';
import { OUTCOME_OF_ANSWER } from '../server/resolve/resolver.js';
import { buildRegistry } from '../server/resolve/resolvers/index.js';
import { METHODOLOGY } from '../server/scan/identity.js';
import { CREDIT, SEVERITY_WEIGHT } from '../server/score/score.js';
import {
  assertReleasedMetadata,
  assertReleaseTransition,
  releasedMethodologyChanged,
} from './methodology-release-policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..');
const RELEASE = join(APP, 'config', 'methodology', 'version-1.release.json');
const OUTPUT = join(APP, 'config', 'methodology', 'version-1.manifest.json');
const COVERAGE_LEDGER = join(ROOT, 'docs', 'coverage-ledger.md');
const EVIDENCE_SCRIPT = join(APP, 'config', 'evidence', 'collect-evidence.py');

interface ReleaseSource {
  readonly schema_version: number;
  readonly public_version: number;
  readonly name: string;
  readonly state: 'candidate' | 'released';
  readonly candidate_started_at: string;
  readonly effective_date: string | null;
  readonly release_commit: string | null;
  readonly approved_by: string | null;
  readonly approval_required_role: string;
  readonly support_boundary: Record<string, unknown>;
}

interface AdministratorEvidenceManifest {
  readonly digest: string;
  readonly probes: readonly {
    readonly label: string;
    readonly controls: readonly string[];
    readonly signals: readonly string[];
    readonly tier: string;
    readonly shape: string;
  }[];
  readonly deferred: readonly { readonly signal: string; readonly reason: string }[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function sorted<T>(values: readonly T[], key: (value: T) => string = (value) => String(value)): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

const release = JSON.parse(readFileSync(RELEASE, 'utf8')) as ReleaseSource;
const catalogue = loadCatalogue();
const registry = buildRegistry();
const descriptors = descriptorsById();
const routes = judgmentRoutes(catalogue, registry, descriptors);
const administrator = JSON.parse(
  execFileSync('python3', [EVIDENCE_SCRIPT, '--manifest'], { encoding: 'utf8' })
) as AdministratorEvidenceManifest;

const administratorByControl = new Map<string, AdministratorEvidenceManifest['probes'][number][]>();
for (const probe of administrator.probes) {
  for (const controlId of probe.controls) {
    const held = administratorByControl.get(controlId) ?? [];
    held.push(probe);
    administratorByControl.set(controlId, held);
  }
}

function questionContracts(control: CatalogueControl): readonly Record<string, unknown>[] {
  const questions: Record<string, unknown>[] = [];
  if (control.attestation != null) {
    questions.push({
      trigger: 'practice-requires-attestation',
      question: control.attestation.question,
      evidence_guidance: control.attestation.evidenceGuidance ?? null,
      cadence_days: cadenceDaysFor(control.severity, control.attestation.cadenceDays),
      proxy_signal: control.attestation.proxySignal ?? null,
      asked_because: control.attestation.askedBecause ?? null,
    });
  }

  const blocked = BLOCKED_QUESTIONS[control.id];
  if (blocked != null) {
    questions.push({
      trigger: 'source-is-unreachable-to-an-app-installation',
      question: blocked.question,
      evidence_guidance: blocked.evidence,
      cadence_days: blocked.cadenceDays,
    });
  }

  const inconclusive = INCONCLUSIVE_QUESTIONS[control.id];
  if (inconclusive != null) {
    questions.push({
      trigger: 'automated-reading-is-inconclusive',
      question: inconclusive.question,
      evidence_guidance: inconclusive.evidence,
      why_asked: inconclusive.whyAsked,
      cadence_days: inconclusive.cadenceDays,
    });
  }
  return questions;
}

function answerPath(control: CatalogueControl): string {
  if (control.measurability === 'attestation') return 'question-practice';
  if (beyondAnyInstall(control, registry, descriptors)) return 'question-setting';
  if (registry.get(control.id) != null) return 'measured';
  throw new Error(`${control.id} has no answer path, so Methodology Version 1 cannot be generated.`);
}

const requirements = sorted(
  catalogue.pillars.flatMap((pillar) =>
    pillar.principles.flatMap((principle) =>
      principle.controls.map((control) => {
        const resolver = registry.get(control.id);
        const routing = routes.get(control.id);
        if (routing == null) throw new Error(`${control.id} has no judgment route.`);
        const probes = sorted(administratorByControl.get(control.id) ?? [], (probe) => probe.label);

        return {
          id: control.id,
          pillar: { id: pillar.id, code: pillar.code, title: pillar.title },
          principle: { id: principle.id, title: principle.title },
          title: control.title,
          source: {
            provenance: control.provenance,
            source_anchor: control.sourceAnchor ?? principle.sourceAnchor,
            source_ref: control.sourceRef ?? null,
            references: sorted(control.references),
            dasf: sorted(control.dasf),
          },
          scoring: {
            severity: control.severity,
            weight: SEVERITY_WEIGHT[control.severity],
            coverage_mode: control.coverageMode,
            alias_group: control.aliasGroup ?? null,
            thresholds: control.thresholds ?? null,
            preconditions: control.preconditions ?? [],
          },
          evidence: {
            answer_path: answerPath(control),
            declared_class: control.measurability,
            evaluator_status: control.evaluatorStatus,
            collector: control.collector ?? null,
            required_signals: sorted(resolver?.requires ?? []),
            enrichment_signals: sorted(resolver?.enrichedBy ?? []),
            administrator_probes: probes.map((probe) => ({
              label: probe.label,
              signals: sorted(probe.signals),
              tier: probe.tier,
              shape: probe.shape,
            })),
            judgment: routing,
          },
          supported_clouds: sorted(control.clouds),
          questions: questionContracts(control),
        };
      })
    )
  ),
  (requirement) => requirement.id
);

const ledger = readFileSync(COVERAGE_LEDGER, 'utf8');
const ledgerIds = new Set([...ledger.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]));
const requirementIds = new Set(requirements.map((requirement) => requirement.id));
const missingFromLedger = [...requirementIds].filter((id) => !ledgerIds.has(id)).sort();
const extraInLedger = [...ledgerIds].filter((id) => !requirementIds.has(id)).sort();
if (missingFromLedger.length > 0 || extraInLedger.length > 0) {
  throw new Error(
    `The coverage ledger and methodology disagree. Missing: ${missingFromLedger.join(', ') || 'none'}; ` +
      `extra: ${extraInLedger.join(', ') || 'none'}.`
  );
}

const questions = requirements.flatMap((requirement) => requirement.questions);
const countWhere = (value: string): number =>
  requirements.filter((requirement) => requirement.evidence.answer_path === value).length;

const scoreContract = {
  digest: METHODOLOGY,
  severity_weight: SEVERITY_WEIGHT,
  outcome_credit: CREDIT,
  pillar_aggregation: 'severity-weighted mean of credit-bearing requirements within each pillar',
  overall_aggregation: 'unweighted mean of pillars that have a score',
  unknowns:
    'unmeasurable and not-applicable leave the weighted mean; unmeasured applicable requirements widen the low/high range',
  alias_groups:
    'one requirement is scored once per pillar at the group worst outcome and reported in every pillar that expresses it',
  evidence_precedence:
    'applicability is evaluated before evidence; a measurement overrides an attestation and an attestation decides only an unmeasurable reading',
};

const questionContract = {
  answers: ANSWERS,
  outcome_of_answer: OUTCOME_OF_ANSWER,
  due_window_days: DUE_WINDOW_DAYS,
  expiry: 'an answer stops counting at reviewBy and the requirement returns to unmeasured',
  attribution:
    'owner and recording identity are required; a later answer supersedes rather than rewrites the earlier record',
};

const content = {
  schema_version: release.schema_version,
  public_version: release.public_version,
  name: release.name,
  release: {
    state: release.state,
    candidate_started_at: release.candidate_started_at,
    effective_date: release.effective_date,
    commit: release.release_commit,
    approved_by: release.approved_by,
    approval_required_role: release.approval_required_role,
  },
  support_boundary: release.support_boundary,
  technical_provenance: {
    catalogue_revision: catalogue.version.version,
    catalogue_fingerprint: catalogue.version.fingerprint,
  },
  counts: {
    pillars: catalogue.pillars.length,
    catalogue_entries: requirements.length,
    scored_units: catalogue.recorded.scoredUnits ?? null,
    alias_groups: catalogue.aliasGroups.size,
    measured: countWhere('measured'),
    question_setting: countWhere('question-setting'),
    question_practice: countWhere('question-practice'),
    question_contracts: questions.length,
    administrator_probes: administrator.probes.length,
  },
  scoring: scoreContract,
  questions: questionContract,
  assurance: {
    coverage_ledger: {
      path: 'docs/coverage-ledger.md',
      requirement_ids_digest: digest([...ledgerIds].sort()),
    },
    administrator_evidence: {
      path: 'app/config/evidence/collect-evidence.py',
      digest: administrator.digest,
      deferred: sorted(administrator.deferred, (entry) => entry.signal),
    },
    required_checks: [
      'validate:catalogue',
      'catalogue:version',
      'check:coverage',
      'check:guidance',
      'check:evidence-script',
      'check:thresholds',
      'check:judgment-routes',
      'check:statement-bounds',
    ],
  },
  pillars: catalogue.pillars.map((pillar) => ({
    id: pillar.id,
    code: pillar.code,
    title: pillar.title,
    source: pillar.page,
    requirement_count: requirements.filter((requirement) => requirement.pillar.id === pillar.id).length,
  })),
  requirements,
  digests: {
    scoring: METHODOLOGY,
    evidence: digest(requirements.map((requirement) => ({ id: requirement.id, evidence: requirement.evidence }))),
    questions: digest(requirements.map((requirement) => ({ id: requirement.id, questions: requirement.questions }))),
    methodology_content: digest({ scoreContract, questionContract, requirements }),
  },
  generated_by: 'app/scripts/methodology-manifest.mts',
};

const manifest = { ...content, manifest_digest: digest(content) };
const expected = `${JSON.stringify(manifest, null, 2)}\n`;
let current = '';
try {
  current = readFileSync(OUTPUT, 'utf8');
} catch {
  // The mode-specific error below explains whether generation or restoring Version 1 is the remedy.
}

const releasing = process.argv.includes('--release');
const writing = process.argv.includes('--write');

if (releasing && writing) throw new Error('Use either --release or --write, not both.');
if (release.state === 'released') assertReleasedMetadata(release);

if (releasing) {
  if (release.state !== 'released') {
    throw new Error('Set the complete released facts in version-1.release.json before running --release.');
  }
  let currentValue: unknown;
  try {
    currentValue = JSON.parse(current) as unknown;
  } catch {
    throw new Error('The approved candidate manifest is missing or is not valid JSON. Restore it before release.');
  }
  assertReleaseTransition(currentValue, manifest);
  writeFileSync(OUTPUT, expected);
  console.log(
    `Methodology Version ${String(release.public_version)} released: ` +
      `${String(requirements.length)} entries, ${String(questions.length)} question contracts, ${manifest.manifest_digest}.`
  );
} else if (writing) {
  if (release.state === 'released' && current !== expected) throw releasedMethodologyChanged();
  if (current === expected) {
    console.log(`Methodology Version ${String(release.public_version)} ${release.state} is already current.`);
    process.exit(0);
  }
  writeFileSync(OUTPUT, expected);
  console.log(
    `Methodology Version ${String(release.public_version)} ${release.state} written: ` +
      `${String(requirements.length)} entries, ${String(questions.length)} question contracts, ${manifest.manifest_digest}.`
  );
} else {
  if (current !== expected) {
    if (release.state === 'released') throw releasedMethodologyChanged();
    console.error(
      'The Methodology Version 1 manifest does not match the executable catalogue, scoring, evidence or question contracts.\n' +
        'Run `npm run methodology:manifest`, inspect the semantic change and commit the regenerated manifest.'
    );
    process.exit(1);
  }
  console.log(
    `Methodology Version ${String(release.public_version)} matches ${String(requirements.length)} catalogue entries ` +
      `and ${String(questions.length)} question contracts (${manifest.manifest_digest}).`
  );
}
