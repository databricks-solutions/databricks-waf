// Whether the data this organisation says it serves is ready to be served.
//
// Eight readings and no total, which is the page's whole shape and the thing most likely to be
// undone by a later change. `45a` measured one estate's description coverage at 13.5% over every
// relation and 34.1% over the tables read in thirty days, from two statements this app already ships,
// both correctly computed. Every dimension here therefore prints what its share is a share of, and
// none of them are added: a figure summing eight populations has one true property, which is that
// somebody computed it.
//
// The other half of the page is the declaration itself, and it is above the dimensions rather than
// behind a link. A reader arriving at eight percentages has one question before any of them — what
// counts as serving data here — and a page that made them go and find out would be publishing eight
// shares of a population it declined to name.
//
// Read-only. There is no form here for declaring or revising, and that is a scope decision rather
// than an oversight: the endpoint exists and is gated, the shape of a declaration is not obvious
// enough to type into a textarea, and 45c said an editor is its own row. What the page does when
// nothing is declared is say so, which is the state most installs are in.

import { useState } from 'react';
import { Link } from 'react-router';
import { useDeclareServing, useFoundationReadiness, type ServingDraft } from '../api/hooks';
import type { FoundationReadiness, ReadinessDimension } from '../api/types';
import { FoundationDeclarationForm } from '../components/FoundationDeclarationForm';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState } from '../components/ui/EmptyState';
import { CustomerPage, Surface } from '../components/system';
import { Badge } from '../components/ui/StatusBadge';
import {
  bandPhrase,
  countPhrase,
  obligationPhrases,
  readingSentence,
  selectionPhrases,
  sharePhrase,
  standingPresentation,
  unreadSentence,
} from './foundation-language';
import { foundationHref } from './foundation-link';

export function FoundationPage() {
  const readiness = useFoundationReadiness();
  const [editing, setEditing] = useState(false);
  const declare = useDeclareServing(() => {
    setEditing(false);
    readiness.reload();
  });

  if (readiness.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Serving readiness">
          <EmptyState
            reason="collector-failed"
            heading="Could not read how ready the serving data is"
            detail={readiness.error}
            action={
              <button type="button" className="wa-button-secondary" onClick={readiness.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (readiness.data == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Serving readiness">
          <EmptyState
            reason="not-yet-collected"
            heading="Reading"
            detail="Running three statements against the relations this organisation declared it serves."
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <Readiness
      readiness={readiness.data}
      editing={editing}
      onEdit={() => setEditing(true)}
      onCancel={() => setEditing(false)}
      onDeclare={(draft) => void declare.send(draft)}
      saving={declare.saving}
      {...(declare.error != null ? { declarationError: declare.error } : {})}
    />
  );
}

/** Exported so a test can render the claims without mounting the hook. */
export function Readiness({
  readiness,
  editing = false,
  onEdit,
  onCancel,
  onDeclare,
  saving = false,
  declarationError,
}: {
  readonly readiness: FoundationReadiness;
  readonly editing?: boolean;
  readonly onEdit?: () => void;
  readonly onCancel?: () => void;
  readonly onDeclare?: (draft: ServingDraft) => void;
  readonly saving?: boolean;
  readonly declarationError?: string;
}) {
  const unread = unreadSentence(readiness.unread);
  const canEdit = onEdit != null && onCancel != null && onDeclare != null;

  if (editing && canEdit) {
    return (
      <CustomerPage>
        <Surface
          tone="task"
          label="Declare serving assets"
          title={readiness.declaration == null ? 'Declare what this organisation serves' : 'Declare a new version'}
          description={
            readiness.declaration == null ? (
              <span className="wa-caption">First declaration</span>
            ) : (
              <span className="wa-caption">Current version {readiness.declaration.version}</span>
            )
          }
        >
          <div className="space-y-1 border-b border-wa-divider pb-3">
            <p className="wa-body-compact text-wa-text">
              Select exact assets or existing tag conventions, then state the metadata and protection obligations the
              readings should check.
            </p>
            <p className="wa-caption">
              This is an assessment-scoped record. It does not change grants, tags, masks, filters, or policies in the
              workspace.
            </p>
          </div>
          <FoundationDeclarationForm
            declaration={readiness.declaration}
            saving={saving}
            {...(declarationError != null ? { error: declarationError } : {})}
            onSubmit={onDeclare}
            onCancel={onCancel}
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (readiness.declaration == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Serving asset declaration" title="What counts as serving data here">
          <EmptyState
            reason="not-yet-collected"
            heading="No serving assets declared"
            detail={`${readingSentence(readiness)} Name exact assets or the existing tags that select them before the readiness checks run.`}
            layout="compact"
            {...(onEdit == null
              ? {}
              : {
                  action: (
                    <button type="button" className="wa-button-primary" onClick={onEdit}>
                      Declare serving assets
                    </button>
                  ),
                })}
          />
          {!readiness.durable && readiness.durabilityNote != null && (
            <p className="wa-body-compact border-t border-wa-divider p-3 text-wa-warning" role="status">
              {readiness.durabilityNote}
            </p>
          )}
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <CustomerPage>
      <div className="space-y-4 pb-4">
        <Surface
          tone="task"
          label="Serving asset declaration"
          title="What counts as serving data here"
          action={
            canEdit && !editing && readiness.declaration != null ? (
              <button type="button" className="wa-button-primary" onClick={onEdit}>
                Revise declaration
              </button>
            ) : readiness.declaration == null ? undefined : (
              <span className="wa-caption">Version {readiness.declaration.version}</span>
            )
          }
        >
          <div className="space-y-2">
            <p className="wa-body-compact text-wa-text-secondary">{readingSentence(readiness)}</p>
            <ul className="wa-body-compact space-y-1 text-wa-text-secondary">
              {selectionPhrases(readiness.declaration).map((phrase) => (
                <li key={phrase}>{phrase}</li>
              ))}
            </ul>
            <ul className="wa-body-compact space-y-1 text-wa-text-secondary">
              {obligationPhrases(readiness.declaration).map((phrase) => (
                <li key={phrase}>{phrase}</li>
              ))}
            </ul>
            <Disclosure summary="Declaration provenance">
              <p>
                Declared by {readiness.declaration.declaredBy} on{' '}
                {new Date(readiness.declaration.declaredAt).toLocaleString()}.
              </p>
              <p className="wa-code break-all">{readiness.declaration.fingerprint}</p>
            </Disclosure>
          </div>

          {!readiness.durable && readiness.durabilityNote != null && (
            <p className="wa-body-compact border-t border-wa-divider p-3 text-wa-warning" role="status">
              {readiness.durabilityNote}
            </p>
          )}
        </Surface>

        <div className="space-y-3">
          {(readiness.unavailable != null || unread != null) && (
            <div className="wa-notice-warning flex flex-wrap items-center justify-between gap-2" role="status">
              <p className="wa-body-compact min-w-0 flex-1">{readiness.unavailable ?? unread}</p>
              <Link className="wa-button-secondary" to="/diagnostics">
                Check data access
              </Link>
            </div>
          )}

          <Surface
            tone="raised"
            label="Foundation readings"
            title="Readiness by dimension"
            description={`${String(readiness.dimensions.length)} readings`}
          >
            {readiness.dimensions.length === 0 ? (
              <EmptyState
                reason="not-yet-collected"
                heading="The sources are not available"
                detail={readiness.unavailable ?? 'The foundation readings could not be read.'}
                action={
                  <Link className="wa-button-secondary" to="/diagnostics">
                    Check data access
                  </Link>
                }
              />
            ) : (
              AREAS.map((area) => {
                const dimensions = readiness.dimensions.filter((dimension) => dimension.area === area.id);
                if (dimensions.length === 0) return null;
                return (
                  <section key={area.id} aria-labelledby={`foundation-${area.id}`}>
                    <div className="border-b border-wa-divider bg-wa-surface-subtle px-3 py-2">
                      <h2 id={`foundation-${area.id}`} className="wa-body-compact font-medium text-wa-text">
                        {area.label}
                      </h2>
                      <p className="wa-caption">{area.detail}</p>
                    </div>
                    <ul className="wa-zebra">
                      {dimensions.map((dimension) => (
                        <li key={dimension.id}>
                          <Dimension dimension={dimension} />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
          </Surface>

          <Surface tone="inset" title="What this reading does not say">
            <div>
              <Disclosure summary={`${String(readiness.absent.length)} limitations`}>
                <ul className="wa-zebra" data-technical-evidence>
                  {readiness.absent.map((absence) => (
                    <li key={absence.what} className="space-y-1 p-3">
                      <p className="wa-body-compact font-medium text-wa-text">{absence.what}</p>
                      <p className="wa-body-compact text-wa-text-secondary">{absence.because}</p>
                      <p className="wa-caption">Measured: {absence.measured}</p>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </div>
          </Surface>
        </div>
      </div>
    </CustomerPage>
  );
}

function Dimension({ dimension }: { readonly dimension: ReadinessDimension }) {
  const standing = standingPresentation(dimension.standing);

  return (
    <div className="space-y-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="wa-body-compact min-w-0 flex-1 font-medium text-wa-text">{dimension.label}</h2>
        {/* Tabular so eight shares down a column can be compared by eye without reading them, which
            is what a reader does with this page first. */}
        <span className="wa-body-compact font-medium tabular-nums text-wa-text">{sharePhrase(dimension.share)}</span>
        <Badge tone={standing.tone} Icon={standing.Icon} title={bandPhrase(dimension)}>
          {standing.label}
        </Badge>
      </div>
      <p className="wa-body-compact text-wa-text-secondary">{dimension.asks}</p>
      <Disclosure summary="Evidence and denominator">
        <p>{countPhrase(dimension)}</p>
        <p>Source: {dimension.sources.join(' + ')}</p>
      </Disclosure>
      {dimension.shortfall.length > 0 && (
        <div className="flex flex-wrap items-end justify-between gap-2">
          <p className="wa-caption min-w-0 flex-1">
            Short of it: {dimension.shortfall.slice(0, SHOWN).join(', ')}
            {dimension.shortfall.length > SHOWN && ` and ${String(dimension.shortfall.length - SHOWN)} more`}
          </p>
          <Link
            className="wa-body-compact shrink-0 text-wa-action hover:underline"
            to={foundationHref('/improvements', dimension.id)}
          >
            Create improvement plan →
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * How many of the assets short of a dimension are named before the rest are counted.
 *
 * Five, because the list is here to make the number concrete rather than to be worked through: a
 * reader who wants the whole set of two thousand wants it in a spreadsheet, and this page is not one.
 * The count of what is not shown travels with them, so the five never read as all of them.
 */
const SHOWN = 5;

const AREAS = [
  {
    id: 'governance',
    label: 'Governance',
    detail: 'Catalog boundary and declared protection obligations, kept as separate readings.',
  },
  {
    id: 'metadata',
    label: 'Metadata',
    detail: 'Table and column metadata, each over the population its source actually read.',
  },
  {
    id: 'semantics',
    label: 'Semantics',
    detail: 'Metric-view evidence only; it does not judge whether the metric definitions are right.',
  },
  {
    id: 'freshness',
    label: 'Freshness signals',
    detail: 'Recent lineage and recorded monitoring status. Neither predicts whether data is current.',
  },
  {
    id: 'performance',
    label: 'Performance foundation',
    detail: 'Storage format is the available prerequisite reading, not a measurement of query speed.',
  },
] as const;
