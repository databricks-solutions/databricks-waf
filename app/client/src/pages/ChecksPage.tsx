// What a scan does, before it does it.
//
// Every other page describes the estate. This one describes the app: for each pillar, the statements
// and calls a run executes, what each reads, and what the reader must be able to see for it to answer.
// It exists because "score 55.2" is not reviewable without it — an administrator asked to authorise a
// scan is entitled to know what will run against their warehouse first, and a reader looking at an
// unanswered requirement is entitled to know whether that is a missing grant or a missing feature.
//
// It used to render all seven pillars and all twenty signals on one scroll, which is the page nobody
// reads to the end of. One pillar at a time now, chosen from a list that is itself the summary, with
// the collection surfaces behind a disclosure because they are read once and then known.
//
// Everything here comes from GET /api/plan, derived on the server from the shipped SQL and the resolver
// registry. Nothing is written twice: the tables each statement reads are read out of the statement.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAttestations, useEvidenceImports, useEvidenceScript, usePlan } from '../api/hooks';
import { AdminScript } from '../components/AdminScript';
import { EvidenceImport } from '../components/EvidenceImport';
import { RerunPillar } from '../components/RerunPillar';
import { CustomerPage, Surface, TaskWorkspace } from '../components/system';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState, type EmptyReason } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { usePaged } from '../components/ui/paging';
import { useRevealedPane } from '../components/ui/reveal';
import { IdentifierBadge } from '../components/ui/StatusBadge';
import {
  answerCall,
  costPhrase,
  costSentence,
  coverageSentence,
  reachPhrase,
  REQUIREMENT_LABEL,
  serves,
} from './checks-language';
import type { CollectionSurface, PlannedSignal, Requirement } from '../api/types';

export function ChecksPage() {
  const plan = usePlan();
  // Fetched here rather than inside the panel, and unconditionally, because hooks cannot be called
  // under an `if`. It is a few hundred bytes of static metadata, so paying for it on every visit to
  // this page costs less than the two components it would take to defer it.
  const script = useEvidenceScript();
  // Fetched here for the same reason and on the same terms. The list is what the import surface shows
  // and what it re-reads after an accepted upload, so the page owns the request and passes the reload
  // down — one place holds the state of what this app has been given.
  const imports = useEvidenceImports();
  // Fetched for the count beside the pillar, which is the size of this list rather than anything the
  // plan knows. Unconditional for the same reason as the two above, and it is the request the page
  // this links to makes on arrival.
  const answers = useAttestations();
  const [params, setParams] = useSearchParams();

  const pillars = plan.data?.pillars ?? [];
  // Preferring a measured pillar as the default: landing on one with no checks makes the page look
  // broken, when in fact it is describing an absence correctly.
  const selectedId = params.get('pillar') ?? pillars.find((pillar) => pillar.measured)?.pillarId;
  const selected = pillars.find((pillar) => pillar.pillarId === selectedId) ?? pillars[0];

  const signals = useMemo(
    () =>
      [...(selected?.signals ?? [])].sort((a, b) => b.answers.length - a.answers.length || a.id.localeCompare(b.id)),
    [selected?.signals]
  );
  // Eight keeps the collection-method list bounded while leaving the selected check readable.
  const paged = usePaged(signals, 8);
  // Keyed on the query string rather than on `selectedId`, which falls back to the first measured
  // pillar: keyed on the fallback, arriving at `/checks` on a phone would scroll past the pillar list
  // to a pillar nobody chose. Measured at 390x844 without it — tapping a pillar left the checks pane
  // showing 71px of itself and moved the page not at all, so the tap marked a row and answered below
  // the fold. The bypass link reaches the same pane, and a finger does not use it.
  const pane = useRevealedPane(params.get('pillar'));
  if (plan.error != null) {
    return (
      <PageEmpty
        reason="collector-failed"
        heading="Could not load what a scan runs"
        detail={`The plan is derived from the shipped queries and the check registry, so this failing means the app could not describe itself: ${plan.error}`}
      />
    );
  }

  if (plan.data == null || selected == null) {
    return (
      <PageEmpty
        reason="not-yet-collected"
        heading="Loading"
        detail="Reading the statements and calls a scan would execute."
      />
    );
  }

  const call = answerCall(answers.data?.requirements ?? [], selected.pillarId);

  return (
    // No page intro: the selected pillar's own summary line says what its checks read and decide,
    // and a second sentence saying the same thing generically cost a row of the list.
    <CustomerPage>
      {/* The pillar queue and selected checks form one workspace; disclosures expand in normal flow
          without changing which task the reader is working on. */}
      <TaskWorkspace
        queueLabel="Pillars and collection method"
        taskLabel={`${selected.title} checks`}
        queue={
          <div className="space-y-3">
            <Surface tone="raised" title="Choose a pillar" description="decided / total" label="Pillars">
              <ul className="wa-zebra">
                {plan.data.pillars.map((pillar) => (
                  <li key={pillar.pillarId}>
                    <button
                      type="button"
                      className="wa-row w-full text-left"
                      data-selected={pillar.pillarId === selected.pillarId ? true : undefined}
                      onClick={() => setParams({ pillar: pillar.pillarId }, { replace: true })}
                    >
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                        <span className="wa-body-compact truncate font-medium text-wa-text">{pillar.title}</span>
                        <span className="wa-caption">
                          {pillar.measured
                            ? `${pillar.signals.length} ${pillar.signals.length === 1 ? 'check' : 'checks'}`
                            : 'No checks yet'}
                        </span>
                      </span>
                      <span className="wa-numeric wa-caption shrink-0">
                        {pillar.answeredControls - pillar.blockedControls} / {pillar.totalControls}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Surface>

            {/* Read once, then known, and it belongs beside the pillar list rather than in a
                full-width plane of its own below the fold: it explains the whole method, not the
                selected pillar. */}
            {/* Scrolls within itself, which is the rule the shell states for prose and the reason this
              page was 875px over a 1512x845 window: open, the disclosure is 1117px of surfaces and
              identities in a column with about 700px to give it. */}
            <Surface
              tone="inset"
              title="How collection works"
              description={`${String(plan.data.surfaces.length)} surfaces`}
            >
              <div>
                <Disclosure summary="Where the evidence comes from, and which identity reads it">
                  <ul className="space-y-3">
                    {plan.data.surfaces.map((surface) => (
                      <SurfaceItem key={surface.surface} surface={surface} />
                    ))}
                  </ul>
                </Disclosure>
              </div>
            </Surface>
          </div>
        }

        task={
          <div ref={pane}>
            <Surface
              tone="task"
              label={`${selected.title} checks`}
              title={selected.title}
              action={
                <Link to={`/pillars/${selected.pillarId}`} className="wa-caption wa-aside-link hover:underline">
                  View findings →
                </Link>
              }
            >
              <div className="space-y-2">
                <p className="wa-body-compact text-wa-text-secondary">{coverageSentence(selected)}</p>
                {/* Offered here as well as on the pillar's own page, because this is where what a run
                  will execute and require is actually stated. Deciding to run it anywhere else is
                  deciding without that. The footprint sentence belongs to the control rather than
                  being printed above it too — it was appearing twice, verbatim, three lines apart. */}
                {selected.measured ? (
                  <RerunPillar pillarId={selected.pillarId} />
                ) : (
                  <p className="wa-caption">{costSentence(selected.cost)}</p>
                )}
                {/* The sentence above has said for some time that N requirements are statements only
                  the reader can answer. Until now it said that and stopped, which is a page telling
                  somebody about work with no way to do it.

                  The number is the answers page's own count of what it will show for this pillar.
                  It was the plan's, over two of the buckets a person answers and not the third, and
                  the two surfaces disagreed by a factor of two. See answerCall. */}
                {call != null && (
                  <p className="wa-caption">
                    <Link className="text-wa-action hover:underline" to={`/answers?pillar=${selected.pillarId}`}>
                      {call.label} →
                    </Link>
                  </p>
                )}
              </div>

              {paged.total === 0 ? (
                <EmptyState
                  reason="not-yet-collected"
                  heading="No checks run for this pillar"
                  detail="Every requirement here is answered by a person or has no check built yet, so a run for this pillar would execute nothing."
                  action={
                    <Link className="wa-button-secondary" to={`/answers?pillar=${selected.pillarId}`}>
                      Answer them instead
                    </Link>
                  }
                />
              ) : (
                <>
                  <ul className="wa-zebra">
                    {paged.rows.map((signal) => (
                      <SignalRow key={signal.id} signal={signal} />
                    ))}
                  </ul>
                  <Pagination paged={paged} noun="checks" />
                </>
              )}

              {selected.requires.length > 0 && (
                <div className="space-y-1.5 border-t border-wa-divider p-3">
                  <Disclosure summary={`What you need to be able to see for all ${String(signals.length)} to answer`}>
                    <RequirementList requirements={selected.requires} />
                    {/* Inside the disclosure, because it is the answer to what the list above says is
                    impossible. A reader who has opened "what you need to be able to see" and found
                    "not grantable to any install" is exactly the reader this is for. */}
                    {selected.requires.some((requirement) => requirement.grantable === false) && (
                      <div className="mt-2 border-t border-wa-divider pt-2">
                        <AdminScript script={script.data} waiting={selected.unanswered.unreachable} />
                        <div className="mt-2 border-t border-wa-divider pt-2">
                          <EvidenceImport imports={imports.data} onImported={imports.reload} />
                        </div>
                      </div>
                    )}
                  </Disclosure>
                </div>
              )}
            </Surface>
          </div>
        }
      />
    </CustomerPage>
  );
}

function SurfaceItem({ surface }: { surface: CollectionSurface }) {
  return (
    <li className="space-y-1">
      <span className="flex items-baseline gap-2">
        <span className="font-medium text-wa-text">{surface.title}</span>
        <IdentifierBadge>{surface.surface}</IdentifierBadge>
      </span>
      <p className="wa-body-compact text-wa-text-secondary">{surface.how}</p>
      <p className="wa-caption">Runs as {surface.identity}.</p>
      {surface.requires.length > 0 && <RequirementList requirements={surface.requires} />}
    </li>
  );
}

function SignalRow({ signal }: { signal: PlannedSignal }) {
  const parts = serves(signal);

  return (
    <li className="wa-row flex-col items-start gap-1 py-2">
      <span className="flex flex-wrap items-baseline gap-2">
        <IdentifierBadge>{signal.id}</IdentifierBadge>
        <span className="wa-caption">{reachPhrase(signal.reach)}</span>
        {/* Each count opens the requirements it counted. See serves(). */}
        <span className="wa-caption">
          {parts.map((part, index) => (
            <span key={part.label}>
              {index > 0 ? ', ' : ''}
              {part.role == null ? (
                part.label
              ) : (
                <Link
                  className="text-wa-action hover:underline"
                  to={`/findings?check=${encodeURIComponent(signal.id)}&role=${part.role}`}
                >
                  {part.label}
                </Link>
              )}
            </span>
          ))}
        </span>
      </span>
      <span className="wa-body-compact text-wa-text">{signal.observes}</span>
      {/* Footprint and grant on one line. The grants are stated in full in the pillar's aggregate
          disclosure below; repeated per row with their explanatory notes they were two-thirds of
          every row's height, the same three sentences over and over, and they pushed the list of
          checks itself off the screen. */}
      <span className="wa-caption">
        {costPhrase(signal)} against {signal.touches.length === 0 ? 'no declared resource' : ''}
        {signal.touches.map((resource, index) => (
          <span key={resource}>
            {index > 0 ? ', ' : ''}
            <span className="wa-code">{resource}</span>
          </span>
        ))}
        {signal.requires.length > 0 && ` · needs ${signal.requires.map((requirement) => requirement.what).join(', ')}`}
      </span>
    </li>
  );
}

/**
 * Requirements as prose, grouped by whether they can ever be held.
 *
 * A scope no install of this app can hold is a different fact from a grant the reader might ask for,
 * and rendering the two identically has been the most confusing thing about the unanswered outcomes:
 * one is a support request, the other is an attestation. ADR 0016.
 */
function RequirementList({ requirements }: { requirements: readonly Requirement[] }) {
  return (
    <ul className="space-y-0.5">
      {requirements.map((requirement) => (
        <li key={`${requirement.kind}:${requirement.what}`} className="wa-caption">
          <span className="text-wa-text-secondary">{REQUIREMENT_LABEL[requirement.kind]}:</span>{' '}
          <span className="wa-code">{requirement.what}</span>
          {requirement.grantable === false && ' — not grantable to any install of this app'}
          {requirement.note != null && <span className="text-wa-text-muted"> {requirement.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function PageEmpty({ reason, heading, detail }: { reason: EmptyReason; heading: string; detail: string }) {
  return (
    <CustomerPage>
      <Surface tone="task">
        <EmptyState reason={reason} heading={heading} detail={detail} />
      </Surface>
    </CustomerPage>
  );
}
