// The words for a retention period, a hold, and a sweep.
//
// The server writes the sentences that are about its own internals — why a table is exempt, why a
// confirmation was refused. What is here is everything a reader needs that the server has no business
// phrasing: what a class of record *is* in their terms, how long a period is when the number is 2,555
// days, and the one sentence that says what a sweep is about to do.
//
// The sweep sentence is the part of this file worth arguing about, and it is deliberately blunt. Every
// other act in this app can be reversed by doing something else; this one cannot be reversed at all, so
// the prose in front of it names the count, the classes and the fact that nothing recovers it. The reset
// sentences below are the same argument one degree further: a sweep takes what a period says is past
// keeping, a reset takes the periods' subject matter too, so the sentence in front of it says so.

import type { Eligibility, LegalHold, Reset, ResetPlan, Retention, RetentionClass, Sweep } from '../api/types';

type Class = RetentionClass['retentionClass'];

export const RETENTION_CLASSES: readonly Class[] = ['temporary', 'assessment', 'governance', 'advisory'];

/** What each class is called on the page. Named for the reason it is kept, not for its tables. */
export const CLASS_LABEL: Readonly<Record<Class, string>> = {
  temporary: 'Working state',
  assessment: 'What was measured',
  governance: 'What people asserted and did',
  advisory: 'Advice, and whether it was taken',
};

/**
 * Why each class is kept, which is what a period is being set against.
 *
 * One sentence each, because an administrator setting four numbers is answering four different
 * questions and "30 days" means nothing until they know which of the four they are answering.
 */
export const CLASS_PURPOSE: Readonly<Record<Class, string>> = {
  temporary: 'Half-written work with no evidential value. Losing it costs somebody the typing they had not finished.',
  assessment:
    'Completed runs and the evidence behind them. This is what a trend line is made of, and what an auditor asks to see.',
  governance:
    'Answers people gave, decisions they took, and every event this app recorded. The record of who did what.',
  // The one class where a longer period is the worse setting, and the sentence says so, because it is
  // the opposite of what the other three have just taught the reader.
  advisory:
    'Recommendations from the workload advisor, kept long enough to see whether anybody acted on them. Advice ages badly: a long period here fills the page with suggestions about workloads that no longer run.',
};

/**
 * A period in the units somebody would say it in.
 *
 * 2,555 days is a number nobody checks; "about 7 years" is the thing they were told to configure. The
 * exact day count is still shown beside it, because that is what the setting holds and a page that
 * rounded silently would have an administrator setting 2,555 and reading 7 years back forever without
 * ever seeing the two agree.
 */
export function periodPhrase(days: number): string {
  if (days < 31) return `${String(days)} ${days === 1 ? 'day' : 'days'}`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return `about ${String(months)} ${months === 1 ? 'month' : 'months'}`;
  }
  const years = days / 365;
  const rounded = Math.round(years * 10) / 10;
  return `about ${rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1)} ${rounded === 1 ? 'year' : 'years'}`;
}

/** What a table holds and how much of it is past the period, in one line. */
export function eligibilitySentence(one: Eligibility): string {
  if (one.total === 0) return 'Nothing stored yet.';
  if (one.eligible === 0) {
    return `${String(one.total)} stored, none past the period.`;
  }
  return `${String(one.total)} stored, of which ${String(one.eligible)} ${one.eligible === 1 ? 'is' : 'are'} past the period.`;
}

/**
 * What a hold is doing, in the words of whoever placed it.
 *
 * The reason is theirs and is shown verbatim. This app does not paraphrase it: whoever lifts the hold
 * will not be whoever placed it, and a summarised reason is one they cannot act on.
 */
export function holdSentence(hold: LegalHold): string {
  const covers = hold.covers.map((one) => CLASS_LABEL[one].toLowerCase());
  const scope = covers.length === 0 ? 'nothing' : listOf(covers);
  if (hold.releasedAt != null) {
    return `Covered ${scope} from ${dayOf(hold.placedAt)} until ${String(hold.releasedBy)} lifted it on ${dayOf(hold.releasedAt)}.`;
  }
  return `Covers ${scope}. Nothing in ${covers.length === 1 ? 'it' : 'those'} will be removed while this stands.`;
}

/**
 * What a sweep would do, said before it is asked for.
 *
 * Names the count and the fact that nothing recovers it, and says nothing reassuring. This is the only
 * irreversible act in the app, and the page in front of it is the last thing between a stale plan and
 * a deletion nobody intended.
 */
export function sweepWarning(retention: Retention): string {
  if (retention.wouldRemove === 0) {
    const held = retention.classes.filter((one) => one.heldBy.length > 0);
    if (held.length > 0) {
      return (
        'Nothing would be removed. Records are past their period, and a legal hold is preserving them — ' +
        'lift the hold below if it no longer applies.'
      );
    }
    return 'Nothing is past its retention period, so there is nothing to remove.';
  }

  const classes = retention.classes
    .filter((one) => one.heldBy.length === 0 && one.tables.some((table) => table.eligible > 0))
    .map((one) => CLASS_LABEL[one.retentionClass].toLowerCase());

  return (
    `${String(retention.wouldRemove)} ${retention.wouldRemove === 1 ? 'record' : 'records'} would be removed, from ` +
    `${listOf(classes)}. This cannot be undone and the records are not kept anywhere else. ` +
    'Removing them changes what past scores can be compared against.'
  );
}

/** What a sweep did, for the confirmation shown afterwards. */
export function sweptSentence(sweep: Sweep): string {
  if (sweep.removed === 0) {
    return 'Nothing was removed: everything is inside its retention period, or held.';
  }

  const tables = sweep.removals.filter((one) => one.removed > 0).length;
  const floor =
    sweep.auditFloor == null
      ? ''
      : ` The audit trail now begins at event ${String(sweep.auditFloor + 1)}; verification starts from there and ` +
        'says so.';

  return (
    `${String(sweep.removed)} ${sweep.removed === 1 ? 'record' : 'records'} removed from ${String(tables)} ` +
    `${tables === 1 ? 'table' : 'tables'}, on ${dayOf(sweep.at)}.${floor}`
  );
}

/**
 * What a reset would empty, said before it is offered.
 *
 * Deliberately not the reassuring version. A sweep removes what somebody's own policy says is past
 * keeping; a reset removes the policy's subject matter as well — every scan, every answer, every
 * decision, the definitions the periods exempt, and the trail that would otherwise say what had been
 * there. So the sentence names all three of those and does not mention the fresh start, which is the
 * only part the reader is already sure of.
 */
export function resetWarning(reset: ResetPlan): string {
  if (reset.heldBy.length > 0) {
    const one = reset.heldBy.length === 1;
    return (
      `${one ? 'A legal hold is' : `${String(reset.heldBy.length)} legal holds are`} in force, and a reset does not ` +
      `override ${one ? 'one' : 'them'}. Lift ${one ? 'it below if it no longer applies' : 'them below if they no longer apply'} ` +
      '— which is itself recorded, and is the point.'
    );
  }

  if (reset.records === 0 && reset.events === 0) {
    return 'This install holds no assessment data to delete.';
  }

  // The trail's own size stated separately from the records, because it is the one part a reader
  // cannot have chosen to accumulate: it grew from the acts, including reading this page.
  const trail =
    reset.events === 0
      ? ''
      : ` The audit trail goes too — ${String(reset.events)} ${reset.events === 1 ? 'event' : 'events'}, replaced by a ` +
        'single event saying who deleted the assessment data and when.';

  // No records and a trail above them is the ordinary state of an install somebody has configured and
  // not yet scanned with, and the reset there is not a no-op. Said with the records phrasing it would
  // read "0 records across 16 tables", which is a sentence about nothing in front of a button that
  // does something.
  if (reset.records === 0) {
    return `This install holds no records yet.${trail}`;
  }

  return (
    `Every record this install holds would be removed: ${String(reset.records)} ` +
    `${reset.records === 1 ? 'record' : 'records'} across ${String(reset.tables.length)} tables, including the ` +
    'assessment definitions that retention periods deliberately never touch. This cannot be undone and nothing is ' +
    `kept anywhere else.${trail}`
  );
}

/** What a reset did, for the confirmation shown afterwards. */
export function resetSentence(reset: Reset): string {
  if (reset.rows === 0) {
    return `The install already held no assessment data. The attempt was recorded on ${dayOf(reset.at)}, by ${reset.by}.`;
  }

  return (
    `${String(reset.rows)} ${reset.rows === 1 ? 'row' : 'rows'} removed from ${String(reset.tables)} ` +
    `${reset.tables === 1 ? 'table' : 'tables'}, on ${dayOf(reset.at)}. The audit trail now begins with that event: ` +
    'it is the first event of a new chain, and verification starts from it.'
  );
}

/** Why a class was skipped, said beside the class rather than in the sweep's summary. */
export function heldSentence(heldBy: readonly string[]): string | undefined {
  if (heldBy.length === 0) return undefined;
  return `Held by ${heldBy.length === 1 ? 'a legal hold' : `${String(heldBy.length)} legal holds`}, so nothing here is removed on a period.`;
}

/**
 * What a durability-free install should read on this page, in place of a policy.
 *
 * The whole page, not a banner over it: an install with nowhere to keep records has no retention
 * position, and three periods with an empty count under each would be a policy governing nothing.
 * The server's own sentence says what is missing and what binding would fix it, which is the whole
 * of the true answer.
 */
export function inertNotice(retention: Retention): string | undefined {
  return retention.durable ? undefined : retention.unavailable;
}

/** A date as the reader's own locale writes it, which is how every other date in the app is shown. */
export function dayOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? 'an unknown date'
    : at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A, B and C. Here rather than at three call sites that would each get the last comma wrong. */
function listOf(parts: readonly string[]): string {
  if (parts.length === 0) return 'nothing';
  if (parts.length === 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${String(parts.at(-1))}`;
}
