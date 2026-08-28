// What a finding rests on, as a class rather than as an implication.
//
// Three kinds of claim reach a finding, and they are not interchangeable:
//
//   observed — this app read it, on a surface it names, as an identity it names. Checkable by
//   re-running the reading.
//
//   admin-collected — an administrator ran a read-only script against an authority this app does not
//   hold, and imported the output. Checkable only to the extent the envelope is trusted: the app did
//   not see the source and cannot see it again. Nothing produces this class yet; H4 does.
//
//   attested — a person answered a question about a practice. Not checkable at all from here. It is
//   somebody's word, with their name and a review date on it.
//
// The rule between them is one-directional, and it already governs resolution: a resolver consults an
// attestation only where it reached no verdict of its own, so an observation can decide something an
// answer cannot override, and never the reverse. What was missing is the class itself. The score
// counted `finding.attested?.bearing === 'outcome'` in three places and inferred the rest, which
// worked while there were two classes and stops working the moment there are three — and left the app
// unable to say the thing a reader most needs about a number: a pillar at 78% measured and a pillar
// at 78% answered are different facts.
//
// So the class is carried on the evidence, derived onto the finding by one function here, and counted
// once into a composition the score, the UI and both exports read. ADR 0033.

import type { Finding } from './finding.js';

export type EvidenceClass = 'observed' | 'admin-collected' | 'attested';

export const EVIDENCE_CLASSES: readonly EvidenceClass[] = ['observed', 'admin-collected', 'attested'];

/**
 * Strongest first. Lower is more reliable, which is what "one-directional" means in one number.
 *
 * Ranked rather than compared ad hoc so that adding a fourth class is a line here and not a search
 * for every `if` that assumed two.
 */
const RANK: Readonly<Record<EvidenceClass, number>> = {
  observed: 0,
  'admin-collected': 1,
  attested: 2,
};

/**
 * Whether a claim of one class may decide an outcome a claim of another already decided.
 *
 * Strictly one-directional: an observation may replace an answer, an answer may never replace an
 * observation, and neither may replace its own class — a second reading of the same kind is not a
 * reason to overwrite the first, it is a reason for both to be evidence.
 *
 * The resolvers implement this structurally rather than by calling it: an attestation is consulted
 * only where the resolver reached no verdict, which is the same rule expressed as control flow. This
 * function is what the tests hold that structure against, and what an importer will consult when
 * admin-collected evidence starts arriving alongside observations.
 */
export function mayDecideOver(incoming: EvidenceClass, existing: EvidenceClass): boolean {
  return RANK[incoming] < RANK[existing];
}

/**
 * The class a finding rests on, or undefined when it rests on nothing.
 *
 * Two rules, and the second is the one worth reading twice.
 *
 * An attestation that bears on the outcome makes the finding attested, whatever else is attached.
 * That follows from the precedence above: a resolver that had an observation of its own would not
 * have consulted the answer, so an attested outcome means there was no observation to weigh.
 *
 * Otherwise the *weakest* bearing evidence governs — the same rule `Finding.coverage` uses, for the
 * same reason. A verdict that needed an observation and an admin's import is only as good as the
 * import, and labelling it observed would describe the finding by its best part. Detail evidence is
 * ignored: a complete observation located by an imported list is still an observation, and counting
 * the locator would understate what was measured.
 *
 * Undefined for an `unmeasurable` finding with nothing bearing on it, which is honest — there is no
 * class of evidence behind a finding that has no evidence.
 */
export function classOf(finding: Finding): EvidenceClass | undefined {
  if (finding.attested?.bearing === 'outcome') return 'attested';

  const bearing = finding.evidence.filter((one) => (one.bearing ?? 'outcome') === 'outcome');
  if (bearing.length === 0) return decidedByApplicability(finding) ? 'observed' : undefined;

  return bearing
    .map((one) => one.evidenceClass ?? 'observed')
    .reduce((weakest, next) => (RANK[next] > RANK[weakest] ? next : weakest));
}

/**
 * Whether the verdict came from the control's preconditions rather than from its own evidence.
 *
 * Those two outcomes carry no evidence rows because there was nothing to measure once the
 * preconditions answered — but the preconditions are signals this app read, so the verdict is
 * observed, and `satisfied-by-architecture` is scored as a pass. Leaving it unclassified would put a
 * requirement in `scoredControls` and in none of the classes, so the composition would not add up to
 * the number beside it. An attested one never reaches here: the check above claims it first.
 */
function decidedByApplicability(finding: Finding): boolean {
  return finding.outcome === 'satisfied-by-architecture' || finding.outcome === 'not-applicable';
}

/** How many findings rest on each class. Every class is present, including at zero. */
export type Composition = Readonly<Record<EvidenceClass, number>>;

export const NO_COMPOSITION: Composition = { observed: 0, 'admin-collected': 0, attested: 0 };

/**
 * The composition of a set of findings.
 *
 * Findings with no class are not counted anywhere, so the total is the number of findings that rest
 * on something. Callers that need a denominator use their own — the score uses the requirements that
 * scored, which is not the same set, and folding one into the other here would make this function
 * answer a question it was not asked.
 */
export function composition(findings: readonly Finding[]): Composition {
  const counted = { ...NO_COMPOSITION } as Record<EvidenceClass, number>;
  for (const finding of findings) {
    const kind = classOf(finding);
    if (kind != null) counted[kind] += 1;
  }
  return counted;
}

/** The classes actually present, strongest first. What a UI shows instead of three rows of which two are zero. */
export function present(of: Composition): readonly EvidenceClass[] {
  return EVIDENCE_CLASSES.filter((kind) => of[kind] > 0);
}

/**
 * The composition as a sentence, when it is worth one.
 *
 * Empty only when everything rests on an observation, because "18 of 18 observed" is a fact a reader
 * can take from the absence of a caveat, and a line that appears on every screen stops being read.
 *
 * Every other case gets a sentence, including the uniform ones — which is a correction rather than a
 * refinement. The rule used to be "say nothing unless the classes are mixed", written when the only
 * class a score could uniformly rest on was `observed`. Once evidence can be imported that rule
 * silently produces the worst output this app is capable of: a score composed entirely of readings from
 * somebody's uploaded file, presented with no caveat at all, indistinguishable from one this app
 * measured. So a single class that is not an observation is exactly the case that most needs saying.
 */
export function describeComposition(of: Composition, scored: number): string {
  const kinds = present(of);
  if (scored === 0) return '';
  if (kinds.length === 1 && kinds[0] === 'observed') return '';
  if (kinds.length === 0) return '';

  const share = (kind: EvidenceClass): string => `${String(of[kind])} ${WORDS[kind]}`;
  return `Of the ${String(scored)} requirements in this score, ${kinds.map(share).join(', ')}.`;
}

const WORDS: Readonly<Record<EvidenceClass, string>> = {
  observed: 'were measured by this app',
  'admin-collected': 'came from a reading an administrator ran and imported',
  attested: 'rest on an answer somebody gave',
};
