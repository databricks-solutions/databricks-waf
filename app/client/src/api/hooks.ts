// Fetching, with the failure cases treated as real states rather than exceptions.
//
// Every request here can fail in a way the reader has to act on: no user token forwarded,
// no warehouse bound, a scan already running, no scan yet. Those are not bugs, they are
// the app's ordinary states in a fresh install, so the hooks return them as values and
// the pages render them as text. The alternative — throwing and letting an error boundary
// show "something went wrong" — turns a fixable configuration problem into a mystery.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAssessmentId, withAssessment } from './assessment-id';
import { REPORT_COLLECTION_READS } from './report-reads';
import type { TopologyPayload } from '../../../shared/api/topology';
import type {
  ActionEffort,
  ActionPriority,
  ActionsForControl,
  ActionsRaised,
  ActionState,
  AdviceReference,
  Advisory,
  AdvisoryHistory,
  ApiError,
  AssessmentResult,
  AssessmentReview,
  Attestations,
  AttestedAnswer,
  AuditTrail,
  AuditVerification,
  CatalogueResponse,
  Decisions,
  Definitions,
  EvidenceScript,
  EvidenceImports,
  EvidenceImportVerdict,
  DefinitionAttribution,
  DefinitionMeasurement,
  DraftTarget as DraftTargetPayload,
  PillarTarget as PillarTargetPayload,
  Diagnostics,
  Disposition,
  FoundationReadiness,
  GuidanceResponse,
  ImprovementPlanDetail,
  Improvements,
  Methodology,
  CatalogueSpan,
  CurrentResult,
  FinalResultHistory,
  NoteCounts,
  NoteSubject,
  NoteSubjectKind,
  NoteThread,
  NoteThreads,
  OpenReviews,
  Plan,
  PlanExports,
  RunChanges,
  RunExports,
  Scan,
  Schedule,
  ScanHistory,
  ScanStatus,
  ScopePreview,
  SelectableWorkspaces,
  SetupDraft,
  SetupDrafts,
  Preflight,
  Reset,
  Retention,
  RetentionClass,
  Risks,
  Severity,
  Sweep,
  Validations,
  MonthDocument,
  MonthPreview,
  Months,
  MonthStanding,
} from './types';

export interface Loadable<T> {
  readonly data?: T;
  readonly loading: boolean;
  /** A sentence to show the reader. Undefined when there is nothing wrong. */
  readonly error?: string;
  /** Set when the API answered with a structured reason rather than failing. */
  readonly reason?: string;
  readonly reload: () => void;
}

async function readError(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = (await response.json()) as ApiError;
    const message = apiErrorMessage(body, response.statusText);
    return { message: message === '' ? response.statusText : message, ...(body.error != null && { code: body.error }) };
  } catch {
    return { message: `The request failed with status ${String(response.status)}.` };
  }
}

/** The server gate's complete explanation wins over a legacy top-level sentence. */
export function apiErrorMessage(body: ApiError, fallback: string): string {
  const gate = body.eligibility?.eligible === false ? body.eligibility.reason : undefined;
  const message =
    gate == null
      ? (body.message ?? [body.summary, body.action].filter(Boolean).join(' '))
      : [gate.message, gate.action].filter(Boolean).join(' ');
  return message === '' ? fallback : message;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<{ data?: T; error?: string; code?: string }> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, signal });
  if (!response.ok) {
    const { message, code } = await readError(response);
    return { error: message, ...(code != null && { code }) };
  }
  return { data: (await response.json()) as T };
}

/**
 * Defers an effect's external work until React has finished the current lifecycle task.
 *
 * Development StrictMode installs an effect, cleans it up and installs it again in that task. Starting a
 * request synchronously therefore sends the throwaway setup to the server before cleanup can cancel it.
 * A zero-delay task lets that cleanup remove work which never belonged to a mounted reader, while adding
 * only one event-loop turn to the single production setup.
 */
export function deferEffectWork(start: () => void): () => void {
  const timer = setTimeout(start, 0);
  return () => clearTimeout(timer);
}

/**
 * A GET with its states.
 *
 * `absentIsFine` names the codes that mean "nothing here yet" rather than "broken", so a
 * fresh install shows an invitation to scan instead of a red error for a 404 that was
 * always going to happen.
 *
 * A `null` path asks for nothing: no request, no data, not loading. That is for a caller whose
 * question does not always exist — "what changed between the version that scored your last run and the
 * one this build ships" has no subject on an install that is not behind. The alternative is a path the
 * server refuses, which every other conditional caller here uses because their question is always
 * well-formed and merely unanswerable yet; a request the client knows is incomplete answers 400, and a
 * 400 says the client sent something wrong rather than that it deliberately asked for nothing.
 */
function useGet<T>(path: string | null, absentIsFine: readonly string[] = []): Loadable<T> {
  const [state, setState] = useState<{ data?: T; error?: string; reason?: string; loading: boolean }>({
    loading: path != null,
  });
  const [nonce, setNonce] = useState(0);

  /*
   * The path the state describes, so a changed one is not answered with the old one's data.
   *
   * Set during render rather than in an effect, which is React's own answer to resetting state when an
   * input changes: an effect would paint the previous path's data under the new path's URL for a frame,
   * and on a page whose URL states what is being read that frame is a wrong answer rather than a flicker.
   * Most callers pass a constant and never take this branch.
   */
  const [asked, setAsked] = useState(path);
  if (asked !== path) {
    setAsked(path);
    setState({ loading: path != null });
  }

  useEffect(() => {
    /*
     * Per run of the effect, not per component.
     *
     * A single ref shared by every run is set back to `true` by the next run before the previous
     * request resolves, so a slow answer to a superseded path still reaches `setState` and the last
     * response to arrive wins rather than the last one asked for. That is invisible while every caller
     * changes its path only on a navigation, and it is reachable the moment one changes it while the
     * reader types.
     */
    let live = true;
    let controller: AbortController | undefined;

    if (path == null) return;

    const cancelStart = deferEffectWork(() => {
      controller = new AbortController();
      void getJson<T>(path, controller.signal)
        .then(({ data, error, code }) => {
          if (!live) return;
          if (data !== undefined) {
            setState({ data, loading: false });
            return;
          }
          const expected = code != null && absentIsFine.includes(code);
          setState({ loading: false, ...(expected ? { reason: error } : { error }) });
        })
        .catch((cause: unknown) => {
          // Cleanup deliberately aborts the request. That is not a customer-visible failure and the
          // component that asked for it is no longer entitled to publish a state. A live network error
          // remains a real state, matching the contract at the top of this file.
          if (!live || controller?.signal.aborted) return;
          setState({
            loading: false,
            error: cause instanceof Error ? cause.message : 'The request failed before it returned a response.',
          });
        });
    });

    return () => {
      live = false;
      cancelStart();
      controller?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- absentIsFine is a literal at every call site.
  }, [path, nonce]);

  // Loading is raised here rather than in the effect: setting it inside the effect body
  // means a second render for every fetch, and the initial state already starts loading.
  const reload = useCallback(() => {
    setState((previous) => ({ ...previous, loading: true }));
    setNonce((value) => value + 1);
  }, []);

  return { ...state, reload };
}

/**
 * A product path under the assessment currently being read.
 *
 * `null` while definitions are still loading, so the hook asks for nothing rather than the unscoped
 * view. Pages that are not about an assessment (catalogue, definitions, trail) keep calling `useGet`
 * directly.
 */
function useScopedPath(path: string | null): string | null {
  return withAssessment(path, useAssessmentId());
}

/**
 * What this install can and cannot reach.
 *
 * Not polled, and deliberately: three of the four readings are probes, and a page that re-asked every
 * five seconds would take an identity probe with it each time. This is read by a person once, while
 * something is wrong, and there is a reload button for the second reading.
 */
export function useDiagnostics(): Loadable<Diagnostics> {
  return useGet<Diagnostics>('/api/diagnostics');
}

/**
 * A page of the trail, under the filters the caller passes.
 *
 * The filters go to the server rather than being applied here, and that is not an optimisation: the
 * trail is the one list in this app that has no ceiling. Every mutation adds a row for the life of the
 * install, so a client that fetched it all to filter locally would work for a month and then stop —
 * and it would stop on the estate that used the app most.
 *
 * `search` is the query string the page composed from its own URL, so the browser's address bar and
 * the request are the same statement of what is being read. A filter the page holds privately is one
 * an auditor cannot send to a colleague.
 */
export function useAuditTrail(search: string): Loadable<AuditTrail> {
  return useGet<AuditTrail>(`/api/audit${search === '' ? '' : `?${search}`}`);
}

/**
 * Whether the trail is still what the app wrote.
 *
 * Its own request rather than a field on the page above, because it walks the whole chain and the
 * page is read far more often than the integrity of the log needs re-establishing. Separating them
 * also means a verification that fails renders as a failure of *that* claim, rather than taking the
 * list of events down with it.
 */
export function useAuditVerification(): Loadable<AuditVerification> {
  return useGet<AuditVerification>('/api/audit/verification');
}

/**
 * How long this install keeps what it wrote, and what that makes eligible now.
 *
 * One request for the policy, the counts and the holds, because none of the three is judgeable without
 * the others — see `retention-routes.ts`, which composes them for the same reason.
 */
export function useRetention(): Loadable<Retention> {
  return useGet<Retention>('/api/retention');
}

export interface ChangeRetention {
  readonly setPeriod: (retentionClass: RetentionClass['retentionClass'], days: number) => void;
  readonly placeHold: (reason: string, covers: readonly RetentionClass['retentionClass'][]) => void;
  readonly releaseHold: (id: string) => void;
  /**
   * Removes what is past its period, confirming the count the reader was shown.
   *
   * The count is passed rather than held here, because it is the reader's confirmation rather than the
   * client's bookkeeping: a hook that remembered the last plan it fetched would confirm a number
   * nobody looked at, which is the whole thing the server's check exists to prevent.
   */
  readonly sweep: (expect: number) => void;
  /**
   * Empties the install, confirming the number of records the reader was shown.
   *
   * The count is the plan's `records` rather than every row, for the reason the route states: the
   * trail's size moves whenever anybody does anything, a refused reset included, so a confirmation
   * that included it would be one nobody could ever satisfy.
   */
  readonly reset: (expect: number) => void;
  readonly working: boolean;
  readonly error?: string;
  /** What the last sweep did. Cleared when anything else is asked for. */
  readonly swept?: Sweep;
  /** What the last reset did. The only reading of it that survives, besides the trail's own event. */
  readonly emptied?: Reset;
}

/**
 * Changing the position, and acting on it.
 *
 * One hook for four acts rather than four hooks, because they share a page and a reader does one at a
 * time: separate `working` flags would let the page show two spinners for one intention, and the
 * refusal from any of them belongs in the same place.
 */
export function useChangeRetention(onChanged?: () => void): ChangeRetention {
  const [state, setState] = useState<{ working: boolean; error?: string; swept?: Sweep; emptied?: Reset }>({
    working: false,
  });

  const act = useCallback(
    (path: string, method: string, body: unknown, then?: (payload: unknown) => void) => {
      setState({ working: true });
      void fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (response) => {
          if (!response.ok) {
            const { message } = await readError(response);
            setState({ working: false, error: message });
            return;
          }
          // 204 for the three that answer nothing; a sweep and a reset answer what they removed.
          const text = response.status === 204 ? '' : await response.text();
          setState({ working: false });
          then?.(text === '' ? undefined : JSON.parse(text));
          onChanged?.();
        })
        .catch((cause: unknown) => {
          setState({ working: false, error: cause instanceof Error ? cause.message : 'The change could not be sent.' });
        });
    },
    [onChanged]
  );

  return {
    setPeriod: (retentionClass, days) => act('/api/retention/periods', 'PUT', { periods: { [retentionClass]: days } }),
    placeHold: (reason, covers) => act('/api/retention/holds', 'POST', { reason, covers }),
    releaseHold: (id) => act(`/api/retention/holds/${encodeURIComponent(id)}/release`, 'POST', {}),
    sweep: (expect) =>
      act('/api/retention/sweep', 'POST', { expect }, (payload) => {
        setState({ working: false, swept: payload as Sweep });
      }),
    reset: (expect) =>
      act('/api/retention/reset', 'POST', { expect }, (payload) => {
        setState({ working: false, emptied: payload as Reset });
      }),
    ...state,
  };
}

export function useCatalogue(): Loadable<CatalogueResponse> {
  return useGet<CatalogueResponse>('/api/catalogue');
}

/**
 * What the app measures against, and what each release of it changed.
 *
 * Separate from `useCatalogue` even though both describe requirements, because the two answer
 * different questions and a reader on the methodology page is asking the second: not "what does this
 * requirement mean" but "what can a version bump change about my score". The overlap is four fields
 * and the difference is the version history, which the catalogue does not carry.
 */
export function useMethodology(): Loadable<Methodology> {
  return useGet<Methodology>('/api/methodology');
}

/**
 * What separates two versions of the methodology.
 *
 * Composed on the server rather than from the history this page already holds, because a requirement
 * renumbered in one release and re-severitied in the next is one requirement with a history, and
 * differencing the two endpoints reports it as a removal beside an addition. `changelog.ts` gets that
 * right and the run comparison already depends on it.
 *
 * Either version absent asks nothing at all rather than asking badly. The ordinary case is an install
 * whose last run was scored by the version it still ships, where there is no span to draw — and a
 * request the client already knows is incomplete would be answered 400, which reads in a log as the
 * client having a bug on every visit to the page.
 */
export function useCatalogueSpan(from: string | undefined, to: string | undefined): Loadable<CatalogueSpan> {
  const both = from != null && to != null;
  return useGet<CatalogueSpan>(
    both ? `/api/methodology/catalogue-span?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : null
  );
}

/**
 * What a run executes, which is a property of the app rather than of the estate.
 *
 * Fetched like everything else rather than compiled into the client, because it is derived
 * from the shipped SQL and the resolver registry on the server. A client-side copy would be a
 * second statement of what the app does, and the whole point of the page is that it is the
 * first and only one.
 */
export function usePlan(): Loadable<Plan> {
  return useGet<Plan>('/api/plan');
}

export function useLatestScan(): Loadable<Scan> {
  return useGet<Scan>(useScopedPath('/api/scans/latest'), ['no-scans']);
}

/** The latest immutable final assessment for the selected definition, never the latest raw run. */
export function useCurrentResult(): Loadable<CurrentResult> {
  return useGet<CurrentResult>(useScopedPath('/api/results/current'));
}

/** Immutable final-assessment history for customer trends and reports. */
export function useResultHistory(): Loadable<FinalResultHistory> {
  return useGet<FinalResultHistory>(useScopedPath('/api/results'));
}

/** One immutable final assessment by its customer-facing identity. */
export function useResult(id: string): Loadable<AssessmentResult> {
  return useGet<AssessmentResult>(useScopedPath(id === '' ? null : `/api/results/${id}`), ['unknown-result']);
}

export function useScanHistory(): Loadable<ScanHistory> {
  return useGet<ScanHistory>(useScopedPath('/api/scans'));
}

/**
 * Whether the *unattended* assessment is working, which the history beside it cannot say.
 *
 * Not polled. It reads the Jobs API through the app's own identity, and a page that re-asked every few
 * seconds would spend two calls a tick to watch a weekly cadence. A reader who starts a run by hand gets
 * a reload when it is accepted, which is the one moment the answer changes while they are looking.
 */
export function useSchedule(): Loadable<Schedule> {
  return useGet<Schedule>('/api/schedule');
}

export interface TestSchedule {
  /** Starts the scheduled job now, taking the path an unattended run takes. */
  readonly test: () => void;
  readonly working: boolean;
  /**
   * Why it was refused, shown beside the button rather than as a page-level alert.
   *
   * Kept here rather than thrown, because two of the three refusals are ordinary answers a reader acts
   * on — the schedule was never deployed, or a run is already going — and neither is a fault in the app.
   */
  readonly error?: string;
  /** Set once a run has been accepted, so the panel can say so without re-reading to find out. */
  readonly started: boolean;
}

/**
 * Starting the scheduled job by hand.
 *
 * `onStarted` reloads the schedule rather than this hook holding the run, because the run's own progress
 * is read from the job and the panel already renders that list. Holding a copy here would give the panel
 * two sources for the same run and a way for them to disagree.
 */
export function useTestSchedule(onStarted?: () => void): TestSchedule {
  const [state, setState] = useState<{ working: boolean; error?: string; started: boolean }>({
    working: false,
    started: false,
  });

  const test = useCallback(() => {
    setState({ working: true, started: false });
    void fetch('/api/schedule/run', { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) {
          const { message } = await readError(response);
          setState({ working: false, error: message, started: false });
          return;
        }
        setState({ working: false, started: true });
        onStarted?.();
      })
      .catch((cause: unknown) => {
        setState({
          working: false,
          started: false,
          error: cause instanceof Error ? cause.message : 'The request could not be sent.',
        });
      });
  }, [onStarted]);

  return { test, ...state };
}

export function useScanStatus(): Loadable<ScanStatus> {
  return useGet<ScanStatus>('/api/scan/status');
}

/** One recorded run, by id. */
export function useScan(id: string): Loadable<Scan> {
  return useGet<Scan>(useScopedPath(id === '' ? null : `/api/scans/${id}`), ['scan-not-found']);
}

/**
 * What the advisor last concluded, which is what both Optimisation pages read.
 *
 * `nothing-yet` and `no-advisor` are forgiven rather than shown as errors, and they are different
 * sentences: the first says press the button, the second says this install has no advisor at all.
 * The server writes both, so the pages show what it said instead of inventing a red banner.
 */
export function useAdvisory(): Loadable<Advisory> {
  return useGet<Advisory>(useScopedPath('/api/advisory/latest'), ['nothing-yet', 'no-advisor']);
}

/** The advisor's history, newest first, for the run a page is not showing. */
export function useAdvisoryHistory(): Loadable<AdvisoryHistory> {
  return useGet<AdvisoryHistory>(useScopedPath('/api/advisory/history'));
}

export interface RunAdvisory {
  readonly run: () => void;
  readonly running: boolean;
  readonly error?: string;
  readonly advisory?: Advisory;
}

/**
 * The assessment an advisory run answers to, in the field the run resolver reads.
 *
 * Kept pure for the same reason as `scanBody`: a server test that proves a field works and a client
 * test that proves a button sends a request can both pass while the request omits that field. Null is
 * the deliberate unscoped choice and therefore sends no definition; undefined is guarded by the hook
 * while definitions are still loading.
 */
export function advisoryBody(definitionId: string | null | undefined): Record<string, unknown> {
  return definitionId == null ? {} : { definitionId };
}

/**
 * Starting an advisory run.
 *
 * The same shape as `useRunScan` and deliberately not the same function. An advisory run is its own
 * cycle — its own trigger, history, retention and cost (ADR 0061) — and folding it into the scan
 * runner would give the two one running state, so a reader waiting on the advisor would be told the
 * estate was being measured and the score would look stale for the duration.
 *
 * There is one thing this cannot do that its scan counterpart can: report a run somebody else
 * started. `/api/scan/status` reports the scan runner and there is no advisory equivalent, so a
 * second tab learns of a run only when it reloads the latest advisory. The consequence is a second
 * click answered with the coordinator's 409 rather than with a band, which is handled below in the
 * terms the reader can act on — wait for the run that is already going.
 */
export function useRunAdvisory(onComplete?: (advisory: Advisory) => void): RunAdvisory {
  const definitionId = useAssessmentId();
  const [state, setState] = useState<{ running: boolean; error?: string; advisory?: Advisory }>({ running: false });

  const run = useCallback(() => {
    // Undefined is the loading state, not the unscoped choice. Sending an empty body here would save
    // a paid advisory where every specialist page in the selected assessment is unable to read it.
    if (definitionId === undefined) return;
    setState({ running: true });
    void fetch('/api/advisory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(advisoryBody(definitionId)),
    })
      .then(async (response) => {
        if (!response.ok) {
          const { message } = await readError(response);
          setState({ running: false, error: message });
          return;
        }
        const advisory = (await response.json()) as Advisory;
        setState({ running: false, advisory });
        onComplete?.(advisory);
      })
      .catch((cause: unknown) => {
        setState({
          running: false,
          error: cause instanceof Error ? cause.message : 'The advisory run request could not be sent.',
        });
      });
  }, [definitionId, onComplete]);

  return { run, ...state };
}

/** What that run changed against the run before it, or why the two cannot be compared. */
export function useRunChanges(id: string): Loadable<RunChanges> {
  return useGet<RunChanges>(useScopedPath(id === '' ? null : `/api/scans/${id}/changes`), ['scan-not-found']);
}

/** What an immutable final assessment changed against the final assessment before it. */
export function useResultChanges(id: string): Loadable<RunChanges> {
  return useGet<RunChanges>(useScopedPath(id === '' ? null : `/api/results/${id}/changes`), ['unknown-result']);
}

/**
 * What each export of that run should hash to.
 *
 * Fetched rather than read off the download, because the two are for different people. A response
 * header reaches whoever pressed the button; this reaches the page they can read the value out of
 * to the recipient of a file they have already sent.
 */
export function useRunExports(id: string): Loadable<RunExports> {
  return useGet<RunExports>(useScopedPath(id === '' ? null : `/api/scans/${id}/exports`), ['scan-not-found']);
}

/** Checksums and links for files sealed from one immutable final assessment. */
export function useResultExports(id: string): Loadable<RunExports> {
  return useGet<RunExports>(useScopedPath(id === '' ? null : `/api/results/${id}/exports`), ['unknown-result']);
}

/**
 * Every requirement only a person can answer, with the answer it has.
 *
 * The whole set rather than the unanswered ones, because reviewing an answer that is about to
 * lapse is as much of this page's job as giving a new one.
 */
export function useAttestations(runId?: string | null): Loadable<Attestations> {
  // No absent-is-fine code: the route answers with the whole set and a durability flag even when
  // nothing is bound to keep answers in, so there is no 404 to forgive.
  const suffix = runId == null || runId === '' ? '' : `?runId=${encodeURIComponent(runId)}`;
  return useGet<Attestations>(useScopedPath(runId === null ? null : `/api/attestations${suffix}`));
}

/** Open reviews of this assessment. A review stays here until every pillar has a confirm or a skip. */
export function useOpenReviews(): Loadable<OpenReviews> {
  return useGet<OpenReviews>(useScopedPath('/api/reviews'));
}

export interface ReviewLoadable extends Loadable<AssessmentReview> {
  /** The review a confirm or skip just wrote, so the page does not wait on a GET that can fail. */
  readonly accept: (written: AssessmentReview) => void;
}

/** One review, by id. */
export function useReview(id: string): ReviewLoadable {
  const path = useScopedPath(id === '' ? null : `/api/reviews/${id}`);
  const loaded = useGet<AssessmentReview>(path, ['unknown-review']);
  const [written, setWritten] = useState<AssessmentReview | undefined>(undefined);
  // The scoped path, not the id: switching assessment changes definitionId without changing the
  // route, and an overlay keyed only on id would keep the previous assessment's review on screen.
  const [asked, setAsked] = useState(path);
  if (asked !== path) {
    setAsked(path);
    setWritten(undefined);
  }
  const accept = useCallback((next: AssessmentReview) => {
    setWritten(next);
  }, []);
  return { ...loaded, ...(written != null ? { data: written, error: undefined, reason: undefined } : {}), accept };
}

/** The review of one completed scan, when that scan has one. */
export function useReviewForRun(runId: string): Loadable<AssessmentReview> {
  return useGet<AssessmentReview>(useScopedPath(runId === '' ? null : `/api/reviews/for/${runId}`), ['unknown-review']);
}

export interface OpenReview {
  readonly open: (runId: string) => void;
  readonly saving: boolean;
  readonly error?: string;
  readonly saved?: string;
}

/**
 * Opening a review of a completed scan.
 *
 * Reloads rather than holding the row: the page renders the review the GET returns, and a copy
 * kept here would be a second source for the same record. Opening a scan that already has a
 * review returns that row rather than refusing, so `saved` is the id either way.
 */
export function useOpenReview(onSaved?: (id: string) => void): OpenReview {
  const [state, setState] = useState<{ saving: boolean; error?: string; saved?: string }>({ saving: false });
  const path = useScopedPath('/api/reviews');
  // The same guard `useRecordPillar` carries, for the same reason: switching assessment changes
  // definitionId without changing the route, and a POST that lands afterwards would otherwise report
  // a saved id — which the caller navigates to — for a review of the assessment left behind.
  const nonce = useRef(0);
  const [asked, setAsked] = useState(path);
  if (asked !== path) {
    setAsked(path);
    setState({ saving: false });
    // eslint-disable-next-line react-hooks/refs -- stale writes must not report onto the new path
    nonce.current += 1;
  }

  const open = useCallback(
    (runId: string) => {
      if (path == null) return;
      const started = nonce.current;
      setState({ saving: true });
      void fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId }),
      })
        .then(async (response) => {
          if (nonce.current !== started) return;
          if (!response.ok) {
            const { message } = await readError(response);
            if (nonce.current !== started) return;
            setState({ saving: false, error: message });
            return;
          }
          const body = (await response.json()) as { id?: string };
          if (nonce.current !== started) return;
          const id = body.id ?? '';
          setState({ saving: false, saved: id });
          if (id !== '') onSaved?.(id);
        })
        .catch((cause: unknown) => {
          if (nonce.current !== started) return;
          setState({
            saving: false,
            error: cause instanceof Error ? cause.message : 'The review could not be opened.',
          });
        });
    },
    [onSaved, path]
  );

  return { open, ...state };
}

export interface RecordPillar {
  readonly confirm: (pillarId: string) => void;
  readonly skip: (pillarId: string) => void;
  readonly saving: boolean;
  readonly error?: string;
  readonly errorPillarId?: string;
}

/**
 * A write beneath one review pillar, scoped after the whole route is assembled.
 *
 * Appending a child to a path that already carries `?definitionId=` puts the child inside the
 * query value and Express sees only `/pillars`. Unscoped reviews hid that mistake because they have
 * no query string. Build the complete pathname first, then add the assessment scope.
 */
export function reviewPillarWritePath(
  reviewId: string,
  pillarId: string,
  action: 'confirm' | 'skip' | 'answers',
  definitionId: string | null | undefined
): string | null {
  if (reviewId === '' || pillarId === '') return null;
  return withAssessment(
    `/api/reviews/${encodeURIComponent(reviewId)}/pillars/${encodeURIComponent(pillarId)}/${action}`,
    definitionId
  );
}

/**
 * Confirm-current or an attributed skip, for one pillar of one review.
 *
 * Uses the review the write returns rather than patching one field or refetching. A confirm of the
 * last pillar includes the result in that body; a GET after the write that failed would drop the
 * record the POST had just put on the page.
 */
export function useRecordPillar(reviewId: string, onSaved?: (written: AssessmentReview) => void): RecordPillar {
  const [state, setState] = useState<{ saving: boolean; error?: string; errorPillarId?: string }>({ saving: false });
  const definitionId = useAssessmentId();
  const confirmPath = useScopedPath(reviewId === '' ? null : `/api/reviews/${reviewId}/pillars`);
  const nonce = useRef(0);
  const [asked, setAsked] = useState(confirmPath);
  if (asked !== confirmPath) {
    setAsked(confirmPath);
    setState({ saving: false, error: undefined, errorPillarId: undefined });
    // Then-handlers read this after await. Bumping here, not in an effect, closes the frame
    // between the path change and effect cleanup — the frame a POST can land in.
    // eslint-disable-next-line react-hooks/refs -- stale writes must not accept onto the new path
    nonce.current += 1;
  }

  const write = useCallback(
    (pillarId: string, kind: 'confirm' | 'skip') => {
      const at = reviewPillarWritePath(reviewId, pillarId, kind, definitionId);
      if (confirmPath == null || at == null) return;
      const started = nonce.current;
      // Replaces the whole object, so a previous error is gone before the next write lands.
      setState({ saving: true });
      void fetch(at, { method: 'POST' })
        .then(async (response) => {
          if (nonce.current !== started) return;
          if (!response.ok) {
            const { message } = await readError(response);
            if (nonce.current !== started) return;
            setState({ saving: false, error: message, errorPillarId: pillarId });
            return;
          }
          const written = (await response.json()) as AssessmentReview;
          if (nonce.current !== started) return;
          onSaved?.(written);
          setState({ saving: false });
        })
        .catch((cause: unknown) => {
          if (nonce.current !== started) return;
          setState({
            saving: false,
            error: cause instanceof Error ? cause.message : 'The record could not be written.',
            errorPillarId: pillarId,
          });
        });
    },
    [confirmPath, definitionId, onSaved, reviewId]
  );

  return {
    confirm: (pillarId) => write(pillarId, 'confirm'),
    skip: (pillarId) => write(pillarId, 'skip'),
    ...state,
  };
}

/**
 * What a person needs in order to answer one question honestly, where somebody has written it.
 *
 * Per requirement rather than with the list, because the list is 105 requirements and this is several
 * hundred words each. The route answers 200 with `status: 'absent'` for a question nobody has written
 * up yet, so there is no code to forgive: absence is a normal answer here, not a 404.
 */
export function useGuidance(controlId: string): Loadable<GuidanceResponse> {
  return useGet<GuidanceResponse>(`/api/guidance/${encodeURIComponent(controlId)}`);
}

/**
 * The admin evidence script, described so a downloaded copy can be checked against it.
 *
 * Metadata rather than the file: the download is a link the browser follows, not a fetch this app
 * has any reason to hold in memory. What the page needs is the digest, so the reader can see it
 * beside the link and check the file they end up with.
 */
export function useEvidenceScript(): Loadable<EvidenceScript> {
  return useGet<EvidenceScript>('/api/evidence/script');
}

/**
 * Every collection an admin has uploaded, newest first.
 *
 * No absent-is-fine code, for the reason the decisions hook has none: the route answers with the
 * whole set and a durability flag even when nothing is bound to keep imports in.
 */
export function useEvidenceImports(): Loadable<EvidenceImports> {
  return useGet<EvidenceImports>('/api/evidence/imports');
}

export interface ImportEvidence {
  readonly send: (file: File) => void;
  readonly sending: boolean;
  /**
   * What the server said, accepted or not.
   *
   * The whole verdict rather than a boolean, because a refusal is up to seven sentences and each is
   * a different thing for the reader to go and do. Collapsing it to "rejected" would leave them
   * guessing between a tampered file, last quarter's file, and the right file for another account.
   */
  readonly verdict?: EvidenceImportVerdict;
  /** Set when the request itself failed, rather than the file being judged and declined. */
  readonly error?: string;
}

/**
 * Uploading a collection.
 *
 * Sent as `application/octet-stream` because the endpoint reads bytes: it applies its own size cap
 * and its own parse rules, and a body declared as JSON is parsed by the framework before either can
 * run. The file is passed straight through — never read, re-serialised, or validated here — since the
 * digest in it is over the bytes the script wrote and this app has no business rewriting them.
 */
export function useImportEvidence(onImported?: () => void): ImportEvidence {
  const [state, setState] = useState<{ sending: boolean; verdict?: EvidenceImportVerdict; error?: string }>({
    sending: false,
  });

  const send = useCallback(
    (file: File) => {
      setState({ sending: true });
      void fetch('/api/evidence/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
        .then(async (response) => {
          // A refusal carries the verdict as its body, so it is read the same way as an acceptance.
          // Only a response that is not the endpoint's own answer — a proxy's error page, a 403 from
          // the gate — falls through to the error state.
          if (response.status === 201 || response.status === 409 || response.status === 422) {
            const verdict = (await response.json()) as EvidenceImportVerdict;
            setState({ sending: false, verdict });
            if (verdict.accepted) onImported?.();
            return;
          }
          const { message } = await readError(response);
          setState({ sending: false, error: message });
        })
        .catch((cause: unknown) => {
          setState({
            sending: false,
            error: cause instanceof Error ? cause.message : 'The file could not be sent.',
          });
        });
    },
    [onImported]
  );

  return { send, ...state };
}

/**
 * Every assessment definition, with its version history.
 *
 * No absent-is-fine code, for the same reason the attestations hook has none: the route answers with
 * the whole set and a durability flag even when nothing is bound to keep definitions in, so there is
 * no 404 to forgive. An install that keeps nothing is a state to describe, not a request that failed.
 */
export function useDefinitions(): Loadable<Definitions> {
  return useGet<Definitions>('/api/definitions');
}

/**
 * The workspaces a definition or ad-hoc run can name.
 *
 * A fresh install reads the one directory statement on demand; afterwards the last scan's dated
 * directory is enough. An unreadable directory is reported in `unavailable` rather than silently
 * looking like an account with no workspaces.
 */
export function useSelectableWorkspaces(): Loadable<SelectableWorkspaces> {
  return useGet<SelectableWorkspaces>('/api/workspaces');
}

/**
 * Everything this reader has part-written.
 *
 * No absent-is-fine code, like the definitions list beside it: the route answers with an empty list
 * and a durability flag rather than a 404, because an install that keeps nothing is a state to
 * describe and not a request that failed.
 */
export function useSetupDrafts(): Loadable<SetupDrafts> {
  return useGet<SetupDrafts>('/api/definitions/drafts');
}

/** The fields of an assessment being written, all optional because that is what unfinished means. */
export interface DraftContent {
  readonly definitionId?: string;
  readonly fromVersion?: number;
  readonly name?: string;
  readonly purpose?: string;
  readonly owners?: readonly string[];
  readonly scope?: { readonly kind: 'account' | 'selected'; readonly workspaceIds?: readonly string[] };
  readonly lookbackDays?: number;
  readonly pillars?: readonly string[];
  readonly targets?: readonly DraftTargetPayload[];
  readonly note?: string;
}

export interface KeepDraft {
  /** Called on every keystroke. Sends at most one request per `settleMs`. */
  readonly keep: (content: DraftContent) => void;
  /** Sends whatever is pending now, for a reader who is about to leave. */
  readonly flush: () => void;
  readonly discard: (definitionId?: string) => void;
  readonly saving: boolean;
  readonly savedAt?: string;
  readonly error?: string;
  /**
   * The server's reading of what was last kept.
   *
   * What is unfinished, where to resume, and whether the assessment being revised has moved under
   * the draft all come from here rather than from a second copy of those rules in the browser. It
   * therefore describes what is *saved* rather than what is on screen, which is the honest thing for
   * a contents strip to describe and is why the panel says when it was last kept.
   */
  readonly kept?: SetupDraft;
}

/** Long enough that a sentence is one request rather than forty, short enough to feel immediate. */
export const SETTLE_MS = 600;

/**
 * Keeping an assessment as it is written.
 *
 * Debounced rather than saved on every change, and sequenced rather than fire-and-forget. Both
 * matter for the same reason: the response carries what is still unfinished, so two requests whose
 * answers arrive out of order would leave the wizard showing the older reading of a newer draft.
 * Each send takes a ticket and a late answer to a superseded ticket is dropped.
 */
export function useKeepDraft(settleMs: number = SETTLE_MS): KeepDraft {
  const [state, setState] = useState<{ saving: boolean; savedAt?: string; error?: string; kept?: SetupDraft }>({
    saving: false,
  });

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<DraftContent | undefined>(undefined);
  const ticket = useRef(0);

  const send = useCallback((content: DraftContent) => {
    const mine = ++ticket.current;
    setState((was) => ({ ...was, saving: true }));
    void fetch('/api/definitions/drafts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(content),
    })
      .then(async (response) => {
        if (mine !== ticket.current) return;
        if (!response.ok) {
          const { message } = await readError(response);
          setState((was) => ({ ...was, saving: false, error: message }));
          return;
        }
        const kept = (await response.json()) as SetupDraft;
        setState({ saving: false, savedAt: kept.savedAt, kept });
      })
      .catch((cause: unknown) => {
        if (mine !== ticket.current) return;
        setState((was) => ({
          ...was,
          saving: false,
          error: cause instanceof Error ? cause.message : 'What you have written could not be saved.',
        }));
      });
  }, []);

  const flush = useCallback(() => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = undefined;
    const content = pending.current;
    pending.current = undefined;
    if (content != null) send(content);
  }, [send]);

  const keep = useCallback(
    (content: DraftContent) => {
      pending.current = content;
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, settleMs);
    },
    [flush, settleMs]
  );

  // Whatever is pending goes on the way out. Without this, typing a name and immediately clicking
  // away loses it — which is the exact failure the whole draft exists to prevent, arriving in the
  // one moment the reader is most likely to be interrupted.
  useEffect(() => flush, [flush]);

  const discard = useCallback((definitionId?: string) => {
    // The ticket is burned so a save still in flight cannot land after the delete and recreate what
    // the reader just threw away.
    ticket.current += 1;
    pending.current = undefined;
    const query = definitionId == null ? '' : `?for=${encodeURIComponent(definitionId)}`;
    void fetch(`/api/definitions/drafts${query}`, { method: 'DELETE' }).catch(() => undefined);
    setState({ saving: false });
  }, []);

  return { keep, flush, discard, ...state };
}

export interface DraftScopeRequest {
  readonly kind: 'account' | 'selected';
  readonly workspaceIds?: readonly string[];
}

/**
 * What a scope would cover, before it is saved.
 *
 * A POST for a read, because the ids of five hundred selected workspaces in a query string is past
 * what some proxies in front of this app will forward — so a preview built on a GET would work for
 * small estates and fail for exactly the large ones that need it.
 *
 * Debounced on the same reasoning as the draft: a reader ticking through a list of workspaces would
 * otherwise ask the server what each intermediate selection covers.
 */
export function useScopePreview(scope: DraftScopeRequest, settleMs: number = SETTLE_MS): Loadable<ScopePreview> {
  const [state, setState] = useState<{ data?: ScopePreview; error?: string; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  // Serialised so the effect depends on the value rather than on the identity of the object, which
  // a caller building it inline changes on every render.
  const asked = JSON.stringify(scope);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setState((was) => ({ ...was, loading: true }));
      void fetch('/api/definitions/scope', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"scope":${asked}}`,
      })
        .then(async (response) => {
          if (!live) return;
          if (!response.ok) {
            const { message } = await readError(response);
            setState({ loading: false, error: message });
            return;
          }
          setState({ loading: false, data: (await response.json()) as ScopePreview });
        })
        .catch((cause: unknown) => {
          if (!live) return;
          setState({
            loading: false,
            error: cause instanceof Error ? cause.message : 'What this scope covers could not be worked out.',
          });
        });
    }, settleMs);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asked, settleMs, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, reload };
}

export interface DefinitionDraft {
  readonly measurement: DefinitionMeasurement;
  readonly attribution: DefinitionAttribution;
  /** What the assessment commits to reaching, which is versioned but not part of the fingerprint. */
  readonly targets?: readonly PillarTargetPayload<string>[];
  /**
   * The version this change was made from, on a revision.
   *
   * Absent creates a new assessment; present revises one. Sent rather than inferred because it is
   * the concurrency control: the server refuses a change made against a version somebody else has
   * already replaced, which is what stops one author's edit disappearing out of an audit record.
   */
  readonly fromVersion?: number;
  readonly note?: string;
}

export interface SaveDefinition {
  readonly save: (id: string | undefined, draft: DefinitionDraft) => void;
  readonly archive: (id: string) => void;
  readonly unarchive: (id: string) => void;
  readonly saving: boolean;
  /** A sentence to show the reader. Set when the server refused. */
  readonly error?: string;
  /**
   * The version now current, when the refusal was that somebody got there first.
   *
   * Carried separately from the message so the page can offer to re-read rather than only apologise:
   * a stale edit is the one failure here the reader can resolve, and it needs a different button
   * from the ones they cannot.
   */
  readonly staleAt?: number;
}

/**
 * Creating, revising, archiving and reopening an assessment.
 *
 * One hook for the four because they share a failure the page has to handle identically: the
 * caller may not be permitted, and the answer is a sentence rather than a status. Revising has the
 * extra one — somebody else got there first — which arrives as `staleAt`.
 */
export function useSaveDefinition(onSaved?: () => void): SaveDefinition {
  const [state, setState] = useState<{ saving: boolean; error?: string; staleAt?: number }>({ saving: false });

  const send = useCallback(
    (path: string, body: unknown) => {
      setState({ saving: true });
      void fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (response) => {
          if (!response.ok) {
            // Cloned before the body is read, not after: `readError` consumes it, and a clone taken
            // from a used response throws rather than returning the document again.
            const spare = response.status === 409 ? response.clone() : undefined;
            const { message } = await readError(response);
            // 409 is the one refusal with a next step in it, and the current version is what the
            // page needs in order to offer that step.
            const stale = spare == null ? undefined : await currentVersionFrom(spare);
            setState({ saving: false, error: message, ...(stale != null && { staleAt: stale }) });
            return;
          }
          setState({ saving: false });
          onSaved?.();
        })
        .catch((cause: unknown) => {
          setState({
            saving: false,
            error: cause instanceof Error ? cause.message : 'The assessment could not be saved.',
          });
        });
    },
    [onSaved]
  );

  return {
    save: (id, draft) => {
      const { path, body } = definitionRequest(id, draft);
      send(path, body);
    },
    archive: (id) => send(`/api/definitions/${encodeURIComponent(id)}/archive`, {}),
    unarchive: (id) => send(`/api/definitions/${encodeURIComponent(id)}/unarchive`, {}),
    saving: state.saving,
    ...(state.error != null && { error: state.error }),
    ...(state.staleAt != null && { staleAt: state.staleAt }),
  };
}

/**
 * Where a definition is written and what is sent, as a value so the rule can be tested.
 *
 * The whole draft either way, minus the two fields that only mean something on a revision.
 *
 * A create used to *name* the fields it sends — `measurement` and `attribution` — which silently
 * dropped every field added to a definition afterwards. Targets left the wizard, appeared on the
 * confirmation, and were absent from the version that got written, with nothing refused and nothing
 * logged: the author had made a commitment the app agreed to and then did not record. Naming what a
 * create *omits* fails the safe way round, because a field added to a definition is sent by default
 * and only a field that must not be sent has to be written down here.
 *
 * `fromVersion` and `note` are both about revising something. On a create there is no version this
 * was made from and no change to describe, and the route refuses neither — so sending them would put
 * a note about a change on the first version of an assessment.
 */
export function definitionRequest(
  id: string | undefined,
  draft: DefinitionDraft
): { readonly path: string; readonly body: unknown } {
  if (id != null) return { path: `/api/definitions/${encodeURIComponent(id)}/versions`, body: draft };

  const { fromVersion: _fromVersion, note: _note, ...rest } = draft;
  return { path: '/api/definitions', body: rest };
}

/**
 * The version a stale-edit refusal says is current.
 *
 * Undefined when the refusal did not carry one, which is the case for the store's own conflict: it
 * happened too late to know what landed, so the page offers a re-read rather than naming a version.
 */
async function currentVersionFrom(response: Response): Promise<number | undefined> {
  try {
    const body = (await response.json()) as { currentVersion?: unknown };
    return typeof body.currentVersion === 'number' ? body.currentVersion : undefined;
  } catch {
    return undefined;
  }
}

export interface CheckDefinition {
  readonly check: (id: string) => void;
  readonly checking: boolean;
  /** The last result, kept until another assessment is checked. */
  readonly result?: Preflight;
  /**
   * Which assessment the result or error belongs to.
   *
   * Set on both, so a page can attach either to the row it came from. Without it a refusal shows under
   * every assessment on the page, and a panel of grants shown under the wrong definition is worse
   * still: acting on it means asking for grants for a scope nobody checked.
   */
  readonly forDefinition?: string;
  readonly error?: string;
}

/**
 * Checking whether an assessment can run.
 *
 * Holds the result, unlike the save hook, because there is nothing to re-read: the answer exists only
 * in this response. Held with the id it came from, so a reader who checks one assessment and then
 * looks at another does not see the first one's grants presented as the second's.
 */
export function useCheckDefinition(): CheckDefinition {
  const [state, setState] = useState<{
    checking: boolean;
    result?: Preflight;
    forDefinition?: string;
    error?: string;
  }>({ checking: false });

  const check = useCallback((id: string) => {
    setState({ checking: true, forDefinition: id });
    void fetch(`/api/definitions/${encodeURIComponent(id)}/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then(async (response) => {
        if (!response.ok) {
          const { message } = await readError(response);
          setState({ checking: false, forDefinition: id, error: message });
          return;
        }
        setState({ checking: false, forDefinition: id, result: (await response.json()) as Preflight });
      })
      .catch((cause: unknown) => {
        setState({
          checking: false,
          forDefinition: id,
          error: cause instanceof Error ? cause.message : 'The assessment could not be checked.',
        });
      });
  }, []);

  return { check, ...state };
}

export interface AnswerDraft {
  readonly controlId: string;
  readonly answer: AttestedAnswer;
  readonly statement: string;
  readonly owner: string;
  readonly evidenceUrl?: string;
}

export interface SubmitAnswer {
  readonly submit: (draft: AnswerDraft) => void;
  readonly saving: boolean;
  /** A sentence naming the field to fix, straight from the server's own validation. */
  readonly error?: string;
  /** The control id last recorded, so the page can confirm against the row the reader used. */
  readonly saved?: string;
}

/**
 * Recording an answer.
 *
 * Deliberately does not hold the new attestation as state for the page to render. The page
 * re-reads the whole set on success instead, because an answer changes the requirement's state,
 * its review date and whether it counts — and a page that patched one field of one row from the
 * response would be maintaining a second, partial copy of what the server just decided.
 */
export function useSubmitAnswer(onSaved?: () => void): SubmitAnswer {
  const [state, setState] = useState<{ saving: boolean; error?: string; saved?: string }>({ saving: false });
  const path = useScopedPath('/api/attestations');

  const submit = useCallback(
    (draft: AnswerDraft) => {
      if (path == null) return;
      setState({ saving: true });
      void fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
        .then(async (response) => {
          if (!response.ok) {
            const { message } = await readError(response);
            setState({ saving: false, error: message });
            return;
          }
          setState({ saving: false, saved: draft.controlId });
          onSaved?.();
        })
        .catch((cause: unknown) => {
          setState({
            saving: false,
            error: cause instanceof Error ? cause.message : 'The answer could not be sent.',
          });
        });
    },
    [onSaved, path]
  );

  return { submit, ...state };
}

export interface AnswerInReview {
  readonly submit: (pillarId: string, draft: AnswerDraft) => void;
  readonly saving: boolean;
  readonly error?: string;
  /** The control id last recorded, so the page can confirm against the row the reader used. */
  readonly saved?: string;
}

/**
 * Recording an answer from inside a review, which is a different route from `useSubmitAnswer`.
 *
 * The two write the same attestation. What this one adds is the record joining it to this review
 * and this pillar, and that record is the whole of the `refreshed` count — an answer given through
 * `/api/attestations` while a review happens to be open is invisible to it, which is what row `60`
 * exists to fix and what the count's language rule says the number may not be read as.
 *
 * Hands the whole review back to the caller rather than the attestation, because the server has
 * just recomputed the review's answers and the page renders that list.
 */
export function useAnswerInReview(reviewId: string, onSaved?: (written: AssessmentReview) => void): AnswerInReview {
  const [state, setState] = useState<{ saving: boolean; error?: string; saved?: string }>({ saving: false });
  const definitionId = useAssessmentId();
  const base = useScopedPath(reviewId === '' ? null : `/api/reviews/${reviewId}/pillars`);

  // The guard `useRecordPillar` carries, for its reason: switching assessment changes definitionId
  // without changing the route, and a POST that lands afterwards would report onto the review of
  // the assessment left behind.
  const nonce = useRef(0);
  const [asked, setAsked] = useState(base);
  if (asked !== base) {
    setAsked(base);
    setState({ saving: false });
    // eslint-disable-next-line react-hooks/refs -- stale writes must not report onto the new path
    nonce.current += 1;
  }

  const submit = useCallback(
    (pillarId: string, draft: AnswerDraft) => {
      const at = reviewPillarWritePath(reviewId, pillarId, 'answers', definitionId);
      if (base == null || at == null) return;
      const started = nonce.current;
      setState({ saving: true });
      void fetch(at, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
        .then(async (response) => {
          if (nonce.current !== started) return;
          if (!response.ok) {
            const { message } = await readError(response);
            if (nonce.current !== started) return;
            setState({ saving: false, error: message });
            return;
          }
          const written = (await response.json()) as AssessmentReview;
          if (nonce.current !== started) return;
          setState({ saving: false, saved: draft.controlId });
          onSaved?.(written);
        })
        .catch((cause: unknown) => {
          if (nonce.current !== started) return;
          setState({
            saving: false,
            error: cause instanceof Error ? cause.message : 'The answer could not be sent.',
          });
        });
    },
    [base, definitionId, onSaved, reviewId]
  );

  return { submit, ...state };
}

/**
 * Fetched separately from the scan rather than folded into it, because the two are recorded
 * separately on purpose: a run is what was measured, a decision is what somebody chose to do about
 * it, and neither rewrites the other. Joining them in the payload would make a decision look like
 * part of the measurement, which is exactly the confusion the split exists to prevent.
 */
export function useDecisions(): Loadable<Decisions> {
  // No absent-is-fine code: the route answers with a durability flag and an empty list even when
  // nothing is bound to keep decisions in, so there is no 404 to forgive.
  return useGet<Decisions>(useScopedPath('/api/decisions'));
}

export interface DecisionDraft {
  readonly controlId: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly owner?: string;
  /** ISO date. Required for an acceptance or a deferral, refused for the other two. */
  readonly until?: string;
}

export interface RecordDecision {
  readonly submit: (draft: DecisionDraft) => void;
  readonly saving: boolean;
  /** A sentence naming what to fix, straight from the server's own validation. */
  readonly error?: string;
  /** The control id last decided, so the page can confirm against the row the reader used. */
  readonly saved?: string;
}

/**
 * Recording a decision.
 *
 * Like the answer form, it deliberately does not hold the new record for the page to render: a
 * decision changes the standing of the finding, and possibly of a decision it supersedes, and a
 * page that patched one row from the response would be keeping a second, partial copy of what the
 * server just worked out.
 */
export function useRecordDecision(onSaved?: () => void): RecordDecision {
  const [state, setState] = useState<{ saving: boolean; error?: string; saved?: string }>({ saving: false });
  const path = useScopedPath('/api/decisions');

  const submit = useCallback(
    (draft: DecisionDraft) => {
      if (path == null) return;
      setState({ saving: true });
      void fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
        .then(async (response) => {
          if (!response.ok) {
            const { message } = await readError(response);
            setState({ saving: false, error: message });
            return;
          }
          setState({ saving: false, saved: draft.controlId });
          onSaved?.();
        })
        .catch((cause: unknown) => {
          setState({
            saving: false,
            error: cause instanceof Error ? cause.message : 'The decision could not be sent.',
          });
        });
    },
    [onSaved, path]
  );

  return { submit, ...state };
}

/**
 * Every improvement plan with the rollup of its actions.
 *
 * Without the actions themselves, deliberately: the list page shows counts and the three lists that
 * call for attention, and a payload carrying every action of every plan would grow with the programme
 * rather than with the page.
 */
export function useImprovements(): Loadable<Improvements> {
  return useGet<Improvements>(useScopedPath('/api/improvements'));
}

/** One plan and every action in it, which is what the plan's own page reads. */
export function useImprovementPlan(planId: string | undefined): Loadable<ImprovementPlanDetail> {
  // `never` for an absent id rather than a conditional hook. The route answers 404 for it and the page
  // renders that as "no such plan", which is the same thing a mistyped id gets.
  return useGet<ImprovementPlanDetail>(useScopedPath(`/api/improvements/${planId ?? 'never'}`));
}

/**
 * What this plan can be sent as, and what each file should hash to.
 *
 * Fetched by the panel that shows it rather than by the plan's page, so an install where nobody sends
 * a plan never seals six files to answer a request nothing renders. The panel is revealed on demand,
 * which makes the two the same decision.
 */
export function usePlanExports(planId: string | undefined): Loadable<PlanExports> {
  return useGet<PlanExports>(useScopedPath(`/api/improvements/${planId ?? 'never'}/exports`));
}

/** The work already raised against one requirement, which is what a finding asks about. */
export function useActionsFor(controlId: string | undefined): Loadable<ActionsForControl> {
  return useGet<ActionsForControl>(useScopedPath(controlId == null ? null : `/api/improvements/for/${controlId}`));
}

/**
 * Every action currently raised, so a page that lists many requirements can ask once.
 *
 * The report is the caller. A findings pane that shows one control still uses `useActionsFor`.
 */
export function useRaisedActions(): Loadable<ActionsRaised> {
  return useGet<ActionsRaised>(useScopedPath(REPORT_COLLECTION_READS.raised));
}

export interface Sent<TBody> {
  /** Sends it. Resolves to the id the server minted, or undefined when it refused. */
  readonly send: (body: TBody) => Promise<string | undefined>;
  readonly saving: boolean;
  /** The server's own sentence about what to fix, shown as it was written. */
  readonly error?: string;
}

/**
 * One writer for all six plan mutations.
 *
 * The decision and answer forms each have a hook of their own, and repeating that five more times
 * here would be five copies of the same three states with five chances for one of them to forget the
 * server's message and substitute a generic one. Every one of these routes answers a refusal as a
 * sentence naming the field to fix — that is the whole design of the domain's validation — so the
 * shared version's one job is to not lose it.
 *
 * `reload` rather than a returned record. A move changes what the estate agrees with, what the plan's
 * rollup says, and possibly which moves are offered next; a page that patched one row from the
 * response would be keeping a second, partial copy of what the server just worked out.
 */
function useSend<TBody>(path: string, method: 'POST' | 'PUT', onSaved?: () => void): Sent<TBody> {
  const [state, setState] = useState<{ saving: boolean; error?: string }>({ saving: false });
  const scoped = useScopedPath(path);

  const send = useCallback(
    async (body: TBody): Promise<string | undefined> => {
      if (scoped == null) return undefined;
      setState({ saving: true });
      try {
        const response = await fetch(scoped, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const { message } = await readError(response);
          setState({ saving: false, error: message });
          return undefined;
        }
        const saved = (await response.json()) as { id?: string };
        setState({ saving: false });
        onSaved?.();
        return saved.id;
      } catch (cause) {
        setState({
          saving: false,
          error: cause instanceof Error ? cause.message : 'The change could not be sent.',
        });
        return undefined;
      }
    },
    [scoped, method, onSaved]
  );

  return { send, ...state };
}

export interface PlanDraft {
  readonly title: string;
  readonly outcome: string;
  readonly owners: readonly string[];
  readonly assessment?: { readonly definitionId: string; readonly version: number };
  readonly raisedFrom?: string;
}

export function useOpenPlan(onSaved?: () => void): Sent<PlanDraft> {
  return useSend<PlanDraft>('/api/improvements', 'POST', onSaved);
}

export function useClosePlan(planId: string, onSaved?: () => void): Sent<{ readonly reason: string }> {
  return useSend<{ readonly reason: string }>(`/api/improvements/${planId}/close`, 'POST', onSaved);
}

export interface ActionDraft {
  readonly controlIds: readonly string[];
  readonly outcome: string;
  readonly definitionOfDone: string;
  readonly owner: string;
  readonly priority: ActionPriority;
  readonly effort: ActionEffort;
  /** ISO date. Optional while an action is a draft, required before it can be planned. */
  readonly due?: string;
  readonly steps?: readonly string[];
  readonly dependsOn?: readonly string[];
  /** The run this was raised from, so the evidence behind it can still be found. */
  readonly raisedFrom?: string;
  /**
   * Which advisor finding this is being raised from, where it is being raised from one.
   *
   * Four ids and nothing the advisor said. The server reads the finding out of the stored advisory and
   * writes what the action keeps of it, so a page cannot post a headline of its own.
   */
  readonly advice?: AdviceReference;
}

export function useRaiseAction(planId: string, onSaved?: () => void): Sent<ActionDraft> {
  return useSend<ActionDraft>(`/api/improvements/${planId}/actions`, 'POST', onSaved);
}

/**
 * Correcting an action.
 *
 * A whole replacement rather than a patch, which is what the route takes: an absent `steps` would
 * otherwise have to mean either "unchanged" or "cleared", and both readings lose somebody's work
 * often enough to matter.
 */
export function useReviseAction(planId: string, actionId: string, onSaved?: () => void): Sent<ActionDraft> {
  return useSend<ActionDraft>(`/api/improvements/${planId}/actions/${actionId}`, 'PUT', onSaved);
}

export interface MoveRequest {
  readonly to: ActionState;
  /** Required for blocked and cancelled, refused as too short below the server's minimum. */
  readonly reason?: string;
}

export function useMoveAction(planId: string, actionId: string, onSaved?: () => void): Sent<MoveRequest> {
  return useSend<MoveRequest>(`/api/improvements/${planId}/actions/${actionId}/move`, 'POST', onSaved);
}

/**
 * Every attempt to validate the claim on one action, and whether another may be asked for.
 *
 * Under the action rather than in a validations collection, like the route: the question is never what
 * attempt 4f2c says, it is what has been tried on this claim.
 */
export function useValidations(planId: string | undefined, actionId: string | undefined): Loadable<Validations> {
  // `never` for either absent id rather than a conditional hook, like the plan detail above.
  return useGet<Validations>(
    useScopedPath(`/api/improvements/${planId ?? 'never'}/actions/${actionId ?? 'never'}/validations`)
  );
}

export interface ValidationRequest {
  /**
   * Days a run must wait before it may answer this. Omitted means the next run may.
   *
   * The only field a requester supplies. Which requirements are checked, how each is answered and the
   * date the claim was made all come from the action and the catalogue — see server/validate/attempt.ts.
   */
  readonly observeDays?: number;
}

export function useRequestValidation(planId: string, actionId: string, onSaved?: () => void): Sent<ValidationRequest> {
  return useSend<ValidationRequest>(`/api/improvements/${planId}/actions/${actionId}/validations`, 'POST', onSaved);
}

/**
 * Taking a claim back before anything answered it.
 *
 * The attempt id is required rather than "the outstanding one", so a withdrawal names what it closes:
 * a run may have answered it between the read and the click, and a request that meant "whichever is
 * waiting" would close whatever was waiting by then instead.
 */
export function useWithdrawValidation(
  planId: string,
  actionId: string,
  validationId: string | undefined,
  onSaved?: () => void
): Sent<{ readonly reason?: string }> {
  return useSend<{ readonly reason?: string }>(
    `/api/improvements/${planId}/actions/${actionId}/validations/${validationId ?? 'never'}/withdraw`,
    'POST',
    onSaved
  );
}

/**
 * Every acceptance this install has recorded, newest first.
 *
 * Every one, including the expired and the replaced, because the question the register answers is how
 * long each exposure has been carried rather than what is parked today. A list of the effective ones
 * would make a requirement accepted for the fourth quarter running look like a fresh decision.
 */
export function useRisks(): Loadable<Risks> {
  // No absent-is-fine code: the route answers with a durability flag and an empty list even where
  // nothing is bound to keep acceptances in, so there is no 404 to forgive.
  return useGet<Risks>(useScopedPath('/api/risks'));
}

/**
 * Every acceptance ever recorded against one requirement.
 *
 * Its own request rather than filtering the register, because the finding pane needs the chain for one
 * requirement and the register is unbounded: an install that has accepted things for three years would
 * have the pane fetching all of it to show two rows.
 */
export function useRisksFor(controlId: string | undefined): Loadable<Risks> {
  // `never` for an absent id rather than a conditional hook, like the plan detail above.
  return useGet<Risks>(useScopedPath(`/api/risks/${controlId ?? 'never'}`));
}

export interface RiskDraft {
  readonly controlId: string;
  /** Why the requirement is not being met, which is not the same sentence as the control below. */
  readonly reason: string;
  /** What is holding the line instead. The record cannot be written without it. */
  readonly compensatingControl: string;
  readonly residual: Severity;
  readonly owner: string;
  /** ISO. Now or later — an acceptance cannot cover a period nothing recorded. */
  readonly effectiveFrom: string;
  /** ISO. Capped by the requirement's own severity, and the form is told the cap. */
  readonly expiresAt: string;
}

/**
 * Accepting a requirement being unmet, for a while, on purpose.
 *
 * There is no edit and no extension by design — see ADR 0054 — so this is the only way an acceptance
 * comes into being, and a longer run is another one of these naming what it replaces. Which the
 * request does not say: what a new acceptance supersedes is read from the store, because a body that
 * could name it could point a renewal at somebody else's chain.
 */
export function useAcceptRisk(onSaved?: () => void): Sent<RiskDraft> {
  return useSend<RiskDraft>('/api/risks', 'POST', onSaved);
}

/**
 * Ending an acceptance before its expiry, with a reason.
 *
 * The id is required rather than "the one in force", so a revocation names what it closes: somebody
 * may have replaced it between the read and the click, and a request meaning "whichever is effective"
 * would end the replacement instead.
 */
export function useRevokeRisk(riskId: string | undefined, onSaved?: () => void): Sent<{ readonly reason: string }> {
  return useSend<{ readonly reason: string }>(`/api/risks/${riskId ?? 'never'}/revoke`, 'POST', onSaved);
}

/**
 * The thread about one thing.
 *
 * `observedIn` is on the write rather than the read: which run somebody was looking at when they wrote
 * a note is part of the note, and it would be wrong to let it change what an old thread says.
 */
export function useNotes(subject: NoteSubject | undefined): Loadable<NoteThread> {
  return useGet<NoteThread>(useScopedPath(subject == null ? null : `/api/notes/${subject.kind}/${subject.id}`));
}

/**
 * Every thread of one kind, so a page that lists many subjects can ask once.
 *
 * The report is the caller. A pane that shows one subject still uses `useNotes`.
 */
export function useNoteThreads(kind: NoteSubjectKind): Loadable<NoteThreads> {
  return useGet<NoteThreads>(useScopedPath(`/api/notes/threads/${kind}`));
}

/** How many notes each subject of one kind carries, for a list that shows which have been written on. */
export function useNoteCounts(kind: NoteSubjectKind): Loadable<NoteCounts> {
  return useGet<NoteCounts>(useScopedPath(`/api/notes/${kind}`));
}

export interface NoteDraft {
  readonly body: string;
  /** The note this one corrects. The corrected note stays and stays readable. */
  readonly corrects?: string;
}

/**
 * How ready the declared serving data is, read now.
 *
 * Not polled and not cached across pages, and both follow from what it is: three statements against
 * the customer's warehouse, run when somebody opens the page. A hook that re-asked on an interval
 * would spend a warehouse on a page nobody was looking at, and one that served a remembered answer
 * would put a date on the screen that the screen does not show.
 */
export function useFoundationReadiness(): Loadable<FoundationReadiness> {
  return useGet<FoundationReadiness>(useScopedPath('/api/foundation/readiness'));
}

export interface ServingDraft {
  readonly named: readonly { readonly catalog: string; readonly schema: string; readonly table: string }[];
  readonly tagged: readonly {
    readonly key: string;
    readonly values?: readonly string[];
    readonly at: readonly ('catalog' | 'schema' | 'table')[];
  }[];
  readonly requiredTagKeys: readonly string[];
  readonly requiredMetadata: readonly ('description' | 'owner')[];
  readonly policy: readonly {
    readonly classification: string;
    readonly requires: readonly ('column-mask' | 'row-filter' | 'abac-policy')[];
  }[];
}

/**
 * Appends the next serving declaration in this assessment.
 *
 * The server owns the version and attribution. A client cannot choose either, which keeps two editors
 * from replacing each other and keeps the declaration attached to the identity that made it.
 */
export function useDeclareServing(onSaved?: () => void): Sent<ServingDraft> {
  return useSend<ServingDraft>('/api/foundation/serving', 'POST', onSaved);
}

/**
 * The seven drawn relations, read now.
 *
 * Not scoped to an assessment: the statements run as the signed-in user against the bound
 * warehouse, the same way 101e answers. `topology-unavailable` is the missing warehouse, not
 * an empty estate.
 */
export function useTopology(): Loadable<TopologyPayload> {
  return useGet<TopologyPayload>('/api/topology', ['topology-unavailable']);
}

/**
 * Writing a note, or correcting one, which is the same request.
 *
 * The run being read goes in the query string because it is context about where the writer was rather
 * than something they typed — see the route. A note about a run does not carry one: the subject is the
 * run.
 */
export function useWriteNote(subject: NoteSubject, observedIn?: string, onSaved?: () => void): Sent<NoteDraft> {
  const where = subject.kind === 'run' || observedIn == null ? '' : `?observedIn=${encodeURIComponent(observedIn)}`;
  return useSend<NoteDraft>(`/api/notes/${subject.kind}/${subject.id}${where}`, 'POST', onSaved);
}

/**
 * What a run was asked to be.
 *
 * A union rather than three optional fields, because the route refuses an assessment named
 * alongside an override rather than merging them: an assessment already says which pillars and how
 * far back, so a run that sent both would be recorded as having asked a question it did not ask.
 * Expressing that here means a caller cannot assemble a body the server will reject — the mistake
 * is a compile error rather than a 400 nobody sees until they click.
 */
export type ScanRequest = AnsweringAssessment | Unstamped;

interface AnsweringAssessment {
  /**
   * The assessment this run answers to, which decides its scope, window and pillars.
   *
   * The server has read this since A2 and the client had no way to send it, so every run started
   * from the interface was the implicit assessment ADR 0037 was written to remove: scope was
   * whatever the calling identity could see, and the run was stamped with nothing. An author could
   * define an assessment, agree its scope with whoever owns the estate, and then have no way to run
   * it.
   */
  readonly definitionId: string;
  readonly lookbackDays?: never;
  readonly pillars?: never;
  readonly workspaces?: never;
}

interface Unstamped {
  /**
   * Explicit null starts an ad-hoc run even while the product is viewing a saved assessment.
   * Undefined keeps that assessment as context, which is what a targeted pillar rerun needs.
   */
  readonly definitionId?: null;
  readonly lookbackDays?: number;
  /**
   * Measure only these pillars. Omitted means everything the build assesses.
   *
   * The pillars left out are carried forward from the previous scan by the server, so a
   * targeted run still returns a whole assessment. See server/scan/carry-forward.ts.
   */
  readonly pillars?: readonly string[];
  /** Selected workspace ids. Omitted means the account visible to the scanning identity. */
  readonly workspaces?: readonly string[];
}

/**
 * The body a run is started with.
 *
 * Exported and pure so the contract can be tested, because the defect it exists to prevent was
 * invisible to both halves of the suite. The server's tests post a `definitionId` and prove the route
 * honours it; the client's prove the button starts a run. Neither asked whether the field the server
 * reads is one the client sends, and for a whole release it was not — so the assessment apparatus
 * worked, was unreachable from the interface, and nothing failed.
 *
 * Fields are omitted rather than sent as null. The route reads `!= null` on each and refuses an
 * assessment named alongside an override, so an explicit null would be a body that names both.
 */
export function scanBody(request: ScanRequest): Record<string, unknown> {
  return {
    ...(request.definitionId != null && { definitionId: request.definitionId }),
    ...(request.lookbackDays != null && { lookbackDays: request.lookbackDays }),
    ...(request.pillars != null && { pillars: request.pillars }),
    ...(request.workspaces != null && { workspaces: request.workspaces }),
  };
}

/** Which saved assessment, if any, the scan route should resolve around the body. */
export function scanPath(request: ScanRequest, selectedDefinitionId: string | null | undefined): string | undefined {
  return (
    withAssessment('/api/scan', request.definitionId !== undefined ? null : (selectedDefinitionId ?? null)) ?? undefined
  );
}

export interface RunScan {
  readonly run: (request?: ScanRequest) => void;
  readonly running: boolean;
  readonly error?: string;
  readonly scan?: Scan;
  /** The pillars the run in flight is measuring, so the UI can scope its running state. */
  readonly runningPillars?: readonly string[];
}

/** How often to ask about a run in flight. Often enough that the count of calls moves visibly. */
const RUNNING_POLL_MS = 3000;

/**
 * How often to ask when nothing is running.
 *
 * Slower, because all this is watching for is a run starting somewhere else — the schedule, or
 * another admin — and the cost of hearing about it fifteen seconds late is nothing.
 */
const IDLE_POLL_MS = 15000;

/**
 * Starting a scan.
 *
 * The request is held open for the scan's whole duration, which is the honest shape for
 * now: the runner completes in one call and there is nothing to poll. When scans become
 * checkpointed and resumable this becomes a start-and-poll pair, and the page will not
 * have to change because it already treats `running` as a state rather than a spinner
 * around an await.
 *
 * A refused start is not a failed scan. The scan lock answers 409 when one is already
 * running, and the honest response to that is to wait for it, not to show an error: the
 * result the reader asked for is on its way, produced by a scan they may well have
 * started themselves. Observed live, from one click: the platform delivered the POST
 * twice, the first started a scan, the second was refused, and the refusal is what the
 * caller saw — an error message for a scan that went on to succeed.
 */
export function useRunScan(onComplete?: (scan: Scan) => void): RunScan {
  const definitionId = useAssessmentId();
  const [state, setState] = useState<{
    running: boolean;
    error?: string;
    scan?: Scan;
    runningPillars?: readonly string[];
  }>({ running: false });

  const run = useCallback(
    (request: ScanRequest = {}) => {
      // Query, not body: a targeted rerun sends pillars and cannot also send definitionId in the
      // body — the route refuses both, because the stamp would describe a question the run did not
      // ask. The query is which assessment the reader is in, so carry-forward reads that assessment's
      // latest scan rather than the unscoped one.
      // A defined request value (a saved id in the body, or null for custom scope) deliberately
      // leaves the selected assessment out of the query. Undefined is the targeted-rerun case: its
      // pillars are in the body and its saved workspace scope remains in the query.
      const path = scanPath(request, definitionId);
      if (path == null) return;
      setState({ running: true, ...(request.pillars != null && { runningPillars: request.pillars }) });
      void fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(scanBody(request)),
      })
        .then(async (response) => {
          if (response.status === 409) {
            // Not an error, and nothing to wait for here: a run is already happening, the follower
            // is watching it and will report its result, and this state is only about the request
            // this tab made. Observed live — one click produced two POSTs, the lock refused the
            // second, and the refusal is what the reader saw for a run that went on to succeed.
            setState({ running: false });
            return;
          }
          if (!response.ok) {
            const { message } = await readError(response);
            setState({ running: false, error: message });
            return;
          }
          const scan = (await response.json()) as Scan;
          setState({ running: false, scan });
          onComplete?.(scan);
        })
        .catch((cause: unknown) => {
          setState({
            running: false,
            error: cause instanceof Error ? cause.message : 'The scan request could not be sent.',
          });
        });
    },
    [onComplete, definitionId]
  );

  return { run, ...state };
}

export interface WatchTiming {
  /** How often to ask while a run is in flight. */
  readonly whileRunningMs?: number;
  /** How often to ask while nothing is, which is how a run this reader did not start is noticed. */
  readonly whileIdleMs?: number;
}

export interface RunWatchHandlers {
  readonly onStatus: (status: ScanStatus) => void;
  /** Called once per run, with the result, when a run that was in flight stops being. */
  readonly onFinished: (scan: Scan) => void;
  /** Called instead of `onFinished` when the run ended and its result could not be read. */
  readonly onLost?: (message: string) => void;
}

export interface RunFollower {
  readonly stop: () => void;
  /**
   * Ask now rather than on the next tick.
   *
   * For when something outside the follower already knows the answer changed — a run this tab
   * started returning, which otherwise leaves the band claiming the estate is being measured for up
   * to one interval after the result of measuring it is on screen.
   */
  readonly now: () => void;
}

/**
 * Follow whatever run is happening, for as long as the reader is here.
 *
 * Polling rather than a one-shot wait, and always rather than only after this reader pressed the
 * button, because who started a run is not the same question as whether one is happening. A
 * scheduled run, a second admin's run, and this reader's own run seen after a page reload were
 * all invisible while the only signal was the state of one click, and the app went on presenting
 * the previous assessment as the current one throughout. See ADR 0055.
 *
 * Status is polled rather than the result, because a run in progress has no result to read and
 * asking for one returns the previous run — the worst available answer, since it looks current.
 *
 * Exported, and its timing injectable, so the following can be tested without a React renderer
 * or a real wait.
 */
export function followRun(
  handlers: RunWatchHandlers,
  timing: WatchTiming = {},
  definitionId: string | null = null
): RunFollower {
  const whileRunning = timing.whileRunningMs ?? RUNNING_POLL_MS;
  const whileIdle = timing.whileIdleMs ?? IDLE_POLL_MS;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  /*
   * Whether a request is out, so that only one chain of them exists.
   *
   * Without this, anything that asks immediately — returning to the tab, or a run this tab started
   * finishing — starts a second chain whenever it lands while a request is in flight: the timer it
   * clears has already fired, so clearing it does nothing, and both chains then schedule their own
   * successor. The rate doubles per occurrence and never comes back down, so a reader who switches
   * tabs a few times ends up polling several times a second for as long as the page is open.
   */
  let asking = false;
  /*
   * Whether something asked while a request was out.
   *
   * Not dropped, because the answer in flight was asked for before whatever prompted the second ask
   * and can be older than the thing it is being asked about: a run this tab started finishing while a
   * poll is out would otherwise be answered by that poll saying the run is still going, and the band
   * would stay up until the next tick. Not run concurrently either, for the doubling above. So it is
   * remembered and asked once the current answer has landed.
   */
  let again = false;

  /*
   * Whether anybody is looking at this.
   *
   * A reader with this open in a background tab overnight is the ordinary case, and polling through
   * it would be thousands of requests nobody reads. Defined defensively for `document` because these
   * hooks are unit-tested outside a DOM, where a missing global would read as a permanently hidden
   * tab and every one of those tests would hang waiting for a call that never came.
   */
  const visible = (): boolean => typeof document === 'undefined' || !document.hidden;

  const ask = async (): Promise<void> => {
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    try {
      await answer();
    } finally {
      asking = false;
    }
    if (again && !stopped) {
      again = false;
      if (timer != null) clearTimeout(timer);
      void ask();
    }
  };

  const answer = async (): Promise<void> => {
    /*
     * A hidden tab asks nothing, and keeps its timer so that it recovers on its own.
     *
     * Checked here rather than only on the event, because the event only tells this that the tab
     * became hidden — the timer set before that fires anyway, and its successor after it, so a tab
     * left open overnight would spend the night asking about a run nobody is watching for. Keeping
     * the timer rather than dropping it means becoming visible again is not the only thing that can
     * restart this: a browser that coalesces or drops the visibility event still gets answered.
     */
    if (!visible()) {
      timer = setTimeout(() => void ask(), whileIdle);
      return;
    }

    const status = await getJson<ScanStatus>('/api/scan/status');
    if (stopped) return;

    // A status call that fails is not a run that ended. Keeping the previous belief means a
    // restarting server does not read as a finished run, which would send this to fetch a result
    // that is not there yet and show the reader the previous assessment as the new one.
    if (status.data != null) {
      handlers.onStatus(status.data);
      if (running && !status.data.running) await collect();
      running = status.data.running;
    }

    if (!stopped) timer = setTimeout(() => void ask(), running ? whileRunning : whileIdle);
  };

  const collect = async (): Promise<void> => {
    const path = withAssessment('/api/scans/latest', definitionId);
    if (path == null) return;
    const latest = await getJson<Scan>(path);
    if (stopped) return;
    if (latest.data != null) {
      handlers.onFinished(latest.data);
      return;
    }
    handlers.onLost?.(
      latest.error ?? 'The run has finished, but its record could not be read. Reload the page to pick it up.'
    );
  };

  /*
   * Coming back to the tab asks straight away rather than waiting for the next tick.
   *
   * Without it, a returning reader is shown whatever was true up to fifteen seconds ago, and the
   * first thing a returning reader does is believe what is on the screen.
   */
  const now = (): void => {
    if (stopped || !visible()) return;
    if (timer != null) clearTimeout(timer);
    void ask();
  };

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', now);

  void ask();

  return {
    stop: () => {
      stopped = true;
      if (timer != null) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', now);
    },
    now,
  };
}

export interface RunInFlight extends ScanStatus {
  /** Ask the server now, for a caller that has its own reason to think this is stale. */
  readonly check: () => void;
}

/**
 * What is happening right now, and what came of it.
 *
 * The provider holds one of these for the whole app, so every page can say a run is in flight —
 * including the pages of a reader who did not start it.
 */
export function useRunInFlight(onFinished: (scan: Scan) => void, onLost?: (message: string) => void): RunInFlight {
  const [status, setStatus] = useState<ScanStatus>({ running: false });
  const follower = useRef<RunFollower | undefined>(undefined);
  const definitionId = useAssessmentId();

  /*
   * Held in a ref so a caller passing a fresh function each render does not restart the polling on
   * every render. The alternative is asking every call site to memoise, which is a rule that gets
   * followed until it doesn't and then quietly polls in a loop.
   *
   * Kept up to date in an effect rather than during render, and it is safe to be one render behind:
   * the only reader is an async callback from the follower, which cannot run before the effects of
   * the render that scheduled it.
   */
  const finished = useRef(onFinished);
  const lost = useRef(onLost);
  useEffect(() => {
    finished.current = onFinished;
    lost.current = onLost;
  }, [onFinished, onLost]);

  useEffect(() => {
    if (definitionId === undefined) return;
    const following = followRun(
      {
        onStatus: setStatus,
        onFinished: (scan) => finished.current(scan),
        onLost: (message) => lost.current?.(message),
      },
      {},
      definitionId
    );
    follower.current = following;
    return following.stop;
  }, [definitionId]);

  // Stable across renders, so a caller may depend on it without restarting anything.
  const check = useCallback(() => follower.current?.now(), []);

  return { ...status, check };
}

/** The published months, and the wall-clock month a preview can open on. */
export function useMonths(): Loadable<Months> {
  return useGet<Months>(useScopedPath('/api/months'));
}

/** One month's publications in order, including when none have been published yet. */
export function useMonthStanding(month: string | undefined): Loadable<MonthStanding> {
  return useGet<MonthStanding>(useScopedPath(month != null ? `/api/months/${month}` : null));
}

/** The live reading of a month, before or after anybody has published it. */
export function useMonthPreview(month: string | undefined): Loadable<MonthPreview> {
  return useGet<MonthPreview>(useScopedPath(month != null ? `/api/months/${month}/preview` : null));
}

/** One frozen publication, parsed from the stored JSON bytes. */
export function useMonthDocument(month: string | undefined, id: string | undefined): Loadable<MonthDocument> {
  return useGet<MonthDocument>(
    useScopedPath(month != null && id != null ? `/api/months/${month}/publications/${id}.json` : null)
  );
}

export interface PublishMonth {
  readonly publish: () => void;
  readonly working: boolean;
  readonly error?: string;
}

/**
 * The first publication of a month.
 *
 * Reloads rather than holding the result, because standing and the frozen bytes are what the page
 * renders after, and keeping a copy here would be a second source for the same record.
 */
export function usePublishMonth(month: string, onPublished?: (id?: string) => void): PublishMonth {
  const [state, setState] = useState<{ working: boolean; error?: string }>({ working: false });
  const path = useScopedPath(`/api/months/${month}/publish`);

  const publish = useCallback(() => {
    if (path == null) return;
    setState({ working: true });
    void fetch(path, { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) {
          const { message } = await readError(response);
          setState({ working: false, error: message });
          return;
        }
        const saved = (await response.json()) as { id?: string };
        setState({ working: false });
        onPublished?.(saved.id);
      })
      .catch((cause: unknown) => {
        setState({
          working: false,
          error: cause instanceof Error ? cause.message : 'The request could not be sent.',
        });
      });
  }, [path, onPublished]);

  return { publish, ...state };
}

/** A correction to a published month: names what it supersedes and why. */
export function useSupersedeMonth(
  month: string,
  onSaved?: () => void
): Sent<{ readonly supersedes: string; readonly reason: string }> {
  return useSend<{ readonly supersedes: string; readonly reason: string }>(
    `/api/months/${month}/supersede`,
    'POST',
    onSaved
  );
}
