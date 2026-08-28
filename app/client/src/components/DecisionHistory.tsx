// Every decision this requirement has had, not just the one that stands.
//
// The sequence is what makes a decision reviewable. One acceptance says somebody judged a failure
// tolerable; four acceptances in a row, each renewed a week before the last one lapsed, say the
// organisation has decided not to fix it and has not said so out loud. That is the thing a reader
// inheriting an estate needs to be able to see, and the thing a report should be able to show.
//
// Loaded on demand for the same reason the answer history is: the list endpoint returns the current
// decision per requirement, and folding every superseded one into it would multiply the payload to
// render one pane.

import { useEffect, useState } from 'react';
import type { Decision } from '../api/types';
import { datePhrase, decidedPhrase, DISPOSITION_LABEL } from '../pages/decide-language';
import { RecordList, RecordValue, Surface } from './system';

export function DecisionHistory({ controlId }: { controlId: string }) {
  const [history, setHistory] = useState<readonly Decision[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  /*
   * Fetches, and does not reset. The caller keys this on the control id, so a change of subject
   * arrives as a fresh mount with empty state — which avoids showing the previous requirement's
   * history for a frame, as clearing inside the effect would.
   */
  useEffect(() => {
    let live = true;

    void fetch(`/api/decisions/${encodeURIComponent(controlId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`The history could not be read (${String(response.status)}).`);
        return (await response.json()) as { decisions: readonly Decision[] };
      })
      .then((body) => {
        if (live) setHistory(body.decisions);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : 'The history could not be read.');
      });

    return () => {
      live = false;
    };
  }, [controlId]);

  // One decision is the one standing, which the pane above shows in full. A history of one is a
  // heading over a repetition.
  if (error == null && history.length < 2) return null;

  return (
    <Surface
      tone="inset"
      title="Previously"
      {...(error == null ? { description: `${String(history.length)} decisions` } : {})}
      headingLevel={3}
    >
      {error != null ? (
        <p className="wa-caption">{error}</p>
      ) : (
        <RecordList label="Previous decisions" ordered>
          {history.slice(1).map((decision) => (
            <RecordValue
              key={decision.id}
              title={`${DISPOSITION_LABEL[decision.disposition]} — ${decidedPhrase(decision)}`}
              summary={decision.until != null ? datePhrase({ ...decision, standing: 'current' }) : undefined}
              meta={decision.reason}
            />
          ))}
        </RecordList>
      )}
    </Surface>
  );
}
