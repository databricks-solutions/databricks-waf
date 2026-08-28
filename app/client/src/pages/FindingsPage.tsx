// Every requirement, as a list you can work through.
//
// Two changes from the page this replaces, and both are about being usable at 148 rows. The list is
// paginated and each row is one line, so the reader can compare rows and find the one they want
// instead of scrolling past forty expanded cards; and the selected requirement opens in a pane beside
// the list rather than in place, so choosing one does not push everything else off the screen.
//
// The filters and the selection live in the URL. That was not cosmetic: an investigation worth having
// is worth sending to somebody, and "the critical security failures" was previously a state of mind
// in one browser tab. Now it is a link.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import { X } from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import { useDecisions, usePlan, useResultChanges } from '../api/hooks';
import { classOf, type ChangeClass } from '../components/change-language';
import { AcceptRiskPanel } from '../components/AcceptRiskPanel';
import { DecidePanel } from '../components/DecidePanel';
import { StandingBadge } from '../components/DecisionNote';
import { FindingDetail } from '../components/FindingDetail';
import { CustomerPage, RecordButton, RecordList, Surface, TaskWorkspace } from '../components/system';
import { outcomeLabel, SEVERITY_LABEL } from '../components/verdict-language';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { NotInList } from '../components/ui/NotInList';
import { onlySelection, selectionFrom, usePaged } from '../components/ui/paging';
import { useRevealedPane } from '../components/ui/reveal';
import { AttestedBadge, OutcomeBadge, SeverityBadge } from '../components/ui/StatusBadge';
import type { Outcome, PlannedSignal, Severity } from '../api/types';

const OUTCOMES: readonly Outcome[] = [
  'fail',
  'partial',
  'unmeasurable',
  'pass',
  'satisfied-by-architecture',
  'not-applicable',
];

const ALL = 'all';
const PAGE_SIZE = 10;

/**
 * Failed or partly met, as one selectable outcome.
 *
 * Not a real outcome — it is the union of two, and it exists because every number that links here
 * counts that union. "Unmet" is what the overview's risk list is a list of, what a pillar's
 * unmet-by-severity bars count, and what the framework language calls a gap. Without it, a bar
 * reading "2 high" could only link to `outcome=fail`, which silently drops the partly met one, so the
 * page would open showing one row under a heading the reader clicked expecting two.
 */
const UNMET = 'unmet';

/**
 * Met, as one selectable outcome, for the same reason `unmet` exists.
 *
 * Every "Met" figure in the app is `pass + satisfied-by-architecture`, because a requirement the
 * architecture satisfies is met — it is simply met for a reason no check re-establishes each run.
 * Coverage bars and pillar segments print that sum, so a link from one could either name a union
 * or drop half of it: the pillar segment carried a comment explaining that it was the one segment
 * that could not be followed, which is a design note standing in for a missing filter.
 */
const MET = 'met';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];

const CHANGE_LABEL: Readonly<Record<ChangeClass, string>> = {
  new: 'New since the previous report',
  regressed: 'Regressed since the previous report',
  resolved: 'Resolved since the previous report',
  changed: 'Changed since the previous report',
};

/**
 * The three ways a check bears on a requirement, as the checks page links them.
 *
 * Named the same in both places, and the wording readers see comes from here so the chip on this page
 * says what the link they followed said. `serves()` in checks-language builds those links.
 */
const ROLES: Readonly<Record<string, ((signal: PlannedSignal) => readonly string[]) | undefined>> = {
  decides: (signal) => signal.answers,
  scopes: (signal) => signal.gates,
  details: (signal) => signal.enriches,
};

const ROLE_PHRASE: Readonly<Record<string, string>> = {
  decides: 'Decided by',
  scopes: 'Scoped by',
  details: 'Detailed by',
};

/** Unmet first, then by severity: the order somebody working through the list would choose. */
const OUTCOME_RANK: Readonly<Record<Outcome, number>> = {
  fail: 0,
  partial: 1,
  unmeasurable: 2,
  pass: 3,
  'satisfied-by-architecture': 4,
  'not-applicable': 5,
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

/** One place the two unions are defined, so a filter and the count beside it cannot drift apart. */
function matchesOutcome(actual: Outcome, filter: string): boolean {
  if (filter === ALL) return true;
  if (filter === UNMET) return actual === 'fail' || actual === 'partial';
  if (filter === MET) return actual === 'pass' || actual === 'satisfied-by-architecture';
  return actual === filter;
}

export function FindingsPage() {
  const { alsoAsking, scan, result, catalogue, controlOf, pillarTitle } = useAssessment();
  const [params, setParams] = useSearchParams();
  const askedChange = params.get('changed');
  const change: ChangeClass | undefined =
    askedChange === 'new' || askedChange === 'changed' || askedChange === 'resolved' || askedChange === 'regressed'
      ? askedChange
      : undefined;
  const changes = useResultChanges(change == null ? '' : (result?.id ?? ''));
  const changedControls = useMemo(
    () =>
      change == null
        ? undefined
        : new Set(
            (changes.data?.changes ?? []).filter((entry) => classOf(entry) === change).map((entry) => entry.controlId)
          ),
    [change, changes.data?.changes]
  );
  const decisions = useDecisions();
  // For the check filter only, and only fetched because a link from the checks page can land here.
  const plan = usePlan();
  const byControl = useMemo(
    () => new Map((decisions.data?.decisions ?? []).map((decision) => [decision.controlId, decision])),
    [decisions.data?.decisions]
  );

  const outcome = params.get('outcome') ?? ALL;
  const pillar = params.get('pillar') ?? ALL;
  const severity = params.get('severity') ?? ALL;
  const principle = params.get('principle');
  const check = params.get('check');
  const role = params.get('role');
  const query = params.get('q') ?? '';
  const selectedId = params.get('control');

  // Replace rather than push for filter changes: a reader who typed five characters into the search
  // box should not have to press Back five times to leave the page.
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    // A selection that the new filter excludes would leave the pane showing something not in the
    // list, which reads as a bug.
    if (key !== 'control') next.delete('control');
    setParams(next, { replace: true });
  };

  const pillars = useMemo(
    () => [...new Set((scan?.findings ?? []).map((finding) => finding.pillarId))].sort(),
    [scan?.findings]
  );

  /*
   * Which requirements a named principle holds, and what it is called.
   *
   * A principle is not a field on a finding — it is the catalogue's subdivision of a pillar — so this
   * filter has to be resolved through the catalogue rather than compared against the row. An id the
   * catalogue does not hold resolves to an empty set rather than to no filter at all: a stale link
   * showing every requirement in the estate would look like it worked.
   */
  const named = useMemo(() => {
    if (principle == null || principle === '') return undefined;
    for (const entry of catalogue?.pillars ?? []) {
      const found = entry.principles.find((candidate) => candidate.id === principle);
      if (found != null) {
        return { title: found.title, controls: new Set(found.controls.map((control) => control.id)) };
      }
    }
    return { title: principle, controls: new Set<string>() };
  }, [catalogue, principle]);

  /*
   * Which requirements a named check has a hand in, and in which of the three ways.
   *
   * Arrived at from the checks page, where "decides 6" is now a link. The relationship is a fact
   * about the plan rather than about a finding — a check that failed to answer leaves no evidence
   * naming itself, and filtering on evidence would show four of the six it decides and call that the
   * six. So it is resolved through the plan, which states the set whatever the run did with it.
   *
   * Unknown ids and unknown roles both resolve to an empty set, on the same reasoning as the
   * principle filter above: a stale link that quietly showed all 184 rows would look like it worked.
   */
  const decided = useMemo(() => {
    if (check == null || check === '') return undefined;
    const wanted = ROLES[role ?? 'decides'];
    for (const entry of plan.data?.pillars ?? []) {
      const signal = entry.signals.find((candidate) => candidate.id === check);
      if (signal != null) {
        return { controls: new Set(wanted == null ? [] : wanted(signal)), pending: false };
      }
    }
    // A deep link can land here before the plan has been fetched, and an empty list for a moment is
    // the honest version: the alternative reads as "this check decides everything".
    return { controls: new Set<string>(), pending: plan.data == null };
  }, [plan.data, check, role]);

  const findings = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (scan?.findings ?? [])
      .filter((finding) => matchesOutcome(finding.outcome, outcome))
      .filter((finding) => pillar === ALL || finding.pillarId === pillar)
      .filter((finding) => severity === ALL || finding.severity === severity)
      .filter((finding) => named == null || named.controls.has(finding.controlId))
      .filter((finding) => decided == null || decided.controls.has(finding.controlId))
      .filter((finding) => changedControls == null || changedControls.has(finding.controlId))
      .filter(
        (finding) =>
          needle === '' ||
          finding.title.toLowerCase().includes(needle) ||
          finding.controlId.toLowerCase().includes(needle)
      )
      .sort(
        (a, b) =>
          OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome] ||
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          a.controlId.localeCompare(b.controlId)
      );
  }, [scan?.findings, outcome, pillar, severity, named, decided, changedControls, query]);

  /*
   * How many distinct requirements the filtered rows are.
   *
   * Counted over the whole filtered set rather than the page, because it reconciles this list with the
   * counts elsewhere in the app and those are counts of the set. A row whose requirement no other
   * shown row shares counts as itself, which is all but a dozen of them.
   */
  const distinct = useMemo(
    () => new Set(findings.map((finding) => controlOf(finding.controlId)?.aliasGroup ?? finding.controlId)).size,
    [findings, controlOf]
  );

  // Paged around the selection, so a link into a particular requirement lands on the page that holds
  // it. The overview's priority list and evidence gaps both link here by control id, and any of them
  // past the tenth row used to open a highlighted pane beside a list of ten other requirements.
  const selectedAt = findings.findIndex((finding) => finding.controlId === selectedId);
  const paged = usePaged(findings, PAGE_SIZE, selectedAt);
  // And a link naming a requirement these filters exclude says so, rather than showing a different
  // one. This pane offers a decision to record against whatever it displays. See selectionFrom.
  const { row: selected, missing } = selectionFrom({
    all: findings,
    page: paged.rows,
    asked: selectedId,
    at: selectedAt,
    known: (scan?.findings ?? []).some((finding) => finding.controlId === selectedId),
  });
  const pane = useRevealedPane(selectedId);

  if (scan == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Findings unavailable">
          <EmptyState
            layout="compact"
            reason="not-yet-collected"
            heading="No findings to display"
            detail="No assessment findings are available for the selected run. The Dashboard shows whether collection or review needs attention."
            action={
              <Link className="wa-button-secondary" to="/overview">
                Open Dashboard
              </Link>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <CustomerPage>
      <TaskWorkspace
        queueLabel="Requirements"
        taskLabel="Selected requirement"
        queue={
          <Surface
            tone="section"
            title="Every requirement assessed"
            description={
              <>
                {paged.total === scan.findings.length
                  ? `${String(scan.findings.length)} in this scan`
                  : `${String(paged.total)} of ${String(scan.findings.length)} shown`}
                {distinct < paged.total && ` · scored as ${String(distinct)}`}
              </>
            }
          >
            {/* Titled, as the answers page's list is. Two pages built to the same master-detail shape
              where only one names its list read as two different designs. */}
            {/* A search landmark rather than a bare row of inputs, so the filters can be reached
              directly instead of by tabbing through however many rows precede them. */}
            <search className="mb-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {/* The design system's own field rather than AppKit's input. The two disagree on
                  height by 4px, which is enough to make a filter row look subtly out of true. */}
                <input
                  className="wa-field wa-body-compact w-full"
                  placeholder="Search title or id"
                  aria-label="Search findings by title or control id"
                  value={query}
                  onChange={(event) => set('q', event.target.value)}
                />
                <Select value={outcome} onValueChange={(value) => set('outcome', value)}>
                  <SelectTrigger className="wa-select w-full" aria-label="Filter by outcome">
                    <SelectValue placeholder="Any outcome" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Any outcome</SelectItem>
                    {/* Above the six real ones, because it is the filter this page is most often
                      arrived at with and the one a reader working a queue wants. */}
                    <SelectItem value={UNMET}>
                      Unmet — not or partly met ({scan.score.counts.fail + scan.score.counts.partial})
                    </SelectItem>
                    {/* And its opposite, because coverage bars and pillar segments both print this
                      sum and both now link here. A reader who followed "Met — 41" needs to see the
                      filter that produced 41 rows named in the control, not infer it. */}
                    <SelectItem value={MET}>
                      Met — passed or met by architecture (
                      {scan.score.counts.pass + scan.score.counts['satisfied-by-architecture']})
                    </SelectItem>
                    {OUTCOMES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {outcomeLabel(value)} ({scan.score.counts[value]})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={pillar} onValueChange={(value) => set('pillar', value)}>
                  <SelectTrigger className="wa-select w-full" aria-label="Filter by pillar">
                    <SelectValue placeholder="Any pillar" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Any pillar</SelectItem>
                    {pillars.map((value) => (
                      <SelectItem key={value} value={value}>
                        {pillarTitle(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Severity is a filter because it is a destination: a pillar's unmet-by-severity bars
                  link straight here, and a reader who arrives that way needs to see which severity
                  is applied and be able to widen it without editing the address bar. */}
                <Select value={severity} onValueChange={(value) => set('severity', value)}>
                  <SelectTrigger className="wa-select w-full" aria-label="Filter by severity">
                    <SelectValue placeholder="Any severity" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Any severity</SelectItem>
                    {SEVERITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {SEVERITY_LABEL[value]} ({scan.findings.filter((finding) => finding.severity === value).length})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/*
              The principle filter, shown only when one is applied.
              A chip rather than a fifth select: there are dozens of principles across the seven
              pillars and nobody picks one from a list, but arriving from a pillar's met-rate row with
              an invisible filter applied is worse — the list would be short for a reason stated
              nowhere on the page, and the count beside the heading would look wrong.
            */}
              {named != null && (
                <p className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="wa-caption">Principle</span>
                  <button
                    type="button"
                    className="wa-chip wa-chip-neutral hover:text-wa-text"
                    onClick={() => set('principle', ALL)}
                  >
                    {named.title}
                    <X aria-hidden className="h-3 w-3" />
                    <span className="sr-only">Remove the principle filter</span>
                  </button>
                </p>
              )}

              {/* The same, for a check. Shown for the same reason: a reader who followed "decides 6"
                from the checks page is looking at six of 184 rows, and the filter that did that has
                to be visible and removable here. */}
              {check != null && check !== '' && (
                <p className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="wa-caption">{ROLE_PHRASE[role ?? 'decides'] ?? 'Read by'}</span>
                  <button
                    type="button"
                    className="wa-chip wa-chip-neutral hover:text-wa-text"
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.delete('check');
                      next.delete('role');
                      setParams(next, { replace: true });
                    }}
                  >
                    <span className="wa-code">{check}</span>
                    <X aria-hidden className="h-3 w-3" />
                    <span className="sr-only">Remove the check filter</span>
                  </button>
                </p>
              )}

              {/* A differential-strip link applies this filter in the URL. Keep it visible and
                removable here: otherwise the list looks unexpectedly short and the reader has to
                understand a query parameter to return to the complete final assessment. */}
              {change != null && (
                <p className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="wa-caption">Movement</span>
                  <button
                    type="button"
                    className="wa-chip wa-chip-neutral hover:text-wa-text"
                    onClick={() => set('changed', ALL)}
                  >
                    {CHANGE_LABEL[change]}
                    <X aria-hidden className="h-3 w-3" />
                    <span className="sr-only">Remove the movement filter</span>
                  </button>
                </p>
              )}
            </search>

            {paged.total === 0 ? (
              <EmptyState
                reason={decided?.pending === true ? 'not-yet-collected' : 'filtered-out'}
                // A deep link into a check's requirements has a moment where the plan naming them has
                // not arrived, and "these filters exclude everything" would be the wrong account of it.
                detail={
                  decided?.pending === true
                    ? 'Reading which requirements this check decides.'
                    : 'These filters exclude every requirement in the scan. Widening the outcome or clearing the search will bring results back.'
                }
                action={
                  <button
                    type="button"
                    className="wa-customer-secondary-action"
                    onClick={() => setParams({}, { replace: true })}
                  >
                    Clear filters
                  </button>
                }
              />
            ) : (
              <>
                {/* Banded, on the same rule as the tables: ten two-line rows read across five facts,
                  and a 1px divider does not hold the eye on one record for the width of the pane. */}
                <RecordList label="Assessed requirements">
                  {paged.rows.map((finding) => {
                    const decision = byControl.get(finding.controlId);
                    const chosen = finding.controlId === selected?.controlId;
                    return (
                      <RecordButton
                        key={finding.controlId}
                        selected={chosen}
                        onSelect={() => set('control', finding.controlId)}
                        eyebrow={
                          <span className="flex flex-wrap items-center gap-1.5">
                            <SeverityBadge severity={finding.severity} />
                            {/* The basis travels with the verdict. A reader scanning ten rows of
                              outcomes must not have to open each one to learn which were measured. */}
                            {finding.attested?.bearing === 'outcome' && <AttestedBadge />}
                            {/* So does the decision. This list is where somebody checks whether a
                              failure is being handled, and a row that looks identical to an
                              unattended one is the row they chase twice. */}
                            {decision != null && <StandingBadge standing={decision.standing} />}
                            <OutcomeBadge outcome={finding.outcome} />
                          </span>
                        }
                        title={finding.title}
                        summary={pillarTitle(finding.pillarId)}
                        meta={
                          <>
                            {finding.controlId}
                            {alsoAsking(finding.controlId).length > 0 &&
                              ` · one reading with ${alsoAsking(finding.controlId)
                                .map((one) => one.controlId)
                                .join(', ')}`}
                          </>
                        }
                        aside={chosen ? 'Selected' : 'Open'}
                      />
                    );
                  })}
                </RecordList>
                <Pagination paged={paged} noun="requirements" />
              </>
            )}
          </Surface>
        }

        task={
          <div ref={pane}>
            {missing != null ? (
              <Surface tone="task" label="Selected requirement unavailable">
                <NotInList
                  id={missing.id}
                  known={missing.known}
                  noun="requirement"
                  onClear={(keep) => setParams(onlySelection('control', keep ? missing.id : null), { replace: true })}
                />
              </Surface>
            ) : selected == null ? (
              <Surface
                tone="task"
                title="Select a requirement"
                description="Action, affected resources, evidence, and verification."
              >
                <EmptyState
                  reason="not-yet-collected"
                  heading="Nothing selected"
                  detail="Choose a requirement from the list to see what was observed, what was expected, and what to do about it."
                />
              </Surface>
            ) : (
              <>
                <FindingDetail
                  key={selected.controlId}
                  finding={selected}
                  decision={byControl.get(selected.controlId)}
                />
                {/* Offered only where there is something to decide. A requirement that passed, or that
                  the scan could not read, has no decision to take — and a form under a passing
                  result would invite somebody to accept a risk the estate does not have. */}
                {(selected.outcome === 'fail' || selected.outcome === 'partial') && (
                  <>
                    <DecidePanel
                      key={`decide-${selected.controlId}`}
                      finding={selected}
                      decision={byControl.get(selected.controlId)}
                      parkDays={decisions.data?.parkDays}
                      ephemeral={decisions.data != null && !decisions.data.durable}
                      durabilityNote={decisions.data?.durabilityNote}
                      onRecorded={decisions.reload}
                    />
                    {/* Under the decision rather than beside it, because the two are asked in that
                      order: a reader decides what they are doing about a finding, and only somebody
                      who has landed on "nothing, for now" is being asked what holds the line while
                      that is true. Offered whatever the decision says, since an acceptance recorded
                      here is the record that carries the expiry — the decision's date does not. */}
                    <AcceptRiskPanel key={`accept-${selected.controlId}`} finding={selected} />
                  </>
                )}
              </>
            )}
          </div>
        }
      />
    </CustomerPage>
  );
}
