// The brief's bottom strip: what moved since the run before this one, on every page.
//
// It is in the shell rather than on a page because the fact it carries is true of the assessment and
// not of wherever the reader is standing — the same reasoning that puts the run-in-flight banner in
// the header. Before this, "since the last run" was a paragraph on the overview and a table on the
// run record, so a reader on Findings had no way to know that four of the requirements in front of
// them had moved that morning.
//
// # What it may say
//
// Four of the brief's six filters, and the two it leaves out are left out rather than shown empty.
// **Exception changed** has no field behind it: nothing in `RunChangesPayload` records an exception
// being raised, varied or withdrawn between two runs, and a filter reading `0` would say that none
// were, which the app did not read. **Evidence gap changed** is the nearer miss — a transition into
// `unmeasurable` looks like one — but the payload carries the outcome and not the reason, so it
// cannot tell a requirement nobody supplied evidence for from one the app could not read. Both are
// [`32i`](../../../../../docs/plan/build-plan.md)'s or a later row's, and an absent filter is a
// question the reader knows to ask elsewhere where an empty one is an answer.
//
// # What `unobserved` does to it
//
// A pillar carried forward was not measured, so no change in it could be observed, and four zeros
// over an unmeasured half of the estate read as four zeros over the estate. So the carried-forward
// sentence is not a footnote here: whenever `unobserved` is non-empty the strip says so beside the
// counts, in the same breath rather than in a tooltip.
//
// # What it may not say
//
// It reports the counts and names the run they are against. It does not say the estate improved,
// that a carried-forward pillar held, or that anything is likely to change next run — the
// discipline in `pages/schedule-language.ts`, which is where the reasoning is written down.

import { Link, useLocation, useMatch } from 'react-router';
import { useAssessment } from '../../api/assessment-context';
import { useResult, useResultChanges, useRunChanges } from '../../api/hooks';
import { countChanges, type ChangeClass } from '../change-language';
import type { RunChanges } from '../../api/types';
import { isCustomerPreview } from './nav';

/** The four the payload can answer, in the brief's order. */
const FILTERS: readonly { readonly id: ChangeClass; readonly label: string; readonly meaning: string }[] = [
  {
    id: 'new',
    label: 'new',
    meaning: 'Requirements with no outcome in the previous run, so nothing to compare against.',
  },
  { id: 'changed', label: 'changed', meaning: 'Requirements whose outcome moved in some other direction.' },
  { id: 'resolved', label: 'resolved', meaning: 'Requirements that were unmet in the previous run and are not now.' },
  { id: 'regressed', label: 'regressed', meaning: 'Requirements that were met in the previous run and are not now.' },
];

export function DifferentialStrip() {
  const { pathname } = useLocation();
  const { scan, result } = useAssessment();
  // The run the reader is looking at, where a route names one, and the current assessment's run
  // otherwise. Two diffs on one screen — the page's and the shell's — is the reader having to work
  // out which of them the strip is about, and the answer being "not this one" most of the time.
  const record = useMatch('/history/:scanId');
  const report = useMatch('/report/:resultId');
  const reportResult = useResult(report?.params.resultId ?? '');
  const scanId = record?.params.scanId ?? reportResult.data?.runId ?? scan?.id;
  const resultId = report?.params.resultId ?? result?.id;
  const runChanges = useRunChanges(record?.params.scanId ?? '');
  const resultChanges = useResultChanges(record == null ? (resultId ?? '') : '');
  const changes = record != null ? runChanges : resultChanges;

  if (isCustomerPreview(pathname) || scanId == null) return null;

  return (
    <footer className="wa-differential-strip" aria-label="Since the previous run">
      <strong className="wa-caption text-wa-text">Since previous run</strong>
      {changes.loading ? (
        <span className="wa-caption">Comparing</span>
      ) : changes.data == null || !changes.data.comparable ? (
        <Refused changes={changes.data} />
      ) : (
        <Counts changes={changes.data} scanId={scanId} rawRun={record != null} />
      )}
    </footer>
  );
}

/**
 * The refusal, in the server's own words where it gave one.
 *
 * Not "no changes": two runs the app declined to compare have an unknown difference, and a strip
 * that goes quiet on the refusal is a strip that reads as nothing having moved.
 */
function Refused({ changes }: { changes?: RunChanges }) {
  return (
    <span className="wa-caption">{changes?.reason ?? 'This run has not been compared against the one before it.'}</span>
  );
}

function Counts({ changes, scanId, rawRun }: { changes: RunChanges; scanId: string; rawRun: boolean }) {
  const counted = countChanges(changes.changes);

  return (
    <>
      {FILTERS.map((filter) => {
        const total = counted[filter.id];
        const label = (
          <>
            <b className="wa-numeric text-wa-text">{total}</b> {filter.label}
          </>
        );
        // A count of zero is a fact and stays on screen, so the strip does not change shape between
        // runs — but it is not a link, because there is nothing at the other end of it.
        return total === 0 ? (
          <span key={filter.id} className="wa-caption whitespace-nowrap" title={filter.meaning}>
            {label}
          </span>
        ) : (
          <Link
            key={filter.id}
            to={rawRun ? `/history/${scanId}?view=changes&changed=${filter.id}` : `/investigate?changed=${filter.id}`}
            className="wa-caption whitespace-nowrap hover:text-wa-text hover:underline"
            title={filter.meaning}
          >
            {label}
          </Link>
        );
      })}

      {changes.unobserved.length > 0 && (
        <span className="wa-caption whitespace-nowrap">
          · {changes.unobserved.length === 1 ? 'one pillar was' : `${String(changes.unobserved.length)} pillars were`}{' '}
          carried forward rather than measured, so the counts are over the rest
        </span>
      )}

      {changes.previous != null && (
        <span className="wa-caption ml-auto whitespace-nowrap">
          against the run of {new Date(changes.previous.finishedAt).toLocaleString()}
        </span>
      )}
    </>
  );
}
