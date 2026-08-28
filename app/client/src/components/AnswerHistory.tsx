// Every answer this requirement has had, not just the current one.
//
// The history is the reason attestation is worth building rather than a field on a form. A single
// current answer says what somebody believes today; the sequence says whether the practice is
// managed — who has confirmed it, how often, and whether the statement has changed or been copied
// forward unread. That is the question an auditor asks, and it is the question the customer should
// be able to ask themselves before one does.
//
// Loaded on demand rather than with the list. The list endpoint returns 82 requirements and this
// would multiply it by however many cycles have been recorded, to render one pane's worth.

import { useEffect, useState } from 'react';
import type { Attestation } from '../api/types';
import { ANSWER_LABEL, attributionPhrase } from '../pages/attest-language';
import { Surface } from './system';

export function AnswerHistory({ controlId }: { controlId: string }) {
  const [history, setHistory] = useState<readonly Attestation[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  /*
   * Fetches, and does not reset. The caller keys this component on the control id, so a change of
   * subject arrives as a fresh mount with empty state — which is both what React wants and what the
   * reader wants, since clearing in an effect shows the previous requirement's history for a frame.
   */
  useEffect(() => {
    let live = true;

    void fetch(`/api/attestations/${encodeURIComponent(controlId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`The history could not be read (${String(response.status)}).`);
        return (await response.json()) as { attestations: readonly Attestation[] };
      })
      .then((body) => {
        if (live) setHistory(body.attestations);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : 'The history could not be read.');
      });

    return () => {
      live = false;
    };
  }, [controlId]);

  // One answer is the current answer, which the pane above already shows in full. A history of
  // one is a heading over a repetition.
  if (error == null && history.length < 2) return null;

  return (
    <Surface
      tone="inset"
      title="Previously"
      description={error == null ? `${String(history.length)} answers` : undefined}
      headingLevel={3}
    >
      {error != null ? (
        <p className="wa-caption p-3">{error}</p>
      ) : (
        <ol className="wa-zebra">
          {history.slice(1).map((answer) => (
            <li key={answer.id} className="wa-row flex-col items-start gap-0.5 py-1.5">
              <span className="wa-body-compact text-wa-text">
                {ANSWER_LABEL[answer.answer]} — {attributionPhrase(answer.attestedBy, answer.attestedAt)}
              </span>
              <span className="wa-caption line-clamp-2">{answer.statement}</span>
            </li>
          ))}
        </ol>
      )}
    </Surface>
  );
}
