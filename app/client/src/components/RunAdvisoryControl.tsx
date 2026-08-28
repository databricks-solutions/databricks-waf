// Starting an advisory run.
//
// The Optimisation pages could show what the advisor concluded and nothing in the interface could
// make it conclude anything: `/api/advisory` existed, the scheduled task called it, and a reader in
// front of an empty Workloads page was told to press a button that was not there. This is it.
//
// Not the split control the scan has, and the difference is not a simplification. A scan answers to
// an assessment — a named scope, a window, a set of pillars, versioned so a run can say what decided
// it — and the menu beside that button is where the reader chooses which one. An advisory run has no
// such thing to answer to: it reads the query history of the estate the caller can see over a fixed
// window, and there is nothing to choose. A chevron offering one option would be a control that
// implies a decision nobody makes.
//
// What it says while running is deliberately not "Scanning". The two runs cost different money
// against different tables and produce different records, and a reader who has to work out which of
// them is happening from a spinner has been told nothing.

import { Spinner } from '@databricks/appkit-ui/react';
import { Play } from 'lucide-react';
import { useAdvisor } from '../api/advisor-context';

export function RunAdvisoryControl() {
  const { advising, runAdvisor } = useAdvisor();

  return (
    <button
      type="button"
      className="wa-button-primary"
      onClick={() => runAdvisor()}
      disabled={advising}
      // Names all three things one run produces rather than the first page it was built for. It said
      // "the workload advisor over the estate's query history", which a screen-reader user on the
      // Warehouses or Serverless page heard as a control for something else.
      aria-label="Run the workload advisor"
    >
      {advising ? (
        <>
          <Spinner className="h-3.5 w-3.5" />
          Advising
        </>
      ) : (
        <>
          <Play aria-hidden className="h-3.5 w-3.5" />
          Run the advisor
        </>
      )}
    </button>
  );
}

/**
 * Why the run this reader asked for did not happen.
 *
 * Beside the analysis rather than beside the button, because the button lives in a header with no
 * room for a sentence — and the commonest message here is not a failure at all but the coordinator
 * refusing a second run while one is already going, which is something to wait for rather than
 * something to fix. Renders nothing when there is nothing to say.
 */
export function AdvisoryRunNotice() {
  const { adviseError } = useAdvisor();
  if (adviseError == null) return null;
  return (
    <p role="alert" className="wa-caption text-wa-text">
      The advisor was not started: {adviseError}
    </p>
  );
}
