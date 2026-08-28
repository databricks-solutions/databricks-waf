// A score bar that shows what it does not know.
//
// A solid progress bar asserts a boundary: everything to the left is achieved, everything
// to the right is not. That is true only when every applicable requirement was measured.
// When some could not be read, the honest picture has three parts — solid up to the score
// the estate holds however the unknowns turn out, hatched across the span still in play,
// and empty for what was measured and failed.
//
// One code path, not a solid bar for certain pillars and a banded one for uncertain ones.
// A fully measured pillar has an empty band, so it renders as the plain bar anyway, and the
// geometry is identical across pillars by construction rather than by coincidence — which
// matters, because the reason to draw these at all is comparing them to each other.
//
// The track and fill use the same tokens as AppKit's Progress so the two look alike, but
// the markup is local: Progress fills to a single value, which is exactly the assertion
// this component exists not to make.
//
// Geometry and colour are in .wa-meter-* in wa-tailwind.css. Only the two widths are inline,
// because they are the data.

import { scoreBand } from './verdict-language';
import type { ScoreRange } from '../api/types';

export interface ScoreBarProps {
  readonly score: number;
  readonly range?: ScoreRange;
  readonly label: string;
}

export function ScoreBar({ score, range, label }: ScoreBarProps): React.JSX.Element {
  const floor = range?.low ?? score;
  const ceiling = Math.max(range?.high ?? score, floor);
  const unknown = ceiling - floor;

  return (
    <div
      className="wa-meter-track"
      // The band is an attribute rather than a class so the colour rule stays in the stylesheet
      // with the rest of the meter's geometry, and the component keeps naming no colour at all.
      data-band={scoreBand(score)}
      role="meter"
      aria-valuenow={score}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={
        unknown > 0
          ? `${label}: ${score.toFixed(1)} out of 100, and between ${floor.toFixed(1)} and ${ceiling.toFixed(
              1
            )} once unmeasured requirements are known`
          : `${label}: ${score.toFixed(1)} out of 100`
      }
    >
      {/* Earned, and safe from any outcome of what is unmeasured. */}
      <div className="wa-meter-earned" style={{ width: `${String(floor)}%` }} />

      {/* Still in play. */}
      {unknown > 0 && (
        <div className="wa-meter-unknown" style={{ left: `${String(floor)}%`, width: `${String(unknown)}%` }} />
      )}
    </div>
  );
}
