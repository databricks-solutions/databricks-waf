// The shape every page reads the assessment through.
//
// Kept apart from the provider so the pages import a type and a hook rather than the
// component tree, which also keeps the provider file to components only.

import { createContext, useContext } from 'react';
import type { Chosen, AssessmentChoice } from './assessment-choice';
import type { ScanRequest } from './hooks';
import type { CustomerResult } from './final-result';
import type { AssessmentResult, CatalogueControl, CatalogueResponse, Scan, ScanStatus } from './types';

export interface AssessmentValue {
  /** The source-run-shaped view of the immutable final assessment. Never the latest raw run. */
  readonly scan?: Scan;
  /** The identity and record behind `scan`, so every displayed outcome can name its final result. */
  readonly result?: CustomerResult;
  /** The newest raw run, used only for review and run operations. It is not a customer score. */
  readonly latestRun?: Scan;
  readonly catalogue?: CatalogueResponse;
  readonly loading: boolean;
  readonly error?: string;
  /** Present when there is legitimately nothing to show yet, e.g. no scan has been run. */
  readonly emptyReason?: string;
  /**
   * Whether a run is in flight, whoever started it.
   *
   * True for a run this reader started, a run a colleague started, the scheduled run, and this
   * reader's own run after a page reload — because to a reader those are one fact, and the page
   * that tells only the first of them is a page that looks idle while the estate is being measured.
   */
  readonly scanning: boolean;
  /**
   * What that run is, when the server was asked rather than inferred from a click.
   *
   * Absent for the moment between this reader pressing the button and the first poll answering,
   * which is why `scanning` is separate rather than derived from this being present.
   */
  readonly runInFlight?: ScanStatus;
  readonly scanError?: string;
  readonly runScan: (request?: ScanRequest) => void;
  /** Accepts the final result returned by the last pillar write without waiting for another GET. */
  readonly acceptResult: (result: AssessmentResult) => void;
  /**
   * The review created for the interactive run this browser just completed.
   *
   * Absent for a scheduled run observed by the follower, so unattended completion creates inbox
   * work without pulling a reader away from what they are doing.
   */
  readonly completedReview?: { readonly runId: string; readonly reviewId: string };
  /**
   * The pillars the run in flight is measuring, when it is a targeted rerun.
   *
   * Present so a pillar's own rerun control can show its own state rather than every pillar
   * appearing to be scanning, which would be indistinguishable from a full scan.
   */
  readonly scanningPillars?: readonly string[];
  /** The catalogue entry behind a finding: criteria, remediation, source. */
  readonly controlOf: (controlId: string) => CatalogueControl | undefined;
  readonly pillarTitle: (pillarId: string) => string;
  /**
   * The other pillars asking for the same requirement under their own ids, where any do.
   *
   * Empty for all but a dozen of the 184, and the reason it is on the context rather than computed
   * where it is needed is the printed report: it renders a pane per finding, and a walk of the whole
   * catalogue inside each one is the same index built thirty-four times.
   */
  readonly alsoAsking: (controlId: string) => readonly AlsoAsking[];
  /**
   * The assessment every product list is reading.
   *
   * `undefined` while definitions are still loading. `null` is without an assessment. A string is
   * the selected definition, defaulting to the most recently defined when several exist.
   */
  readonly definitionId: string | null | undefined;
  readonly choices: readonly AssessmentChoice[];
  readonly selected?: AssessmentChoice;
  readonly setChosen: (chosen: Chosen) => void;
}

/** One pillar's own entry for a requirement another pillar also asks for. */
export interface AlsoAsking {
  readonly controlId: string;
  readonly pillarId: string;
  readonly title: string;
}

export const AssessmentContext = createContext<AssessmentValue | undefined>(undefined);

export function useAssessment(): AssessmentValue {
  const value = useContext(AssessmentContext);
  if (value == null) throw new Error('useAssessment must be used inside an AssessmentProvider.');
  return value;
}
