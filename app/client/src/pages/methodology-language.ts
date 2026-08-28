// The methodology in the reader's words rather than the record's.
//
// The record names its own fields — `coverage_mode`, `alias_group`, `preconditions` — and those names
// are correct, stable, and meaningless to the person being assessed. They are also what a changelog
// entry carries, so this page cannot simply rename them at the source: a reader comparing two versions
// has to see the same thing named the same way in both places, and the record's names are the ones the
// bump writes.
//
// So the names stay on the wire and are translated here, once. The translation is the load-bearing
// part of the page: "severity moved" is a sentence a reader can act on, and `severity` in monospace is
// a field name they have to ask somebody about.
//
// Separated from the component for the reason the other language modules are: every phrase here is a
// claim about how somebody is being judged, and the ones that are easiest to get wrong are the ones
// about what a change to a field actually does to a score. Those are worth testing without a renderer.

/**
 * What a field of the scoring shape is, phrased to complete "… moved" or as a column heading.
 *
 * Every field the fingerprint covers has an entry, and the fallback is the raw name. The fallback
 * matters more than it looks: a record written by a newer build can carry a field this one has never
 * heard of, and printing it verbatim is the honest degradation — the alternative is dropping it, which
 * would tell the reader nothing changed.
 */
const FIELD: Readonly<Record<string, string>> = {
  severity: 'how heavily it weighs',
  thresholds: 'what it is judged against',
  preconditions: 'when it does not apply',
  coverage_mode: 'how much of the estate it looks at',
  measurability: 'how it can be answered',
  provenance: 'where it comes from',
  alias_group: 'which requirements it is the same as',
  clouds: 'which clouds it applies to',
  pillar: 'which pillar asks it',
  principle: 'which principle it belongs to',
  title: 'what it is called',
};

export function fieldPhrase(field: string): string {
  return FIELD[field] ?? field;
}

/** The fields of a change as one clause, longest-standing first so the list reads consistently. */
export function fieldsPhrase(fields: readonly string[]): string {
  const phrases = [...fields].map(fieldPhrase);
  if (phrases.length === 0) return 'nothing recorded';
  if (phrases.length === 1) return phrases[0];
  return `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1) as string}`;
}

/**
 * What one technical catalogue revision did, as a sentence.
 *
 * Four kinds and they are kept apart, because a reader comparing two scores acts on them differently.
 * An arrival or a departure changes what the score is out of. A renumbering changes neither and has to
 * carry a requirement's history with it. A field moving on a requirement that stayed changes how the
 * same estate scores without changing what is being asked about — which is the one a reader will not
 * think of unless it is said.
 */
export function revisionSentence(
  revision: {
    readonly describes: boolean;
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly renamed: readonly unknown[];
    readonly changed: readonly unknown[];
  },
  /**
   * Whether this is the oldest revision the record holds.
   *
   * It changes what an undescribed entry means, and the difference matters on every install today,
   * this being the only entry any of them has. "What this revision changed was not written down" reads
   * as somebody having failed to write it down; on the earliest entry there was nothing to write —
   * there is no revision before it in the record to have differed from. The consequence for a reader is
   * the same and is kept: a score from before this revision cannot be compared with one after.
   */
  earliest = false,
): string {
  if (!revision.describes) {
    return earliest
      ? 'The earliest catalogue revision this build records. What came before it is not written down, so a score ' +
          'taken before this cannot be compared with one taken after.'
      : 'What this catalogue revision changed was not written down, so scores either side of it are not comparable.';
  }

  const parts = [
    count(revision.added, 'requirement', 'added'),
    count(revision.removed, 'requirement', 'removed'),
    count(revision.renamed, 'requirement', 'renumbered'),
    count(revision.changed, 'requirement', 'redefined'),
  ].filter((part): part is string => part != null);

  return parts.length === 0 ? 'Nothing about any requirement moved in this catalogue revision.' : `${parts.join(', ')}.`;
}

/**
 * What separates the version a run was scored against from the one this build ships.
 *
 * The sentence a reader on an upgraded install actually needs. `standingSentence` tells them their
 * last score came from version 8 and this build is on 9, which is the fact; this is the consequence,
 * and it is the difference between "your trend is broken" and "your trend is broken because these
 * four requirements were redefined".
 *
 * The undescribable case is not softened. A span with a version in the middle of it that never wrote
 * down what it moved cannot be summarised, and a count taken across the versions that did describe
 * themselves would read as the whole answer.
 */
export function spanSentence(span: {
  readonly earlier: string;
  readonly later: string;
  readonly describable: boolean;
  readonly why?: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly unknown[];
  readonly changed: readonly unknown[];
}): string {
  if (!span.describable) {
    return (
      span.why ??
      `What separates version ${span.earlier} from version ${span.later} was not written down, so the two cannot ` +
        'be compared.'
    );
  }

  const parts = [
    count(span.added, 'requirement', 'added'),
    count(span.removed, 'requirement', 'removed'),
    count(span.renamed, 'requirement', 'renumbered'),
    count(span.changed, 'requirement', 'redefined'),
  ].filter((part): part is string => part != null);

  return parts.length === 0
    ? `Nothing about any requirement moved between version ${span.earlier} and version ${span.later}.`
    : `Between version ${span.earlier} and version ${span.later}: ${parts.join(', ')}.`;
}

function count(items: readonly unknown[], noun: string, verb: string): string | undefined {
  if (items.length === 0) return undefined;
  return `${String(items.length)} ${items.length === 1 ? noun : `${noun}s`} ${verb}`;
}

/**
 * What a severity is worth, as a share of the heaviest.
 *
 * A relative figure rather than the raw weight, because the raw weights are only meaningful against
 * each other: "10" tells a reader nothing and "worth six times an informational one" tells them what
 * the table is for. Derived from the served table rather than restated, so a change to the weighting
 * moves this sentence.
 */
export function weightPhrase(severity: string, weights: Readonly<Record<string, number>>): string | undefined {
  const own = weights[severity];
  const least = Math.min(...Object.values(weights));
  if (own == null || !Number.isFinite(least) || least <= 0) return undefined;
  const ratio = own / least;
  return ratio === 1 ? 'the lightest weight' : `${trim(ratio)}× the lightest weight`;
}

/** A ratio without a trailing `.0`, because "6×" reads and "6.0×" is arithmetic. */
function trim(ratio: number): string {
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(1);
}

/**
 * What an outcome earns, in words.
 *
 * The null case is the one that has to be right. An outcome outside the average is not an outcome
 * that earned nothing — it is a requirement the score is not out of at all — and rendering both as
 * "0" would collapse the distinction the whole score rests on: a `not-applicable` requirement and a
 * failing one would look identical in the table that explains how scoring works.
 *
 * "the weight" rather than "its weight", because the subject of the finished sentence is the outcome
 * and the weight belongs to the requirement. "pass and satisfied-by-architecture earn its full
 * weight" is what the possessive produced, which is a singular pronoun on a plural subject pointing
 * at a noun that is not in the sentence. The weight it means is the one in the table directly above.
 */
export function creditPhrase(credit: number | null): string {
  if (credit == null) return 'left out of the score entirely';
  if (credit === 1) return 'earns the full weight';
  if (credit === 0) return 'earns none of the weight';
  return `earns ${String(Math.round(credit * 100))}% of the weight`;
}

/**
 * What every outcome earns, grouped by what it earns.
 *
 * Grouped rather than listed one per row, and that is a claim rather than a saving. `pass` and
 * `satisfied-by-architecture` earn the same thing, and `unmeasurable` and `not-applicable` are both
 * outside the average — a table of six rows leaves the reader to notice those pairings, where a
 * sentence states them. It also fits a 300px column, which six rows of it did not.
 *
 * Derived from the served table rather than written out, so a change to the credits moves this text.
 */
export function creditSentence(credit: Readonly<Record<string, number | null>>): readonly string[] {
  const byShare = new Map<string, string[]>();
  for (const [outcome, share] of Object.entries(credit)) {
    const key = String(share);
    if (!byShare.has(key)) byShare.set(key, []);
    (byShare.get(key) ?? []).push(outcome);
  }

  // Heaviest first, with the outcomes outside the average last: the list then reads as a scale, and
  // the one group that is not a share on that scale is where a reader expects the exception.
  const order = [...byShare.entries()].sort(([a], [b]) => {
    const share = (key: string) => (key === 'null' ? -1 : Number(key));
    return share(b) - share(a);
  });

  return order.map(([share, outcomes]) => `${list(outcomes)} ${verb(outcomes, share)}.`);
}

function verb(outcomes: readonly string[], share: string): string {
  const plural = outcomes.length > 1;
  if (share === 'null') return plural ? 'are left out of the score entirely' : 'is left out of the score entirely';
  const credit = creditPhrase(Number(share));
  return plural ? credit.replace(/^earns/, 'earn') : credit;
}

function list(outcomes: readonly string[]): string {
  if (outcomes.length === 1) return outcomes[0];
  return `${outcomes.slice(0, -1).join(', ')} and ${outcomes.at(-1) as string}`;
}

/** How a requirement can be answered at all, which decides whether a scan can reach it. */
const ANSWERED_BY: Readonly<Record<string, string>> = {
  'system-table': 'read from system tables',
  'rest-api': 'read from the workspace API',
  'cloud-api': 'read from the cloud provider',
  attestation: 'answered by a person',
  derived: 'derived from other readings',
  automatable: 'readable by a machine',
};

/** Where a requirement came from, where that is worth a reader's attention. */
const SOURCE: Readonly<Record<string, string>> = {
  extension: 'added by this app',
  'security-guide': 'from the security best practices guide',
};

/**
 * What decides how one requirement scores, as one line.
 *
 * A single line rather than a block, and that is a layout decision made here because it is really an
 * editorial one. Rendered as conditional prose in the component, this ran to three wrapped lines and
 * put six requirements on an 845px window — a 184-row list paged 31 ways, which is not a list anybody
 * reads. Every clause dropped below is dropped for the same reason: a fact true of almost every row
 * costs the reader a line and tells them nothing about the row they are on.
 *
 * So provenance appears only where it is *not* the framework — the framework being where 180 of the
 * 184 come from — and coverage only where it is sampled rather than complete. What is always here is
 * what a reader cannot infer: how it can be answered at all, what number it is judged against, and
 * whether anything excludes it.
 */
export function shapeSentence(requirement: {
  readonly provenance: string;
  readonly measurability: string;
  readonly coverageMode: string;
  readonly aliasGroup?: string;
  readonly continues?: string;
  readonly thresholds?: Readonly<Record<string, number | string | boolean | null>>;
  readonly preconditions: readonly { readonly signal: string }[];
}): string {
  const parts = [
    SOURCE[requirement.provenance],
    ANSWERED_BY[requirement.measurability] ?? requirement.measurability,
    requirement.coverageMode === 'sampled' ? 'sampled rather than every object' : undefined,
    requirement.thresholds == null ? undefined : thresholdPhrase(requirement.thresholds),
    requirement.preconditions.length > 0
      ? `excluded by ${requirement.preconditions.map((one) => one.signal).join(' or ')}`
      : undefined,
    requirement.aliasGroup != null ? 'scored once with its alias' : undefined,
    requirement.continues != null ? `continues ${requirement.continues}` : undefined,
  ].filter((part): part is string => part != null && part !== '');

  return parts.join(' · ');
}

/**
 * What a requirement is judged against.
 *
 * The threshold names are the resolvers' own and are not uniform — `pass_share`, `min_runtime_major` —
 * so these are read as pairs rather than against a schema they do not have. A share is printed as a
 * percentage because that is how the criteria prose states it; everything else goes verbatim, which is
 * the honest treatment of a name this module has never seen.
 */
function thresholdPhrase(thresholds: Readonly<Record<string, number | string | boolean | null>>): string {
  return Object.entries(thresholds)
    .map(([name, value]) => {
      const label = name.replace(/_/g, ' ');
      if (typeof value === 'number' && name.endsWith('share')) return `${label} ${String(Math.round(value * 100))}%`;
      return `${label} ${String(value)}`;
    })
    .join(', ');
}

/**
 * Whether a run records the same public methodology identity this build describes.
 */
export function standingSentence(
  current: {
    readonly publicVersion: number;
    readonly manifestDigest: string;
    readonly state: 'candidate' | 'released';
    readonly effectiveDate: string | null;
  },
  run:
    | {
        readonly publicVersion: number;
        readonly manifestDigest: string;
        readonly state: 'candidate' | 'released';
        readonly effectiveDate?: string;
      }
    | undefined,
): string | undefined {
  if (run == null) {
    return 'The most recent run is a pre-release development record. It does not carry Methodology Version 1.';
  }
  if (run.publicVersion !== current.publicVersion) {
    return `The most recent run records Methodology Version ${String(run.publicVersion)}, not Version ${String(current.publicVersion)}.`;
  }
  if (run.manifestDigest !== current.manifestDigest) {
    return `The most recent run records Version ${String(run.publicVersion)} with a different manifest digest.`;
  }
  if (run.state === 'candidate') {
    return `The most recent run records Methodology Version ${String(run.publicVersion)} as a release candidate.`;
  }
  return `The most recent run records released Methodology Version ${String(run.publicVersion)}${run.effectiveDate != null ? `, effective ${run.effectiveDate}` : ''}.`;
}
