// Four figures about improvement work, side by side and never added together.
//
// [ADR 0083](../../../../docs/decisions/0083-four-value-figures-none-of-which-is-a-score-and-only-a-measured-one-aggregates.md)
// defines them, `value.ts` computes them and `value-language.ts` words them. What is left for this
// component is the layout, and the layout is the part of the decision most easily lost: four figures
// in one row with a shared heading is a dashboard, and a reader adds the numbers in a dashboard.
//
// So they are four labelled blocks, each carrying the sentence that says what produced it, in the
// order that keeps the two most confusable ones apart: posture first because it is the assessment's
// own and the only one a score may come from, then what an advisor says is available, then what
// somebody accepted, then what was measured twice. Opportunity and committed value differ by exactly
// one thing — whether a person said yes — and a reader who cannot tell them apart is a reader who
// reports the first as the second.
//
// **Nothing here moves a score, and no score enters the other three.** It is the prohibition in both
// audit readings, and this is the one component with all four in scope.

import type { ValueReport } from '../api/types';
import { Surface } from './system/Surface';
import { measuredOver, moneyPhrase, moneySource, movementPhrase } from '../pages/value-language';

export function ValueReportView({ value }: { readonly value: ValueReport }) {
  const outcomes = Object.entries(value.outcomes).filter(([, count]) => count > 0);

  return (
    <Surface
      tone="section"
      title="Four figures, and none of them is a total"
      description="Posture, opportunity, committed value and realised value answer different questions."
      label="What the work is worth"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Figure
          label="Posture"
          note="The assessment's own answer. The only figure here a score comes from, and nothing below is derived from it."
        >
          {value.posture == null ? (
            <Absent>No run has finished, so this install has no score to restate.</Absent>
          ) : (
            <>
              <p className="wa-body-compact text-wa-text">
                {value.posture.overall == null
                  ? 'Nothing scored'
                  : `${String(Math.round(value.posture.overall))} out of 100`}
              </p>
              <ValueNote>
                {value.posture.scoredControls.toLocaleString()} of {value.posture.totalControls.toLocaleString()}{' '}
                requirements scored, {value.posture.unmeasured.toLocaleString()} unmeasurable, from the run of{' '}
                {value.posture.at.slice(0, 10)}.
              </ValueNote>
            </>
          )}
        </Figure>

        <Figure
          label="Opportunity"
          note="What an advisor says is available now, in its own arithmetic. Not every advisor prices anything, and two advisors' figures are never one number."
        >
          <Amounts totals={value.opportunity} absent="No advisor in the latest run priced anything." />
        </Figure>

        <Figure
          label="Committed"
          note="The part of that opportunity somebody accepted by raising work against it, as it was priced on the day they did."
        >
          <Amounts
            totals={value.committed}
            absent="No action on the board was raised from a finding that carried a price."
          />
        </Figure>

        <Figure
          label="Realised"
          note="A measure read twice: once when the action was raised and once by the latest advisory. Both readings, never their difference."
        >
          {value.realised.length === 0 ? (
            <Absent>
              Nothing on the board has a measure the latest advisory read again. A finding it no longer reports leaves
              no reading to compare.
            </Absent>
          ) : (
            <ul className="space-y-1.5">
              {value.realised.map((measured) => (
                <li key={`${measured.advisor}-${measured.label}-${measured.unit}`}>
                  <p className="wa-body-compact wa-code text-wa-text">{movementPhrase(measured)}</p>
                  <ValueNote>{measuredOver(measured)}</ValueNote>
                </li>
              ))}
            </ul>
          )}

          {/* Beside the realised figures and deliberately not inside them. An advisor computes its
              evidence inside the condition that fires, so the run showing the work landed carries no
              reading of what it fired on — which makes the outcome worth aiming for the one with
              nothing to add here.

              A count of zero says only that nothing reached that reading. It is not "every finding is
              still reported": the same zero covers an action nobody has claimed done, one whose
              resource the latest advisory did not rank, and an install with no later advisory at all.
              What each one is instead is counted by outcome further down. */}
          <ValueNote>
            {value.cleared.actions === 0
              ? 'No action here has an advisory reading that stopped reporting the finding it was raised from.'
              : `${plural(value.cleared.actions, 'action')} on ${plural(value.cleared.resources, 'resource')} ` +
                'were raised from findings the latest advisory does not report. Those carry no measurement, so they ' +
                'are counted here rather than added above.'}
          </ValueNote>
        </Figure>
      </div>

      {/* Every advice-raised action by what the estate says now, including the ones that did not
          work and the ones nothing could read. A page whose only counts were its successes is the
          list the audit asks not to be given. */}
      {outcomes.length > 0 && (
        <div className="border-t border-wa-divider pt-4">
          <p className="wa-label">Every action raised from advice</p>
          <p className="wa-body-compact text-wa-text">
            {outcomes.map(([outcome, count]) => `${String(count)} ${OUTCOME_LABEL[outcome] ?? outcome}`).join(', ')}.
          </p>
        </div>
      )}
    </Surface>
  );
}

/**
 * What each agreement state means for an action raised from advice.
 *
 * The same six states the WAF board uses, worded for the other judge: an advice-raised action is
 * answered by a later advisory rather than by a scan, so `agreed` here means an advisory no longer
 * reports the finding and not that a requirement was met.
 */
const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  unclaimed: 'not yet claimed done',
  awaiting: 'claimed done, waiting on a later advisory',
  agreed: 'claimed done and no longer reported',
  contradicted: 'claimed done and still reported',
  unmeasured: 'claimed done, and the latest advisory could not read it',
  unjudged: 'not yet read by any later advisory',
};

function Figure({
  label,
  note,
  children,
}: {
  readonly label: string;
  readonly note: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <p className="wa-label">{label}</p>
      {children}
      <ValueNote>{note}</ValueNote>
    </section>
  );
}

/** One entry per advisor and currency, because that is the widest thing that may be added. */
function Amounts({ totals, absent }: { readonly totals: ValueReport['opportunity']; readonly absent: string }) {
  if (totals.length === 0) return <Absent>{absent}</Absent>;

  return (
    <ul className="space-y-1.5">
      {totals.map((total) => (
        <li key={`${total.advisor}-${total.currency}`}>
          <p className="wa-body-compact text-wa-text">{moneyPhrase(total)}</p>
          <ValueNote>{moneySource(total)}</ValueNote>
        </li>
      ))}
    </ul>
  );
}

/**
 * Why there is no number, rather than a zero.
 *
 * A zero is a measurement. Every absence here is the opposite — no run, no priced finding, no second
 * reading — and printing one as the other is the defect this whole surface exists downstream of.
 */
function Absent({ children }: { readonly children: React.ReactNode }) {
  return <p className="wa-body-compact text-wa-text-secondary">{children}</p>;
}

function ValueNote({ children }: { readonly children: React.ReactNode }) {
  return <p className="wa-value-note">{children}</p>;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
