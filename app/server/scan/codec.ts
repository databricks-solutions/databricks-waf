// Turning a scan into bytes and back.
//
// Two things here are decisions rather than plumbing, and both are the kind that fail
// silently if left to `JSON.stringify` alone.
//
// The first is dates. JSON has no date type, so every `Date` on a scan comes back as a
// string, and a string that is asked for `getTime()` throws at the point of display
// rather than at the point of reading. Revival is explicit, field by field, rather than
// done by pattern-matching every string that looks like a timestamp: evidence carries
// observed values copied from the customer's estate, and a table property that happens
// to read as an ISO date would be silently converted into a `Date` and then rendered as
// something the customer never wrote.
//
// The second is raw signal values. They are dropped, deliberately, and this is the same
// choice the wire projection already makes: a finding carries its own evidence, so the
// raw payload a resolver read is of no use to anyone looking at a stored result. Two of
// them cannot survive the round trip anyway — the workspace settings probe answers with
// a `Map`, which `JSON.stringify` renders as `{}` without complaint. Dropping the field
// outright is honest; keeping it and having it silently empty is not.

import type { SignalResult } from '../collect/signal.js';
import type { Evidence, Finding } from '../resolve/finding.js';
import type { PillarMeasurement, Scan } from './scan.js';
import type { Composition } from '../resolve/evidence-class.js';
import type { ScanFootprint } from './scheduler.js';
import type { PillarScore, Score } from '../score/score.js';

/** Bumped when this encoding changes shape, so an old file is upgraded or refused, never misread. */
export const CODEC_VERSION = 4;

/**
 * Versions this build can read, each with what has to be supplied to bring it up to date.
 *
 * Refusing every older file was the previous behaviour and it is the wrong trade for a
 * history: a shape change would silently empty the customer's trend view, and the only
 * signal would be scans quietly vanishing from the list. A version that can be read with a
 * stated assumption is read with that assumption recorded.
 *
 * 2 is listed as a literal rather than reached through `CODEC_VERSION` because it names two
 * shapes instead of one. Row 81 added `terminal` to the stored per-surface counters and left the
 * version at 2, so a version 2 document may or may not carry it and the number cannot say which.
 * That is the property the bump to 3 buys back for documents written from here, and the one thing
 * it cannot do for documents already written — so what separates a readable 2 from an unreadable
 * one is `footprint` below, not this set.
 *
 * 3 remains readable after the bump to 4 because the public-methodology identity added to a scan's
 * stamp is optional by design. Its absence is itself the historical fact: the run predates a public
 * release and is classified as pre-release development. The decoder must preserve that absence rather
 * than backfill Version 1 from the technical catalogue revision. This is the upgrade path required
 * before the first pilot install holds customer history; it deliberately narrows ADR 0094's earlier
 * development-estate permission to discard records across a shape change.
 */
const READABLE = new Set([1, 2, 3, CODEC_VERSION]);

export interface StoredScanFile {
  readonly codecVersion: number;
  readonly scan: unknown;
}

export class UnreadableScanError extends Error {
  constructor(id: string, why: string) {
    super(`Stored scan ${id} could not be read: ${why}`);
    this.name = 'UnreadableScanError';
  }
}

/**
 * A scan as it is written down.
 *
 * `signals` keeps everything except `value`, because the status, the coverage and the
 * reason a signal could not be measured are all shown in the UI, and only the payload is
 * redundant once findings exist.
 */
export function encodeScan(scan: Scan): string {
  const signals = scan.signals.map(({ value: _dropped, ...rest }) => rest);
  const file: StoredScanFile = { codecVersion: CODEC_VERSION, scan: { ...scan, signals } };
  return JSON.stringify(file);
}

export function decodeScan(id: string, text: string): Scan {
  let file: StoredScanFile;
  try {
    file = JSON.parse(text) as StoredScanFile;
  } catch (error) {
    throw new UnreadableScanError(id, `it is not valid JSON (${(error as Error).message})`);
  }

  if (!READABLE.has(file.codecVersion)) {
    throw new UnreadableScanError(
      id,
      `it was written by encoding version ${String(file.codecVersion)} and this build reads ` +
        `${[...READABLE].join(' and ')}. Scans written by a version this build does not know are not read ` +
        'rather than read approximately.'
    );
  }

  const raw = file.scan as Scan;
  if (raw?.id == null || raw.stamp == null || raw.score == null) {
    throw new UnreadableScanError(id, 'it is missing the id, stamp or score a scan must have');
  }

  const finishedAt = date(raw.finishedAt, id, 'finishedAt');
  const findings = raw.findings.map((finding) => revive(finding, id));

  return {
    ...raw,
    startedAt: date(raw.startedAt, id, 'startedAt'),
    finishedAt,
    findings,
    footprint: footprint(raw, id),
    score: score(raw.score),
    measurement: measurement(raw, findings, finishedAt, id),
    signals: raw.signals.map(
      (signal): SignalResult => ({ ...signal, collectedAt: date(signal.collectedAt, id, 'signal.collectedAt') })
    ),
  };
}

/**
 * What a score looked like before evidence classes: one attested count, no composition.
 *
 * Written out rather than reached with a cast, so the fields being read from an older file are
 * declared somewhere a reader can find them, and so the day `attestedControls` stops being understood
 * is a deletion here rather than a search for assertions.
 */
type PreClassPillar = Omit<PillarScore, 'composition'> & {
  readonly composition?: Composition;
  readonly attested?: number;
};

type PreClassScore = Omit<Score, 'composition' | 'pillars'> & {
  readonly composition?: Composition;
  readonly attestedControls?: number;
  readonly pillars: readonly PreClassPillar[];
};

/**
 * Composition, supplied for scans written before evidence classes existed.
 *
 * Those scans carried one number — how many scored requirements rested on an answer — under
 * `attestedControls` on the score and `attested` on each pillar. That is not lost information: every
 * collector in the build that wrote them observed what it reported, so the rest of the scored set was
 * observed, and the third class did not exist to be counted. So the mapping is exact rather than a
 * guess, which is why it happens here instead of the UI defaulting a missing field to zero and quietly
 * reporting an old run as having rested on nothing.
 */
function score(raw: PreClassScore): Score {
  // Dropped rather than carried through, so what the API serves has the shape the contract declares.
  // Leaving it would put a field on the wire that no reader is allowed to trust and one might use.
  const { attestedControls, pillars: was, composition, ...rest } = raw;

  const pillars = was.map(({ attested, composition: had, ...pillar }) => ({
    ...pillar,
    composition: had ?? mixture(pillar.scored, attested ?? 0),
  }));

  return { ...rest, pillars, composition: composition ?? mixture(raw.scoredControls, attestedControls ?? 0) };
}

/** A scored set that was observed except where it was answered, which is what those runs were. */
function mixture(scored: number, attested: number): Composition {
  return { observed: Math.max(0, scored - attested), 'admin-collected': 0, attested };
}

/*
 * A scan written before row 33d may carry a `serverless` analysis, and this decoder deliberately does
 * not revive its dates. Nothing reads the field any more — the analysis belongs to the advisory run —
 * so reviving two dates on a structure no surface serves would be work in aid of nothing. The property
 * survives the spread as it was stored, which is the same thing that happens to any field a later
 * version stops understanding: it is inert rather than corrupt, and no reader can reach it.
 */

/**
 * Per-pillar provenance, supplied for scans written before it existed.
 *
 * A version 1 scan has exactly one measurement per pillar and it is its own, because
 * targeted reruns did not exist when it was written — so the assumption is not a guess, it
 * is what the format implied. Reconstructing it here means the UI has one shape to render
 * rather than a branch for pre-rerun scans that nobody would test.
 */
function measurement(
  raw: Scan,
  findings: readonly Finding[],
  finishedAt: Date,
  id: string
): readonly PillarMeasurement[] {
  if (raw.measurement != null) {
    return raw.measurement.map((entry) => ({ ...entry, measuredAt: date(entry.measuredAt, id, 'measuredAt') }));
  }

  return [...new Set(findings.map((finding) => finding.pillarId))].map((pillarId) => ({
    pillarId,
    scanId: raw.id,
    measuredAt: finishedAt,
    actor: raw.stamp.actor,
    carriedForward: false,
  }));
}

/** The five counts every surface has carried since footprints were first stored. */
const COUNTS = ['ok', 'skipped', 'failed', 'retries', 'attempts'] as const;

/**
 * The footprint, checked rather than trusted.
 *
 * This function returns `Scan`, and from the moment it does the type system is describing a document it
 * never looked at. That is how row 81 shipped: it added `terminal` to the stored per-surface counters
 * with no version bump and no upgrade, so a document written before it parses cleanly, satisfies the
 * compiler, and throws at `Object.entries(counters.terminal)` in the route that renders it — which on
 * labs took the process down rather than the request, because nothing contained a rejected handler.
 *
 * So this refuses a footprint it cannot read instead of passing it on. The codec already promised that
 * much at the top of this file and had no machinery for it at this depth: the version check above sees
 * the envelope, and everything below it took the document's word.
 *
 * **It does not default the missing field.** ADR 0094 decided that a stored shape this build cannot read
 * is emptied rather than upgraded before a pilot, and an empty `terminal` is not a neutral stand-in for
 * an absent one — it renders as a surface whose tasks failed for no stated reason, which is the reading
 * row 81 added the field to make impossible.
 *
 * What it checks is what the read path dereferences, rather than every field the interface declares.
 * `presentFootprint` in `api/routes.ts` is the only consumer of a *stored* footprint — the runners read
 * one from a live scheduler — so this list and that function are the pair to keep in step.
 */
function footprint(raw: Scan, id: string): ScanFootprint {
  const stored: unknown = raw.footprint;
  if (!isRecord(stored)) {
    throw new UnreadableScanError(id, 'it carries no footprint, and the run record is read from one');
  }

  const spend: unknown = stored.spend;
  if (!isRecord(spend) || !isRecord(spend.spent) || !isRecord(spend.limits) || typeof spend.elapsedMs !== 'number') {
    throw new UnreadableScanError(
      id,
      "its footprint's spend is not the shape a run record reads: spent, limits and a numeric elapsedMs"
    );
  }

  const tasks: unknown = stored.tasks;
  if (!isRecord(tasks)) {
    throw new UnreadableScanError(id, 'its footprint counts no tasks, and every surface on the record is read from them');
  }

  for (const [surface, counters] of Object.entries(tasks)) {
    if (!isRecord(counters)) {
      throw new UnreadableScanError(id, `its footprint's ${surface} counters are not a record of counts`);
    }

    const absent = COUNTS.filter((count) => typeof counters[count] !== 'number');
    if (absent.length > 0) {
      throw new UnreadableScanError(id, `its footprint's ${surface} counters have no ${absent.join(', ')}`);
    }

    // The field row 81 added. Named as a version rather than as a field, because that is the useful
    // thing for whoever reads this line in a log: the document predates a change, so there is nothing
    // to fix about this build.
    if (!isRecord(counters.terminal)) {
      throw new UnreadableScanError(
        id,
        `its footprint's ${surface} counters have no terminal, so it was written by a build before row 81 ` +
          'and stored under an encoding version that does not distinguish the two'
      );
    }
  }

  if (!isRecord(stored.limiters)) {
    throw new UnreadableScanError(id, "its footprint's limiters are not a record, and the record counts reductions from them");
  }

  // The declared type, returned unchanged. Nothing is asserted here: the checks above are what earn the
  // declaration `Scan` already makes, which is the thing this file could not previously say.
  return raw.footprint;
}

/**
 * A JSON object, which is the only thing any of the checks above want.
 *
 * Arrays are excluded because `Object.entries` and `Object.values` accept one without complaint, so an
 * array reaching the route would render as a footprint rather than be refused as one.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function revive(finding: Finding, id: string): Finding {
  return {
    ...finding,
    ...(finding.attested != null
      ? {
          attested: {
            ...finding.attested,
            at: date(finding.attested.at, id, 'attested.at'),
            // Revived rather than left as a string because whether an answer has lapsed is
            // decided by comparing this to now, and a string comparison would silently
            // succeed for some dates and fail for others.
            reviewBy: date(finding.attested.reviewBy, id, 'attested.reviewBy'),
          },
        }
      : {}),
    evidence: finding.evidence.map(
      (evidence): Evidence => ({ ...evidence, collectedAt: date(evidence.collectedAt, id, 'evidence.collectedAt') })
    ),
  };
}

/**
 * A date from whatever JSON left behind.
 *
 * Throws rather than substituting the current time, which would turn a corrupt file into
 * a plausible-looking scan dated now.
 */
function date(value: Date | string, id: string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new UnreadableScanError(id, `${field} is not a date (${JSON.stringify(value)})`);
  }
  return parsed;
}
