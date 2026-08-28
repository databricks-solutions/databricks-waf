// Reading the control catalogue at runtime.
//
// The catalogue is the app's definition of what is being assessed, and it is data
// rather than code so that a threshold or a severity can change without a release
// and so that CI can validate it against a schema. This module is the one place that
// turns those YAML files into the typed specs the resolvers and the scorer consume.
//
// It is deliberately strict about ids and provenance and lenient about nothing. A
// catalogue that parsed loosely would let a typo in a control id produce a control
// with no resolver, which the app would then report as "unmeasured" — a wrong answer
// that looks like an honest one.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { shippedConfigDirectory } from '../shipped-config.js';
import { loadChangelog, type CatalogueChangelog } from './changelog.js';
import { NO_RECORD, recordedFrom, type RecordedMethodology } from './methodology.js';
import type { Precondition } from '../resolve/applicability.js';
import type { Severity } from '../resolve/finding.js';
import type { ControlSpec } from '../resolve/resolver.js';

export type Provenance = 'waf-docs' | 'security-guide' | 'extension';
export type Measurability = 'system-table' | 'rest-api' | 'cloud-api' | 'attestation' | 'derived';
export type EvaluatorStatus = 'implemented' | 'planned' | 'unimplemented';
export type CoverageMode = 'complete' | 'sampled';

export interface Remediation {
  readonly summary?: string;
  readonly sql?: string;
  readonly cli?: string;
  readonly terraform?: string;
  /**
   * What a person does where no command exists.
   *
   * Some fixes are not commands and never will be: whether a GPU cluster is justified is a
   * judgement about the workload, assigning a workspace to a metastore is an account-console
   * action, and switching a stream to a triggered one is a change to somebody's notebook. Those get
   * a paragraph instead, held to the same standard by scripts/check-remediation.mjs — specific
   * enough to follow, and never the only thing on a requirement that could have carried a snippet.
   */
  readonly byHand?: string;
  readonly deepLink?: string;
  readonly docUrl?: string;
  /** Where the fix trades something away, shown next to it rather than buried. */
  readonly caveat?: string;
}

/**
 * What the platform could contribute to a requirement this catalogue asks a person about.
 *
 * Three, and the middle one is the reason this is an enum rather than a sentence. "A machine cannot
 * answer this" and "a machine could answer this and we have not written it" are opposite claims about
 * the product, and a questionnaire that does not distinguish them lets the second hide inside the
 * first indefinitely: every question looks equally unavoidable, so nobody ever checks.
 *
 * Not to be confused with the `AskedBecause` on the wire, which is a different judgement about the
 * same question: that one says which mechanism put it in front of a person — practice, unauthorised
 * setting, or an inconclusive reading this time — and is decided per scan. This one is a property of
 * the requirement and is decided by audit. Both were called `askedBecause` for a while and a reviewer
 * duly read one as the other, which is why each now names the other.
 */
export type TelemetryVerdict = 'beyond-telemetry' | 'partial-telemetry' | 'owed-a-measure';

/**
 * The recorded reason a question exists, so that "we had to ask" is a claim somebody reviewed.
 *
 * A questionnaire is the most expensive answer this tool can give — it costs a person's attention and
 * buys an answer no better than their word — so the bar for reaching for one has to be visible. This
 * records, per question, what a machine would have to observe, whether the platform records it, and
 * where the answer is that it does, what is owed.
 */
export interface TelemetryJustification {
  readonly verdict: TelemetryVerdict;
  /** What a machine would have to see, and whether anything records it. */
  readonly why: string;
  /** The table, column or endpoint that bears on the answer, where one does. */
  readonly signal?: string;
}

export interface Attestation {
  readonly question: string;
  readonly evidenceGuidance?: string;
  readonly cadenceDays?: number;
  readonly proxySignal?: string;
  /** Why this is asked rather than measured. Required by the schema; see `TelemetryJustification`. */
  readonly askedBecause?: TelemetryJustification;
}

export interface CatalogueControl extends ControlSpec {
  readonly provenance: Provenance;
  readonly measurability: Measurability;
  readonly evaluatorStatus: EvaluatorStatus;
  readonly coverageMode: CoverageMode;
  readonly sourceAnchor?: string;
  readonly sourceRef?: string;
  readonly rationale?: string;
  readonly collector?: string;
  readonly criteria?: string;
  readonly clouds: readonly ('aws' | 'azure' | 'gcp')[];
  readonly remediation?: Remediation;
  readonly attestation?: Attestation;
  readonly dasf: readonly string[];
  readonly references: readonly string[];
}

export interface CataloguePrinciple {
  readonly id: string;
  readonly title: string;
  readonly sourceAnchor: string;
  readonly controls: readonly CatalogueControl[];
}

export interface CataloguePillar {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly page: string;
  readonly principles: readonly CataloguePrinciple[];
}

export interface CatalogueVersion {
  readonly version: string;
  readonly fingerprint: string;
}

export interface Catalogue {
  readonly version: CatalogueVersion;
  /**
   * What each recorded version changed about the one before it.
   *
   * Kept beside the catalogue rather than loaded where it is used, because it is written by the
   * same bump that sets `version` and read from the same directory — two loaders for one directory
   * is two places for a shipped install to disagree about which catalogue it has.
   */
  readonly changelog: CatalogueChangelog;
  /**
   * The scoring shape the version record was computed over, requirement by requirement.
   *
   * The methodology of record, as distinct from the catalogue this build loaded: the fingerprint
   * covers this projection by construction, so it is what "version 9" means. They agree in this
   * repository because CI refuses a catalogue edit without a bump, and the methodology surface
   * reports it where they do not.
   */
  readonly recorded: RecordedMethodology;
  readonly pillars: readonly CataloguePillar[];
  readonly controls: readonly CatalogueControl[];
  /**
   * Controls that share an alias group, keyed by group. Each group is scored once,
   * so a requirement appearing in two pillars cannot count twice against an estate
   * that has one thing wrong.
   */
  readonly aliasGroups: ReadonlyMap<string, readonly CatalogueControl[]>;
}

/**
 * Where the catalogue lives, found by walking up from this module.
 *
 * Searched rather than computed because this module runs from two different depths: from
 * `server/catalogue/` under `tsx` in development, and from `dist/catalogue/` in the
 * shipped bundle. A fixed number of `..` segments is right for one and wrong for the
 * other, and the way that failure presents is an app that boots fine locally and dies on
 * install with an ENOENT naming a path nobody wrote.
 */
export function catalogueDirectory(moduleUrl = import.meta.url): string {
  return shippedConfigDirectory('controls', moduleUrl);
}

export function loadCatalogue(directory: string = catalogueDirectory()): Catalogue {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.yaml'))
    .sort();

  const pillars = withSharedRemediation(files.map((name) => readPillar(join(directory, name))));
  const controls = pillars.flatMap((pillar) => pillar.principles.flatMap((principle) => principle.controls));

  const aliasGroups = new Map<string, CatalogueControl[]>();
  for (const control of controls) {
    if (control.aliasGroup == null) continue;
    const group = aliasGroups.get(control.aliasGroup) ?? [];
    group.push(control);
    aliasGroups.set(control.aliasGroup, group);
  }

  const record = readVersionRecord(directory);

  return {
    version: record.version,
    changelog: loadChangelog(directory),
    recorded: record.recorded,
    pillars,
    controls,
    aliasGroups,
  };
}

/**
 * One fix per requirement, shared by every pillar that asks for it.
 *
 * An alias group is one requirement written down in several pillars — "use a data format that
 * supports ACID transactions" in reliability is "use performance optimized data formats" in cost
 * optimization, and converting the tables satisfies both. The group is already scored once. This
 * makes it remediated once too, by giving the members that carry no `remediation` of their own the
 * one their group carries.
 *
 * Resolved here rather than at each reader because there are several readers — the catalogue
 * endpoint, the export, the finding pane — and a rule enforced in three places is a rule that
 * holds in two. Resolved rather than copied into the YAML because two copies of the same
 * instruction drift, and the drift shows up as one pillar telling a customer to do something the
 * next pillar has stopped recommending.
 *
 * The whole `remediation` is inherited, not merged field by field. A summary from one control and
 * a SQL snippet from another would read as one instruction and be two, which is worse than either.
 *
 * Nothing is inherited where the members that authored a fix do not agree on it, because sometimes
 * they are right to disagree. `delta-history-retention` is the case: cost optimization asks for the
 * retention window to be shortened and reliability asks for it to be long enough to recover from,
 * and the catalogue states both, deliberately, with each caveat naming the other. That is one
 * decision with two honest framings rather than a copy that drifted, and choosing a winner between
 * them is not this function's judgement to make.
 */
function withSharedRemediation(pillars: readonly CataloguePillar[]): readonly CataloguePillar[] {
  const authored = new Map<string, Remediation[]>();
  for (const pillar of pillars) {
    for (const principle of pillar.principles) {
      for (const control of principle.controls) {
        if (control.aliasGroup == null || control.remediation == null) continue;
        authored.set(control.aliasGroup, [...(authored.get(control.aliasGroup) ?? []), control.remediation]);
      }
    }
  }

  const inherited = new Map<string, Remediation>();
  for (const [group, remediations] of authored) {
    // Non-empty by construction: a group only appears above when a member authored a fix.
    const [first] = remediations;
    if (remediations.every((one) => same(one, first))) inherited.set(group, first);
  }
  if (inherited.size === 0) return pillars;

  const resolve = (control: CatalogueControl): CatalogueControl => {
    if (control.remediation != null || control.aliasGroup == null) return control;
    const remediation = inherited.get(control.aliasGroup);
    return remediation == null ? control : { ...control, remediation };
  };

  return pillars.map((pillar) => ({
    ...pillar,
    principles: pillar.principles.map((principle) => ({
      ...principle,
      controls: principle.controls.map(resolve),
    })),
  }));
}

/** Two remediations that say the same thing, whatever order the YAML listed their keys in. */
function same(a: Remediation, b: Remediation): boolean {
  const flatten = (one: Remediation) => JSON.stringify(Object.entries(one).sort(([x], [y]) => x.localeCompare(y)));
  return flatten(a) === flatten(b);
}

/**
 * The version record, read once.
 *
 * Both halves come out of one parse because both come out of one file. Two readers of `version.json`
 * is two places for a shipped install to disagree about which catalogue it has, which is the argument
 * the changelog makes for living here rather than at its reader.
 */
function readVersionRecord(directory: string): { version: CatalogueVersion; recorded: RecordedMethodology } {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'version.json'), 'utf8')) as Record<string, unknown>;

    // The bump script writes the version as a JSON number. Accepting only a string
    // here silently stamped every scan `0.0.0` while the fingerprint beside it was
    // correct, so the number the guard maintains never reached the user.
    const version =
      typeof parsed.version === 'number' && Number.isFinite(parsed.version)
        ? String(parsed.version)
        : typeof parsed.version === 'string' && parsed.version !== ''
          ? parsed.version
          : undefined;
    const fingerprint = typeof parsed.fingerprint === 'string' && parsed.fingerprint !== '' ? parsed.fingerprint : undefined;

    return {
      version: version != null && fingerprint != null ? { version, fingerprint } : unknownVersion(),
      recorded: recordedFrom(parsed),
    };
  } catch {
    // A scan without a catalogue version is still a valid scan; it just cannot be
    // compared against another one. Refusing to run would be a worse trade.
    return { version: unknownVersion(), recorded: NO_RECORD };
  }
}

/**
 * A version that compares equal to nothing, including another unknown one.
 *
 * Comparability keys on the fingerprint, so a fixed placeholder would make two scans
 * with unreadable catalogues look like they asked the same questions. There is no
 * evidence for that, and the trend view would draw a line across it. A unique value
 * makes the absence behave like the uncertainty it represents.
 */
function unknownVersion(): CatalogueVersion {
  return { version: 'unknown', fingerprint: `unknown:${randomUUID()}` };
}

interface RawPillar {
  pillar: { id: string; code: string; title: string; page: string };
  principles: RawPrinciple[];
}

interface RawPrinciple {
  id: string;
  title: string;
  source_anchor: string;
  controls?: RawControl[];
}

interface RawControl {
  id: string;
  title: string;
  provenance: Provenance;
  measurability: Measurability;
  severity: Severity;
  evaluator_status: EvaluatorStatus;
  coverage_mode?: CoverageMode;
  source_anchor?: string;
  source_ref?: string;
  rationale?: string;
  collector?: string;
  criteria?: string;
  alias_group?: string;
  clouds?: ('aws' | 'azure' | 'gcp')[];
  thresholds?: Record<string, unknown>;
  applicability?: { preconditions?: RawPrecondition[] };
  remediation?: Record<string, string>;
  attestation?: {
    question: string;
    evidence_guidance?: string;
    cadence_days?: number;
    proxy_signal?: string;
    asked_because?: { verdict: TelemetryVerdict; why: string; signal?: string };
  };
  dasf?: string[];
  references?: string[];
}

interface RawPrecondition {
  signal: string;
  operator: Precondition['operator'];
  value?: unknown;
  outcome: Precondition['outcome'];
  reason: string;
  scope?: 'estate' | 'segment';
}

function readPillar(path: string): CataloguePillar {
  const raw = load(readFileSync(path, 'utf8')) as RawPillar;
  const pillar = raw.pillar;

  return {
    id: pillar.id,
    code: pillar.code,
    title: pillar.title,
    page: pillar.page,
    principles: (raw.principles ?? []).map((principle) => ({
      id: principle.id,
      title: principle.title,
      sourceAnchor: principle.source_anchor,
      controls: (principle.controls ?? []).map((control) => toControl(control, pillar.id, principle.id)),
    })),
  };
}

function toControl(raw: RawControl, pillarId: string, principleId: string): CatalogueControl {
  return {
    id: raw.id,
    pillarId,
    principleId,
    title: raw.title,
    severity: raw.severity,
    provenance: raw.provenance,
    measurability: raw.measurability,
    evaluatorStatus: raw.evaluator_status,
    coverageMode: raw.coverage_mode ?? 'complete',
    clouds: raw.clouds ?? ['aws', 'azure', 'gcp'],
    dasf: raw.dasf ?? [],
    references: raw.references ?? [],
    ...present('sourceAnchor', raw.source_anchor),
    ...present('sourceRef', raw.source_ref),
    ...present('rationale', raw.rationale),
    ...present('collector', raw.collector),
    ...present('criteria', raw.criteria),
    ...present('aliasGroup', raw.alias_group),
    ...present('thresholds', raw.thresholds),
    ...present('remediation', raw.remediation == null ? undefined : toRemediation(raw.remediation)),
    ...present(
      'attestation',
      raw.attestation == null
        ? undefined
        : {
            question: raw.attestation.question,
            ...present('evidenceGuidance', raw.attestation.evidence_guidance),
            ...present('cadenceDays', raw.attestation.cadence_days),
            ...present('proxySignal', raw.attestation.proxy_signal),
            ...present(
              'askedBecause',
              raw.attestation.asked_because == null
                ? undefined
                : {
                    verdict: raw.attestation.asked_because.verdict,
                    why: raw.attestation.asked_because.why,
                    ...present('signal', raw.attestation.asked_because.signal),
                  }
            ),
          }
    ),
    ...present(
      'preconditions',
      raw.applicability?.preconditions?.map((precondition) => ({
        signal: precondition.signal as Precondition['signal'],
        operator: precondition.operator,
        outcome: precondition.outcome,
        reason: precondition.reason,
        ...present('value', precondition.value),
        ...present('scope', precondition.scope),
      }))
    ),
  };
}

function toRemediation(raw: Record<string, string>): Remediation {
  return {
    ...present('summary', raw.summary),
    ...present('sql', raw.sql),
    ...present('cli', raw.cli),
    ...present('terraform', raw.terraform),
    ...present('byHand', raw.by_hand),
    ...present('deepLink', raw.deep_link),
    ...present('docUrl', raw.doc_url),
    ...present('caveat', raw.caveat),
  };
}

/**
 * Include a key only when it has a value, so an absent catalogue field stays absent
 * rather than becoming an explicit null in every API response and every stored scan.
 */
function present<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
