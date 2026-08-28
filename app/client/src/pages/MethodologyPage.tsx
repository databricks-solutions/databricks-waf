// What the app measures against, and the exact identities behind it.
//
// Every new score is stamped with two identities: the public methodology version and manifest that name
// the customer standard, and the catalogue revision and fingerprint that identify its exact technical
// scoring shape. Until this page existed, only the second pair was visible — two opaque strings on a run
// record and a repository a customer would have to clone to find out what "version 9" held. GAP-019 in
// the 2026-08-02 audit records that absence. A git history is not a customer methodology surface.
//
// So the page answers three questions, and they are the reason for its three regions.
//
// **What am I measured against?** The one public Version 1 candidate or release and its requirement
// list. The list is the recorded scoring shape rather than the loaded catalogue — the technical
// fingerprint covers the record by construction. It is not the whole catalogue: prose, remediation and
// references stay on the pillars and findings pages, where a reader acts on them.
//
// **How is it counted?** The weights, served open. Severity is on every requirement row, but `high` is
// not a number, and a reader cannot get from a list of severities to a score without the table that
// says what each is worth and what each outcome earns against it. Not folded away, because on a
// reference page this is the reference — and the rail has the room for it.
//
// **Which exact implementation produced it?** The release disclosure carries the manifest, catalogue
// revision, catalogue fingerprint and scoring digest. Development revisions remain available in a
// folded technical-history panel for support, never as customer releases or a release selector.
//
// # What is deliberately not here
//
// Nothing on this page is editable. That is ADR 0059 and not an omission: a customer who could change a
// severity or a threshold could produce a score that is not comparable with anybody else's, and a
// framework assessment whose framework is per-customer measures nothing. What a customer may say about
// a requirement — that it does not apply to their estate — is a separate record with an owner and an
// expiry, and it is deliberately not an edit to this.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAssessment } from '../api/assessment-context';
import { useMethodology } from '../api/hooks';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { usePaged } from '../components/ui/paging';
import { CustomerPage, PageLead, Surface, TaskWorkspace } from '../components/system';
import { IdentifierBadge, SeverityBadge } from '../components/ui/StatusBadge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import {
  creditSentence,
  fieldsPhrase,
  shapeSentence,
  standingSentence,
  revisionSentence,
  weightPhrase,
} from './methodology-language';
import type { CatalogueRevision, Methodology, MethodologyRequirement, Severity } from '../api/types';

const ALL = 'all';

export function MethodologyPage() {
  const { catalogue, scan } = useAssessment();
  const methodology = useMethodology();
  const [params, setParams] = useSearchParams();

  const query = params.get('q') ?? '';
  const pillar = params.get('pillar') ?? ALL;
  const data = methodology.data;
  // Memoised only to keep a stable identity for the filters below. `?? []` mints a new array on every
  // render, which is enough to re-run every `useMemo` that depends on it.
  const all = useMemo(() => data?.requirements ?? [], [data?.requirements]);

  // Pillar codes to the titles this build's catalogue gives them. The record holds a code, because a
  // code is what the fingerprint covers and a title is not; a reader needs the title. Mapped here
  // rather than served translated, because a translation on the wire would be the server adding a
  // field the record does not hold.
  const pillarOf = useMemo(() => {
    const index = new Map<string, string>();
    for (const one of catalogue?.pillars ?? []) index.set(one.code, one.title);
    return (code: string) => index.get(code) ?? code;
  }, [catalogue?.pillars]);

  const codes = useMemo(() => [...new Set(all.map((one) => one.pillar))].sort(), [all]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter(
      (one) =>
        (pillar === ALL || one.pillar === pillar) &&
        (needle === '' || one.id.toLowerCase().includes(needle) || one.title.toLowerCase().includes(needle))
    );
  }, [all, pillar, query]);

  const paged = usePaged(shown, 8);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  if (methodology.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Methodology unavailable">
          <EmptyState
            reason="collector-failed"
            heading="Could not load the methodology"
            detail={`This describes the app rather than your estate, so a failure here means the app could not read its own version record: ${methodology.error}`}
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (data == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Loading methodology">
          <EmptyState
            reason="not-yet-collected"
            heading="Loading"
            detail="Reading Methodology Version 1 and the technical provenance behind it."
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <CustomerPage>
      <PageLead
        eyebrow="Utility"
        headingLevel={2}
        title="Methodology Version 1"
        summary="The released customer standard, scoring method, and exact requirements used by this build."
      />
      <TaskWorkspace
        queueLabel="Methodology identity and scoring"
        taskLabel="Requirements in Methodology Version 1"
        queue={
          <div className="flex min-w-0 flex-col gap-4">
            <CurrentVersion methodology={data} scan={scan} />
            <ScoringMethod methodology={data} />
            <TechnicalHistory revisions={data.technical.revisions} />
          </div>
        }
        task={
          <Surface
            tone="task"
            label="Requirements"
            title="What is measured"
            action={
              <span className="wa-caption">
                {shown.length === all.length
                  ? `${String(all.length)} requirements`
                  : `${String(shown.length)} of ${String(all.length)}`}
              </span>
            }
          >
            {/* The drift notice, above the filters rather than below them, because it disqualifies
              everything under it. A build whose config has been edited without a bump is stamping runs
              with a version that no longer describes what they were scored against, and a reader who
              scrolls past this is reading a list that does not match their scores. Silence here is the
              ordinary case: CI refuses the edit, so this only fires on a hand-modified install. */}
            <Drift methodology={data} />

            <search className="grid grid-cols-1 gap-2 border-b border-wa-divider p-2 sm:grid-cols-2">
              <input
                className="wa-field wa-body-compact w-full"
                placeholder="Search title or id"
                aria-label="Search requirements by title or id"
                value={query}
                onChange={(event) => set('q', event.target.value)}
              />
              <Select value={pillar} onValueChange={(value) => set('pillar', value)}>
                <SelectTrigger className="wa-select w-full" aria-label="Filter by pillar">
                  <SelectValue placeholder="Any pillar" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any pillar ({all.length})</SelectItem>
                  {codes.map((code) => (
                    <SelectItem key={code} value={code}>
                      {pillarOf(code)} ({all.filter((one) => one.pillar === code).length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </search>

            {paged.total === 0 ? (
              <EmptyState
                reason={all.length === 0 ? 'nothing-to-report' : 'filtered-out'}
                {...(all.length === 0
                  ? {
                      heading: 'This build lists no requirements',
                      detail:
                        data.unavailable ??
                        'The version record holds no requirements, so there is nothing to describe. Runs still record which version scored them.',
                    }
                  : {
                      heading: 'Nothing matches',
                      detail: 'No requirement in Methodology Version 1 matches the filters above.',
                    })}
              />
            ) : (
              <>
                <ul className="wa-zebra">
                  {paged.rows.map((requirement) => (
                    <RequirementRow
                      key={requirement.id}
                      requirement={requirement}
                      pillar={pillarOf(requirement.pillar)}
                    />
                  ))}
                </ul>
                <Pagination paged={paged} noun="requirements" />
              </>
            )}
          </Surface>
        }
      />
    </CustomerPage>
  );
}

/**
 * The public methodology this build stamps on every new run, and whether the last run carries it.
 *
 * The standing sentence is the point of the panel. A release record is a fact about the app; what a
 * reader needs is whether the score they were just looking at records that exact public version and
 * manifest. The honest answer may be no: old development runs remain pre-release, and a candidate
 * regeneration invalidates earlier candidate evidence instead of relabelling it.
 */
function CurrentVersion({
  methodology,
  scan,
}: {
  readonly methodology: Methodology;
  readonly scan?: { readonly stamp: unknown };
}) {
  const stamp = (scan?.stamp ?? {}) as {
    readonly publicMethodology?: {
      readonly publicVersion: number;
      readonly manifestDigest: string;
      readonly state: 'candidate' | 'released';
      readonly effectiveDate?: string;
    };
  };
  const standing = scan == null ? undefined : standingSentence(methodology.release, stamp.publicMethodology);
  const released = methodology.release.state === 'released';

  return (
    <Surface
      tone="raised"
      label="Methodology Version 1"
      title="The methodology"
      action={<IdentifierBadge>{`Version ${String(methodology.release.publicVersion)}`}</IdentifierBadge>}
    >
      <div className="space-y-2 p-3">
        <p className="wa-caption">
          {released
            ? `Effective ${methodology.release.effectiveDate ?? 'date not recorded'} · Approved by ${methodology.release.approvedBy ?? 'approver not recorded'}`
            : `Release candidate since ${methodology.release.candidateStartedAt}; no effective date is recorded.`}
        </p>
        <p className="wa-body-compact text-wa-text-secondary">
          {String(methodology.requirements.length)} requirements
          {methodology.scoredUnits != null && (
            <>
              , and a score is out of {String(methodology.scoredUnits)} of them: a requirement that two pillars ask for
              is counted once
            </>
          )}
          .
        </p>
        {standing != null && <p className="wa-caption">{standing}</p>}
        <Disclosure summary="Exact release and technical provenance">
          <div className="space-y-2">
            <p className="wa-caption break-all">
              <span className="text-wa-text-secondary">Version 1 manifest</span>{' '}
              <span className="wa-code">{methodology.release.manifestDigest}</span>
            </p>
            {methodology.release.releaseCommit != null && (
              <p className="wa-caption break-all">
                <span className="text-wa-text-secondary">Approved source commit</span>{' '}
                <span className="wa-code">{methodology.release.releaseCommit}</span>
              </p>
            )}
            <p className="wa-caption break-all">
              <span className="text-wa-text-secondary">Catalogue revision</span>{' '}
              <span className="wa-code">{methodology.technical.catalogueRevision}</span>
            </p>
            <p className="wa-caption break-all">
              <span className="text-wa-text-secondary">Catalogue fingerprint</span>{' '}
              <span className="wa-code">{methodology.technical.catalogueFingerprint}</span>
            </p>
            <p className="wa-caption break-all">
              <span className="text-wa-text-secondary">Weighting</span>{' '}
              <span className="wa-code">{methodology.scoring.digest}</span>
            </p>
            <p className="wa-caption">
              The public version identifies the customer standard. The catalogue revision and weighting identify the
              exact implementation that produced a run.
            </p>
          </div>
        </Disclosure>
      </div>
    </Surface>
  );
}

/**
 * The two tables that turn findings into a number.
 *
 * Open rather than behind a disclosure, which was the first cut and was wrong twice over. The rail has
 * the room — three short panels left 380px of empty column under them — and this is the half of the
 * methodology that a list of 184 severities cannot supply: `high` is not a number, and a reader who
 * has to click to find out what it is worth has been shown a requirement list and asked to trust the
 * arithmetic. A reference page's reference material does not hide.
 *
 * Only the digest is folded away, because it is the one thing here for a different reader: whoever is
 * matching a run record against this weighting, rather than trying to understand it.
 */
function ScoringMethod({ methodology }: { methodology: Methodology }) {
  const { severityWeight, credit } = methodology.scoring;

  return (
    <Surface tone="section" label="How a score is computed" title="How a score is computed">
      <ul className="space-y-1 p-3">
        {Object.entries(severityWeight)
          .sort(([, a], [, b]) => b - a)
          .map(([severity, weight]) => {
            const phrase = weightPhrase(severity, severityWeight);
            return (
              <li key={severity} className="wa-caption flex items-baseline justify-between gap-2">
                <span className="text-wa-text-secondary">{severity}</span>
                <span className="text-right">{phrase ?? String(weight)}</span>
              </li>
            );
          })}
      </ul>
      <div className="space-y-1.5 border-t border-wa-divider p-3">
        {creditSentence(credit).map((sentence) => (
          <p key={sentence} className="wa-caption">
            {sentence}
          </p>
        ))}
      </div>
      {/* Each pillar on its own requirements, then averaged. Stated because it is the thing a reader is
          most likely to get wrong about the overall figure: security carries 70 requirements and data
          governance 13, so a single estate-wide average would be a security score with rounding error
          attached, and a governance failure would barely move it. */}
      <p className="wa-caption border-t border-wa-divider p-3">
        Each pillar scores its own requirements, and the overall figure is their mean, so one large pillar cannot
        dominate.
      </p>
    </Surface>
  );
}

/**
 * Development catalogue history, kept out of the customer release model.
 *
 * Folded because it is forensic provenance rather than a release selector. A customer arrives here
 * to understand Version 1; support can still identify exactly which development scoring shape an old
 * scan carried without calling ten internal checkpoints ten customer releases.
 */
function TechnicalHistory({ revisions }: { readonly revisions: readonly CatalogueRevision[] }) {
  return (
    <Surface tone="inset" label="Pre-release technical history" title="Technical provenance">
      <div className="p-3">
        <Disclosure summary={`Pre-release technical history · ${String(revisions.length)} revisions`}>
          <p className="wa-caption mb-2">
            Catalogue revisions are development checkpoints. They remain immutable for support and do not appear as
            Methodology releases.
          </p>
          {revisions.length === 0 ? (
            <p className="wa-caption">No technical revision history is recorded.</p>
          ) : (
            <ul className="space-y-2">
              {revisions.map((revision, at) => (
                <li key={revision.revision} className="border-t border-wa-divider pt-2 first:border-0 first:pt-0">
                  <p className="wa-body-compact font-medium text-wa-text">
                    Catalogue revision {revision.revision}
                    {revision.recordedAt !== '' && (
                      <span className="wa-caption ml-2 font-normal">{revision.recordedAt}</span>
                    )}
                  </p>
                  <p className="wa-caption">{revisionSentence(revision, at === revisions.length - 1)}</p>
                </li>
              ))}
            </ul>
          )}
        </Disclosure>
      </div>
    </Surface>
  );
}

/**
 * Where the record and the loaded catalogue disagree.
 *
 * Nothing at all in the ordinary case, and that is deliberate: a notice that appears on every visit is
 * furniture, and this one has to be alarming when it fires. It fires when the shipped config has been
 * edited without the version being bumped, which means runs are being stamped with a version that does
 * not describe what they were scored against — the app cannot detect that any other way, because the
 * fingerprint is computed by a release script rather than at boot.
 */
function Drift({ methodology }: { methodology: Methodology }) {
  const drifted = methodology.requirements.filter((one) => one.drifted != null);
  const { missing, unrecorded, unavailable } = methodology;

  if (unavailable != null) {
    return (
      <div className="wa-notice-warning m-2 flex flex-col gap-1">
        <span className="wa-body-compact font-medium text-wa-text">The methodology cannot be listed</span>
        <span className="wa-caption">{unavailable}</span>
      </div>
    );
  }

  if (drifted.length === 0 && missing.length === 0 && unrecorded.length === 0) return null;

  return (
    <div className="wa-notice-warning m-2 flex flex-col gap-1">
      <span className="wa-body-compact font-medium text-wa-text">
        This install does not match its own version record
      </span>
      <span className="wa-caption">
        The catalogue files this build loaded differ from technical revision {methodology.technical.catalogueRevision},
        so runs are being stamped with a revision that does not describe how they were scored. Somebody has edited the
        shipped configuration.
      </span>
      <ul className="wa-caption space-y-0.5">
        {drifted.slice(0, 4).map((one) => (
          <li key={one.id}>
            <span className="wa-code">{one.id}</span> — {fieldsPhrase(one.drifted ?? [])} differs
          </li>
        ))}
        {drifted.length > 4 && <li>and {String(drifted.length - 4)} more requirements differ</li>}
        {missing.length > 0 && (
          <li>
            {String(missing.length)} recorded {missing.length === 1 ? 'requirement is' : 'requirements are'} no longer
            in the catalogue: <span className="wa-code">{missing.slice(0, 6).join(', ')}</span>
          </li>
        )}
        {unrecorded.length > 0 && (
          <li>
            {String(unrecorded.length)} {unrecorded.length === 1 ? 'requirement is' : 'requirements are'} being scored
            that no version records: <span className="wa-code">{unrecorded.slice(0, 6).join(', ')}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function RequirementRow({
  requirement,
  pillar,
}: {
  readonly requirement: MethodologyRequirement;
  readonly pillar: string;
}) {
  const shape = shapeSentence(requirement);

  return (
    <li className="wa-row flex-col items-start gap-0.5 py-2">
      <span className="flex w-full min-w-0 items-baseline gap-2">
        <IdentifierBadge>{requirement.id}</IdentifierBadge>
        {/* The severity, and deliberately not what it is worth. "12× the lightest weight" is true on
            every `high` row, so putting it here writes it sixty times and it becomes furniture — the
            same argument the design system makes about a badge that appears on every row. The weights
            are one panel to the left, where they are read once. */}
        <SeverityBadge severity={requirement.severity as Severity} />
        <span className="wa-body-compact min-w-0 flex-1 truncate text-wa-text">{requirement.title}</span>
        {/* Straight to the requirement's own findings, because a reader who has found the definition
            wants the reading. The methodology says what is asked; the finding says what the estate
            answered, and having to search for it again is the page ending one step short. */}
        <Link className="wa-caption shrink-0 text-wa-action hover:underline" to={`/findings?control=${requirement.id}`}>
          {pillar} →
        </Link>
      </span>
      {/* Truncated with the whole of it on the title, rather than wrapped. Wrapped, a long threshold
          list took a row to three lines and put six of 184 requirements on a laptop screen, which is a
          list nobody scrolls; the clauses that survive to this line are the ones a reader cannot infer
          from the badges beside it. */}
      <span className="wa-caption w-full truncate" title={shape}>
        {shape}
      </span>
    </li>
  );
}
