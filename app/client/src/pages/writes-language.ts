// The words the writes page uses, in one place, with what each one may not say beside it.
//
// The same arrangement `jobs-language.ts` and `schedule-language.ts` use, and this page needs it for one
// reason above the others: **every sentence here is one step away from a recommendation the app cannot
// make.** A rewrite is not a rewrite-that-should-be-a-merge, and a small load is not a load-that-should-be
// Auto-Loader — which of those is true depends on the pipeline that produced the statement, and this reads
// `system.query.history`, which records what ran rather than what could have run instead.
//
// So the rule below is stricter than "report the field". Each sentence may say what the platform recorded
// and may name the alternative as a thing to check. None of them may say the estate should be doing it,
// and none of them may describe a statement as one kind of thing when the field only says it wrote.
//
// The second load-bearing distinction is `undeterminable`. `written_bytes` is null on a run the platform
// recorded no figure for, and null is not zero. A shape whose runs stated nothing is one no rule could
// read, and rendering it as a shape with nothing wrong is the flattering lie ADR 0074 is about.

import { Database, RefreshCw, CircleHelp, type LucideIcon } from 'lucide-react';
import type { WriteShape, WriteState, Writes } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';
import { bytes } from './workload-language';

export const WRITES_ICON = Database;

/** In the order a reader works down the list: what was found, what was fine, what could not be judged. */
export const WRITE_STATES: readonly WriteState[] = ['advised', 'clean', 'undeterminable'];

export const STATE_LABEL: Readonly<Record<WriteState, string>> = {
  advised: 'Worth a look',
  clean: 'Nothing found',
  undeterminable: 'Could not judge',
};

/**
 * What each state means, said in full on the page rather than in a tooltip.
 *
 * `clean` is hedged in the one direction that matters. Both rules are about *how* a statement writes, and
 * neither reads whether what it wrote was correct, well-partitioned or wanted — so the strongest honest
 * form of a clean verdict is that neither pattern was present, not that the write is fine.
 */
export const STATE_DETAIL: Readonly<Record<WriteState, string>> = {
  advised:
    'One of the two write patterns was present here. Each names what the platform recorded and what would be ' +
    'worth checking, and neither is a recommendation: whether the alternative applies depends on the pipeline ' +
    'behind the statement, which is not in the query history.',
  clean:
    'Neither pattern was present. Both rules are about how a statement writes rather than about what it wrote, ' +
    'so this says the write group is not a repeated full rewrite and not a stream of small loads — and nothing about ' +
    'whether the data or the schedule is right.',
  // Phrased without the word a reader would supply themselves. An earlier draft said "neither declined
  // because the shape was fine", which puts the verdict this state does not have into the sentence that
  // exists to withhold it — and a reader skimming picks up the adjective and not the negation.
  undeterminable:
    'The platform recorded no written figure for any run in this write group, and both rules read one. So this is ' +
    'not a verdict on the group: no rule was applied to it, because there was no number to apply one to.',
};

/** Only the state that calls for a decision is coloured. See StatusBadge on why. */
export const STATE_TONE: Readonly<Record<WriteState, Tone>> = {
  advised: 'warning',
  clean: 'success',
  undeterminable: 'neutral',
};

export const STATE_ICON: Readonly<Record<WriteState, LucideIcon>> = {
  advised: RefreshCw,
  clean: Database,
  undeterminable: CircleHelp,
};

/**
 * A state's facts, looked up rather than indexed into.
 *
 * A stored advisory can name a state this build does not have — the same case `jobs-language.ts` guards —
 * and indexing straight into the records hands React an undefined component.
 */
export function stateFacts(state: WriteState): {
  readonly label: string;
  readonly detail: string;
  readonly tone: Tone;
  readonly Icon: LucideIcon;
} {
  return {
    label: STATE_LABEL[state] ?? 'Unrecognised',
    detail: STATE_DETAIL[state] ?? 'This run recorded a state this build does not know how to describe.',
    tone: STATE_TONE[state] ?? 'neutral',
    Icon: STATE_ICON[state] ?? CircleHelp,
  };
}

export const NOT_SCORED = 'Advice. Nothing here changes the score.';

/**
 * What the estate wrote, for the page's opening line.
 *
 * Two figures and no third. The statements are counted and the bytes are summed, and the share of SQL that
 * writes is arithmetic over two counts the payload carries — so a reader can check it. What this may not
 * say is anything about tables: nothing in the query history names what a statement wrote to, so "the
 * estate rewrites 40 tables" is a sentence no field here supports.
 */
export function writesSentence(analysis: Writes): string {
  const { writeStatements, otherStatements, estateWrittenBytes, windowDays } = analysis;
  const window = `the last ${String(windowDays)} days`;
  if (writeStatements === 0) {
    return `No statement wrote anything in ${window}, out of ${plural(otherStatements, 'statement')} the window saw.`;
  }
  const total = writeStatements + otherStatements;
  return (
    `${plural(writeStatements, 'write statement')} ran in ${window}, ${share(writeStatements, total)} of the ` +
    `${plural(total, 'statement')} the window saw, writing ${bytes(estateWrittenBytes)} between them.`
  );
}

/**
 * One count as a share of another, without rounding a real thing down to nothing.
 *
 * A rounded percentage next to a non-zero count reads as a contradiction, and it is the common case here
 * rather than the edge: on the calibration estate 73 writes out of 19,300 statements rounded to `0%` in
 * the same sentence that said there were 73 of them. Below one percent the sentence says so in words.
 */
function share(part: number, whole: number): string {
  if (whole === 0 || part === 0) return '0%';
  const exact = (part / whole) * 100;
  if (exact < 1) return 'under 1%';
  if (exact > 99 && part < whole) return 'over 99%';
  return `${String(Math.round(exact))}%`;
}

/**
 * How many of the estate's writes carried a figure, where any did not.
 *
 * Absent when every one did, because a caveat rendered on every estate is one a reader learns to skip.
 * Measured on the estate this was built against, 10,470 of 10,472 carried one — so this is the rare line
 * and the run where it appears is the run whose byte totals are a floor rather than a total.
 */
export function statedSentence(analysis: Writes): string | undefined {
  const missing = analysis.writeStatements - analysis.writesStatingBytes;
  if (missing <= 0) return undefined;
  return (
    `${plural(missing, 'write')} of those recorded no written figure, so the total above is what the rest of ` +
    'them wrote and not what the estate wrote.'
  );
}

/**
 * What was found, and across how many shapes, for the line under the opening one.
 *
 * Says which of the listed shapes could not be judged as part of the same sentence, because the two counts
 * answer one question: a page reporting no findings over forty shapes reads very differently when thirty of
 * them had no number to read.
 */
export function findingsSentence(analysis: Writes): string {
  const shapes = analysis.shapes.length;
  if (shapes === 0) return 'No write group was returned, so there is nothing to rank.';

  const assessed = plural(shapes, 'write group');
  const unjudged =
    analysis.undeterminable === 0
      ? ''
      : ` ${analysis.undeterminable.toLocaleString()} of them recorded no written figure on any run, so no rule could read one.`;

  if (analysis.findingCount === 0) {
    return `No rule fired on the ${assessed} analyzed: they are the largest writers, not the worst.${unjudged}`;
  }
  return `${plural(analysis.findingCount, 'finding')} across the ${assessed} analyzed.${unjudged}`;
}

/**
 * Which rules this page is made of, said as a count rather than left to the findings to imply.
 *
 * The number is derived from the ruleset version and the payload rather than written here, for the reason
 * `jobs-language.ts` records: a count in prose goes stale the moment a rule is added, and this file has
 * no way to know it happened.
 */
export function rulesSentence(analysis: Writes): string {
  return (
    `Assessed against write rule set ${String(analysis.rulesVersion)}: two rules, one over statements that ` +
    'replace their target and one over statements that load into it. Neither reads what the statement wrote ' +
    'to — the query history does not record it.'
  );
}

/**
 * What one shape did, for the row that has a line to say it in.
 *
 * The statement type as the platform spells it, because that is the field, and the two figures the rules
 * read. Never a verb the type does not carry: a `REPLACE` replaced and an `INSERT` inserted, and neither
 * of them "rebuilt a table" as far as this payload knows.
 */
export function shapeLine(shape: WriteShape): string {
  const parts = [`${shape.statementType.toLowerCase()} · ${plural(shape.runs, 'run')}`];
  if (shape.medianWriteBytes != null) parts.push(`${bytes(shape.medianWriteBytes)} in the middle run`);
  else parts.push('no written figure recorded');
  return parts.join(' · ');
}

/** The single worst thing found on a shape, for the row that has one line to say it in. */
export function leadWriteFinding(shape: WriteShape): string | undefined {
  return shape.findings[0]?.headline;
}

/**
 * How much of this shape's runs the byte figures are over.
 *
 * Absent where every run stated a figure. Where some did not, the sentence gives both counts rather than a
 * share, because a reader checking a finding wants to know how many runs are behind the number and a
 * percentage makes them multiply to find out.
 */
export function statedRunsSentence(shape: WriteShape): string | undefined {
  const missing = shape.runs - shape.runsStatingBytes;
  if (missing <= 0) return undefined;
  return (
    `${String(shape.runsStatingBytes)} of its ${plural(shape.runs, 'run')} recorded a written figure, so the ` +
    'byte totals here are over those and not over all of them.'
  );
}

/**
 * When the shape was seen, where both ends were recorded.
 *
 * Both dates or neither. One end alone invites a reader to pair it with the window, and the window's other
 * end is the moment the run happened rather than the moment the shape stopped running.
 */
export function seenSentence(shape: WriteShape): string | undefined {
  if (shape.firstSeen == null || shape.lastSeen == null) return undefined;
  const first = new Date(shape.firstSeen);
  const last = new Date(shape.lastSeen);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return undefined;
  return `First run in this write group was ${first.toLocaleString()}, the last ${last.toLocaleString()}.`;
}

/** The caption over the representative statement, which is the largest write rather than the slowest. */
export const REPRESENTATIVE_NOTE =
  'The run in this write group that wrote the most, shown as it was recorded. Other runs in the group differ ' +
  'in their literals and in what they wrote.';

/** What the page says where the analysis exists and the estate simply does not write. */
export const NO_WRITES =
  'The window recorded no write statement at all. That is ordinary in a workspace whose data is written ' +
  'elsewhere, and it is not a statement about tables that exist and were not written.';

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
