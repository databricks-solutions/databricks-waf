// Deciding, in the pane where the finding is.
//
// The decision belongs beside the evidence rather than on a page of its own, because the moment a
// reader is qualified to decide something is the moment they have just read what was observed and
// what was expected. A separate page would ask them to remember a control id and go looking for it.
//
// It holds the mutation and nothing else about the finding: what to say about a standing lives in
// DecisionNote, what to ask lives in DecisionForm, and this puts the two either side of a request.
// Which is why it can also be dropped into a pillar's pane later without dragging the findings page
// along with it.

import { useState } from 'react';
import { useRecordDecision } from '../api/hooks';
import type { Decision, Finding, Severity } from '../api/types';
import { DecisionForm } from './DecisionForm';
import { StateNotice, Surface } from './system';

export interface DecidePanelProps {
  readonly finding: Finding;
  readonly decision?: Decision;
  readonly parkDays?: Readonly<Record<Severity, number>>;
  /** True when nothing durable is bound, so the panel can say so before somebody records intent. */
  readonly ephemeral?: boolean;
  readonly durabilityNote?: string;
  /** Refetches the decisions the page is holding, since a new one changes standings elsewhere. */
  readonly onRecorded: () => void;
}

export function DecidePanel({
  finding,
  decision,
  parkDays,
  ephemeral = false,
  durabilityNote,
  onRecorded,
}: DecidePanelProps) {
  /*
   * Collapsed by default where a decision already stands, open where none does.
   *
   * The two readers are different. One is looking at a finding for the first time and the form is
   * the point; the other came to read what was already decided, and putting a blank form above that
   * record invites them to overwrite it before they have read it.
   */
  const [open, setOpen] = useState(decision == null);
  const record = useRecordDecision(() => {
    onRecorded();
    setOpen(false);
  });

  return (
    <Surface
      tone="raised"
      title={decision == null ? 'What are you doing about it' : 'Decision'}
      headingLevel={3}
      action={
        // `undefined` rather than `false` where there is nothing to put here: `false != null`, so the
        // header rendered its aside element around nothing and set up a gap and a wrap for content
        // that never arrived.
        decision != null ? (
          <button type="button" className="wa-caption wa-aside-link hover:underline" onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'Decide again'}
          </button>
        ) : undefined
      }
    >
      {/* Said before the form, not after the button. A reader who records an acceptance into a
          process that cannot keep it has documented nothing, and finding that out from a toast
          afterwards is worse than not having been offered the form. */}
      {ephemeral && (
        <StateNotice
          tone="warning"
          title="This decision will not survive a restart"
          detail={
            durabilityNote ??
            'Nothing is bound to keep decisions, so anything recorded here is lost when the app restarts.'
          }
        />
      )}

      {open && (
        <DecisionForm
          controlId={finding.controlId}
          severity={finding.severity}
          parkDays={parkDays}
          hasDecision={decision != null}
          onSubmit={record.submit}
          saving={record.saving}
          error={record.error}
          saved={record.saved === finding.controlId}
        />
      )}
    </Surface>
  );
}
