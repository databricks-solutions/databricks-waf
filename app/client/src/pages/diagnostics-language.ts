// The words and the shapes for a health reading.
//
// The server writes what a reading means and what to do about it, because those sentences are about
// the app's own internals and belong beside the code that knows them. What is here is everything that
// is presentation: the name of a dependency in the reader's terms, the tone and icon for a standing,
// and the one sentence the page's own header needs, which is a reduction over four readings rather
// than a property of any one of them.
//
// Tone and icon are chosen together in this file for the reason the outcome badges are: a status
// whose colour is decided in one place and whose shape in another is how the two came to disagree.

import { CheckCircle2, CircleHelp, CircleSlash, PlugZap, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui/StatusBadge';
import type { Diagnostics, HealthReading } from '../api/types';

type Standing = HealthReading['standing'];
type Dependency = HealthReading['dependency'];

/**
 * What each dependency is called, in the words the workspace uses for it.
 *
 * "Database" rather than "Lakebase" and "Identity" rather than "SCIM": the resource form an operator
 * has to open says the first of each pair, and a page that names the thing differently from the form
 * it is sending somebody to is a page that adds a translation step to every fix.
 */
export const DEPENDENCY_LABEL: Readonly<Record<Dependency, string>> = {
  warehouse: 'SQL warehouse',
  database: 'Database',
  identity: 'Identity',
  'audit-log': 'Audit trail',
};

/** One line saying what this app uses it for, so a reading is legible without knowing the internals. */
export const DEPENDENCY_PURPOSE: Readonly<Record<Dependency, string>> = {
  warehouse: 'Runs every statement the assessment measures from',
  database: 'Keeps runs, answers, decisions and assessment definitions',
  identity: 'Establishes who a caller is, so the gate can decide what they may change',
  'audit-log': 'Records every event: who did what, against what, and how it ended',
};

export const STANDING_LABEL: Readonly<Record<Standing, string>> = {
  answering: 'Answering',
  degraded: 'Degraded',
  silent: 'Silent',
  unbound: 'Not bound',
  unknown: 'Not established',
};

interface Presentation {
  readonly tone: Tone;
  readonly Icon: LucideIcon;
}

/**
 * Tone by what the reader has to do about it, not by sentiment.
 *
 * `unbound` is neutral rather than a warning, which is the one choice here worth arguing. A fresh
 * install has nothing bound, and colouring the ordinary first state of the app in red teaches the
 * reader that this page is always angry — after which the amber on the install that really is
 * degraded says nothing. It is also the only standing with a form to fill in, so the action beside it
 * carries more than a colour could.
 *
 * `unknown` is neutral for the reverse reason: it is the absence of a reading rather than a fault,
 * and it must not read as a quiet pass either. The word does that work.
 */
const PRESENTATION: Readonly<Record<Standing, Presentation>> = {
  answering: { tone: 'success', Icon: CheckCircle2 },
  degraded: { tone: 'warning', Icon: TriangleAlert },
  silent: { tone: 'danger', Icon: CircleSlash },
  unbound: { tone: 'neutral', Icon: PlugZap },
  unknown: { tone: 'neutral', Icon: CircleHelp },
};

export function standingPresentation(standing: Standing): Presentation {
  return PRESENTATION[standing];
}

/**
 * How a reading was arrived at, in four words beside the standing.
 *
 * Shown rather than folded into the detail because it changes what the standing claims: "answering"
 * established a second ago and "answering" as of the last run eleven hours ago are different
 * statements, and a reader who cannot tell them apart will take the stronger one.
 */
export function provenancePhrase(reading: HealthReading, now: Date = new Date()): string {
  if (reading.provenance === 'probed') return 'Checked just now';
  return `Observed ${agoPhrase(new Date(reading.at), now)}`;
}

/**
 * How long ago, to the coarsest unit that still answers the question.
 *
 * Coarse on purpose. The reader's question is whether the observation is old enough to distrust, and
 * "eleven hours ago" answers it where "11h 42m ago" invites arithmetic nobody needed.
 */
export function agoPhrase(at: Date, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (Number.isNaN(minutes)) return 'at an unknown time';
  if (minutes < 0) return 'just now';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} days ago`;
}

/**
 * The page's own verdict, in one sentence.
 *
 * Named for the faults rather than for the count, because "two of four dependencies are degraded" is
 * a statistic and "the database is silent, so nothing is being recorded" is a next step. Where more
 * than one thing is wrong it names them all: an operator who fixes the first and reloads should not
 * be told about the second as though it were new.
 */
export function healthSentence(diagnostics: Diagnostics): string {
  const faults = diagnostics.readings.filter(
    (reading) => reading.standing === 'silent' || reading.standing === 'degraded'
  );
  if (faults.length === 0) {
    const unbound = diagnostics.readings.filter((reading) => reading.standing === 'unbound');
    if (unbound.length > 0) {
      return `Nothing is failing. ${listOf(unbound.map((reading) => DEPENDENCY_LABEL[reading.dependency]))} ${
        unbound.length === 1 ? 'is' : 'are'
      } not bound, so part of what this app does is unavailable rather than broken.`;
    }
    return 'Everything this app depends on is answering, or was the last time anything used it.';
  }

  return `${listOf(faults.map((reading) => `${DEPENDENCY_LABEL[reading.dependency]} (${STANDING_LABEL[reading.standing].toLowerCase()})`))} ${
    faults.length === 1 ? 'needs' : 'need'
  } attention. Each reading below says what it means and what to do.`;
}

/** A, B and C. Kept here rather than at the two call sites that would each get the Oxford comma wrong. */
function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${String(parts.at(-1))}`;
}

/**
 * What the unrecorded count means, where there is one.
 *
 * Its own sentence rather than part of the audit reading, because it is the only number on this page
 * that describes something already lost: a reading says what is true now and this says what happened.
 * Undefined when nothing was missed, so the page shows no reassurance about a fault that never was.
 */
export function unrecordedSentence(unrecorded: number): string | undefined {
  if (unrecorded <= 0) return undefined;
  return `${String(unrecorded)} ${unrecorded === 1 ? 'action' : 'actions'} performed since this app last started ${
    unrecorded === 1 ? 'was' : 'were'
  } not written to the trail. They happened; the record of them did not, and it cannot be recovered.`;
}
