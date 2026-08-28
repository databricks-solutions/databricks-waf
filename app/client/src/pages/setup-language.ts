// The sentences the setup says, and the arithmetic behind them.
//
// Its own module for the reason the other language files are: a sentence written inline in a
// component is a sentence nobody tests, and half of these are about the difference between two
// states that read almost the same. "Saved a moment ago" and "kept in memory only" are the same
// length and mean opposite things about whether tomorrow's visit finds the work.
//
// The steps are declared here rather than imported from the server, and that is a deliberate
// duplication of five strings. The alternative is importing a server module into the browser
// bundle for a tuple, and the pairing is checked where it matters: the wizard reads `resumeAt` and
// the troubles' `step` from the server, and `stepFrom` refuses anything it does not recognise, so a
// step renamed on one side lands the reader on the first step rather than on a blank page.

import type { DraftTarget, ScopePreview, SetupDraft } from '@/api/types';

export const SETUP_STEPS = ['purpose', 'scope', 'sources', 'targets', 'policies', 'confirm'] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * A step name from the URL or from the server, or nothing when it is neither.
 *
 * Returns undefined rather than falling back to `purpose`, so the caller can tell "no step asked
 * for" from "a step this build does not have" — the first resumes, the second is a stale link and
 * resuming is also the right answer, but the caller decides that rather than this.
 */
export function stepFrom(raw: string | null | undefined): SetupStep | undefined {
  return SETUP_STEPS.find((step) => step === raw);
}

export interface StepCopy {
  readonly title: string;
  /** One line under the title, saying what the step is for rather than what to type. */
  readonly blurb: string;
}

/**
 * What each step is called and what it is for.
 *
 * `sources`, `targets` and `policies` come after scope because all three are consequences of it:
 * what gets read follows from which pillars are in the assessment, a commitment can only be made
 * about a pillar that is in it, and the rules the result will be judged by are worth reading once
 * the reader knows what is being judged.
 */
export const STEPS: Readonly<Record<SetupStep, StepCopy>> = {
  purpose: {
    title: 'What this is and who owns it',
    blurb: 'A name somebody can ask for it by, why it exists, and the people accountable for the answer.',
  },
  scope: {
    title: 'What it covers',
    blurb: 'Which workspaces are in it and how far back it reads, held against the estate as the last scan found it.',
  },
  sources: {
    title: 'Where the answers come from',
    blurb: 'Which pillars are in the assessment, what a run reads to answer them, and what only a person can answer.',
  },
  targets: {
    title: 'What you are aiming for',
    blurb:
      'A score to reach on a pillar and the date to reach it by. Optional, and an assessment that commits to nothing is a real answer.',
  },
  policies: {
    title: 'How the result will be judged',
    blurb:
      'The rules a run applies, stated here because they decide what the score means and none of them is optional.',
  },
  confirm: {
    title: 'Confirm it',
    blurb: 'Everything above in one place, and the version this becomes.',
  },
};

/** Where a step stands, which is what the contents strip shows against each one. */
export type StepStanding = 'unfinished' | 'done' | 'nothing-to-fill-in';

/**
 * How a step is getting on.
 *
 * `nothing-to-fill-in` is not a tidier `done`. The policies step has no field on it, and marking it
 * finished would claim the reader had done something they have not — while marking it unfinished
 * would send the resume there forever. Naming the third state is what lets the strip say "read it
 * if you want to" instead of lying in either direction.
 */
export function standingOfStep(draft: SetupDraft | undefined, step: SetupStep): StepStanding {
  if (step === 'policies') return 'nothing-to-fill-in';
  if (draft == null) return 'unfinished';
  if (step === 'confirm') return draft.ready ? 'done' : 'unfinished';
  return draft.troubles.some((trouble) => trouble.step === step) ? 'unfinished' : 'done';
}

/** What is outstanding on one step, in the server's own words. */
export function troublesOn(draft: SetupDraft | undefined, step: SetupStep): readonly string[] {
  return (draft?.troubles ?? []).filter((one) => one.step === step).map((one) => one.trouble);
}

/**
 * Whether the work will still be here tomorrow, and when it was last kept.
 *
 * Both halves in one sentence on purpose. A wizard that autosaves and says so trains a reader to
 * stop worrying about losing it, and if the install has nothing bound to keep drafts in then that
 * training is exactly wrong — so the durability is not a footnote somewhere else on the page.
 */
export function describeSaving(
  state: { readonly savedAt?: string; readonly saving: boolean; readonly error?: string },
  durable: boolean,
  now: Date = new Date()
): string {
  if (state.error != null) return `Not saved. ${state.error}`;
  if (state.saving) return 'Saving…';
  if (state.savedAt == null) {
    return durable
      ? 'Nothing is saved yet. It will be kept as soon as you type something.'
      : 'Nothing is saved yet, and this install keeps drafts in memory only — finish in one sitting.';
  }
  const kept = `Kept ${describeWhen(new Date(state.savedAt), now)}`;
  return durable
    ? `${kept}, so you can leave this and come back to it.`
    : `${kept}, in memory only: a restart or a redeploy loses it.`;
}

function describeWhen(at: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  if (seconds < 60) return 'a moment ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return `on ${at.toLocaleDateString()}`;
}

/**
 * Which pillars are in it.
 *
 * An absent list means every pillar, exactly as it does on a definition, and this says so in words
 * rather than showing an empty selection — because the two states an author can be in here are "I
 * want all of it" and "I want these four", and only one of them is a list.
 */
export function describePillars(chosen: readonly string[] | undefined, available: number): string {
  if (chosen == null) {
    return available === 0
      ? 'Every pillar this build measures.'
      : `Every pillar this build measures, all ${String(available)} of them.`;
  }
  if (chosen.length === 0) return 'No pillars, which is not an assessment. Choose at least one, or choose them all.';
  if (available > 0 && chosen.length === available) {
    return `All ${String(available)} pillars, chosen one by one. Leaving them all selected means the same thing as choosing none of them.`;
  }
  return `${plural(chosen.length, 'pillar')} of ${String(available)}. The rest are not measured and are not scored.`;
}

/**
 * What this assessment commits to, as one sentence.
 *
 * "Nothing" is stated rather than left blank, because the strip marks a step with no troubles on it
 * as done — and a targets step reading "done" beside an empty commitment would let an author leave
 * believing they had set one. Saying that committing to nothing is allowed is what makes the tick
 * mean what it says.
 *
 * Half-written rows are counted with the rest. They are the reason the step is unfinished, the
 * trouble beside it already says which pillar and what is missing, and describing them separately
 * here would put two accounts of the same row on one screen.
 */
export function describeTargets(
  targets: readonly DraftTarget[] | undefined,
  pillarTitle: (pillarId: string) => string = (pillarId) => pillarId
): string {
  const written = (targets ?? []).filter((target) => target.pillar.trim() !== '');
  if (written.length === 0) return 'Nothing committed to, which is allowed and is how most assessments start.';

  const whole = written.filter((target) => target.atLeast != null && (target.by ?? '') !== '');
  if (whole.length === 0) return `${plural(written.length, 'commitment')} started, none of them finished.`;

  // The nearest date, and only worth naming when there is more than one. With a single commitment the
  // row saying the same thing is directly below this sentence, and "the nearest is" reads as though a
  // second one is being kept somewhere out of sight.
  const soonest = whole.length > 1 ? [...whole].sort((one, two) => (one.by ?? '').localeCompare(two.by ?? ''))[0] : undefined;
  const first =
    soonest == null
      ? ''
      : ` The nearest is ${pillarTitle(soonest.pillar)} at ${String(soonest.atLeast ?? 0)} by ${describeDay(soonest.by ?? '')}.`;
  const started = written.length - whole.length;
  const rest = started > 0 ? ` ${plural(started, 'other')} still half-written.` : '';
  return `${plural(whole.length, 'commitment')}.${first}${rest}`;
}

/**
 * Each commitment as its own line, for a surface with no row beside it to read.
 *
 * The step can summarise, because the rows are on screen under the sentence. The confirmation cannot:
 * it is the last thing an author reads before pressing a button, its whole job is to say what is
 * about to be recorded, and "1 commitment" is the one fact about a commitment that does not include
 * the commitment.
 *
 * Half-written rows are listed too, and named as such. They will not be recorded, and an author who
 * typed a score and never came back needs to see that here rather than discover it in the version.
 */
export function listTargets(
  targets: readonly DraftTarget[] | undefined,
  pillarTitle: (pillarId: string) => string = (pillarId) => pillarId
): readonly string[] {
  return (targets ?? [])
    .filter((target) => target.pillar.trim() !== '')
    .map((target) => {
      const named = pillarTitle(target.pillar);
      if (target.atLeast == null || (target.by ?? '') === '') {
        return `${named} — half a commitment, so it will not be recorded`;
      }
      return `${named} to at least ${String(target.atLeast)} by ${describeDay(target.by ?? '')}`;
    });
}

/**
 * A date the author typed, as a day a reader recognises.
 *
 * Strict about the shape, and deliberately stricter than `new Date` is. The field this comes from is
 * a date input, so a whole value is always `YYYY-MM-DD` — and `new Date` reads a half-typed `2026-1`
 * as the first of January, which would print a day the author had not chosen yet as though they had.
 * Anything that is not the whole shape is passed through, and the step's own field is where it gets
 * complained about.
 *
 * Rendered in UTC for the reason the server's identical helper is: the stored value is a day rather
 * than an instant, and a reader west of Greenwich would otherwise be shown the day before the one
 * they typed.
 */
export function describeDay(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const when = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) return raw;
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * What a run does to the workspace to answer one pillar, as a count of the things it touches.
 *
 * Counted rather than listed. The Checks page lists them, and repeating a hundred table names here
 * would make the step that exists to be read the longest one in the setup.
 */
export function describeSources(pillar: {
  readonly signals: readonly { readonly touches: readonly string[] }[];
  readonly answeredControls: number;
  readonly unanswered: {
    readonly attestation: number;
    readonly unreachable: number;
    readonly planned: number;
    readonly unimplemented: number;
  };
}): string {
  const touched = new Set(pillar.signals.flatMap((signal) => signal.touches));
  // An endpoint is written as a path and a system table is not, which is the distinction the plan
  // itself makes in `touches`. Counted separately because they are two different grants to ask for.
  const endpoints = [...touched].filter((one) => one.startsWith('/')).length;
  const tables = touched.size - endpoints;

  const reads =
    touched.size === 0
      ? 'Nothing here is read automatically'
      : `Reads ${[tables > 0 ? plural(tables, 'system table') : '', endpoints > 0 ? plural(endpoints, 'endpoint') : '']
          .filter((part) => part !== '')
          .join(' and ')} to measure ${plural(pillar.answeredControls, 'requirement')}`;

  const { attestation, unreachable, planned, unimplemented } = pillar.unanswered;
  const rest = [
    attestation > 0 ? `${plural(attestation, 'requirement')} only a person can answer` : '',
    unreachable > 0 ? `${plural(unreachable, 'requirement')} no install of this app is allowed to read` : '',
    planned + unimplemented > 0 ? `${plural(planned + unimplemented, 'requirement')} with no check yet` : '',
  ].filter((part) => part !== '');

  return rest.length === 0 ? `${reads}.` : `${reads}. Beside that: ${rest.join(', ')}.`;
}

/** One rule a run applies, and why it is not a setting. */
export interface Policy {
  readonly rule: string;
  readonly detail: string;
}

/**
 * The rules the result will be judged by.
 *
 * Read-only, and that is the design rather than a stage it is at. Every one of these is enforced by
 * the runner, the scorer or the record, so a control here that did not change any of them would be
 * a setting that appears to do something — the worst kind. They are stated because an author who
 * does not know that an under-granted scan still produces a score will read that score as an
 * assessment of the estate rather than of the part of it the app could see.
 */
export const POLICIES: readonly Policy[] = [
  {
    rule: 'A run reads as whoever started it, never as the app.',
    detail:
      'Every statement is executed with the caller’s own credentials, so a requirement they cannot see is ' +
      'reported unmeasured rather than answered from somebody else’s access. It also means two people can ' +
      'run the same assessment and get different coverage, and the run says which of them it was.',
  },
  {
    rule: 'Missing access does not fail the run. It narrows it.',
    detail:
      'A check whose source cannot be read is recorded as unmeasured, with the reason, and the score is ' +
      'computed from what remained. That is why the assessment is worth checking before it is run: the ' +
      'result of an under-granted scan looks like an answer.',
  },
  {
    rule: 'A requirement only a person can answer is not scored until somebody answers it.',
    detail:
      'Sixty-three of them are questions about process rather than about the platform. An unanswered one ' +
      'counts as unmeasured, and an answer carries the name of who gave it and the date it stops counting.',
  },
  {
    rule: 'An answer expires, and an expired answer stops scoring.',
    detail:
      'Answers are dated and reviewed rather than kept forever, because a statement about how a team ' +
      'operates is only true of the team that made it. Renewing one is a new dated record naming the one ' +
      'it replaced; nothing is overwritten.',
  },
  {
    rule: 'A decision about a finding does not change the finding.',
    detail:
      'Accepting a risk or planning a fix is recorded beside the result, dated and attributed, and the ' +
      'requirement still fails and still costs its points. That is what makes the record readable a year ' +
      'later by somebody asking why.',
  },
  {
    rule: 'Changing what is measured starts a new trend rather than continuing the old one.',
    detail:
      'Scope, lookback and pillars are fingerprinted. Two runs of the same fingerprint are comparable; a ' +
      'revision that changes any of them is a different question, and the app says so instead of drawing ' +
      'one line through both.',
  },
];

/**
 * What the preview found, as the sentence above the lists.
 *
 * The server sends its own description and this defers to it wherever it can, because the resolution
 * is the server's and a second account of it here is a second place to be wrong. What this adds is
 * the case the server cannot describe: there is no directory to resolve against, and the reader needs
 * to know that the empty lists below mean "not known" rather than "nothing".
 */
export function describePreview(preview: ScopePreview | undefined): string {
  if (preview == null) return 'Choosing a scope will show what it covers.';
  if (preview.unavailable != null) return preview.unavailable;
  return preview.description;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
