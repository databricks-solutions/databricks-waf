// The methodology, as a thing a reader can inspect rather than a digest in a stamp.
//
// Every run records the catalogue version it was scored against and a fingerprint of that catalogue's
// scoring shape, and both are already on the run record. What no surface could answer is the question
// underneath them: what *is* version 9. A reader looking at "catalogue 9, sha256:5e57d689…" has been
// shown two identifiers and told nothing — not which requirements it holds, not how heavily each one
// weighs, not what the last release moved. The audit calls that out as GAP-019 and is right to: a
// repository somebody would have to clone is not a product capability, and "we changed the
// methodology" is the one explanation a customer must be able to check for themselves.
//
// Three properties shape what this module does and does not do.
//
// **It serves the recorded shape, not the loaded catalogue.** `version.json` holds the projection the
// fingerprint was computed over, keyed by requirement, and that projection is the methodology of
// record — the fingerprint means it by construction. Recomputing the same projection from the loaded
// YAML would put a second definition of "what the fingerprint covers" in the tree, and the failure
// mode of two definitions is a page confidently describing a methodology no run was scored against.
//
// **It names the disagreement rather than choosing a side.** A build whose catalogue has been edited
// without a bump has a record that no longer describes it. CI refuses that (`catalogue:version
// --check`), which covers this repository and not an install where somebody has edited the shipped
// config. So each requirement carries which of its fields the loaded catalogue reads differently, in
// the same vocabulary the changelog uses for a version's own changes, and a requirement present on
// one side only is reported as such. Silence here is the honest, ordinary case.
//
// **It is read-only, and the whole of D1's read half.** Nothing in this file is customer-configurable.
// The methodology is product-controlled on purpose: a customer who could edit severities or thresholds
// could produce a score that is not comparable with anybody else's, which is the one thing a
// framework assessment is for. What a customer may say about a requirement — that it does not apply,
// or that its check should not run — is a separate record with an owner and an expiry, and it is
// deliberately not a methodology edit. See ADR 0059.

import type { FieldChange } from './changelog.js';

/** A precondition as the version record holds it: the shape, without the prose. */
export interface RecordedPrecondition {
  readonly signal: string;
  readonly operator: string;
  readonly value?: unknown;
  readonly outcome: string;
  readonly scope: string;
}

/**
 * One requirement's scoring shape, as recorded.
 *
 * The field names are the record's own, snake_case and all, rather than translated into this app's
 * conventions. They are what the fingerprint covers, they are what a `changed` entry in the changelog
 * names, and a reader who sees `coverage_mode` on this page and `coverage_mode` in the changelog is
 * reading one vocabulary rather than being asked to map between two.
 */
export interface RecordedShape {
  readonly id: string;
  readonly pillar: string;
  readonly principle: string;
  readonly title: string;
  readonly provenance: string;
  readonly severity: string;
  readonly measurability: string;
  readonly coverage_mode: string;
  readonly alias_group: string | null;
  readonly clouds: readonly string[];
  readonly thresholds: Readonly<Record<string, unknown>> | null;
  /** The requirement this one continues, where a renumbering was declared. */
  readonly continues?: string;
  readonly preconditions: readonly RecordedPrecondition[];
}

/**
 * What `version.json` says, beyond the two identifiers the stamp already carries.
 *
 * `unavailable` is a sentence rather than a flag, because the two ways to get here are different
 * facts: a version file this build could not read, and one written before it held shapes. A surface
 * that showed an empty methodology for either would be claiming the app assesses nothing.
 */
export interface RecordedMethodology {
  readonly shapes: ReadonlyMap<string, RecordedShape>;
  /** Requirements after alias groups are folded, which is what a score is out of. */
  readonly scoredUnits?: number;
  readonly unavailable?: string;
}

export const NO_RECORD: RecordedMethodology = {
  shapes: new Map(),
  unavailable:
    'This build could not read the catalogue version record, so what the methodology holds cannot be ' +
    'shown. Runs still record which version they were scored against.',
};

/**
 * The recorded shapes out of a parsed `version.json`.
 *
 * Takes the parsed object rather than a directory so that `loadCatalogue` reads the file once. Two
 * readers of one file is two places for a shipped install to disagree about which catalogue it has,
 * which is the argument the changelog loader makes one directory over.
 */
export function recordedFrom(parsed: unknown): RecordedMethodology {
  const record = (parsed ?? {}) as Record<string, unknown>;
  const controls = record.controls;
  if (controls == null || typeof controls !== 'object' || Array.isArray(controls)) {
    return {
      shapes: new Map(),
      unavailable:
        'The catalogue version record for this build holds no per-requirement shapes, so what this ' +
        'version covers cannot be listed. It was written before the record held them.',
      ...(typeof record.scored_units === 'number' ? { scoredUnits: record.scored_units } : {}),
    };
  }

  const shapes = new Map<string, RecordedShape>();
  for (const [id, raw] of Object.entries(controls as Record<string, unknown>)) {
    shapes.set(id, shape(id, raw));
  }

  return {
    shapes,
    ...(typeof record.scored_units === 'number' ? { scoredUnits: record.scored_units } : {}),
  };
}

function shape(id: string, raw: unknown): RecordedShape {
  const one = (raw ?? {}) as Record<string, unknown>;
  return {
    id,
    pillar: text(one.pillar) ?? '',
    principle: text(one.principle) ?? '',
    title: text(one.title) ?? '',
    provenance: text(one.provenance) ?? '',
    severity: text(one.severity) ?? '',
    measurability: text(one.measurability) ?? '',
    coverage_mode: text(one.coverage_mode) ?? 'complete',
    alias_group: text(one.alias_group) ?? null,
    clouds: Array.isArray(one.clouds) ? one.clouds.filter((cloud): cloud is string => typeof cloud === 'string') : [],
    thresholds:
      one.thresholds != null && typeof one.thresholds === 'object' && !Array.isArray(one.thresholds)
        ? (one.thresholds as Record<string, unknown>)
        : null,
    ...(text(one.continues) != null ? { continues: text(one.continues) } : {}),
    preconditions: Array.isArray(one.preconditions) ? one.preconditions.map(precondition) : [],
  };
}

function precondition(raw: unknown): RecordedPrecondition {
  const one = (raw ?? {}) as Record<string, unknown>;
  return {
    signal: text(one.signal) ?? '',
    operator: text(one.operator) ?? '',
    ...(one.value !== undefined ? { value: one.value } : {}),
    outcome: text(one.outcome) ?? '',
    scope: text(one.scope) ?? 'segment',
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * What the loaded catalogue reads differently from the record, requirement by requirement.
 *
 * The comparison is the record's own field list, so a field the record does not hold is not compared
 * and a field it holds that this build has no equivalent for would be reported for every requirement
 * at once — which is the signal a reader wants when the record and the build come from different
 * releases of the app rather than from different edits of the catalogue.
 *
 * `thresholds` and `preconditions` are compared as canonical JSON rather than field by field. A
 * threshold moving from 0.95 to 0.9 and a threshold being renamed are both "this requirement is
 * judged against something else", and splitting them would put `thresholds.pass_share` on a page
 * whose vocabulary is the changelog's, which says `thresholds`.
 */
export interface Drift {
  /** Requirements in both, whose shape differs. Same shape as a changelog `changed` entry. */
  readonly changed: readonly FieldChange[];
  /** In the record and not in this build's catalogue. */
  readonly missing: readonly string[];
  /** In this build's catalogue and not in the record. */
  readonly unrecorded: readonly string[];
}

export const NO_DRIFT: Drift = { changed: [], missing: [], unrecorded: [] };

/** The live reading of a requirement, in the record's own terms, for comparison. */
export interface LiveShape {
  readonly id: string;
  readonly pillar: string;
  readonly principle: string;
  readonly title: string;
  readonly provenance: string;
  readonly severity: string;
  readonly measurability: string;
  readonly coverage_mode: string;
  readonly alias_group: string | null;
  readonly clouds: readonly string[];
  readonly thresholds: Readonly<Record<string, unknown>> | null;
  readonly preconditions: readonly RecordedPrecondition[];
}

export function driftBetween(recorded: RecordedMethodology, live: readonly LiveShape[]): Drift {
  if (recorded.shapes.size === 0) return NO_DRIFT;

  const byId = new Map(live.map((one) => [one.id, one]));
  const changed: FieldChange[] = [];
  const missing: string[] = [];

  for (const [id, was] of recorded.shapes) {
    const now = byId.get(id);
    if (now == null) {
      missing.push(id);
      continue;
    }
    const fields = differing(was, now);
    if (fields.length > 0) changed.push({ id, fields });
  }

  return {
    changed: changed.sort((a, b) => a.id.localeCompare(b.id)),
    missing: missing.sort(),
    unrecorded: live
      .map((one) => one.id)
      .filter((id) => !recorded.shapes.has(id))
      .sort(),
  };
}

function differing(was: RecordedShape, now: LiveShape): readonly string[] {
  const fields: string[] = [];
  const scalars = ['pillar', 'principle', 'title', 'provenance', 'severity', 'measurability', 'coverage_mode'] as const;
  for (const field of scalars) {
    if (was[field] !== now[field]) fields.push(field);
  }
  if (was.alias_group !== now.alias_group) fields.push('alias_group');
  if (canonical([...was.clouds].sort()) !== canonical([...now.clouds].sort())) fields.push('clouds');
  if (canonical(was.thresholds) !== canonical(now.thresholds)) fields.push('thresholds');
  if (canonical(was.preconditions) !== canonical(now.preconditions)) fields.push('preconditions');
  return fields;
}

/**
 * A value as a string that depends on its content and not on key order.
 *
 * The bump script's own `canonical`, restated because that script is deliberately standalone — it has
 * to run without the server build, so nothing here can be imported into it and importing it here
 * would make a check the repository depends on depend on a compiled bundle. The two are held together
 * by `methodology-agreement.test.ts`, which drives the real script and reads the result back through
 * this module, on the same reasoning as `changelog-agreement.test.ts` next door.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
