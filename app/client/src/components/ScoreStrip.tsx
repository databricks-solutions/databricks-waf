// Band one: eight cards — the estate, then all seven pillars.
//
// This was four: the estate and the three pillars with the most to act on, with the other four left
// to a census table further down the page. The stated reason was width, and the arithmetic was right
// for the width it was given — eight cards under the old 1236px page cap are 133px each, below the
// 150px floor. The conclusion was wrong anyway, because the cap contradicted the spec's own measure,
// and a ranking then decided which pillar scores a reader was allowed to see. Somebody landing on a
// seven-pillar review saw three scores and no way to tell which four were missing or why.
//
// So the strip is the census now, and it is the whole of it. Nothing here ranks, hides or selects:
// eight cards, one row, every pillar named whether it has anything to report or not — which is the
// thing the old table was kept for and the thing a card grid was said to be incapable of. It is
// capable of it as long as an unmeasured pillar shows no number, which is the rule below.
//
// The number is the only large thing on a card — 28px against a 12px name. That ratio is what the
// version before this did not have: name and number were within two points of each other, so the
// band read as a wall of text and the worst pillar had to be found by reading all of them.
//
// Three rules the strip enforces, all of them things the earlier card wall got wrong:
//
// A pillar nobody measured shows no number. Not 0.0, not a grey zero — the words "Not assessed",
// because a zero in a row of scores is read as a catastrophic result no matter how it is toned, and
// a reader who takes that away has been actively misled rather than merely under-informed.
//
// A pillar measured too thinly to support its own number shows the muted number with its range and
// opens the evidence gaps that would settle it, because "41, could be 41–78" is a different claim
// from "41" and should not inherit the same posture colour or trend treatment.
//
// The sparkline appears at three measured points, and draws a line through three comparable ones in a
// row. One or two make a flat line or a two-point slope, both of which read as stability — the single
// most confident thing this app could say and the one it has the least evidence for — and a break
// elsewhere in the series does not earn either of them. A point that was not compared stays visible as
// that break, with its reason, rather than being filtered out until the line looks smooth.

import { Link } from 'react-router';
import { PillarIcon } from './shell/PillarIcon';
import { shortPillarLabel } from './shell/pillar-label';
import { scoreStroke, scoreTone, scoreVerdict } from './verdict-language';
import { drawable, pillarSeries, type Series, type SeriesPoint } from './trend';
import { isUncertain, tooLittleMeasured } from './score-range';
import { evidenceGapPath } from './score-path';
import { SCORE_DISCLAIMER, ScoreDisclaimerMark } from './ui/ScoreDisclaimer';
import type { PillarScore, Scan, ScanSummary } from '../api/types';

export interface ScoreStripProps {
  readonly scan: Scan;
  readonly history: readonly ScanSummary[];
  readonly pillars: readonly { readonly id: string; readonly title: string }[];
}

export function ScoreStrip({ scan, history, pillars }: ScoreStripProps) {
  return (
    <div className="wa-strip">
      <EstateCard scan={scan} />
      {pillars.map((pillar) => (
        <PillarCard
          key={pillar.id}
          pillarId={pillar.id}
          title={pillar.title}
          score={scan.score.pillars.find((entry) => entry.pillarId === pillar.id)}
          history={history}
          stamp={scan.stamp}
        />
      ))}
    </div>
  );
}

/**
 * The estate's own card. First in the strip, and the only one that is not a pillar.
 *
 * A link now, to the page that compares all seven. It was a `<div>`, which made the largest number
 * on the landing page the one thing on it that could not be followed — a reader who wanted to know
 * what "58" was made of had to guess that a pillar card was the way in.
 */
function EstateCard({ scan }: { scan: Scan }) {
  const score = scan.score.overall;
  const measured = scan.score.scoredControls > 0 && score != null;
  const directional = measured && tooLittleMeasured(scan.score.range);

  return (
    <Link to={directional ? evidenceGapPath() : '/investigate'} className="wa-scorecard">
      <span className="flex items-start gap-1.5">
        <span aria-hidden className="wa-icon-frame">
          <span className="h-2.5 w-2.5 rounded-xs bg-wa-lava" />
        </span>
        <span className="wa-caption wa-scorecard-label pt-0.5 font-semibold text-wa-text">
          {directional ? 'Application-defined score' : 'Measured posture'}
        </span>
      </span>

      {measured ? <Value score={score} range={scan.score.range} /> : <NotAssessed />}

      {/*
        The caveat, and nothing beside it.
        
        It shared this row with a "7 pillars" count, and the two of them in the 140px the strip gives
        a card wrapped into each other: "7 Application-" over "pillars defined". The count is the one
        that went, because the seven pillar cards are in this same row — it was counting things the
        reader can see. The caveat stays on the card because the card is what gets screenshotted into
        a steering deck, and a score that arrives there without it gets quoted as Databricks'.
      */}
      {directional ? (
        <>
          <EvidenceGapAction />
          <span className="sr-only">{SCORE_DISCLAIMER}</span>
        </>
      ) : (
        <ScoreDisclaimerMark />
      )}
    </Link>
  );
}

interface PillarCardProps {
  readonly pillarId: string;
  readonly title: string;
  readonly score?: PillarScore;
  readonly history: readonly ScanSummary[];
  readonly stamp: Scan['stamp'];
}

function PillarCard({ pillarId, title, score, history, stamp }: PillarCardProps) {
  const value = score?.score;
  const measured = score != null && score.scored > 0 && value != null;
  const directional = measured && tooLittleMeasured(score.range);
  const series = pillarSeries(history, pillarId, stamp);

  return (
    <Link
      /*
       * The pillar's own page, not a focus panel on this one.
       *
       * It used to be `?pillar=`, which redrew a panel below the strip. That made the strip a
       * control for the page it sat on, and the panel it drew is now that pillar's page — where it
       * has room for the requirement list a reader clicking a score is actually after. A card that
       * changes something further down a page the reader cannot see all of is a dead end wearing a
       * link's clothes.
       */
      to={directional ? evidenceGapPath(pillarId) : `/investigate?pillar=${encodeURIComponent(pillarId)}`}
      className="wa-scorecard"
    >
      <span className="flex items-start gap-1.5">
        <span aria-hidden className="wa-icon-frame">
          <PillarIcon pillarId={pillarId} className="h-3.5 w-3.5" />
        </span>
        {/* The short label, because the official title needs four lines in a 142px card and would
            make the cards ragged. The full one is on the pillar's own page and in the matrix. */}
        <span className="wa-caption wa-scorecard-label pt-0.5 font-semibold text-wa-text" title={title}>
          {shortPillarLabel(pillarId, title)}
        </span>
      </span>

      {measured ? <Value score={value} range={score.range} /> : <NotAssessed />}

      {directional ? (
        <EvidenceGapAction />
      ) : measured ? (
        <Trend series={series} score={value} />
      ) : (
        <span className="wa-caption h-6 leading-6">
          {score == null ? 'No requirements' : `${String(score.unmeasurable)} unanswered`}
        </span>
      )}
    </Link>
  );
}

function EvidenceGapAction() {
  return (
    <span className="wa-caption h-6 overflow-hidden leading-6 whitespace-nowrap text-wa-action">
      Close evidence gaps →
    </span>
  );
}

/**
 * A score, its denominator and its verdict word — the only coloured thing on the card.
 *
 * Exported for the test that holds the history list's posture cell to what this renders. The two
 * band the same run and disagreed about it, so the thing worth asserting is that they agree, not
 * that each separately calls `scoreVerdict`.
 */
export function Value({ score, range }: { score: number; range?: PillarScore['range'] }) {
  const uncertain = isUncertain(range);
  const directional = tooLittleMeasured(range);
  const scoreColour = directional ? 'text-wa-text-muted' : scoreTone(score);
  const verdictColour = directional ? 'text-wa-warning' : scoreColour;

  return (
    <span className="wa-scorecard-value flex flex-col gap-0.5">
      <span className="flex items-baseline gap-1">
        <span className={`wa-metric-value ${scoreColour}`}>{score.toFixed(0)}</span>
        <span className="wa-metric-suffix">/100</span>
      </span>
      <span className={`wa-body-compact font-medium ${verdictColour}`}>
        {scoreVerdict(score, range)}
        {/*
          The range is the honest form of a thinly measured score, and it belongs beside the number
          rather than in a footnote: a reader who sees 41 and no range has been told the estate
          scored 41, which is not what was measured.
        */}
        {uncertain && range != null && (
          <span className="wa-caption wa-numeric ml-1 font-normal">
            {range.low.toFixed(0)}–{range.high.toFixed(0)}
          </span>
        )}
      </span>
    </span>
  );
}

/** No number at all. See the file header: a zero here is a lie the reader cannot detect. */
function NotAssessed() {
  return (
    <span className="wa-scorecard-value flex flex-col gap-0.5">
      <span className="wa-metric-value text-wa-unmeasured">—</span>
      <span className="wa-body-compact font-medium text-wa-text-muted">Not assessed</span>
    </span>
  );
}

/**
 * The trend, as a line where there is one and as a sentence where there is not.
 *
 * Three points is the floor for the line, and it is the floor for each *drawn* run of them rather
 * than for the series: two produce a straight segment whose slope is an artefact of two runs, and one
 * produces a dot the eye reads as a flat line — both of which claim stability, and a break in the
 * series does not make either honest. So the strip renders as soon as there are three measured runs,
 * because a break is a thing to show, and `Sparkline` connects nothing shorter than three.
 */
export function Trend({ series, score }: { series: Series; score: number }) {
  if (series.points.length >= 3) {
    return <Sparkline points={series.points} score={score} />;
  }

  const refused = series.points.flatMap((point) =>
    point.basis.read && !point.basis.verdict.ok ? [point.basis.verdict.reason ?? 'The comparison was refused.'] : []
  );
  if (refused.length > 0) {
    const reasons = refused.join(' ');
    return (
      <span
        className="wa-caption h-6 leading-6 text-wa-danger"
        title={reasons}
        aria-label={`${String(refused.length)} run comparison refused. ${reasons}`}
      >
        {refused.length === 1 ? '1 run refused' : `${String(refused.length)} runs refused`}
      </span>
    );
  }

  // Said apart from a refusal, and after it: a refusal is this app's verdict on a run it read, and an
  // unread basis is the absence of one. A reader shown "refused" for a run recorded before the basis
  // was kept would go looking for the change that caused it.
  const unread = series.points.flatMap((point) => (point.basis.read ? [] : [point.basis.why]));
  if (unread.length > 0) {
    const whys = unread.join(' ');
    return (
      <span
        className="wa-caption h-6 leading-6 text-wa-text-muted"
        title={whys}
        aria-label={`${String(unread.length)} run basis not read. ${whys}`}
      >
        {unread.length === 1 ? '1 run not compared' : `${String(unread.length)} runs not compared`}
      </span>
    );
  }

  const caveats = series.points.flatMap((point) =>
    point.basis.read && point.basis.verdict.caveat != null ? [point.basis.verdict.caveat] : []
  );
  if (caveats.length > 0) {
    return (
      <span
        className="wa-caption h-6 leading-6 text-wa-warning"
        title={caveats.join(' ')}
        aria-label={`Trend qualified. ${caveats.join(' ')}`}
      >
        Trend qualified
      </span>
    );
  }

  /*
   * One line, and short enough to hold it at 142px.
   *
   * "No change since the last run" is 160px at 12px, so in a card this narrow it wrapped to two
   * lines while its neighbours drew a 24px sparkline — and eight cards whose last row is sometimes
   * 24px and sometimes 32px are eight cards of different heights, which is the ragged strip the
   * two-line label reservation above exists to prevent. The full phrasing survives on the pillar
   * page and in the run record; here it is one line or it is not worth the row.
   */
  if (series.delta != null) {
    const rounded = Math.round(series.delta);
    if (rounded === 0) return <span className="wa-caption h-6 leading-6">No change</span>;
    return (
      <span className="wa-caption wa-numeric h-6 leading-6">
        {rounded > 0 ? '+' : ''}
        {rounded} vs last run
      </span>
    );
  }
  return <span className="wa-caption h-6 leading-6">First run</span>;
}

/** Half the width of the widest mark, which is how far the first and last points inset from the edges. */
const MARK = 2.5;

/**
 * A sparkline, hand-drawn.
 *
 * No chart dependency: every package that draws this brings a renderer, an animation layer, a
 * tooltip system and a palette that will not follow the theme tokens without a fight — hundreds of
 * kilobytes and a licence to clear for a Marketplace listing, to draw eleven line segments.
 */
function Sparkline({ points: series, score }: { points: readonly SeriesPoint[]; score: number }) {
  const width = 96;
  const height = 24;
  const values = series.filter(drawable).map((point) => point.value);
  const low = values.length > 0 ? Math.min(...values) : score;
  const high = values.length > 0 ? Math.max(...values) : score;
  // A flat series would divide by zero; drawing it down the middle is the honest rendering of it.
  const span = high - low || 1;
  const plotted = series.map((point, index) => ({
    ...point,
    // Inset by the mark's own radius at both ends, because a mark centred on 0 or on the full width is
    // half outside the viewBox and reads as clipped rather than as a point.
    x: MARK + (index * (width - 2 * MARK)) / Math.max(series.length - 1, 1),
    // A run that was not compared has no honest y-position: plotting its score would itself be the
    // comparison. The centred mark says where the run was and the broken line says its value is not
    // on this axis.
    y: drawable(point) ? height - 2 - ((point.value - low) / span) * (height - 4) : height / 2,
  }));
  const segments: (typeof plotted)[] = [];
  for (const [index, point] of plotted.entries()) {
    if (!drawable(point)) continue;
    const previous = plotted[index - 1];
    if (previous == null || !drawable(previous)) segments.push([point]);
    else segments.at(-1)?.push(point);
  }
  const words = sparklineWords(series, score);

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className="h-6 w-full"
      role="img"
      data-chart
      aria-label={words}
      preserveAspectRatio="none"
    >
      <title>{words}</title>
      {/* Three, not two: the floor in this component's own docstring, applied to what is drawn. */}
      {segments
        .filter((segment) => segment.length >= 3)
        .map((segment) => (
          <polyline
            key={segment[0]?.x}
            points={segment.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}
            fill="none"
            strokeWidth={1.5}
            className={scoreStroke(score)}
          />
        ))}
      {plotted.map((point) => {
        if (!point.basis.read) {
          return (
            <g key={point.x} data-comparability="not-read" className="stroke-wa-text-muted">
              <title>{point.basis.why}</title>
              <line x1={point.x} y1={point.y - MARK} x2={point.x} y2={point.y + MARK} strokeWidth={1.5} />
            </g>
          );
        }

        if (!point.basis.verdict.ok) {
          const reason = point.basis.verdict.reason ?? 'The comparison was refused.';
          return (
            <g key={point.x} data-comparability="refused" className="stroke-wa-danger">
              <title>{reason}</title>
              <line x1={point.x - MARK} y1={point.y - MARK} x2={point.x + MARK} y2={point.y + MARK} strokeWidth={1.5} />
              <line x1={point.x + MARK} y1={point.y - MARK} x2={point.x - MARK} y2={point.y + MARK} strokeWidth={1.5} />
            </g>
          );
        }

        const { caveat } = point.basis.verdict;
        return (
          <circle
            key={point.x}
            data-comparability={caveat == null ? 'permitted' : 'caveat'}
            cx={point.x}
            cy={point.y}
            r={caveat == null ? 1.25 : 2.25}
            strokeWidth={caveat == null ? 1 : 1.5}
            className={`fill-wa-surface ${caveat == null ? scoreStroke(score) : 'stroke-wa-warning'}`}
          >
            {caveat != null && <title>{caveat}</title>}
          </circle>
        );
      })}
    </svg>
  );
}

/**
 * The line as a sentence, which is the whole of it for a reader who cannot see the line.
 *
 * The direction is the part the previous label was missing. It said how many runs and where the score
 * stands now, which is what the number beside the chart already says — so the one fact only the chart
 * carried, whether this is going up or down, was the one fact not stated. Direction is first for that
 * reason, and it is measured from the first run in the window to the last rather than from the last
 * step, because a series that fell twelve points and recovered one is not improving.
 *
 * Then the series itself, in order. A sparkline of eleven points has eleven values and no axis, so a
 * table of them would be eleven rows of a number and nothing to key it on; the equivalent that
 * actually helps is the run of values read out, which is what a sighted reader takes from the shape.
 *
 * A direction needs two comparable points to be a direction. With fewer, the movement is not stated
 * at all: falling back to the current score made `first` and `last` the same number, so a strip where
 * nothing could be compared read out as "level" — the flat line this component refuses to draw,
 * spoken aloud to the one reader who cannot see that it was not drawn.
 */
function sparklineWords(points: readonly SeriesPoint[], score: number): string {
  const values = points.filter(drawable).map((point) => point.value);
  const first = values[0];
  const last = values[values.length - 1];
  const movement =
    values.length >= 2 && first != null && last != null
      ? `: ${describeMove(Math.round(last - first))}, now ${score.toFixed(0)} out of 100. ` +
        `Comparable values, oldest to newest: ${values.map((value) => value.toFixed(0)).join(', ')}.`
      : `, so no movement can be read from them. Now ${score.toFixed(0)} out of 100.`;

  const annotations = points.flatMap((point, index) => {
    const at = `Point ${String(index + 1)}`;
    if (!point.basis.read) return [`${at} was not compared: ${point.basis.why}`];
    if (!point.basis.verdict.ok) {
      return [`${at} was refused: ${point.basis.verdict.reason ?? 'The comparison was refused.'}`];
    }
    return point.basis.verdict.caveat == null
      ? []
      : [`${at} was permitted with a caveat: ${point.basis.verdict.caveat}`];
  });

  return `Trend across ${String(points.length)} measured runs; ${comparableCount(values.length)}${movement} ${annotations.join(' ')}`.trim();
}

function comparableCount(comparable: number): string {
  if (comparable === 0) return 'none can be compared with this one';
  if (comparable === 1) return 'one can be compared with this one';
  return `${String(comparable)} are comparable`;
}

function describeMove(move: number): string {
  if (move === 0) return 'level';
  return move > 0 ? `up ${String(move)} points` : `down ${String(Math.abs(move))} points`;
}
