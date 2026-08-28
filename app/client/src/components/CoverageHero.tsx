// The first thing on the page, because it is the first thing that is true.
//
// The page used to open with six score cards, and a reader who took 52.7 from it was holding a
// number computed from 34 of 138 applicable requirements while reading it as an architecture
// rating. That is not a presentational problem. Any surface that shows the score more prominently
// than the coverage is actively misinforming, and this component exists to make coverage the
// dominant fact and the score a secondary one.
//
// The score is still here. Hiding it would be a different dishonesty — the arithmetic exists, the
// reader will find it, and a tool that conceals its own output invites the suspicion that the
// output is bad. It sits to the side, labelled as measured posture over what was evaluated.

import { Link } from 'react-router';
import { Surface } from './system/Surface';
import { Disclosure } from './ui/Disclosure';
import { ReviewStandingDetail, ReviewStandingNote } from './ReviewStanding';
import { ScoreDisclaimer } from './ui/ScoreDisclaimer';
import { Segments, SegmentLegend, type Segment } from './ui/Segments';
import { CONFIDENCE_LABEL, confidenceOf, confidenceSentence, estateCoverage, isDirectional } from './coverage';
import { rangeSentence } from './score-range';
import type { Scan, Unmeasured } from '../api/types';

export interface CoverageHeroProps {
  readonly scan: Scan;
  /** A pillar's own words, for the review note. Absent → a skipped pillar is named by its id. */
  readonly pillarTitle?: (pillarId: string) => string;
}

export function CoverageHero({ scan, pillarTitle }: CoverageHeroProps) {
  const coverage = estateCoverage(scan.score);
  const confidence = confidenceOf(coverage);
  const counts = scan.score.counts;

  // Each segment leads to the requirements it counted, as the pillar page's do. This component is
  // also the report's opening panel, where the links print as plain text and cost nothing.
  const segments: readonly Segment[] = [
    { label: 'Met', value: counts.pass + counts['satisfied-by-architecture'], tone: 'success', to: to('met') },
    { label: 'Partly met', value: counts.partial, tone: 'warning', to: to('partial') },
    { label: 'Not met', value: counts.fail, tone: 'danger', to: to('fail') },
    { label: 'Unmeasured', value: counts.unmeasurable, tone: 'unknown', to: to('unmeasurable') },
    { label: 'Not applicable', value: counts['not-applicable'], tone: 'excluded', to: to('not-applicable') },
  ];

  return (
    <Surface tone="section" label="Assessment coverage and confidence" className="wa-coverage-hero">
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="wa-numeric text-4xl leading-none font-semibold text-wa-text">
              {Math.round(coverage.percent)}%
            </h2>
            <p className="wa-title-section text-wa-text">of the applicable framework assessed</p>
          </div>

          <p className="wa-body-compact max-w-prose text-wa-text-secondary">
            {coverage.assessed.toLocaleString()} of {coverage.applicable.toLocaleString()} applicable requirements were
            evaluated
            {coverage.notApplicable > 0 &&
              `, with ${coverage.notApplicable.toLocaleString()} excluded as not applicable to this estate`}
            . {confidenceSentence(coverage)}
          </p>

          <Segments
            segments={segments}
            total={scan.score.totalControls}
            of={`the ${scan.score.totalControls.toLocaleString()} requirements in this catalogue`}
          />
          <SegmentLegend segments={segments} total={scan.score.totalControls} />
        </div>

        {/*
          The score, deliberately in the sidebar and deliberately not large. The vertical rule
          rather than a nested card: this is a second reading of the same subject, not a second
          subject.
        */}
        <div className="space-y-3 lg:border-l lg:border-wa-divider lg:pl-6">
          <div>
            <p className="wa-label">Confidence</p>
            <p className="wa-title-section text-wa-text">{CONFIDENCE_LABEL[confidence]}</p>
            {/* Named here as well as in the paragraph, because this is the box a reader looks at
                when they want one word for how much to trust the number — and "Moderate" with no
                reason beside it invites them to assume the reason is coverage. */}
            {coverage.attested > 0 && (
              <p className="wa-caption mt-1">
                {/* A count and no denominator. It read "12 of 34 assessed", which is the deduplicated
                    scoring set — while the paragraph to the left says how many were assessed, and
                    that number is larger wherever the catalogue aliases controls. Two totals under
                    one word, in one panel. The share with its proper denominator is in that
                    paragraph, so what is wanted here is the count and the way to go and read them. */}
                {coverage.attested.toLocaleString()} answered by a person.{' '}
                <Link className="text-wa-action hover:underline" to="/answers">
                  Review answers
                </Link>
              </p>
            )}
            {/* An imported reading is a measurement, taken against an authority this app cannot
                reach. Said separately from the answered count because it does not weaken confidence
                the way an answer does, and folding the two into one caption would imply it did. */}
            {coverage.adminCollected > 0 && (
              <p className="wa-caption mt-1">
                {coverage.adminCollected.toLocaleString()} imported from a check an administrator ran.
              </p>
            )}
          </div>

          <div>
            <p className="wa-label">Measured posture</p>
            <p className="flex items-baseline gap-1.5">
              <span className="wa-numeric text-2xl leading-none font-semibold text-wa-text-secondary">
                {scan.score.overall?.toFixed(1) ?? '—'}
              </span>
              <span className="wa-caption">/ 100</span>
            </p>
            <p className="wa-caption mt-1">
              {isDirectional(scan.score.range)
                ? 'Directional. Based only on what was evaluated.'
                : 'Based only on what was evaluated.'}
            </p>
          </div>

          {/* Beside the number rather than under the disclosure, because whether a person has been
              over this run is the second thing somebody quoting the score should know and the first
              thing they will not think to open a disclosure for. */}
          <ReviewStandingNote
            {...(scan.finalisation != null ? { finalisation: scan.finalisation } : {})}
            {...(pillarTitle != null ? { pillarTitle } : {})}
          />

          <Disclosure summary="How this number is derived">
            <ScoreDisclaimer />
            <p>
              {rangeSentence(scan.score.range, counts.unmeasurable, {
                subject: 'this estate',
                by: unmeasuredSplit(scan),
              }) ?? 'Every applicable requirement in this estate was measured, so the score cannot move.'}
            </p>
            {/* What the review was made of, with the unmeasured split above it: the two together are
                what the score does not cover, from the check's side and from the person's. */}
            <ReviewStandingDetail
              {...(scan.finalisation != null ? { finalisation: scan.finalisation } : {})}
              {...(pillarTitle != null ? { pillarTitle } : {})}
            />
            <p>{scan.stamp.scope.description}</p>
          </Disclosure>
        </div>
      </div>
    </Surface>
  );
}

const to = (outcome: string) => `/investigate?outcome=${outcome}`;

/** The estate's unmeasured split, which is the pillars' added up. */
function unmeasuredSplit(scan: Scan): Record<Unmeasured, number> {
  const total: Record<Unmeasured, number> = {
    attestation: 0,
    unreachable: 0,
    unbuilt: 0,
    unreadable: 0,
    disabled: 0,
  };
  for (const pillar of scan.score.pillars) {
    // Over the accumulator's own keys rather than a second list of the same kinds beside it. Those
    // were two lists of the same thing, and a fifth kind added to one of them would sum to a total
    // the segments below it do not add up to.
    for (const kind of Object.keys(total) as Unmeasured[]) {
      total[kind] += pillar.unmeasuredBy?.[kind] ?? 0;
    }
  }
  return total;
}
