// The line under the page title: what you are looking at, and why two of them may not be comparable.
//
// Two sentences rather than one, because the app has two run cycles and the pages of each are
// populated by their own. The version this replaced had one — the scan's — under every page,
// including the two Optimisation pages a scan does not populate. A reader on Workloads was told the
// estate was measured at 09:12 over a 30-day lookback against catalogue 1.4.0, none of which had
// anything to do with the query shapes underneath it, and the advisory run that did produce them
// went unnamed. That is worse than saying nothing: every clause was true of something else.
//
// Out of the header component so it can be read as text in a test rather than through a renderer,
// which is how the rest of the app's sentences are held.

import { actorName } from '../../pages/run-language';
import type { Advisory, Scan } from '../../api/types';
import type { CustomerResult } from '../../api/final-result';
import { methodologyProvenance } from '../../methodology-identity';

/**
 * What either sentence reads, so a test states a run rather than assembling a whole payload.
 *
 * `measurement` is optional because a run recorded before the field existed has none, and because
 * every caller that only wants the moment should not have to build seven of them.
 */
export type StampedScan = Pick<Scan, 'finishedAt' | 'stamp'> & Partial<Pick<Scan, 'measurement'>>;
export type StampedAdvisory = Pick<Advisory, 'finishedAt' | 'actor'>;

/**
 * Whether the caller has an answer yet, for the two sentences that are otherwise about an absence.
 *
 * Absent and not-yet-known arrive at both functions below as the same `undefined`, and each of them
 * used to report the first of those for both. On `/checks` that read "No scan has been run in this
 * workspace yet." for three seconds above eighteen checks and their counts, all of them from the scan
 * the caption denied — measured on labs against a run finished the same morning. It corrects itself,
 * and three seconds is long enough to read and to decide the numbers under it mean nothing.
 *
 * Most pages never showed it because they have nothing to draw without their run. The pages that do are
 * the ones whose content comes from somewhere else: `/checks` renders the catalogue and takes only its
 * figures from the scan, and the Optimisation pages read the estate live.
 *
 * A separate input rather than a reworded string, because the absent sentence is right and is held to
 * the word by a test. Defaulting to `false` keeps a caller who has resolved its query from having to say
 * so, which is every caller that renders a run it already holds.
 */
export interface Waiting {
  readonly loading?: boolean;
}

/*
 * Both say what the app is doing rather than what it found, because that is all it knows while a
 * request is out. Neither promises an outcome: a workspace that has never been scanned reaches this
 * sentence first and then the one that says so.
 */
const LOOKING_FOR_A_SCAN = 'Looking for the most recent scan in this workspace.';
const LOOKING_FOR_AN_ADVISORY = 'Looking for the most recent advisory run in this workspace.';

/**
 * The assessment's own identity, in one line.
 *
 * Every clause is a reason two runs are not comparable, which is why they travel together and why
 * they are on every assessment page rather than on the overview alone.
 *
 * # What the moment says on a run that is not all one age
 *
 * A targeted rerun's result is a composite: the pillar that was rerun is minutes old and the rest are
 * as old as the scan that last measured them — the state `MeasurementPayload` exists to record. This
 * line dated the whole result by `finishedAt`, which is the one failure that contract's own comment
 * says a rerun feature must not have: week-old evidence presented as current, in the app's most-read
 * sentence.
 *
 * So the moment becomes a range whenever the run holds a measurement older than itself, and it is a
 * range of two read fields — the oldest `measuredAt` and `finishedAt` — rather than a judgment about
 * either. It does not say the older half is stale. Nothing the app reads sets the threshold that
 * would make that true, and `docs/decisions/0091` records the decision not to invent one.
 *
 * # Scope, and why the short form rather than the description
 *
 * `scope.description` is two sentences and was the header's tooltip, which is a fact the reader can
 * only find by hovering something that does not look hoverable. What goes on the line is the shape of
 * the scope — one workspace, six of them, or every workspace the identity can see — and the sentence
 * that qualifies it stays on the coverage summary, where the reader is asking the question. Measured
 * at 1280x800: the description takes the caption to four lines and the shape keeps it at two.
 */
export function scanProvenance(scan?: StampedScan, { loading = false }: Waiting = {}): string {
  if (scan == null) return loading ? LOOKING_FOR_A_SCAN : 'No scan has been run in this workspace yet.';

  const who = actorName(scan.stamp);
  // Named only for a scheduled run. Saying "by hand" on every interactive one would spend a
  // clause of the most-read line in the app on the case the reader is already in.
  const how = scan.stamp.trigger === 'scheduled' ? ' on a schedule' : '';

  return [
    `Measured ${measuredOver(scan)}${how} as ${who}`,
    `${scan.stamp.lookbackDays}-day lookback`,
    methodologyProvenance(scan.stamp),
    scopeShape(scan.stamp.scope),
    answering(scan.stamp.definition),
  ].join(' · ');
}

/** The identity carried by every customer score and finding surface. */
export function resultProvenance(
  result: Pick<CustomerResult, 'finalisedAt' | 'finalisedBy'> & {
    readonly assessment: Pick<CustomerResult['assessment'], 'stamp'>;
  }
): string {
  return [
    'Published report',
    methodologyProvenance(result.assessment.stamp),
    `reviewed ${moment(result.finalisedAt)} by ${result.finalisedBy}`,
  ].join(' · ');
}

/**
 * The run's moment, widened to a range where part of the result was not measured by this run.
 *
 * The trigger is `carriedForward` and not "older than `finishedAt`". Every measurement in an ordinary
 * scan is older than the moment the scan finished — the pillars are measured one after another and the
 * finish is the last of them — so the arithmetic version rendered "Aug 4, 2026 to Aug 4, 2026, 9:12 AM"
 * on a perfectly ordinary run, which is a range about nothing and reads as a warning. `carriedForward`
 * is the field that says the run did not measure this pillar, which is the thing being reported.
 *
 * Same day is still a range and still rendered: a pillar carried forward from this morning was not
 * measured by this run either, and the reader is owed the same fact whether it is hours or months.
 */
function measuredOver(scan: StampedScan): string {
  const carried = (scan.measurement ?? []).filter((one) => one.carriedForward);
  const oldest = carried
    .map((one) => one.measuredAt)
    .reduce<string | undefined>((least, at) => (least == null || at < least ? at : least), undefined);

  if (oldest == null) return moment(scan.finishedAt);
  return `${day(oldest)} to ${moment(scan.finishedAt)}`;
}

/**
 * How wide the run was, in the terms the scope was built with.
 *
 * The three branches are the three the scope has: `narrowedTo` is one workspace asked for by name,
 * `selected` is the set an assessment named, and neither is the account default. Nothing here counts
 * anything the run did — `selected.length` is what was asked for, and how many of them answered is
 * the coverage summary's question and not this line's.
 */
function scopeShape(scope: Scan['stamp']['scope']): string {
  if (scope.narrowedTo != null) return 'one workspace';
  const selected = scope.selected?.length;
  if (selected != null) return `${String(selected)} workspace${selected === 1 ? '' : 's'}`;
  return 'all visible workspaces';
}

/**
 * Which assessment the run answers to, and the two ways that can be unanswerable.
 *
 * Three states rather than two. A run with no definition was started directly and answers to nothing,
 * which is a normal thing to do and not a gap. A run with a definition and no recorded name is a run
 * from before the name was kept, and saying "no assessment" of it would be false. The name itself is
 * the run's own copy — see `RunDefinitionPayload.name` — so a rename or an archival since does not
 * change what this line says about a run that already happened.
 *
 * Trimmed at forty characters because the name is the author's and has no length the app enforces,
 * and the caption is two lines at 1280x800 with nothing to spare. The whole name is on `/definitions`
 * and on the run record.
 */
function answering(definition?: Scan['stamp']['definition']): string {
  if (definition == null) return 'answering no assessment';
  if (definition.name == null) return 'answering an assessment this run did not name';
  const name = definition.name.length > 40 ? `${definition.name.slice(0, 39).trimEnd()}…` : definition.name;
  return `answering “${name}”`;
}

/**
 * The advisory's identity, in the same shape and none of the same words.
 *
 * "Analysed" rather than "measured", because the advisor does not measure the estate against anything
 * — it reads how it ran. A reader who has both pages open should be able to tell from this line alone
 * which cycle produced what is under it, and borrowing the assessment's vocabulary would make the two
 * lines differ only by their numbers.
 *
 * Two clauses rather than the assessment's four, and the window is the one deliberately missing.
 * `lookbackDays` on the record is what the run was asked for, and it is not what either analysis
 * read: the query-shape statement caps its window at fifteen days however long a lookback it is
 * given, and the first labs run put "30-day window" in this line above a page reading "the last 15
 * days of query history". Each Optimisation page states the window its own analysis used, which is
 * where the number belongs — under the figures it qualifies rather than over both of them.
 *
 * The scope is left off for the reason the assessment's is: it runs to a sentence on an account-wide
 * run and would push every page down by a line. It is the header's tooltip, and the coverage summary
 * on the page states it where the reader asks the question.
 */
export function advisoryProvenance(advisory?: StampedAdvisory, { loading = false }: Waiting = {}): string {
  if (advisory == null) return loading ? LOOKING_FOR_AN_ADVISORY : 'The advisor has not run in this workspace yet.';

  // The actor is named by the same rule a scan's is. An advisory record carries no execution mode, so
  // the application-id shape is what tells a nightly service principal from a person — and a bare
  // UUID under the page title is exactly the noise that rule exists to label.
  return `Analysed ${moment(advisory.finishedAt)} as ${actorName({ actor: advisory.actor })}`;
}

/**
 * A page that neither run populates, which is a third thing to say and not a blank.
 *
 * It carries no instant, and that is the point rather than an omission: the reading happened when the
 * page opened, so a timestamp here would be the app telling a reader something they watched happen.
 * What they cannot see is that no run is behind it — that the figures below will not change when a
 * scan finishes, and that reloading is what moves them.
 */
export function liveProvenance(): string {
  return 'Read when this page opened, rather than by a run. Reloading the page reads it again.';
}

/** The same format both sentences date themselves with, in the reader's own locale. */
function moment(at: string): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The older end of a range, to the day.
 *
 * No time of day on it: the reader is being told which measurements are not this run's, and the hour
 * a carried-forward pillar was measured at is a precision they cannot act on — while the two full
 * timestamps together are eleven characters this line does not have.
 */
function day(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
