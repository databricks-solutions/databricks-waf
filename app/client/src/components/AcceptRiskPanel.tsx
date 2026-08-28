// Accepting a risk, and revoking one, in the pane where the finding is.
//
// Beside the evidence for the reason DecidePanel is: the moment a reader is qualified to accept an
// exposure is the moment they have just read what was observed and what was expected. A register page
// would ask them to remember a control id and go looking for it.
//
// This holds the two mutations and the chain of acceptances for one requirement. What each acceptance
// says lives in AcceptedRiskNote, what to ask lives in AcceptRiskForm, and this puts the two either
// side of a request — which is also why it can be dropped into a pillar's pane later without dragging
// the findings page along with it.
//
// The chain is fetched here rather than passed in, unlike the decision beside it. A decision is one
// row per requirement so the page can hold them all; acceptances accumulate, and the page would be
// fetching every acceptance ever recorded to show the two on this requirement.

import { useEffect, useRef, useState } from 'react';
import { useAcceptRisk, useRevokeRisk, useRisksFor } from '../api/hooks';
import type { AcceptedRisk, Finding } from '../api/types';
import { MIN_PROSE } from '../pages/accept-language';
import { AcceptedRiskNote } from './AcceptedRiskNote';
import { AcceptRiskForm } from './AcceptRiskForm';
import { StateNotice, Surface } from './system';

export interface AcceptRiskPanelProps {
  readonly finding: Finding;
  /** Refetches what the page is holding, since an acceptance changes which findings are on the queue. */
  readonly onChanged?: () => void;
}

/**
 * The standings that make the server refuse another acceptance of the same requirement.
 *
 * One at a time is the server's rule and `riskFrom` enforces it: two acceptances of one requirement
 * would expire on different days and neither would be the one in force. Named here so this panel
 * offers only what will be accepted — it previously offered "Accept again" and a button reading
 * "Replace acceptance", and the reader who filled that form in got a refusal telling them to revoke
 * first. An affordance for something the server declines by design is worse than none.
 *
 * `pending` is in the list, and it is the one worth stating: an acceptance dated to start next week
 * blocks another and does not park the finding yet, so a panel keyed on `effective` alone showed a
 * requirement that could be neither accepted nor released.
 */
const BLOCKING: readonly AcceptedRisk['standing'][] = ['pending', 'active', 'expiring'];

export function AcceptRiskPanel({ finding, onChanged }: AcceptRiskPanelProps) {
  const risks = useRisksFor(finding.controlId);
  const recorded = risks.data?.risks ?? [];
  // Newest first from the server, so the effective one is the first that says it is.
  const inForce = recorded.find((risk) => risk.effective);
  const blocking = recorded.find((risk) => BLOCKING.includes(risk.standing));

  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  /*
   * Whether the record that arrives next should be scrolled to, and holding on until it is.
   *
   * Recording an acceptance replaces a tall form with a short record, and this panel is at the bottom of
   * a pane that is a 815px window over 3000px of evidence, so what had just been written landed some
   * 2200px below the fold: the reader pressed the button and the pane appeared to lose their work.
   *
   * One scroll when the record mounts is not enough, which is what the first attempt at this did.
   * Recording also refetches the page's findings — an acceptance takes one off the queue — and that
   * answer lands after the record has mounted, re-rendering the pane and putting it back at the top. So
   * the scroll re-asserts itself after each commit until the record is actually on screen.
   *
   * After each commit rather than on each animation frame, which the second attempt used: a frame
   * callback is at the mercy of whoever is scheduling frames, and the two moments that matter here are
   * both React commits — the one that mounts the record and the one the findings answer causes. Checking
   * whether it is on screen rather than scrolling a fixed number of times is what stops this fighting a
   * reader who has started scrolling somewhere else; the attempt cap stops it entirely if they do.
   *
   * It is armed on an acceptance and not on a revocation, because ending one early is pressed at the
   * record, which is on screen already.
   */
  const follow = useRef(0);
  const newest = useRef<HTMLDivElement | null>(null);
  const reveal = (node: HTMLDivElement | null) => {
    newest.current = node;
  };

  // No dependency list: this has to run after every commit, since the commit that undoes the scroll is
  // caused by a fetch this component did not make and cannot list as a dependency.
  useEffect(() => {
    if (follow.current <= 0) return;
    const node = newest.current;
    if (node == null) return;
    const box = node.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight) {
      follow.current = 0;
      return;
    }
    follow.current -= 1;
    node.scrollIntoView({ block: 'nearest' });
  });

  const changed = () => {
    setOpen(false);
    setRevoking(false);
    risks.reload();
    onChanged?.();
  };

  const accept = useAcceptRisk(() => {
    // Enough commits to outlast the findings answer that re-renders the pane, and few enough that a
    // reader who scrolls somewhere else themselves is left alone.
    follow.current = 8;
    changed();
  });
  // Whatever is blocking, not only what is effective: a pending acceptance has to be endable too.
  const revoke = useRevokeRisk(blocking?.id, changed);

  return (
    <Surface
      tone="raised"
      title={blocking != null ? 'What is holding the line' : 'Accepting the risk'}
      headingLevel={3}
      action={
        // Nothing to offer while one is in force: the only move from here is to end that one, and
        // the button for it is beneath the record it would end rather than up here away from it.
        blocking != null ? undefined : (
          <button
            type="button"
            className="wa-caption wa-aside-link hover:underline"
            onClick={() => {
              setOpen(!open);
              setRevoking(false);
            }}
          >
            {open ? 'Cancel' : 'Accept the risk'}
          </button>
        )
      }
    >
      {/* Before the form, not after the button. Somebody who records an exception into a process that
          cannot keep it has documented nothing, and its expiry — the part that puts the work back — is
          the first thing a restart loses. */}
      {risks.data != null && !risks.data.durable && (
        <StateNotice
          tone="warning"
          title="This acceptance will not survive a restart"
          detail={
            risks.data.durabilityNote ??
            'Nothing is bound to keep accepted risks, so anything recorded here is lost when the app restarts.'
          }
        />
      )}

      {blocking == null && !open && (
        <p className="wa-caption">
          Nothing is accepted against this requirement. Accepting it takes the finding off the queue until an expiry
          date, and asks what is holding the line in the meantime. It does not change the score.
        </p>
      )}

      {/* Said where the button used to be, because "one at a time" is only obvious to somebody who has
          already been refused. A reader who wants different terms needs to know the shape of the move —
          end this one, record another — and not to discover it from a filled-in form coming back. */}
      {blocking != null && (
        <p className="wa-caption">
          {blocking.standing === 'pending'
            ? 'An acceptance is recorded and has not started yet. One requirement carries one acceptance at a time, so ' +
              'changing its terms means ending this one and recording another.'
            : 'One requirement carries one acceptance at a time. To change the terms — a different expiry, a different ' +
              'owner, a control that has since changed — end this one and record another.'}
        </p>
      )}

      {open && (
        <AcceptRiskForm
          key={`accept-${finding.controlId}`}
          controlId={finding.controlId}
          severity={finding.severity}
          {...(risks.data?.acceptanceDays != null ? { acceptanceDays: risks.data.acceptanceDays } : {})}
          onSubmit={(draft) => void accept.send(draft)}
          saving={accept.saving}
          {...(accept.error != null ? { error: accept.error } : {})}
          saved={false}
        />
      )}

      {/*
       * Every acceptance ever recorded against this requirement, not only the one in force.
       *
       * Which is the point of the record: a requirement accepted for the fourth quarter running is a
       * different fact from one accepted last week, and a pane that showed only what is effective
       * today would present the two identically.
       */}
      <div className="space-y-3">
        {recorded.map((risk, index) => (
          // Only the newest takes the ref, since it is the one an acceptance just wrote.
          <div key={risk.id} ref={index === 0 ? reveal : undefined}>
            <AcceptedRiskNote risk={risk} />
          </div>
        ))}
      </div>

      {blocking != null && (
        <div>
          {revoking ? (
            <RevokeForm
              saving={revoke.saving}
              {...(revoke.error != null ? { error: revoke.error } : {})}
              onCancel={() => setRevoking(false)}
              onSubmit={(reason) => void revoke.send({ reason })}
            />
          ) : (
            // "Early" is right for one that has started and wrong for one that has not, and the
            // difference matters to the reader pressing it: nothing is being cut short in the second case.
            <button type="button" className="wa-button-secondary" onClick={() => setRevoking(true)}>
              {inForce != null ? 'End this acceptance early' : 'Withdraw this acceptance'}
            </button>
          )}
        </div>
      )}
    </Surface>
  );
}

interface RevokeFormProps {
  readonly saving: boolean;
  readonly error?: string;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => void;
}

/**
 * Ending one early, which needs a reason.
 *
 * Required, and for a different purpose from the reason on the acceptance itself: this one puts a
 * requirement back on somebody's queue ahead of the date they were told to expect, and whoever finds
 * it there is owed an explanation of why the ground shifted.
 */
function RevokeForm({ saving, error, onCancel, onSubmit }: RevokeFormProps) {
  const [reason, setReason] = useState('');
  const short = reason.trim().length < MIN_PROSE;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (short || saving) return;
        onSubmit(reason.trim());
      }}
    >
      <label className="wa-label" htmlFor="revoke-reason">
        Why this is ending early
      </label>
      <textarea
        className="wa-textarea wa-body-compact"
        id="revoke-reason"
        rows={2}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="What changed. The requirement goes back on the queue now."
        aria-describedby="revoke-reason-help"
        required
      />
      <p className="wa-caption" id="revoke-reason-help">
        {short ? `At least ${String(MIN_PROSE - reason.trim().length)} more characters.` : 'Long enough.'}
      </p>

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" className="wa-button-primary" disabled={short || saving}>
          {saving ? 'Ending…' : 'End it now'}
        </button>
        <button type="button" className="wa-button-secondary" onClick={onCancel}>
          Keep it
        </button>
      </div>
    </form>
  );
}
