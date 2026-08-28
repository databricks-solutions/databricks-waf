// What is being done about the findings, as plans rather than as a list of intentions.
//
// The decisions register answers "what have we agreed to live with". This answers the other half:
// what somebody is actually doing, who, by when, and whether the estate agrees yet. They are separate
// surfaces because they are separate claims — parking a finding is a decision about a risk, and
// raising an action is a commitment to change something — and a single page carrying both would let
// one be read as the other.
//
// Every plan's row leads with what calls for attention rather than with a completion figure. "9 of 14
// done" is the number an executive asks for and it is the number that hides the four rows a run has
// contradicted, which is the whole defect this feature exists to avoid reproducing.

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAssessment } from '../api/assessment-context';
import { useImprovements, useOpenPlan } from '../api/hooks';
import { CustomerPage, RecordLink, RecordList, StateNotice, Surface } from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import { Badge } from '../components/ui/StatusBadge';
import { ValueReportView } from '../components/ValueReport';
import type { ImprovementPlan } from '../api/types';
import { adviceHref, adviceIn, advicePhrase } from './advice-link';
import { foundationHref, foundationIn, foundationPhrase } from './foundation-link';
import { STATE_ICON, STATE_LABEL, STATE_TONE, standingPhrase } from './improve-language';
import { requirementHref, requirementIn } from './requirement-link';

const EMPTY: readonly ImprovementPlan[] = [];

export function ImprovementsPage() {
  const { controlOf } = useAssessment();
  const improvements = useImprovements();
  const [opening, setOpening] = useState(false);
  const [params] = useSearchParams();
  /*
   * The advisor finding a reader arrived with, where they arrived from one.
   *
   * This page is the step between the finding and the form, and it exists because an action needs a
   * plan and an advisor page has no idea which. So the reference travels through the plan link and
   * the plan's own page raises it: one place that knows how to write an action, rather than a second
   * copy of the form on four advisor pages.
   */
  const advice = adviceIn(params);
  const foundation = foundationIn(params);
  const askedRequirement = requirementIn(params);
  const requirement =
    askedRequirement != null && controlOf(askedRequirement.controlId) != null ? askedRequirement : undefined;

  const plans = useMemo(() => {
    // Open plans first, then the ones with the most to answer for. A closed plan is a record, and a
    // record above live work is a record that pushes the live work off the first screen.
    return [...(improvements.data?.plans ?? EMPTY)].sort(
      (a, b) =>
        Number(a.closed != null) - Number(b.closed != null) ||
        b.progress.contradicted.length - a.progress.contradicted.length ||
        b.progress.overdue.length - a.progress.overdue.length ||
        b.createdAt.localeCompare(a.createdAt)
    );
  }, [improvements.data?.plans]);

  if (improvements.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Improvement plans unavailable">
          <EmptyState
            layout="compact"
            reason="collector-failed"
            heading="The plans could not be read"
            detail={improvements.error}
            action={
              <button type="button" className="wa-button-secondary" onClick={improvements.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <CustomerPage>
      {improvements.data != null && !improvements.data.durable && (
        <StateNotice
          tone="warning"
          announce="alert"
          title="These plans are not durable"
          detail={
            <p>
              These plans are held in memory and will be lost when the app restarts.{' '}
              {improvements.data.durabilityNote ?? 'Unset WAF_DEMO_NO_PERSISTENCE and restart to keep them.'}{' '}
              <Link className="text-wa-action hover:underline" to="/diagnostics">
                What this app can reach →
              </Link>
            </p>
          }
        />
      )}

      {advice != null && (
        <StateNotice
          tone="info"
          title="Choose the improvement plan for this advice"
          detail={
            <p>
              Choose the plan to raise this in. It will be an action against {advicePhrase(advice)}, and what that
              finding says is read from the advisory rather than from this page. A closed plan cannot take new work.
            </p>
          }
        />
      )}

      {foundation != null && (
        <StateNotice
          tone="info"
          title="Choose the improvement plan for this foundation gap"
          detail={
            <p>
              Choose the plan for {foundationPhrase(foundation)}. The action form starts with the framework requirements
              that can check the same change; the foundation reading remains separate and does not become a score or
              write policy for you. A closed plan cannot take new work.
            </p>
          }
        />
      )}

      {requirement != null && (
        <StateNotice
          tone="info"
          title={`Choose the improvement plan for ${requirement.controlId}`}
          detail={
            <p>
              Choose the plan that will close {requirement.controlId} — {controlOf(requirement.controlId)?.title}. The
              action form starts with this requirement selected so its owner, target state and verification stay tied to
              the assessment. A closed plan cannot take new work.
            </p>
          }
        />
      )}

      {/* Above the plans rather than on a page of its own, and above rather than below them: what the
          work is worth is the question a plan is opened to answer, and a figure under a list of
          fourteen plans is a figure nobody scrolled to. Absent entirely where this install has run no
          advisory — three of the four figures are the advisors' and a posture beside three zeroes
          would read as an estate with nothing to gain. */}
      {improvements.data?.value != null && <ValueReportView value={improvements.data.value} />}

      {/* Takes the canvas, like every other list page. Without this the plane was as tall as its
          contents, so an installation with no plans drew a 190px panel at the top of a 945px window and
          left two thirds of the page as empty ground — which reads as a page that failed to finish
          loading rather than one with nothing on it yet. */}
      <Surface
        tone="section"
        title="What is being done about the findings"
        description={`${String(plans.length)} ${plans.length === 1 ? 'plan' : 'plans'}`}
        action={
          <button type="button" className="wa-button-primary" onClick={() => setOpening((was) => !was)}>
            {opening ? 'Cancel' : 'Open a plan'}
          </button>
        }
      >
        {opening && (
          <PlanForm
            minProse={improvements.data?.minProse ?? 20}
            onSaved={() => {
              setOpening(false);
              improvements.reload();
            }}
          />
        )}

        {improvements.loading && plans.length === 0 ? (
          <EmptyState
            layout="compact"
            reason="not-yet-collected"
            heading="Reading the plans"
            detail="Fetching every plan and its actions."
          />
        ) : plans.length === 0 ? (
          <EmptyState
            layout="compact"
            reason="not-yet-collected"
            heading="No plans yet"
            detail={
              'A plan is a named outcome with the actions that get there. Start from an evidence-backed opportunity, ' +
              'then create a plan so the resource, source reading and later validation stay attached.'
            }
            action={
              <Link to="/workloads" className="wa-button-secondary">
                Review opportunities
              </Link>
            }
          />
        ) : (
          <RecordList label="Improvement plans">
            {plans.map((plan) => (
              <RecordLink
                key={plan.id}
                // The reference travels on the link rather than in a store, so a reader who opens
                // the plan in a new tab arrives with the same finding attached.
                to={
                  advice != null
                    ? adviceHref(`/improvements/${plan.id}`, advice)
                    : foundation != null
                      ? foundationHref(`/improvements/${plan.id}`, foundation.id)
                      : requirement != null
                        ? requirementHref(`/improvements/${plan.id}`, requirement.controlId)
                        : `/improvements/${plan.id}`
                }
                eyebrow={
                  <span className="flex flex-wrap items-center gap-1.5">
                    {plan.closed != null && (
                      <Badge tone={STATE_TONE.cancelled} Icon={STATE_ICON.cancelled}>
                        Closed
                      </Badge>
                    )}
                    {plan.progress.contradicted.length > 0 && (
                      <Badge tone="danger" Icon={STATE_ICON.blocked}>
                        {plan.progress.contradicted.length} still failing
                      </Badge>
                    )}
                    {plan.progress.overdue.length > 0 && (
                      <Badge tone="warning" Icon={STATE_ICON.planned}>
                        {plan.progress.overdue.length} overdue
                      </Badge>
                    )}
                  </span>
                }
                title={plan.title}
                summary={standingPhrase(plan.progress)}
                meta={
                  <>
                    {plan.owners.join(', ')} ·{' '}
                    {Object.entries(plan.progress.states)
                      .filter(([, count]) => count > 0)
                      .map(
                        ([state, count]) =>
                          `${String(count)} ${STATE_LABEL[state as keyof typeof STATE_LABEL].toLowerCase()}`
                      )
                      .join(', ')}
                  </>
                }
              />
            ))}
          </RecordList>
        )}
      </Surface>
    </CustomerPage>
  );
}

/**
 * Opening a plan.
 *
 * Deliberately four fields. A plan is thin on purpose — it is a title, an outcome and the people
 * answerable — because everything a reader acts on lives on the actions, and a plan that collected a
 * status of its own would be a second place for the truth to live and drift.
 */
function PlanForm({ minProse, onSaved }: { readonly minProse: number; readonly onSaved: () => void }) {
  const { scan } = useAssessment();
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [owners, setOwners] = useState('');
  const open = useOpenPlan(onSaved);

  const shortOutcome = Math.max(0, minProse - outcome.trim().length);
  const named = owners
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const ready = title.trim() !== '' && shortOutcome === 0 && named.length > 0;

  return (
    <form
      className="flex flex-col gap-4 border-b border-wa-divider p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || open.saving) return;
        void open.send({
          title: title.trim(),
          outcome: outcome.trim(),
          owners: named,
          // The run the plan starts from, by reference rather than as a copy, so the baseline stays
          // checkable against what was actually measured that day.
          ...(scan?.id != null ? { raisedFrom: scan.id } : {}),
        });
      }}
    >
      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor="plan-title">
          What to call it
        </label>
        <input
          className="wa-field wa-body-compact"
          id="plan-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Secrets out of cluster configuration"
          required
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor="plan-outcome">
          What will be different
        </label>
        <textarea
          className="wa-textarea wa-body-compact"
          id="plan-outcome"
          rows={2}
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          placeholder="No production workload reads a credential from anywhere but the vault."
          aria-describedby="plan-outcome-help"
          required
        />
        <p className="wa-caption" id="plan-outcome-help">
          {shortOutcome > 0 ? `At least ${String(shortOutcome)} more characters.` : 'Long enough.'}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="wa-label" htmlFor="plan-owners">
          Who is answerable
        </label>
        <input
          className="wa-field wa-body-compact"
          id="plan-owners"
          value={owners}
          onChange={(event) => setOwners(event.target.value)}
          placeholder="platform-engineering, security"
          aria-describedby="plan-owners-help"
          required
        />
        <p className="wa-caption" id="plan-owners-help">
          Comma separated. These are the people the plan is reviewed with, not the owner of each action.
        </p>
      </div>

      {open.error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {open.error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="wa-caption">Does not change the score.</p>
        <button type="submit" className="wa-button-primary" disabled={!ready || open.saving}>
          {open.saving ? 'Opening…' : 'Open the plan'}
        </button>
      </div>
    </form>
  );
}
