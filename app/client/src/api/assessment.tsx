// One loaded assessment, shared by every page.
//
// The alternative is each page fetching the latest scan itself, which means four requests
// for one answer and, worse, four pages that can disagree: run a scan on the overview,
// click through to findings, and see the previous scan because that page loaded first.
// Holding it once means the pages are views of the same result by construction.

import { useCallback, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  useCatalogue,
  useCurrentResult,
  useDefinitions,
  useLatestScan,
  useRunInFlight,
  useRunScan,
  useScan,
} from './hooks';
import { AssessmentContext, type AlsoAsking, type AssessmentValue } from './assessment-context';
import { AssessmentIdContext } from './assessment-id';
import { choicesFrom, definitionIdOf, selectedChoice, type AssessmentChoice, type Chosen } from './assessment-choice';
import { customerResult } from './final-result';
import { readablePillarId } from './pillar-label';
import type { AssessmentResult, CatalogueControl, Scan } from './types';

/** One array for every requirement with no kin, so a consumer's `useMemo` is not invalidated per call. */
const EMPTY: readonly AlsoAsking[] = [];

export function AssessmentProvider({ children }: { children: ReactNode }) {
  const definitions = useDefinitions();
  const [chosen, setChosen] = useState<Chosen>({ kind: 'unset' });
  const choices = useMemo(() => choicesFrom(definitions.data?.definitions ?? []), [definitions.data]);
  const selected = selectedChoice(chosen, choices);
  const definitionId = definitionIdOf(definitions.loading, definitions.data != null, chosen, selected);

  return (
    <AssessmentIdContext.Provider value={definitionId}>
      <AssessmentDataProvider setChosen={setChosen} choices={choices} selected={selected} definitionId={definitionId}>
        {children}
      </AssessmentDataProvider>
    </AssessmentIdContext.Provider>
  );
}

function AssessmentDataProvider({
  children,
  setChosen,
  choices,
  selected,
  definitionId,
}: {
  children: ReactNode;
  setChosen: Dispatch<SetStateAction<Chosen>>;
  choices: readonly AssessmentChoice[];
  selected: AssessmentChoice | undefined;
  definitionId: string | null | undefined;
}) {
  const catalogue = useCatalogue();
  const latest = useLatestScan();
  const current = useCurrentResult();
  const [fresh, setFresh] = useState<Scan | undefined>(undefined);
  const [freshResult, setFreshResult] = useState<AssessmentResult | undefined>(undefined);
  const [lost, setLost] = useState<string | undefined>(undefined);
  const [completedReview, setCompletedReview] = useState<AssessmentValue['completedReview']>(undefined);
  /*
   * A scan belonging to the previous assessment must not stay on screen after the reader switches.
   *
   * Compared during render rather than cleared in an effect, for the same reason `useGet` does: an
   * effect would paint the previous assessment's scan under the new one's id for a frame, and that
   * frame is a wrong answer rather than a flicker.
   */
  const [scopedTo, setScopedTo] = useState(definitionId);
  if (scopedTo !== definitionId) {
    setScopedTo(definitionId);
    setFresh(undefined);
    setFreshResult(undefined);
    setLost(undefined);
    setCompletedReview(undefined);
  }

  /*
   * One place a finished run arrives, whoever started it.
   *
   * Both paths set the same `fresh`, rather than the follower reloading the latest scan through its
   * own hook, because two sources for the current assessment means a moment where the newer of them
   * is not the one on screen — and the scan on screen is the whole product.
   */
  const inFlight = useRunInFlight(setFresh, setLost);

  /*
   * A run this tab started answers here, and the follower is told to look again.
   *
   * Without the second half the band goes on saying the estate is being measured for up to one poll
   * after the measurement is on screen, which is a small lie on the one surface whose claim is that
   * it does not make them.
   */
  const took = useCallback(
    (scan: Scan) => {
      setFresh(scan);
      setLost(undefined);
      const reviewId = scan.finalisation?.reviewId;
      setCompletedReview(reviewId == null ? undefined : { runId: scan.id, reviewId });
      inFlight.check();
    },
    [inFlight]
  );
  const runner = useRunScan(took);

  const latestRun = fresh ?? latest.data;
  const resultRecord = freshResult ?? current.data?.result;
  const source = useScan(resultRecord?.runId ?? '');
  const result = useMemo(() => customerResult(resultRecord, source.data), [resultRecord, source.data]);
  const scan = result?.assessment;
  const acceptResult = useCallback((accepted: AssessmentResult) => {
    setFreshResult(accepted);
  }, []);

  const controls = useMemo(() => {
    const index = new Map<string, CatalogueControl>();
    for (const pillar of catalogue.data?.pillars ?? []) {
      for (const principle of pillar.principles) {
        for (const control of principle.controls) index.set(control.id, control);
      }
    }
    return index;
  }, [catalogue.data]);

  const titles = useMemo(() => {
    const index = new Map<string, string>();
    for (const pillar of catalogue.data?.pillars ?? []) index.set(pillar.id, pillar.title);
    return index;
  }, [catalogue.data]);

  /*
   * Which requirements are the same requirement, indexed by alias group.
   *
   * Built from the catalogue rather than from the findings, so it answers for a requirement no run
   * measured — a pane on an unmeasured requirement still has to say the other pillar asks for it.
   */
  const kin = useMemo(() => {
    const index = new Map<string, AlsoAsking[]>();
    for (const pillar of catalogue.data?.pillars ?? []) {
      for (const principle of pillar.principles) {
        for (const control of principle.controls) {
          if (control.aliasGroup == null) continue;
          const group = index.get(control.aliasGroup) ?? [];
          group.push({ controlId: control.id, pillarId: pillar.id, title: control.title });
          index.set(control.aliasGroup, group);
        }
      }
    }
    return index;
  }, [catalogue.data]);

  const controlOf = useCallback((controlId: string) => controls.get(controlId), [controls]);
  const pillarTitle = useCallback((pillarId: string) => titles.get(pillarId) ?? readablePillarId(pillarId), [titles]);
  const alsoAsking = useCallback(
    (controlId: string) => {
      const group = controls.get(controlId)?.aliasGroup;
      if (group == null) return EMPTY;
      return kin.get(group)?.filter((one) => one.controlId !== controlId) ?? EMPTY;
    },
    [controls, kin]
  );

  const value: AssessmentValue = {
    ...(scan != null && { scan }),
    ...(result != null && { result }),
    ...(latestRun != null && { latestRun }),
    ...(catalogue.data != null && { catalogue: catalogue.data }),
    loading:
      catalogue.loading || current.loading || (resultRecord != null && source.loading) || definitionId === undefined,
    ...((catalogue.error ?? current.error ?? source.error) != null && {
      error: catalogue.error ?? current.error ?? source.error,
    }),
    ...(scan == null && {
      emptyReason:
        latestRun == null
          ? (latest.reason ?? 'No raw run has been recorded for this assessment.')
          : 'The latest run is waiting for its review. The Dashboard appears when that review publishes the report.',
    }),
    // Either source is enough. The click leads the first poll by up to three seconds, and the poll
    // outlives the click across a reload, so a reader is told a run is happening in both directions.
    scanning: runner.running || inFlight.running,
    ...(inFlight.running && { runInFlight: inFlight }),
    // A run that finished and could not be read is reported the same way a refused run is: the reader
    // is looking at an assessment that has been superseded, and silence would leave it looking current.
    ...((runner.error ?? lost) != null && { scanError: runner.error ?? lost }),
    runScan: runner.run,
    acceptResult,
    ...(completedReview != null ? { completedReview } : {}),
    ...(runner.runningPillars != null && { scanningPillars: runner.runningPillars }),
    controlOf,
    pillarTitle,
    alsoAsking,
    definitionId,
    choices,
    ...(selected != null ? { selected } : {}),
    setChosen,
  };

  return <AssessmentContext.Provider value={value}>{children}</AssessmentContext.Provider>;
}
