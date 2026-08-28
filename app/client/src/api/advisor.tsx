// One loaded advisory, shared by the header and both Optimisation pages.
//
// The pages each read `/api/advisory/latest` themselves before this, which was two requests for one
// answer and, more to the point, left the run button nowhere to live: a control in the header could
// start a run and had no way to hand the result to whichever page the reader was standing on. So the
// header showed a scan's provenance and a scan's button on pages a scan does not populate, and the
// advisor could only be run by POSTing to the API. This holds the one advisory both surfaces read.
//
// It wraps the router for the reason the assessment's provider does: an advisory started on the
// workloads page is still the advisory the serverless page shows after navigating to it.

import { useCallback, useState, type ReactNode } from 'react';
import { useAdvisory, useRunAdvisory } from './hooks';
import { AdvisorContext, type AdvisorValue } from './advisor-context';
import type { Advisory } from './types';

export function AdvisorProvider({ children }: { children: ReactNode }) {
  const latest = useAdvisory();
  const [fresh, setFresh] = useState<Advisory | undefined>(undefined);

  /*
   * A finished run lands here rather than reloading the latest advisory.
   *
   * The run answers with the advisory it produced, so asking the server for it again would be a
   * second request for something already in hand — and a moment in between where the page shows the
   * previous run's advice under a header stamped with the new run's time.
   */
  const took = useCallback((advisory: Advisory) => {
    setFresh(advisory);
  }, []);
  const runner = useRunAdvisory(took);

  const advisory = fresh ?? latest.data;

  const value: AdvisorValue = {
    ...(advisory != null && { advisory }),
    loading: latest.loading,
    ...(latest.error != null && { error: latest.error }),
    // Suppressed once a run has landed. The reason was written for a workspace the advisor had never
    // run in, and it is no longer true of one it just ran in.
    ...(advisory == null && latest.reason != null && { reason: latest.reason }),
    advising: runner.running,
    ...(runner.error != null && { adviseError: runner.error }),
    runAdvisor: runner.run,
    reload: latest.reload,
  };

  return <AdvisorContext.Provider value={value}>{children}</AdvisorContext.Provider>;
}
