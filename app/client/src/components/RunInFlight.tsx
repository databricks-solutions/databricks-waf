// A run is happening: who started it, how long it has been going, and what it has done so far.
//
// This exists because of an observation made against the deployed app: a run was started, and the
// app said nothing. Not "nothing useful" — nothing at all. The only thing that knew a run was in
// flight was the React state of the click that started it, so a reader who had not clicked saw an
// idle app presenting the previous assessment as the current one. That covers the scheduled run,
// a second admin's run, a second tab, and — the case that makes it a defect rather than a gap —
// the same reader's own run after a page reload.
//
// There is no percentage here, and that is deliberate. How many calls a run makes is not known
// when it starts: a permission refusal skips work, the budget can stop it early, and a targeted
// rerun measures a subset. Any denominator would be invented, and an invented one is worse than
// none — a bar that sticks at 90% teaches the reader that the app's numbers are decorative, on the
// one screen whose entire claim is that its numbers are measured. So what is shown is what is
// known: a clock that rises, a count of calls that rises, and the duration of the last run as the
// only honest answer to "how long will this take". See ADR 0055.

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import { duration, elapsed } from '../pages/run-language';
import type { Scan, ScanStatus } from '../api/types';

/**
 * How often the elapsed clock re-renders.
 *
 * A second, because the point of the clock is to be visibly alive. It re-renders one small band
 * and nothing else: the state is held here rather than in the provider so a ticking second does
 * not re-render every page in the app.
 */
const TICK_MS = 1000;

export function RunInFlight() {
  const { scanning, runInFlight, scan } = useAssessment();
  if (!scanning) return null;

  // A separate component, so the clock inside it is mounted when the band appears and unmounted
  // when the run ends. Holding the clock out here instead means its first reading is whenever this
  // page was loaded, which for a reader who has had the app open all morning is a band that opens
  // saying the run has been going for three hours and corrects itself a second later.
  return (
    <RunningBand {...(runInFlight != null && { run: runInFlight })} {...(scan != null && { previous: scan })} />
  );
}

function RunningBand({ run, previous }: Omit<RunInFlightViewProps, 'now'>) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return <RunInFlightView now={now} {...(run != null && { run })} {...(previous != null && { previous })} />;
}

export interface RunInFlightViewProps {
  /**
   * What the server says about the run, once it has been asked.
   *
   * Absent for the moment between this reader's click and the first poll answering it, which is why
   * the band still renders without it: a reader who has just pressed the button is owed the
   * acknowledgement immediately, and the detail can arrive three seconds later.
   */
  readonly run?: ScanStatus;
  /** The run before this one, whose duration is the only honest estimate available. */
  readonly previous?: Scan;
  readonly now: number;
}

export function RunInFlightView({ run, previous, now }: RunInFlightViewProps) {
  return (
    <>
      {/*
        Announced once, and without the clock in it.
        
        A live region containing a ticking elapsed time would announce a number every second, which
        is not information — it is a reason to close the tab. The stable sentence goes here; the
        clock is in the band below, where a screen reader reaches it on demand.
      */}
      <div aria-live="polite" className="sr-only">
        A run is measuring your estate.
      </div>

      <div className="wa-callout mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-wa-text">
          {/* The one permitted spin, as in CollectingBadge. Reduced-motion readers get a static icon,
              which is why the clock beside it carries the same information in text. */}
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          <span className="wa-body-compact font-medium">{started(run)}</span>
        </span>

        {/* Separated the way the provenance line directly above this one separates its clauses. Three
            captions divided by nothing but whitespace read as one sentence that does not parse. */}
        <span className="wa-caption">{detail(run, previous, now).join(' · ')}</span>
      </div>
    </>
  );
}

/**
 * Who or what started the run.
 *
 * The distinction a reader needs first is not the actor's name, it is whether this is something
 * that is happening to them or something they did: an unexpected run against their warehouse in
 * the middle of the working day is a different fact from the nightly one, and the two were
 * previously indistinguishable because neither was shown at all.
 */
function started(run?: ScanStatus): string {
  if (run == null) return 'Starting a run';
  if (run.trigger === 'scheduled') return 'A scheduled run is measuring your estate';
  if (run.actor != null) return `${run.actor} is measuring your estate`;
  return 'A run is measuring your estate';
}

/**
 * The clauses under the headline: how long, how much, and how long it took last time.
 *
 * Composed as a list rather than as sibling elements so the separators are the list's business and
 * an absent clause cannot leave a stranded one behind it.
 */
function detail(run: ScanStatus | undefined, previous: Scan | undefined, now: number): readonly string[] {
  return [
    run?.startedAt != null ? `Running for ${elapsed(run.startedAt, now)}` : undefined,
    work(run),
    previous != null ? `The previous run took ${duration(previous)}` : undefined,
  ].filter((clause): clause is string => clause != null);
}

/**
 * What the run has done so far.
 *
 * Zero is its own sentence rather than "0 calls", because zero means the run is still resolving
 * credentials and planning, and a count of zero next to a spinner reads as a run that is stuck.
 */
function work(run?: ScanStatus): string {
  const calls = run?.callsMade;
  if (calls == null || calls === 0) return 'Planning the queries it will run';
  if (calls === 1) return '1 query so far';
  return `${calls.toLocaleString()} queries and API calls so far`;
}
