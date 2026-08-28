// What changed between two catalogue versions.
//
// The refusal this exists to replace is honest and is also a product failure. A run scored against
// catalogue 9 and one scored against catalogue 10 currently compare as "these scans asked different
// questions", full stop — so on the month we ship a catalogue update, every customer's trend line
// resets, and they find out in front of their executives.
//
// The refusal is too coarse because most of the two catalogues is the same catalogue. Of 184
// controls, a release moves a handful; the rest asked the identical question of the identical estate
// and their answers are directly comparable. What the reader needs is not a refusal but a sentence:
// down four points, three of them because two new critical requirements arrived and one because a
// warehouse regressed.
//
// So the bump writes down what moved, and this reads it back. Nothing here infers: a rename is a
// rename because a control declared `continues`, and a version is comparable because an entry
// describes it. A version with no entry — one written before this record existed, or by a build
// newer than this one — is not guessed at, and the comparison across it is still refused. That is
// the same distinction `identity.ts` draws between an axis this build could not establish and one a
// run never recorded, and for the same reason: an equality nobody checked is worse than a gap
// somebody can see.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One control's move between two versions, in the terms a reader acts on. */
export interface ControlMove {
  readonly from: string;
  readonly to: string;
}

export interface FieldChange {
  readonly id: string;
  /** Which parts of the scoring shape moved: severity, thresholds, pillar, clouds, and so on. */
  readonly fields: readonly string[];
}

/**
 * What one catalogue version did to the one before it.
 *
 * `describes` is false for a version recorded before the changelog held shapes. Kept as an entry
 * rather than omitted, because "this version exists and what it changed was not written down" and
 * "this version is unknown to this build" are different facts and only the second is a reason to
 * distrust the build.
 */
export interface CatalogueChange {
  readonly version: string;
  readonly fingerprint: string;
  readonly recordedAt: string;
  readonly scoredUnits: number;
  readonly describes: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly ControlMove[];
  readonly changed: readonly FieldChange[];
}

/** The recorded history of the catalogue, oldest first. */
export interface CatalogueChangelog {
  readonly entries: readonly CatalogueChange[];
}

export const NO_CHANGELOG: CatalogueChangelog = { entries: [] };

/**
 * What separates two versions, or why it cannot be said.
 *
 * `describable` is the whole question a caller asks. When it is false the two runs are as
 * incomparable as they were before this module existed, and `why` says which version is missing —
 * which is more use than a refusal that names neither.
 */
export interface CatalogueSpan {
  readonly describable: boolean;
  readonly why?: string;
  /** Requirements the later catalogue has and the earlier did not. */
  readonly added: readonly string[];
  /** Requirements the earlier catalogue had and the later does not. */
  readonly removed: readonly string[];
  /** Earlier id to later id, composed across every version in between. */
  readonly renamed: ReadonlyMap<string, string>;
  /** Requirements present in both, whose scoring shape moved. */
  readonly changed: readonly FieldChange[];
  /** The versions crossed, later first, so a reader can be told which releases are involved. */
  readonly versions: readonly string[];
  /**
   * The fingerprint the record holds for the later endpoint's version.
   *
   * Carried so a caller can check it against the fingerprint the later run actually recorded. They
   * disagree when the changelog entry and the catalogue it claims to describe have parted company —
   * a hand-edited record, or a version bumped without the entry being rewritten — and a record that
   * does not describe the catalogue a run was scored against is not evidence about that run.
   */
  readonly recordedFingerprint?: string;
}

export function loadChangelog(directory: string): CatalogueChangelog {
  const path = join(directory, 'changelog.json');
  if (!existsSync(path)) return NO_CHANGELOG;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return NO_CHANGELOG;
    return {
      // An entry whose version is not a number is dropped rather than kept at whatever `order` makes
      // of it. Kept, a malformed entry coerces to version 0, which is finite, so it joins the set of
      // versions the gap check considers present — and a genuinely missing version 0 would be
      // reported as recorded on the strength of an entry that says nothing.
      entries: parsed
        .map(entry)
        .filter((one) => numbered(one.version))
        .sort((a, b) => order(a.version) - order(b.version)),
    };
  } catch {
    // An unreadable changelog is the state the app was in before one existed: comparisons across a
    // version change are refused. Failing to boot over it would trade a degraded trend for no app.
    return NO_CHANGELOG;
  }
}

function entry(raw: unknown): CatalogueChange {
  const one = (raw ?? {}) as Record<string, unknown>;
  return {
    // Written as a number by the bump script and read back as a string, because it is an identifier
    // here rather than a quantity: it is compared with a run's recorded version and printed.
    version: typeof one.version === 'number' || typeof one.version === 'string' ? String(one.version) : '',
    fingerprint: typeof one.fingerprint === 'string' ? one.fingerprint : '',
    recordedAt: typeof one.recordedAt === 'string' ? one.recordedAt : '',
    scoredUnits: typeof one.scored_units === 'number' ? one.scored_units : 0,
    describes: one.describes === true,
    added: ids(one.added),
    removed: ids(one.removed),
    renamed: Array.isArray(one.renamed)
      ? one.renamed
          .map((move) => move as Record<string, unknown>)
          .filter((move) => typeof move.from === 'string' && typeof move.to === 'string')
          .map((move) => ({ from: String(move.from), to: String(move.to) }))
      : [],
    changed: Array.isArray(one.changed)
      ? one.changed
          .map((change) => change as Record<string, unknown>)
          .filter((change) => typeof change.id === 'string')
          .map((change) => ({ id: String(change.id), fields: ids(change.fields) }))
      : [],
  };
}

function ids(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
}

function order(version: string): number {
  const parsed = Number(version);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function numbered(version: string): boolean {
  return version !== '' && Number.isFinite(Number(version));
}

/**
 * What lies between the catalogue a run was scored against and the catalogue a later run was.
 *
 * Directional: `later` and `earlier` are the two runs' versions in time order, and the answer is
 * expressed from the earlier catalogue's point of view, because that is the one whose findings have
 * to be carried across. Symmetric input would be a nicer signature and a worse answer — a control
 * "added" means the opposite depending on which way round it is read.
 */
export function spanBetween(changelog: CatalogueChangelog, earlier: string, later: string): CatalogueSpan {
  if (earlier === later) return { describable: true, added: [], removed: [], renamed: new Map(), changed: [], versions: [] };

  // `unknown` is what a run records when the version file could not be read, and it is not a point
  // on the line: it has no predecessor and no successor, so nothing about the span between it and a
  // real version can be established.
  if (!numbered(earlier) || !numbered(later)) {
    return {
      describable: false,
      why:
        'One of these runs does not record which catalogue version it was scored against, so what ' +
        'changed between them cannot be established.',
      added: [],
      removed: [],
      renamed: new Map(),
      changed: [],
      versions: [],
    };
  }

  const from = order(earlier);
  const to = order(later);
  if (from > to) {
    // The later run was scored against an older catalogue, which happens when an install is rolled
    // back. Describing it would mean inverting every entry, and the inverse of "changed severity"
    // is not recorded. Refused rather than approximated.
    return {
      describable: false,
      why:
        `The more recent run was scored against catalogue version ${later}, which is older than ` +
        `version ${earlier}. Comparing across a rollback is not described.`,
      added: [],
      removed: [],
      renamed: new Map(),
      changed: [],
      versions: [],
    };
  }

  const crossed = changelog.entries.filter((one) => order(one.version) > from && order(one.version) <= to);
  const missing = missingVersions(crossed, from, to);
  if (missing != null) {
    return { describable: false, why: missing, added: [], removed: [], renamed: new Map(), changed: [], versions: [] };
  }

  const endpoint = crossed.find((one) => order(one.version) === to);
  return {
    describable: true,
    ...compose(crossed),
    versions: crossed.map((one) => one.version).reverse(),
    ...(endpoint != null && endpoint.fingerprint !== '' ? { recordedFingerprint: endpoint.fingerprint } : {}),
  };
}

/**
 * A requirement's identity across the span, independent of the ids it held along the way.
 *
 * This indirection is the whole correctness argument of `compose`, and it is worth being explicit
 * about why an id cannot serve as the key. Control ids here are positional — `CO-01-01` is the first
 * requirement of the first group of the cost pillar — so a maintainer who drops a requirement frees
 * a number, and a later release can put an unrelated requirement on it. Any structure keyed on the
 * id then has two different requirements colliding on one entry, and every collision resolves by
 * one of them silently overwriting the other: a removal erased by a later rename onto the freed id,
 * a rename destroyed by a later removal of its source, a departure reported under the arriving
 * requirement's number. Each of those was reachable, each read as a plausible answer, and each
 * blamed the customer's estate for a renumbering.
 *
 * A lineage is an object, so its identity is its own and no amount of id reuse can conflate two of
 * them. `startId` and `liveId` are then simply the two endpoints, and every case the span reports
 * falls out of which of the two is present.
 */
interface Lineage {
  /** The id the earlier catalogue knew it by. Absent when it arrived inside the span. */
  startId?: string;
  /** The id it holds at the point the walk has reached. Absent once it has left. */
  liveId?: string;
  /** Every part of its scoring shape that moved, accumulated across versions. */
  readonly changed: Set<string>;
}

/**
 * What the crossed versions did, composed forward one version at a time.
 *
 * Forward rather than as a set-difference between the two endpoints, because a control can move more
 * than once: renumbered in 10 and re-severitied in 11 is one requirement with a history, and
 * differencing the endpoints would report it as a removal beside an addition.
 */
function compose(crossed: readonly CatalogueChange[]): Omit<CatalogueSpan, 'describable' | 'versions'> {
  const lineages: Lineage[] = [];
  /** Which lineage holds each id right now. An id absent from this is unoccupied. */
  const occupying = new Map<string, Lineage>();
  /** Every id this walk has ever put a lineage on, so a vacated id is not mistaken for an untouched one. */
  const touched = new Set<string>();

  /**
   * The lineage holding an id, minting one for a requirement the walk has not seen before.
   *
   * A first sighting means the requirement was in the earlier catalogue under this id and nothing
   * has moved it yet, so the minted lineage starts there. Unless the id has been *vacated*, which
   * means the record is naming an id nothing occupies — a `changed` on a requirement a previous
   * version removed. That is a contradictory record rather than a case to interpret, and the
   * degradation is chosen deliberately: the lineage is minted with no `startId`, so it cannot claim
   * an earlier-catalogue identity that another lineage already holds, and it surfaces as an
   * arrival rather than corrupting the departure.
   */
  const holding = (id: string): Lineage => {
    const occupant = occupying.get(id);
    if (occupant != null) return occupant;

    const lineage: Lineage = touched.has(id) ? { changed: new Set() } : { startId: id, changed: new Set() };
    lineages.push(lineage);
    occupy(id, lineage);
    return lineage;
  };

  /** Puts a lineage on an id, and takes off whatever was there. */
  function occupy(id: string, lineage: Lineage): void {
    const displaced = occupying.get(id);
    if (displaced != null && displaced !== lineage) displaced.liveId = undefined;
    occupying.set(id, lineage);
    touched.add(id);
    lineage.liveId = id;
  }

  const vacate = (id: string): Lineage => {
    const lineage = holding(id);
    occupying.delete(id);
    lineage.liveId = undefined;
    return lineage;
  };

  for (const step of crossed) {
    // Departures before renumberings, within a version. A version's own renames cannot name a
    // requirement that same version dropped — the bump only pairs a continuation when the named id
    // really left and the continuing id really arrived — so anything a removal resolves through is a
    // rename from an earlier version, which is exactly what it should follow.
    for (const id of step.removed) vacate(id);

    for (const move of step.renamed) {
      const lineage = holding(move.from);
      occupying.delete(move.from);
      occupy(move.to, lineage);
    }

    // Always a new lineage, never a revival. Nothing in the record says a requirement arriving on a
    // freed number is the one that freed it, and with positional ids the likelier reading is that a
    // maintainer dropped one requirement and a different one later landed on its number. Treating it
    // as a return would admit two different requirements to the like-for-like core as one, and
    // report the difference between them as the customer's estate moving.
    for (const id of step.added) {
      const lineage: Lineage = { changed: new Set() };
      lineages.push(lineage);
      occupy(id, lineage);
    }

    for (const one of step.changed) {
      const lineage = holding(one.id);
      for (const field of one.fields) lineage.changed.add(field);
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  const renamed = new Map<string, string>();
  const changed: FieldChange[] = [];

  for (const lineage of lineages) {
    const { startId, liveId } = lineage;

    if (startId != null && liveId != null) {
      // Present at both endpoints. A renumbering back to the number it started under is not a move,
      // whatever route it took, so it is reported as neither renamed nor anything else.
      if (startId !== liveId) renamed.set(startId, liveId);
      // Under the later id, because every caller keys the span on those. Only for a requirement
      // present at both endpoints: `changed` means "asks something different than it did", and a
      // requirement that left or arrived was not asking anything at one of the two ends. Reporting
      // it would put a `redefined` note on a row reading `absent → fail`.
      if (lineage.changed.size > 0) changed.push({ id: liveId, fields: [...lineage.changed].sort() });
      continue;
    }

    // Gone. Under the id the earlier catalogue used, because that is the id the earlier run's
    // findings carry — and a requirement renumbered and then dropped has nothing at the later
    // endpoint for a rename to point at.
    if (startId != null) removed.push(startId);
    // Arrived. Under the later id, for the same reason.
    else if (liveId != null) added.push(liveId);
    // Neither: it arrived and left inside the span, so it is absent from both endpoints and no run
    // either side holds a finding for it. Counting it would inflate the caveat with a requirement
    // the reader never saw.
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    renamed,
    changed: changed.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Why the span cannot be walked, if it cannot.
 *
 * Every version between the two endpoints has to be present and has to describe itself. One gap and
 * the composition is wrong in a way that reads as right: a control renamed in the missing version
 * would appear as an addition beside a removal, and the delta attributed to it would be a
 * requirement arriving rather than being renumbered.
 */
function missingVersions(crossed: readonly CatalogueChange[], from: number, to: number): string | undefined {
  const present = new Set(crossed.map((one) => order(one.version)));
  const absent: number[] = [];
  // Whole steps, and the endpoint separately. The bump script only ever writes integers, but the
  // loader accepts whatever is in the file, and stepping by one from a fractional endpoint checks
  // versions nothing could have written while skipping the ones something did.
  for (let version = Math.floor(from) + 1; version <= Math.floor(to); version += 1) {
    if (!present.has(version)) absent.push(version);
  }
  if (to !== Math.floor(to) && !present.has(to)) absent.push(to);
  if (absent.length > 0) {
    return (
      `This build has no record of what changed in catalogue version ${absent.map(String).join(', ')}, ` +
      'so the difference between these two runs cannot be attributed.'
    );
  }

  const undescribed = crossed.filter((one) => !one.describes).map((one) => one.version);
  if (undescribed.length > 0) {
    return (
      `Catalogue version ${undescribed.join(', ')} was recorded before this app wrote down what a ` +
      'version changed, so the difference between these two runs cannot be attributed.'
    );
  }
  return undefined;
}
