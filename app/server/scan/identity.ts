// What produced a run, beyond who ran it and when.
//
// The stamp already recorded the observer — identity, mode, scope, window — and the catalogue the
// questions came from. That is enough to refuse a comparison across a change of observer, and not
// enough to reproduce a score. Two runs a month apart against an unchanged estate can differ because
// a resolver was corrected, because the weighting changed, or because one of them read a surface the
// other could not, and the record held none of those.
//
// So each axis here is something that changes what the numbers mean, recorded as what it was or as
// why this build could not establish it. The distinction matters more than it looks: an axis this
// app tried to read and failed on is a reason to refuse a comparison, while an axis it never
// recorded is a reason to qualify one, and collapsing the two either destroys a customer's history
// or claims an equality nobody established.
//
// Two axes the audit names are deliberately absent, because adding them would mean asserting
// something this build has not established:
//
// The **framework edition**. The catalogue is seeded from the Databricks Well-Architected pages, and
// those pages carry no version. There is no value to read, so a field here could only hold a
// constant somebody remembered to bump — which would state that the framework had not moved when
// what is true is that nobody checked. `catalogueFingerprint` already refuses a comparison when our
// reading of the framework changed, which is the part this app can be held to.
//
// The **severity policy**. Which requirements are critical and what each is judged against are
// per-requirement fields inside the catalogue, and `catalogue-version.mjs` fingerprints exactly
// those — severity, measurability, thresholds, preconditions. A separate policy axis would be a
// second name for that digest, and two names for one fact eventually disagree.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignalResult } from '../collect/signal.js';
import { CREDIT, SEVERITY_WEIGHT } from '../score/score.js';
import { CODEC_VERSION } from './codec.js';
import type { Surface } from './surfaces.js';

/**
 * One dimension of what produced a run: what it was, or why it is not known.
 *
 * Never both, and never neither. Encoded as two optional fields rather than a tagged union because
 * this is written to a JSON column and read back by a decoder that has to survive both shapes; a
 * discriminator would be a third thing to keep in step for no gain at the call sites, which all ask
 * the same two questions — is it known, and is it the same as the other one.
 */
export interface Axis {
  /** What it was. Absent when this build could not establish it. */
  readonly id?: string;
  /** Why it could not be established, in the reader's terms. Absent when it was. */
  readonly unknown?: string;
}

/** Where a reading came from, as a run reports it. */
export type RunSource = Surface | 'import';

/**
 * What produced a run.
 *
 * Recorded on every run and compared selectively, which is the distinction to hold on to: a snapshot
 * exists so a score can be reproduced and explained, and only some of what it takes to reproduce a
 * score changes what that score means.
 */
export interface RunIdentity {
  /**
   * The code that turned readings into findings: this app's version, and a digest of the bundle that
   * ran.
   *
   * Both, because neither alone answers the question. The version is what a person says out loud and
   * it moves only when somebody remembers to move it. The digest moves whenever the shipped server
   * changes, which is what a reader comparing two scores actually needs to know.
   */
  readonly build: Axis;
  /**
   * A digest of the weighting and the credit each outcome earns.
   *
   * Derived from the tables themselves rather than a version constant, for the reason the catalogue
   * fingerprint exists: a number a human maintains is a number that will be wrong, and rescaling
   * every score in the product is the last place to find that out.
   */
  readonly methodology: Axis;
  /** The encoding the run is written down under, so a decoded score says what it was decoded from. */
  readonly record: Axis;
  /**
   * Which surfaces answered, sorted.
   *
   * A run with no warehouse bound and a run with one do not measure the same estate, and the
   * difference shows up as unmeasurable counts rather than as a wrong score — but a reader comparing
   * two runs has to be told, because "twelve requirements stopped being measurable" reads as an
   * estate that lost a grant when what happened is that a binding went missing.
   */
  readonly sources: readonly RunSource[];
  /**
   * The requirements a customer's applicability decisions took out of the score's denominator, and by
   * which lever, sorted. One entry per requirement, written `SEC-01-01:not-applicable` by
   * {@link exclusionKeys} — control ids carry no colon, so the first one separates the two.
   *
   * Not the reasons: which requirements moved is what changes what the score is out of, and the reasons
   * are the export's to list. Only the excluded ones — a *lapsed* decision left its requirement in the
   * score, so it did not move the denominator and is not here.
   *
   * The lever is here because it is a second thing that moves without the estate moving. It does not
   * change what the score is out of; both levers take the requirement out of the weighted average. It
   * changes the *range*: `disabled` widens it, because a check switched off is something that could have
   * been measured, and `not-applicable` does not, because a requirement that does not apply is not a gap
   * in knowledge. That is what 31c measured, and it is written at the top of `apply/apply.ts` beside the
   * code that does it. So the ids alone left a decision switched from one lever to the other comparing
   * equal, and two runs whose ranges differ for that reason were drawn as a trend.
   *
   * Absent is a fact, not an unknown, and that is the one place this axis parts from the others in this
   * file. Applicability postdates every run recorded without the field, and a run from before the
   * feature existed could not have excluded anything — so `exclusionRefusal` reads absent as the empty
   * set rather than qualifying the comparison, and two such runs compare cleanly. A run *with* the
   * feature records the set it used, empty or not, so a later comparison has something to compare. An
   * entry with no lever on it is a run recorded before the lever was kept: `exclusionRefusal` compares
   * levers only where both runs carry one, so upgrading does not read as every decision having changed.
   */
  readonly exclusions?: readonly string[];
}

/**
 * The identity entry for each requirement a run's decisions excluded, sorted.
 *
 * One function rather than the same `map` in the two places that write the field — a scan and the merge
 * of a targeted rerun — because the two producing different spellings of the same fact would make every
 * comparison across them refuse.
 */
export function exclusionKeys(
  excluded: readonly { readonly controlId: string; readonly lever: string }[]
): readonly string[] {
  return [...excluded].map((one) => `${one.controlId}:${one.lever}`).sort();
}

/** Which assessment definition, and which of its versions, a run answers to. */
export interface RunDefinition {
  readonly id: string;
  readonly version: number;
  /**
   * The fingerprint of that version's measurement.
   *
   * Carried rather than looked up, because a comparison has to work when the definition has been
   * revised since, and because the fingerprint is the thing being compared: two runs at the same
   * fingerprint asked the same question of the same estate whatever the version numbers say.
   */
  readonly fingerprint: string;
  /**
   * What the assessment was called when this run answered to it.
   *
   * Carried for the same reason as the fingerprint and for a different audience: the fingerprint is
   * what a comparison turns on, and this is what a person reading a six-month-old run is told it was.
   * Looking the name up at read time would relabel that run with a name nobody used then, and would
   * show nothing at all once the definition is deleted.
   *
   * It is not part of any comparison — {@link definitionBarrier} decides on the fingerprint, so a
   * rename does not break a trend, which is ADR 0037's property and this field does not spend it.
   *
   * Absent on a run recorded before the app kept it. That is not the same as a run answering to no
   * assessment, which is `definition` itself being absent.
   */
  readonly name?: string;
}

/**
 * The digest of the two tables that decide how findings become a score.
 *
 * Computed once at module load. Both tables are frozen constants, so the digest cannot change while
 * a process runs, and recomputing it per scan would suggest otherwise.
 *
 * Exported because the methodology surface serves the two tables and this identifier beside them: a
 * reader holding a run whose `identity.methodology` does not match this is looking at a score
 * computed by a weighting the app has since changed, and that is the whole reason the axis exists.
 * Recomputing it there would be a second definition of the same digest.
 */
export const METHODOLOGY = digest({ credit: CREDIT, severityWeight: SEVERITY_WEIGHT });

/**
 * A digest over a value, with object keys sorted so the result depends on content and not on the
 * order a literal happened to be written in.
 */
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The app's version and the digest of the server bundle that ran.
 *
 * The bundle rather than the source tree, because the bundle is what the platform executes: a
 * deploy-from-Git install runs `dist/server.js` and never compiles anything. That has one honest
 * limitation, which is stated here so it is not discovered later — under `npm run dev` the process
 * runs from `server/**` and this digest describes the committed bundle sitting beside it, which is
 * the same file for anybody who has bundled and a stale one for anybody mid-change. It is a reason
 * to qualify a comparison rather than refuse one, and `identityBarriers` treats it that way.
 *
 * The client bundle is deliberately not included. It decides what a reader sees and nothing about
 * what a score is, so folding it in would qualify comparisons over a corrected label.
 */
export function buildIdentity(moduleUrl: string = import.meta.url): Axis {
  const root = appRoot(moduleUrl);
  if (root == null) {
    return { unknown: 'The app root could not be located, so the build that produced this run is not recorded.' };
  }

  const version = versionOf(join(root, 'package.json'));
  const bundle = join(root, 'dist', 'server.js');
  if (!existsSync(bundle)) {
    // A tree that has never been bundled. Honest rather than guessed: the version alone would say
    // two runs came from the same build when one of them ran uncommitted work.
    return {
      unknown:
        `No dist/server.js was found under ${root}, so the code that produced this run cannot be ` +
        `identified beyond version ${version ?? 'unknown'}.`,
    };
  }

  const fingerprint = digestOfFile(bundle);
  return { id: `${version ?? 'unknown'}+${fingerprint.slice('sha256:'.length, 'sha256:'.length + 12)}` };
}

function versionOf(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function digestOfFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/**
 * The directory holding `package.json`, found by searching upwards.
 *
 * The same approach as `shipped-config.ts` and for the same reason: this module runs from
 * `server/scan/` under tsx and from `dist/` in the bundle, so a path computed from a depth is
 * correct in one of them and silently wrong in the other.
 */
function appRoot(moduleUrl: string): string | undefined {
  let here = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(join(here, 'package.json'))) return here;
    const parent = resolve(here, '..');
    if (parent === here) return undefined;
    here = parent;
  }
}

/**
 * What produced this run, assembled from the readings it made.
 *
 * `sources` comes from the readings rather than from what was configured, because what a run could
 * have read and what answered are different facts and only the second one is evidence.
 */
export function runIdentity(
  signals: readonly SignalResult[],
  options: {
    /**
     * The requirements this run took out of the score's denominator, in any order. Recorded even when
     * empty, so a later run can tell "nothing was excluded" from "recorded before the field existed".
     */
    readonly exclusions?: readonly string[];
    readonly moduleUrl?: string;
  } = {}
): RunIdentity {
  return {
    build: options.moduleUrl == null ? buildIdentity() : buildIdentity(options.moduleUrl),
    methodology: { id: METHODOLOGY },
    record: { id: `codec-${String(CODEC_VERSION)}` },
    sources: sourcesOf(signals),
    exclusions: [...(options.exclusions ?? [])].sort(),
  };
}

/**
 * The surfaces that produced a reading, sorted.
 *
 * Only readings that observed something. A refused probe still names the surface it would have read,
 * and counting those would report every run as having read everything — which is the opposite of
 * what this field is for.
 */
export function sourcesOf(signals: readonly SignalResult[]): readonly RunSource[] {
  const found = new Set<RunSource>();
  for (const signal of signals) {
    if (signal.status !== 'observed') continue;
    const provenance = signal.provenance;
    if (provenance == null) continue;
    found.add(provenance.authority === 'admin-cli' ? 'import' : provenance.surface);
  }
  return [...found].sort();
}

// Kept as re-exports for the identity-focused tests and call sites. The implementation lives beside
// the shared stamp contract so the browser and server cannot answer the same comparison differently.
export { definitionBarrier, identityBarriers, type IdentityBarriers } from '../../shared/api/comparability.js';
