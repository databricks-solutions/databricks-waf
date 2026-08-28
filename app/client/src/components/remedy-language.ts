// How a remedy is labelled, who closes it, and where they go to do it.
//
// The server writes the sentence — it knows which scope was refused and what the platform said,
// and a second copy of that reasoning here would drift from it. What the client decides is the
// heading above the sentence, the edge colour beside it and whether there is somewhere in the app
// to go, because those are presentation: the same fact reads differently as "Missing access" than
// as "Nothing to chase", and which one a reader sees determines whether they open a ticket.
//
// The tones are deliberately not severity. An ungrantable scope is not a worse problem than a
// missing grant, it is a different owner, and colouring it red would put the app's own limits in
// the same visual channel as the estate's failures.

import type { RemedyKind } from '../api/types';

export interface RemedyPresentation {
  /** The heading, phrased as the work rather than the state. */
  readonly heading: string;
  /**
   * Who closes it, when that is somebody other than the reader. Absent otherwise.
   *
   * Only set where the reader might otherwise try to fix it themselves and fail. Naming an owner on
   * every kind put "Closed by whoever owns the practice." beneath all 105 findings, below the very
   * link that told the reader to close it — a line that varied with nothing, said nothing the advice
   * had not, and drew the eye past the one clickable thing on the pane. Where the reader is the
   * owner, or nobody is, silence is the accurate presentation.
   *
   * A clause rather than a noun: it is set as a sentence and not as a badge. The badge it used to be
   * needed 372px beside a 199px heading in a 366px pane, so it wrapped to its own line on every
   * finding at every viewport width, and the heading-left, owner-right row never once rendered.
   */
  readonly owner?: string;
  /**
   * A `wa-callout` modifier, or nothing for the muted edge.
   *
   * One modifier, not three. There was an `info` tone for `enable` and `retry`, drawn on `--wa-info`,
   * which is a deliberate near-neutral in this theme — and the default edge is `--wa-text-muted`. In
   * dark those two are 28 apart in RGB, which across a 3px stripe is nothing: two of the three tones
   * were the same tone, so a reader could not have learnt the code with the key in front of them.
   * What separates "the source is switched off" from "answer it" is the heading and the sentence,
   * which say it in words. A stripe indistinguishable from its neighbour is not a quieter way of
   * saying the same thing, it is a colour spent on nothing.
   */
  readonly tone?: 'wa-callout-warning';
  /**
   * Where in the app the reader goes, when there is anywhere.
   *
   * Only `attest` has one. Naming a destination in the advice and leaving the reader to find it
   * themselves is the kind of small friction that turns a call to action into a caption, and it
   * read worse still on a pane where the documentation link two sections below it is clickable.
   * A grant has no in-app destination, so offering a link for one would be inventing a journey.
   */
  readonly action?: { readonly label: string; readonly to: string };
}

const PRESENTATION: Readonly<Record<RemedyKind, RemedyPresentation>> = {
  /*
   * Coloured on the two that are actionable inside the reader's own estate, because those are the
   * only rows in a list of unmeasured requirements where doing nothing has a cost. Everything else
   * is either somebody else's decision or already correct.
   */
  /*
   * The two owners named are the two a reader cannot be sure they are. Somebody reading a finding
   * has no way to tell from the sentence whether the grant is theirs to issue, and the cost of
   * guessing wrong is an afternoon in the wrong console — so these say who, and the other four,
   * whose owner is either the reader or nobody, say nothing and let the advice carry it.
   */
  grant: {
    heading: 'Missing access',
    owner: 'a workspace or metastore admin',
    tone: 'wa-callout-warning',
  },
  enable: { heading: 'Source not enabled', owner: 'an account admin' },

  're-authorise': { heading: 'Sign in again', tone: 'wa-callout-warning' },
  /*
   * The heading says "judgement" and not "answer" on purpose.
   *
   * Three lines render 6px apart here: the heading, the advice, and the link. With "Needs an answer
   * from a person" above "An answer scores in place of a measurement" above "Answer this requirement",
   * the same word appeared three times inside 108px, and the effect is unmistakably machine-written —
   * the reader's eye reads one word three times and concludes the box has one idea padded to fill it.
   * The verb belongs to the link, which is the thing that acts; the heading names what is wanted.
   */
  attest: {
    heading: 'Needs a person’s judgement',
    action: { label: 'Answer this requirement', to: '/answers' },
  },
  retry: { heading: 'Did not finish' },
  report: { heading: 'A gap in this app' },
};

export function presentRemedy(kind: RemedyKind): RemedyPresentation {
  return PRESENTATION[kind];
}
