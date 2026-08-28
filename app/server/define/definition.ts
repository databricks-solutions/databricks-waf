// What this assessment is an assessment of, written down before it runs.
//
// Until now the app ran one implicit assessment whose scope was whatever the calling identity
// happened to be able to read. That is not a scope, it is a side effect, and it leaves two
// questions unanswerable. "What was in this review?" has no answer beyond a list of workspaces
// the app discovered after the fact. "Who agreed to that?" has no answer at all.
//
// A definition answers both by being written first and stamped on the run. It is versioned,
// because the alternative is editing the thing a finished assessment claims to have been about.
//
// The split between what a version fingerprints and what it merely records is the design here,
// and it is worth being exact about, because getting it the obvious way round makes the feature
// hostile. `Measurement` is what decides the answer: which workspaces, how far back, which
// pillars. `Attribution` is who owns the answer and why it was asked for. Both are versioned —
// a change of owner is a governance event and the history should hold it — but only `Measurement`
// is fingerprinted. So correcting a typo in a name leaves the fingerprint alone and the trend
// line intact, while adding a workspace changes it and the trend refuses. Fingerprinting the
// whole document instead would mean a spelling correction silently ended the customer's history,
// which nobody would report as a bug and everybody would work around by never editing anything.
//
// See ADR 0037.

import { digestOf, type Digest } from '../records/digest.js';
import type { WorkspaceDirectory, WorkspaceRow } from '../collect/sql/shapes.js';

/**
 * Which workspaces the assessment is about.
 *
 * Account reach stays available and stays the default, because it is the right answer for the
 * account admin this app is built for and because narrowing on a guess was a mistake this project
 * has already made once (see `estate-scope.ts`). What it is not is a *scope*: it means "whatever
 * the identity can see", which changes when a grant changes and takes the meaning of the score
 * with it. A selected set is a claim the app can be held to.
 */
export type DefinitionScope =
  | { readonly kind: 'account' }
  | {
      readonly kind: 'selected';
      /** Sorted and deduplicated, so two definitions asking for the same estate fingerprint alike. */
      readonly workspaceIds: readonly string[];
    };

/** The configuration that decides what the answer is. Changing any of it changes the fingerprint. */
export interface Measurement {
  readonly scope: DefinitionScope;
  readonly lookbackDays: number;
  /**
   * The pillars in the assessment, or absent for all of them.
   *
   * Absent rather than a list of all seven, because "everything" and "everything that exists
   * today" are different claims: a definition written now and run after an eighth pillar is added
   * should cover the eighth if it said everything, and should not if it named seven.
   */
  readonly pillars?: readonly string[];
}

/** Who owns the assessment and why it exists. Versioned, but not fingerprinted. */
export interface Attribution {
  readonly name: string;
  /** Why this assessment is being run, in the author's words. */
  readonly purpose?: string;
  /**
   * The people accountable for the result, as the identities the platform knows them by.
   *
   * A list rather than one owner because the reviews this is for are signed off by more than one
   * person, and an empty list is allowed: an assessment nobody has claimed yet is a real state,
   * and refusing to record one would push authors into naming a placeholder.
   */
  readonly owners: readonly string[];
}

/**
 * A score this customer has committed to reaching in one pillar, by a date.
 *
 * The commitment is theirs. This build has no opinion about what a good score is and cannot have one:
 * a 62 in cost optimisation is a different fact in a research estate than in a regulated one, and a
 * benchmark invented here would be an invented benchmark shown next to a real measurement. So a target
 * exists only because somebody set it, and the surfaces report against it rather than against a bar
 * this app chose.
 *
 * `atLeast` rather than `score`, because a `PillarTarget.score` sitting next to a `PillarScore.score`
 * is two different numbers under one name — one measured, one promised — and every reader of either
 * would have to check which they had. The name says the comparison as well as the value.
 */
export interface PillarTarget {
  readonly pillar: string;
  /**
   * The score committed to, in the units the app reports: 0–100, severity-weighted. See `score.ts`.
   *
   * The same scale as the number it is held against, deliberately. A target expressed as a count of
   * requirements would need translating before it could be compared, and the translation would move
   * when the catalogue did — so a commitment made once would quietly mean something else next quarter.
   */
  readonly atLeast: number;
  /**
   * When they undertook to have reached it.
   *
   * A date that has already passed is allowed, and not only for tolerance of typos: an assessment is
   * usually written for a programme that is already running, and refusing the dates it has already set
   * would force the author to either lie about them or leave them out. What a passed date does is
   * change what the surface says, not whether the target can be recorded — see `programme/targets.ts`.
   */
  readonly by: Date;
}

export interface DefinitionVersion {
  /** 1 for the first, and one higher for each revision. Never reused, never renumbered. */
  readonly version: number;
  /** Over the measurement alone, so a rename does not end a trend. */
  readonly fingerprint: Digest;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly measurement: Measurement;
  readonly attribution: Attribution;
  /**
   * What this assessment has committed to, per pillar. Absent when nothing was committed.
   *
   * A third thing beside measurement and attribution rather than folded into either, and the reason is
   * the split this file's header describes. It cannot go in `Measurement`: that is fingerprinted, so
   * setting a target would end the customer's trend line — the one consequence guaranteed to make
   * somebody stop setting targets. And it does not belong in `Attribution` either, which answers who
   * owns the result and why it was asked for. A commitment is a third kind of fact: not what is
   * measured, not who is accountable, but what they said they would reach.
   *
   * Versioned like both of them, because moving a date or lowering a bar is a governance event and the
   * history is the only place that can hold it. A target stored outside the version would be editable
   * without trace, and "the target was always 70" is not a claim a reader should have to take on faith.
   */
  readonly targets?: readonly PillarTarget[];
  /** What the author says changed and why. Absent on the first version, which changed nothing. */
  readonly note?: string;
}

export interface AssessmentDefinition {
  readonly id: string;
  /** Every version, oldest first. The last is current; the rest are what finished runs point at. */
  readonly versions: readonly DefinitionVersion[];
  /**
   * When this definition stopped being offered for new runs.
   *
   * Archived rather than deleted, because runs reference a version and a reference to a row that
   * has been removed is worse than a reference to one marked closed — the report would have to say
   * the assessment was of something unknown.
   */
  readonly archivedAt?: Date;
}

export const MIN_LOOKBACK_DAYS = 1;
export const MAX_LOOKBACK_DAYS = 365;

export class DefinitionError extends Error {}

/**
 * The measurement in the exact shape the fingerprint is taken over.
 *
 * Sorted and stripped of anything absent, so that a definition assembled in a different field
 * order, or with `pillars: undefined` present as a key, fingerprints the same. Without this the
 * hash would depend on how the object was built, which is the failure `canonical.ts` exists to
 * stop for stored records and which arrives here by the same route.
 */
function fingerprintable(measurement: Measurement): unknown {
  const scope =
    measurement.scope.kind === 'account'
      ? { kind: 'account' }
      : { kind: 'selected', workspaceIds: [...new Set(measurement.scope.workspaceIds)].sort() };
  return {
    lookbackDays: measurement.lookbackDays,
    ...(measurement.pillars != null ? { pillars: [...new Set(measurement.pillars)].sort() } : {}),
    scope,
  };
}

/** What two runs compare on. Equal fingerprints mean the same question of the same estate. */
export function fingerprintOf(measurement: Measurement): Digest {
  return digestOf(fingerprintable(measurement));
}

/**
 * A measurement with its sets in canonical form, as it should be stored.
 *
 * The fingerprint would be stable without this, since it canonicalises on the way in. Storing the
 * canonical form as well means the value a reader sees and the value that was hashed are the same
 * thing, rather than two representations that happen to agree.
 */
function normalise(measurement: Measurement): Measurement {
  if (!Number.isInteger(measurement.lookbackDays)) {
    throw new DefinitionError('A lookback is a whole number of days.');
  }
  if (measurement.lookbackDays < MIN_LOOKBACK_DAYS || measurement.lookbackDays > MAX_LOOKBACK_DAYS) {
    throw new DefinitionError(
      `A lookback of ${String(measurement.lookbackDays)} days is outside the ${String(MIN_LOOKBACK_DAYS)} to ${String(MAX_LOOKBACK_DAYS)} the system tables retain.`,
    );
  }
  if (measurement.pillars != null && measurement.pillars.length === 0) {
    // An empty list would assess nothing while reading as a deliberate choice, and the shape
    // already has a way to say "all of them" that cannot be confused with it.
    throw new DefinitionError('An assessment of no pillars is not an assessment. Omit the list to cover all of them.');
  }
  if (measurement.scope.kind === 'selected' && measurement.scope.workspaceIds.length === 0) {
    throw new DefinitionError(
      'A selected scope with no workspaces in it would assess nothing. Choose at least one, or use account reach.',
    );
  }

  const scope: DefinitionScope =
    measurement.scope.kind === 'account'
      ? { kind: 'account' }
      : { kind: 'selected', workspaceIds: identifiers(measurement.scope.workspaceIds, 'workspace') };

  return {
    scope,
    lookbackDays: measurement.lookbackDays,
    ...(measurement.pillars != null ? { pillars: identifiers(measurement.pillars, 'pillar') } : {}),
  };
}

/**
 * A set of ids in canonical form: trimmed, deduplicated after trimming, sorted, none of them blank.
 *
 * Trimming matters more here than it looks. `' w1'` and `'w1'` are one estate under two fingerprints,
 * and a fingerprint is what two runs compare on — so an author who pasted a list with a stray space
 * gets a definition that can never be compared against the same definition typed by hand. Deduplicating
 * after the trim rather than before is the whole point: the two forms have to collapse into one.
 *
 * A blank id is refused rather than dropped. Dropping it would silently turn a selection of three
 * workspaces into a selection of two, at a stable fingerprint, which is the shape of error this module
 * exists to make impossible: a definition that persists a mistake and repeats it on every run while the
 * trend reads as healthy.
 *
 * What this does not check is whether the id names anything. That needs the catalogue for a pillar and
 * the account directory for a workspace, and neither belongs to a domain object that has to be
 * constructible from a stored row without reading either. The routes check existence; see
 * `definition-routes.ts`.
 */
function identifiers(values: readonly string[], kind: 'workspace' | 'pillar'): readonly string[] {
  const trimmed = values.map((value) => value.trim());
  if (trimmed.some((value) => value === '')) {
    throw new DefinitionError(`A blank ${kind} id is not a ${kind}. Remove it, or name the one that was meant.`);
  }
  return [...new Set(trimmed)].sort();
}

export const MIN_TARGET = 1;
export const MAX_TARGET = 100;

/**
 * The targets in canonical form, checked against the measurement they are targets of.
 *
 * Sorted by pillar so two definitions committing to the same thing store it the same way, which
 * matters here for the same reason it matters for workspace ids even though these are not
 * fingerprinted: a reader comparing two versions should see a reordering as no change.
 *
 * The cross-check is the point of taking the measurement. A target for a pillar the assessment does
 * not measure can never be reported against — the run produces no score for it — so it would sit in
 * the document looking like a commitment and behaving like nothing. That is worse than being refused,
 * because the author believes they have set it.
 */
function normaliseTargets(targets: readonly PillarTarget[], measurement: Measurement): readonly PillarTarget[] {
  const measured = measurement.pillars == null ? undefined : new Set(measurement.pillars);
  const seen = new Set<string>();
  const kept: PillarTarget[] = [];

  for (const target of targets) {
    const pillar = target.pillar.trim();
    if (pillar === '') {
      throw new DefinitionError('A target names the pillar it is a target for, and this one names none.');
    }
    if (seen.has(pillar)) {
      // Refused rather than last-one-wins. Two targets for one pillar is somebody's mistake either way,
      // and silently keeping one of them decides which of two numbers the customer committed to.
      throw new DefinitionError(
        `There are two targets for ${pillar}. A pillar has one target, so say which of them is meant.`,
      );
    }
    seen.add(pillar);

    if (measured != null && !measured.has(pillar)) {
      throw new DefinitionError(
        `This assessment does not measure ${pillar}, so a target for it could never be reported against. ` +
          'Add the pillar to the assessment, or drop the target.',
      );
    }

    if (!Number.isInteger(target.atLeast)) {
      // Whole points only. The score is reported rounded, so a target of 80.5 is a bar the surface can
      // never say was met exactly and a distinction no reader of the number can see.
      throw new DefinitionError(`A target is a whole number of points, and ${String(target.atLeast)} is not.`);
    }
    if (target.atLeast < MIN_TARGET || target.atLeast > MAX_TARGET) {
      // Zero is excluded at the bottom on purpose: every estate already meets it, so it is not a
      // commitment, and a row reading "met" against a target nobody could miss devalues the ones that
      // mean something.
      throw new DefinitionError(
        `A target of ${String(target.atLeast)} is outside the ${String(MIN_TARGET)} to ${String(MAX_TARGET)} a score can be.`,
      );
    }

    if (Number.isNaN(target.by.getTime())) {
      throw new DefinitionError(`The date on the ${pillar} target is not a date.`);
    }

    kept.push({ pillar, atLeast: target.atLeast, by: target.by });
  }

  return kept.sort((a, b) => a.pillar.localeCompare(b.pillar));
}

function normaliseAttribution(attribution: Attribution): Attribution {
  const name = attribution.name.trim();
  if (name === '') throw new DefinitionError('An assessment needs a name somebody can ask for it by.');
  const purpose = attribution.purpose?.trim();
  return {
    name,
    ...(purpose != null && purpose !== '' ? { purpose } : {}),
    owners: [...new Set(attribution.owners.map((owner) => owner.trim()).filter((owner) => owner !== ''))].sort(),
  };
}

export interface Draft {
  readonly measurement: Measurement;
  readonly attribution: Attribution;
  /** What this assessment commits to. Absent and empty both mean nothing was committed. */
  readonly targets?: readonly PillarTarget[];
}

/**
 * The person a version is attributed to, which cannot be nobody.
 *
 * `normaliseAttribution` already refuses a blank name, and this field has a stronger claim to the same
 * check: the name is what an assessment is called, and this is who decided what it measures. An empty
 * string satisfies the type and defeats the feature — a version history whose author column is blank
 * answers none of the questions a version history exists to answer.
 *
 * Refused rather than replaced with "unknown". A caller that does not know who is acting has a bug in
 * its authorization, and every route reaching here has already established an actor in order to be
 * allowed to call it. Substituting a placeholder would hide that.
 */
function attributedTo(createdBy: string): string {
  const actor = createdBy.trim();
  if (actor === '') {
    throw new DefinitionError('A version records who decided it, and no one was named.');
  }
  return actor;
}

/** A new definition at version 1. */
export function define(draft: Draft, id: string, createdAt: Date, createdBy: string): AssessmentDefinition {
  const measurement = normalise(draft.measurement);
  const targets = normaliseTargets(draft.targets ?? [], measurement);
  return {
    id,
    versions: [
      {
        version: 1,
        fingerprint: fingerprintOf(measurement),
        createdAt,
        createdBy: attributedTo(createdBy),
        measurement,
        attribution: normaliseAttribution(draft.attribution),
        // Absent rather than an empty array, so "committed to nothing" is one shape rather than two.
        // A stored `targets: []` and an absent key would answer the same question differently to
        // anything that checks the key rather than the length.
        ...(targets.length > 0 ? { targets } : {}),
      },
    ],
  };
}

export function currentVersion(definition: AssessmentDefinition): DefinitionVersion {
  const current = definition.versions.at(-1);
  // A definition with no versions cannot be constructed by anything here, so reaching this means
  // a stored row was truncated — which is worth failing loudly rather than returning a shape the
  // caller will read fields off.
  if (current == null) throw new DefinitionError(`Definition ${definition.id} has no versions.`);
  return current;
}

export interface Revision {
  readonly measurement?: Measurement;
  readonly attribution?: Attribution;
  /**
   * The targets this version commits to, replacing whatever the last one had.
   *
   * Replacement rather than a patch, and an empty list is how a target is withdrawn. A per-pillar
   * delta would need a way to say "remove this one", which is a second vocabulary for a document the
   * author is editing whole in front of them. What makes replacement safe here is that the previous
   * version keeps its own copy: withdrawing a target does not erase that it was once made.
   */
  readonly targets?: readonly PillarTarget[];
  readonly note?: string;
}

/**
 * The same definition with one more version on the end.
 *
 * Refuses a revision that changes nothing, because a version that differs from its predecessor
 * only in timestamp tells a later reader that something was decided when nothing was, and a
 * history of those is a history nobody reads.
 */
export function revise(
  definition: AssessmentDefinition,
  revision: Revision,
  createdAt: Date,
  createdBy: string,
): AssessmentDefinition {
  if (definition.archivedAt != null) {
    throw new DefinitionError(
      `Assessment "${currentVersion(definition).attribution.name}" was archived, so it cannot be revised. Copy it instead.`,
    );
  }

  const author = attributedTo(createdBy);
  const current = currentVersion(definition);
  const measurement = revision.measurement != null ? normalise(revision.measurement) : current.measurement;
  const attribution =
    revision.attribution != null ? normaliseAttribution(revision.attribution) : current.attribution;
  // Re-checked against the new measurement even when the revision does not mention targets, because a
  // revision that drops a pillar would otherwise carry a target for something no longer measured — the
  // exact state `normaliseTargets` refuses on the way in. Failing here says which pillar and why, which
  // is more use than a target that silently stops being reportable.
  const targets = normaliseTargets(revision.targets ?? current.targets ?? [], measurement);

  if (
    same(measurement, current.measurement) &&
    same(attribution, current.attribution) &&
    same(targets, current.targets ?? [])
  ) {
    throw new DefinitionError('That revision would change nothing.');
  }

  const note = revision.note?.trim();
  return {
    ...definition,
    versions: [
      ...definition.versions,
      {
        version: current.version + 1,
        fingerprint: fingerprintOf(measurement),
        createdAt,
        createdBy: author,
        measurement,
        attribution,
        ...(targets.length > 0 ? { targets } : {}),
        ...(note != null && note !== '' ? { note } : {}),
      },
    ],
  };
}

/** Compared as canonical bytes, so field order and set order do not decide whether this is a change. */
function same(a: unknown, b: unknown): boolean {
  return digestOf(a) === digestOf(b);
}

/**
 * Retire a definition from the list of things a new run can be started against.
 *
 * Idempotent, and it keeps the *first* date: archiving twice is a second click on a button whose
 * effect already happened, and moving the date would rewrite when the decision was taken.
 */
export function archive(definition: AssessmentDefinition, at: Date): AssessmentDefinition {
  if (definition.archivedAt != null) return definition;
  return { ...definition, archivedAt: at };
}

/**
 * Put an archived definition back, by forgetting that it was archived.
 *
 * The date is dropped rather than kept beside a flag, because `archivedAt` is the whole
 * representation of the state and a definition holding the date it was once archived would read as
 * archived to every caller that asks the obvious question. What was archived and when is in the
 * audit log, which is where a history belongs — the definition carries what is true now.
 *
 * Nothing about the versions changes. Archiving never removed them, so there is nothing to restore:
 * a run stamped with version 3 still resolves version 3 either way, and this only decides whether
 * the definition appears among the things a new run can be started against.
 */
export function unarchive(definition: AssessmentDefinition): AssessmentDefinition {
  if (definition.archivedAt == null) return definition;
  const { archivedAt: _was, ...rest } = definition;
  return rest;
}

/**
 * Why a workspace the definition named is not in the assessment.
 *
 * The three are not interchangeable, and the third is the reason this type exists rather than a
 * boolean. `not-running` and `other-region` are answers: the workspace is there and here is what
 * is true of it. `unknown` is the absence of an answer — the workspace is not in the directory at
 * all, which happens when it was cancelled and also when the scanning identity lost the grant that
 * let it see the workspace. Those are opposite events. One means the estate shrank, the other
 * means the observer did, and this app cannot tell them apart from here. Reporting either as
 * "excluded" would state a fact that was not measured.
 */
export type OmissionReason = 'not-running' | 'other-region' | 'unknown';

export interface OmittedWorkspace {
  readonly workspaceId: string;
  /** Absent when the reason is `unknown`, because the directory is where a name would come from. */
  readonly name?: string;
  readonly status?: string;
  readonly reason: OmissionReason;
}

/**
 * What a definition's scope turns out to cover, once held against the estate as it is now.
 *
 * A definition names workspaces when it is written and runs later, so the two can disagree, and
 * every field here exists because of a way they disagree. The distinction the implicit scope could
 * not draw is `omitted` against `outOfScope`: today a workspace missing from an assessment is
 * "excluded" whether the author left it out on purpose or the app could not reach it. Those read
 * the same in a report and mean opposite things to whoever has to act on it.
 */
export interface ScopeResolution {
  readonly assessed: readonly WorkspaceRow[];
  /** Named by the definition, not assessed, each with which of the three reasons applies. */
  readonly omitted: readonly OmittedWorkspace[];
  /** Assessable, and deliberately not asked for. Empty under account reach, which asks for all. */
  readonly outOfScope: readonly WorkspaceRow[];
  /**
   * Assessed, with no evidence of which region they bill from.
   *
   * Carried because region is not read from a workspace record — it is inferred from SKU names in
   * `system.billing.usage` over the lookback window, so a workspace that spent nothing in that window
   * has no region and a short window can leave every workspace without one. The estate summary says
   * this under account reach; without it here, a selected scope's description read as unqualified fact
   * about a set the app could not fully place. See `collect/sql/region.ts`.
   */
  readonly regionUnverified: readonly WorkspaceRow[];
  /**
   * Set when the home region itself could not be established, which is the worse case of the above.
   *
   * `scopedToRegion` filters nothing when it cannot find a home region, so every workspace in the
   * account stays in scope and every one of them is region-unverified. An assessment that says it
   * covered five workspaces may then be reading across regions that bill separately, and the
   * description has to say so — this is the flag that makes it say it rather than a count that happens
   * to equal the total.
   */
  readonly homeRegionUndetermined?: boolean;
  /**
   * Why there was no directory to resolve against, when there was not.
   *
   * The directory table is in Public Preview and unreadable in some accounts, so this is a real state
   * and not a defensive branch. Without it the only way to call this function was with an empty
   * directory, and every named workspace came back `unknown` with "covers less than it claims" — which
   * blames the estate for a permission error. ADR 0015 refused that reading elsewhere and it is refused
   * here for the same reason: a gap in what the observer can see is not a gap in what exists.
   */
  readonly undeterminedReason?: string;
  /** Whether the assessment covers everything the definition claimed. */
  readonly complete: boolean;
  /** Shown verbatim, so what was covered reads as fact rather than as a caveat. */
  readonly description: string;
}

/**
 * The definition's scope, resolved against the directory the scan just read.
 *
 * Order matters in one place worth naming: a named workspace is looked up in the whole directory
 * before it is called unknown, so a cancelled workspace is reported as cancelled rather than as
 * missing. The `live` set alone would have collapsed all three omission reasons into one.
 */
export function resolveScope(
  measurement: Measurement,
  directory: WorkspaceDirectory | undefined,
  undeterminedReason?: string
): ScopeResolution {
  if (directory == null) {
    // Not complete and not a claim about the estate. Every set is empty because nothing was read, which
    // is a different statement from "nothing is there" and has to read differently.
    return {
      assessed: [],
      omitted: [],
      outOfScope: [],
      regionUnverified: [],
      undeterminedReason: undeterminedReason ?? UNREADABLE_DIRECTORY,
      complete: false,
      description: undeterminedDescription(measurement, undeterminedReason),
    };
  }

  const unverified = directory.regionUnverified;
  const undetermined = directory.homeRegion == null;

  if (measurement.scope.kind === 'account') {
    return {
      assessed: directory.live,
      // Under account reach nothing was named, so nothing can be missing from what was named.
      // The workspaces the directory excluded are still reported — by the estate summary, which
      // is where they belong, because they are facts about the estate and not about this scope.
      omitted: [],
      outOfScope: [],
      regionUnverified: unverified,
      ...(undetermined ? { homeRegionUndetermined: true } : {}),
      complete: true,
      description: accountDescription(directory),
    };
  }

  const wanted = new Set(measurement.scope.workspaceIds);
  const byId = new Map(directory.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
  const liveIds = new Set(directory.live.map((workspace) => workspace.workspaceId));
  const excludedById = new Map(directory.excluded.map((workspace) => [workspace.workspaceId, workspace]));

  const assessed = directory.live.filter((workspace) => wanted.has(workspace.workspaceId));
  const outOfScope = directory.live.filter((workspace) => !wanted.has(workspace.workspaceId));

  const omitted: OmittedWorkspace[] = [];
  for (const id of [...wanted].sort()) {
    if (liveIds.has(id)) continue;
    const excluded = excludedById.get(id);
    if (excluded != null) {
      omitted.push({ workspaceId: id, name: excluded.name, status: excluded.status, reason: excluded.reason });
      continue;
    }
    const known = byId.get(id);
    if (known != null) {
      // In the directory, neither live nor excluded. The parser does not produce this today, and a
      // future one that does should not have it read as a missing workspace.
      omitted.push({ workspaceId: id, name: known.name, status: known.status, reason: 'unknown' });
      continue;
    }
    omitted.push({ workspaceId: id, reason: 'unknown' });
  }

  // Only the assessed ones. A workspace left out of the scope on purpose has no region question to
  // answer, and counting it here would attach a caveat about workspaces this assessment is not of.
  const assessedIds = new Set(assessed.map((workspace) => workspace.workspaceId));
  const regionUnverified = unverified.filter((workspace) => assessedIds.has(workspace.workspaceId));

  return {
    assessed,
    omitted,
    outOfScope,
    regionUnverified,
    ...(undetermined ? { homeRegionUndetermined: true } : {}),
    complete: omitted.length === 0,
    description: selectedDescription({
      assessed: assessed.length,
      omitted,
      outOfScope: outOfScope.length,
      regionUnverified: regionUnverified.length,
      homeRegionUndetermined: undetermined,
    }),
  };
}

/**
 * The fallback reason, worded to claim nothing about why.
 *
 * "Could not be read" would name a cause this function does not know: the caller may have been refused
 * the grant, or may simply not have looked yet. Callers that know say so through `undeterminedReason`,
 * and the two readings need different remedies — one is a grant, the other is a scan.
 */
const UNREADABLE_DIRECTORY =
  'The account directory was not read, so what this scope covers is unknown rather than empty.';

/**
 * What to say when there was no directory.
 *
 * Names what was asked for, because that much is known and is the part an author can act on, and says
 * plainly that whether it was covered was not established. The reason is quoted when the caller has one
 * — "the workspace directory is in Public Preview and this account cannot read it" sends somebody
 * somewhere, and "unavailable" does not.
 */
function undeterminedDescription(measurement: Measurement, reason: string | undefined): string {
  const named =
    measurement.scope.kind === 'account'
      ? 'every workspace the scanning identity can see'
      : `${String(measurement.scope.workspaceIds.length)} named workspace${measurement.scope.workspaceIds.length === 1 ? '' : 's'}`;

  return (
    `This assessment covers ${named}, and how much of that was reached could not be established. ` +
    (reason ?? UNREADABLE_DIRECTORY)
  );
}

function accountDescription(directory: WorkspaceDirectory): string {
  const covered = directory.live.length;
  const workspaces = `${String(covered)} workspace${covered === 1 ? '' : 's'}`;
  return (
    `Assessed across every workspace the scanning identity can see — ${workspaces} at the time of the ` +
    'run. Because the scope is what the identity can read rather than a set that was chosen, a change ' +
    'to its grants changes what this assessment is of.'
  );
}

interface Coverage {
  readonly assessed: number;
  readonly omitted: readonly OmittedWorkspace[];
  readonly outOfScope: number;
  readonly regionUnverified: number;
  readonly homeRegionUndetermined: boolean;
}

function selectedDescription(coverage: Coverage): string {
  const { assessed, omitted, outOfScope } = coverage;
  const named = assessed + omitted.length;
  const head =
    `Assessed ${String(assessed)} of the ${String(named)} workspace${named === 1 ? '' : 's'} this ` +
    'assessment covers.';

  const tail: string[] = [];
  if (outOfScope > 0) {
    tail.push(
      `${String(outOfScope)} further workspace${outOfScope === 1 ? '' : 's'} in the account ` +
        `${outOfScope === 1 ? 'is' : 'are'} deliberately outside it.`,
    );
  }

  const missing = omitted.filter((one) => one.reason === 'unknown');
  const stopped = omitted.filter((one) => one.reason === 'not-running');
  const elsewhere = omitted.filter((one) => one.reason === 'other-region');

  if (stopped.length > 0) {
    tail.push(
      `${list(stopped)} ${stopped.length === 1 ? 'is' : 'are'} no longer running, so ${stopped.length === 1 ? 'it holds' : 'they hold'} nothing to assess.`,
    );
  }
  if (elsewhere.length > 0) {
    tail.push(
      `${list(elsewhere)} ${elsewhere.length === 1 ? 'is' : 'are'} in another region, which this deployment cannot read. A deployment there would cover ${elsewhere.length === 1 ? 'it' : 'them'}.`,
    );
  }
  // Two different facts share the `unknown` reason and cannot share a sentence. A workspace the
  // directory has a row for is present and unclassified; one it has no row for is absent. Saying "not
  // in the account directory at all" about the first contradicts the row this function just read, and a
  // description that misdescribes its own input is worse than a vaguer one. They are told apart by the
  // name: the row-present branch of `resolveScope` carries the directory's name and status, the
  // no-row branch has neither to carry.
  const unclassified = missing.filter((one) => one.name != null);
  const absent = missing.filter((one) => one.name == null);

  if (unclassified.length > 0) {
    tail.push(
      `${list(unclassified)} ${unclassified.length === 1 ? 'is' : 'are'} in the account directory, which ` +
        `does not say whether ${unclassified.length === 1 ? 'it is' : 'they are'} running. Until it does, ` +
        `${unclassified.length === 1 ? 'it was' : 'they were'} left out rather than assessed on a guess.`
    );
  }
  if (absent.length > 0) {
    // The reason `unknown` is not folded into the other two. Naming one cause would be a claim nobody
    // measured.
    tail.push(
      `${list(absent)} ${absent.length === 1 ? 'is' : 'are'} not in the account directory at all. ` +
        'That happens when a workspace is cancelled and when the scanning identity loses the grant to ' +
        'see it, and the two cannot be told apart from here — so this assessment covers less than it ' +
        'claims until somebody says which.'
    );
  }

  const regionClause = regionCaveat(coverage);
  if (regionClause != null) tail.push(regionClause);

  return [head, ...tail].join(' ');
}

/**
 * What to say about workspaces whose region was never established, if anything.
 *
 * Two sentences rather than one because the causes are different and so is the remedy. When the home
 * region itself is unknown nothing was filtered, so the risk is that the assessment silently spans
 * regions; when only some workspaces lack a region, the usual cause is that they spent nothing in the
 * lookback window, and a longer window fixes it. Saying "region unverified" without which of those it is
 * leaves a reader with a caveat and no action.
 */
function regionCaveat(coverage: Coverage): string | undefined {
  if (coverage.homeRegionUndetermined) {
    return (
      'Which region this deployment reads was not established, so no workspace was excluded for being ' +
      'in another one. If the account spans regions, this assessment may be reading across them.'
    );
  }
  const unverified = coverage.regionUnverified;
  if (unverified === 0) return undefined;
  return (
    `${String(unverified)} of ${String(coverage.assessed)} ${unverified === 1 ? 'was' : 'were'} assessed ` +
    'without confirming the region it bills from, which happens when a workspace spent nothing in the ' +
    'lookback window. A longer window would settle it.'
  );
}

/** Names where there are few enough to read, and a count where there are not. */
function list(workspaces: readonly OmittedWorkspace[]): string {
  const labels = workspaces.map((one) => one.name ?? one.workspaceId);
  if (labels.length > 3) return `${String(labels.length)} workspaces`;
  if (labels.length === 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1) ?? ''}`;
}
