// The words and the shapes for the trail.
//
// The trail's own vocabulary comes from the server — `AUDIT_PHRASES` in `server/audit/event.ts`, served
// with every page of events — so nothing here restates what an act is called. What is here is
// everything that is presentation: the tone and icon for an outcome, what a target kind is called in
// the reader's terms, how an instant and a digest are written, and the sentences the page's header
// needs, which are reductions over a page rather than properties of any one event.
//
// Times are absolute and never relative. Every other surface in this app says "three hours ago",
// because on those the reader's question is whether a reading is fresh. Here the reader's question is
// what happened at 09:41, usually while holding a ticket, an email or another system's log open beside
// it — and "three hours ago" cannot be lined up against any of those.

import { CheckCircle2, ShieldX, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { AuditEvent, AuditHead, AuditTrail, AuditVerification } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';

type Outcome = AuditEvent['outcome'];

/**
 * The three outcomes, in the words that distinguish them.
 *
 * "Refused" and "Failed" are the pair worth keeping apart in the reader's head: the first is the app
 * working — somebody outside the group asked for something and was turned away — and the second is
 * the app not working, on behalf of somebody who was entitled to what they asked for. A single word
 * covering both ("Unsuccessful") would bury the only distinction an auditor is reading for.
 */
export const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  performed: 'Performed',
  refused: 'Refused',
  failed: 'Failed',
};

interface Presentation {
  readonly tone: Tone;
  readonly Icon: LucideIcon;
}

/**
 * Tone by what the reader should make of it, not by sentiment.
 *
 * A refusal is not a fault, so it is not red. It is the gate doing exactly what it was built to do,
 * and an install with a healthy number of them is an install whose permissions are being enforced —
 * colouring them as errors would teach a reader to treat the page's alarming rows as normal, after
 * which the genuinely alarming row says nothing.
 *
 * A failure is amber rather than red for a narrower reason: by the time it is in the trail it is
 * history, and there is nothing on this page to do about it. The diagnostics page is where a fault
 * that is still happening is red.
 */
const PRESENTATION: Readonly<Record<Outcome, Presentation>> = {
  performed: { tone: 'success', Icon: CheckCircle2 },
  refused: { tone: 'neutral', Icon: ShieldX },
  failed: { tone: 'warning', Icon: TriangleAlert },
};

export function outcomePresentation(outcome: Outcome): Presentation {
  return PRESENTATION[outcome];
}

/**
 * What each kind of target is called.
 *
 * Every kind `event.ts` declares, and a fallback, because it may grow one before this file hears about
 * it and the honest rendering of an unknown kind is the kind itself. A map that silently returned
 * "Record" for anything it did not recognise would make a new kind of object look like an old one.
 */
const TARGET_LABEL: Readonly<Record<string, string>> = {
  scan: 'Run',
  control: 'Requirement',
  definition: 'Assessment',
  draft: 'Unfinished assessment',
  evidence: 'Collected evidence',
  'legal-hold': 'Legal hold',
  // A file this app produced and handed over. Named for what the reader is holding rather than for
  // the word the log uses, which is a term of art nobody outside this codebase says.
  artefact: 'Exported file',
  plan: 'Improvement plan',
  action: 'Action',
  // Only ever a target because a note can be written about a pillar. A note's own act names what the
  // note is about, so this is the reader seeing "Pillar — Data and AI governance" beside "wrote a note".
  pillar: 'Pillar',
};

export function targetLabel(kind: string): string {
  return TARGET_LABEL[kind] ?? kind;
}

/** How the caller was acting, in four words. Blank for a person, because that is the ordinary case. */
export function executionPhrase(mode: AuditEvent['executionMode']): string | undefined {
  return mode === 'service-principal' ? "the app's own identity" : undefined;
}

/**
 * An instant, to the second, in the reader's own locale.
 *
 * To the second and not to the minute: two acts in the same minute is the ordinary shape of somebody
 * working, and an auditor establishing which of two came first should not have to fall back to the
 * sequence number to find out.
 */
export function momentOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'an unknown time';
  return at.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * The first twelve characters of a digest.
 *
 * Enough to compare two by eye and far short of enough to verify anything, which is the honest
 * division of labour: a person checks that the head they wrote down last quarter starts the same way,
 * and the app checks the chain. Shown in full nowhere on this page, because sixty-four hex characters
 * in a table cell is a column of noise that pushes the columns a reader came for off the screen.
 */
export function digestBrief(digest: string): string {
  const hex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return hex.slice(0, 12);
}

/**
 * What the head is for, said once beside it.
 *
 * The head digest is the one value on this page a customer should copy somewhere this app cannot
 * reach. Nothing about a self-verifying log is evidence against the app that wrote it: the chain
 * proves that nobody edited a row without rewriting every row after it, and this app could do exactly
 * that. A digest recorded elsewhere at a known date is what closes that hole, and it only closes it if
 * somebody was told to record it.
 */
export function headSentence(head: AuditHead): string {
  return (
    `The chain now ends at event ${String(head.sequence)}, digest ${digestBrief(head.digest)}. ` +
    'Recording that value somewhere outside this app — a ticket, a minute, a mail to yourself — is ' +
    'what lets you prove later that the history below has not been rewritten since today. The chain ' +
    'on its own proves only that it is internally consistent, which is a weaker claim.'
  );
}

/** Whether the chain is intact, for the badge beside the header. */
export function verificationPresentation(verification: AuditVerification): Presentation & { readonly label: string } {
  if (verification.breaks.length > 0) {
    return { tone: 'danger', Icon: TriangleAlert, label: 'Chain broken' };
  }
  if (verification.checked === 0) {
    return { tone: 'neutral', Icon: CheckCircle2, label: 'Nothing to check' };
  }
  return { tone: 'success', Icon: CheckCircle2, label: 'Chain intact' };
}

/**
 * Which part of the trail is on screen.
 *
 * By sequence rather than by row number, because the sequence is the trail's own identity for an act
 * and it is what the reader will quote. "Rows 21 to 40" is a fact about this page; "acts 412 down to
 * 393" is a fact about the log.
 */
export function rangeSentence(trail: AuditTrail): string {
  const first = trail.events[0];
  const last = trail.events.at(-1);
  if (first == null || last == null) return 'No events match';

  const span =
    first.sequence === last.sequence
      ? `Event ${String(first.sequence)}`
      : `Events ${String(first.sequence)} down to ${String(last.sequence)}`;
  const of = trail.head == null ? '' : ` of ${String(trail.head.sequence)} recorded`;
  return `${span}${of}`;
}

/**
 * Why a reason is a word rather than a sentence.
 *
 * Shown once under the list rather than per row, because it is a property of the whole column and a
 * reader who meets `PostgresError` in a cell will otherwise read it as the app failing to write a
 * message it had. It did not have one: an exception's text is the likeliest place in this app for a
 * host name, a connection string or a fragment of a customer's query to end up, and this log is
 * designed to be handed to somebody outside the estate. See ADR 0046.
 */
export const REASON_NOTE =
  'A reason is this app\u2019s own identifier for how an event ended \u2014 a refusal it chose, or the ' +
  'class of an error it caught \u2014 and never a message from the database. An exception\u2019s text is ' +
  'where an estate detail would leak into a record meant to outlive the incident.';

/** What the filters exclude, for the empty state that is not an empty trail. */
export const NOTHING_MATCHED =
  'These filters match no event in the trail. That is a result rather than a fault \u2014 "nobody has ' +
  'ever been refused a definition change" is a question worth being able to ask \u2014 but widening ' +
  'them is how you tell it from having asked the wrong question.';
