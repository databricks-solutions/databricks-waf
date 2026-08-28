// What this install can reach, and what to do about the parts it cannot.
//
// Every other page in this app describes the estate. This one describes the app's own footing, and it
// exists because a half-bound install reports its symptoms one page at a time and never names the
// cause: a pillar mostly unmeasured on the overview, a history that will not load under Runs, an
// answer that warns it will be lost on the next deploy. Each of those is true, none of them says which
// single binding is behind all three, and the person who has to fix it reads four complaints and
// guesses.
//
// So: four readings, one per thing that can be bound wrongly, each with what it means and what to do.
// The words are the server's, because they are about the app's internals and a second copy here would
// drift from the first. What the page adds is the verdict over the four, the count of what could not be
// recorded, and the ordering — see components/HealthReadings.tsx.
//
// It is not polled. Three of the four readings are probes, and a page that re-asked every five seconds
// would take an identity probe with it each time; this is read once, by a person, while something is
// wrong. There is a button for the second reading.

import { RotateCw } from 'lucide-react';
import { Link } from 'react-router';
import { useDiagnostics } from '../api/hooks';
import { HealthReadings } from '../components/HealthReadings';
import { DeploymentGuideLink } from '../components/DeploymentGuideLink';
import { EmptyState } from '../components/ui/EmptyState';
import { CustomerPage, PageLead, Surface } from '../components/system';
import { Badge } from '../components/ui/StatusBadge';
import { healthSentence, standingPresentation, unrecordedSentence } from './diagnostics-language';

export function DiagnosticsPage() {
  const diagnostics = useDiagnostics();

  if (diagnostics.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Diagnostics">
          <EmptyState
            reason="collector-failed"
            heading="Could not read what this app can reach"
            // The one failure here with no reading to describe it, because it is the page itself that
            // did not answer. Named as such rather than reported as four unknowns: a page of "not
            // established" would look like a diagnosis and be the absence of one.
            detail={`This page asks the app about its own footing, so this failing means the app could not answer for itself: ${diagnostics.error}`}
            action={
              <button type="button" className="wa-button-secondary" onClick={diagnostics.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (diagnostics.data == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Diagnostics">
          <EmptyState reason="not-yet-collected" heading="Reading" detail="Asking each dependency what it can do." />
        </Surface>
      </CustomerPage>
    );
  }

  const health = diagnostics.data;
  const missed = unrecordedSentence(health.unrecorded);

  return (
    <CustomerPage>
      <PageLead
        headingLevel={2}
        title="What this install can reach"
        summary="What this install can reach, and what to do about the parts it cannot."
        actions={
          <>
            <DeploymentGuideLink />
            <button
              type="button"
              className="wa-button-secondary"
              onClick={diagnostics.reload}
              disabled={diagnostics.loading}
            >
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              {diagnostics.loading ? 'Reading' : 'Read again'}
            </button>
          </>
        }
      />
      {/* Scrolls inside itself rather than letting the canvas grow, which is the shell's rule and what
          `check:viewport` measured this page 96px short of. Four readings with a meaning and a next
          step each is more than an 800px window holds, and the header naming the overall standing is
          the last thing that should go off the top. */}
      <Surface
        tone="raised"
        label="What this install can reach"
        title="Dependencies"
        action={
          <Badge
            tone={health.well ? 'success' : 'warning'}
            Icon={standingPresentation(health.well ? 'answering' : 'degraded').Icon}
          >
            {health.well ? 'Nothing failing' : 'Needs attention'}
          </Badge>
        }
      >
        <div className="space-y-2">
          <p className="wa-body-compact text-wa-text-secondary">{healthSentence(health)}</p>
          {/* Volunteered rather than left under the trail's own reading, because it is the only number
              here that describes something already lost. A reading says what is true now. */}
          {missed != null && (
            <p className="wa-body-compact text-wa-warning" role="status">
              {missed}{' '}
              <Link className="text-wa-action hover:underline" to="/history">
                What did run is still recorded under Runs →
              </Link>
            </p>
          )}
        </div>

        <HealthReadings readings={health.readings} at={health.at} />
      </Surface>
    </CustomerPage>
  );
}
