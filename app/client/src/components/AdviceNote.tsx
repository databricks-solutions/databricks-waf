// What an action kept of the advisor finding it came from.
//
// Everything here is the record's own, written by the server when the action was raised and not
// recomputed since. That is the point of showing it: the advisor's opinion changes every run, and a
// pane that re-read the current advice would show whoever picks this up next a reason that is not the
// reason the work was agreed to.
//
// Three rules govern what this may say, and each of them is a sentence somebody would otherwise
// write here.
//
// **The date is the advice's, not the action's.** "Measured on the 3rd" is a fact about the advisory;
// nothing here knows whether it is still true, and the note says as much rather than implying it.
//
// **A number is shown with its unit and never converted into money.** The advisors that estimate a
// saving do it themselves, under assumptions they declare; a figure this component derived would be
// an estimate with nothing attached to it — which is the thing 44b's own note refuses.
//
// **Where the measurement is a sentence, it stays a sentence.** A serverless reason says what it saw in
// prose — `Its longest task run took 8.0 days` — and 44b gave the ones that fire on a quantity a number
// beside it. The rest fire on a setting, and the difference between two sentences is not a number, so
// this shows the sentence and claims nothing about it.

import { ExternalLink } from 'lucide-react';
import type { AdviceProvenance, AdviceReading } from '../api/types';
import { Surface } from './system';
import { Disclosure } from './ui/Disclosure';
// The advisor pages' own units, rather than a second reading of the same numbers. A baseline shown
// here in different words from the finding it was taken from would read as a different measurement.
import { evidencePhrase } from '../pages/workload-language';
import { STANDING_LABEL, incomparablePhrase, movementPhrase, readingPhrase } from '../pages/value-language';

/** Which advisor, in the word the Optimisation surface uses for it. */
const ADVISOR_LABEL: Readonly<Record<AdviceProvenance['advisor'], string>> = {
  workload: 'query workload',
  sizing: 'warehouse sizing',
  jobs: 'job health',
  writes: 'write patterns',
  serverless: 'serverless readiness',
};

const SUBJECT: Readonly<Record<AdviceProvenance['resource']['kind'], string>> = {
  shape: 'query group',
  warehouse: 'warehouse',
  job: 'job',
};

export function AdviceNote({
  advice,
  reading,
}: {
  readonly advice: AdviceProvenance;
  readonly reading?: AdviceReading;
}) {
  const day = advice.measuredAt.slice(0, 10);

  return (
    <Surface tone="inset" title="The advice this came from" headingLevel={3}>
      <p className="wa-body-compact font-medium text-wa-text">{advice.headline}</p>
      <p className="wa-caption">{advice.detail}</p>

      <p className="wa-caption">
        {ADVISOR_LABEL[advice.advisor]}, rule {advice.rule}, on {SUBJECT[advice.resource.kind]}{' '}
        {advice.resource.name ?? advice.resource.id} in workspace {advice.resource.workspaceId}.
      </p>

      {/* The numbers the rule fired on, as they were. Not compared with anything: no later reading
          has been taken here, and a delta this component computed would be one nobody measured. */}
      {advice.baseline.length > 0 && (
        <ul className="wa-caption flex flex-wrap gap-x-3 gap-y-0.5">
          {advice.baseline.map((evidence) => (
            <li key={evidence.label} className="wa-code">
              {evidencePhrase(evidence)}
            </li>
          ))}
        </ul>
      )}

      {advice.observation != null && <p className="wa-caption wa-code">{advice.observation}</p>}

      {/* Said rather than left as an empty list. An advisor that measured in prose is one whose
          advice cannot be subtracted from a later reading, and whoever picks this up should know
          that before they write down what "done" means for it. */}
      {advice.baseline.length === 0 && (
        <p className="wa-caption">
          This advisor reported what it saw as a sentence rather than as a number, so nothing here can be measured
          against a later reading of it.
        </p>
      )}

      <p className="wa-caption">
        Read on {day} from advisory {advice.advisoryId.slice(0, 8)}, over {advice.lookbackDays} days
        {advice.versions.length > 0
          ? `, under ${advice.versions.map((version) => `${version.name} ${version.value}`).join(' and ')}`
          : '. That analysis records no version of the rules it ran'}
        . Kept as it was: this is the advice the action was agreed against, not the advisor&rsquo;s latest.
      </p>

      {advice.assumptions.length > 0 && (
        <Disclosure summary="What that advisor's figures assume">
          <ul className="space-y-1.5">
            {advice.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </Disclosure>
      )}

      <a href={advice.docUrl} target="_blank" rel="noreferrer" className="wa-caption text-wa-action hover:underline">
        What to do about it
        <ExternalLink aria-hidden className="ml-1 inline h-3 w-3" />
      </a>

      {reading != null && <LaterReading reading={reading} />}
    </Surface>
  );
}

/**
 * What the latest advisory says about the same rule on the same resource.
 *
 * Under the advice rather than beside it, because it is only meaningful as a second reading of the
 * first: the server compared this pair and nothing else, and a panel that showed the later run's
 * numbers on their own would invite a comparison with whichever baseline the reader remembered.
 *
 * Two things this may not say. It may not call a movement an improvement — a measure can move for
 * reasons that have nothing to do with the work, and the direction that counts as better is not in
 * the payload. And it may not subtract: where `incomparable` is set the two readings were taken
 * differently, and the caution goes under them rather than the arithmetic.
 */
function LaterReading({ reading }: { readonly reading: AdviceReading }) {
  return (
    <div className="mt-2 border-t border-wa-divider pt-2">
      <p className="wa-body-compact font-medium text-wa-text">{STANDING_LABEL[reading.standing]}</p>
      <p className="wa-caption">{readingPhrase(reading)}</p>

      {reading.movements.length > 0 && (
        <ul className="wa-caption mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {reading.movements.map((movement) => (
            <li key={movement.label} className="wa-code">
              {movementPhrase(movement)}
            </li>
          ))}
        </ul>
      )}

      {reading.incomparable != null && <p className="wa-caption">{incomparablePhrase(reading.incomparable)}</p>}

      {/* A baseline measure the later run did not carry. Said by name, because the alternative is a
          partial comparison that looks whole: three of four measures moved and the fourth is missing
          reads, without this, as three measures that moved. */}
      {reading.unmatched.length > 0 && (
        <p className="wa-caption">
          The later run carries no reading of {reading.unmatched.join(', ')}, so{' '}
          {reading.unmatched.length === 1 ? 'that measure is' : 'those measures are'} not compared here.
        </p>
      )}

      <p className="wa-caption">
        Read from advisory {reading.advisoryId.slice(0, 8)} on {reading.measuredAt.slice(0, 10)}, over{' '}
        {reading.lookbackDays} days.
      </p>
    </div>
  );
}
