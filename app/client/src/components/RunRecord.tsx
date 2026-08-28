// What a run was, and what it cost.
//
// Extracted from the overview because the run detail page needs exactly the same two panels,
// and a second copy of them would be a second place for the provenance of a result to be
// stated — which is the one thing in this app that must have a single statement. If the two
// pages ever disagreed about who a scan ran as, neither could be trusted.

import { EmptyState } from './ui/EmptyState';
import { Surface } from './system';
import { ranAsServicePrincipal, startedBy, whoRanInFull } from '../pages/run-language';
import type { Scan, SurfaceFootprint } from '../api/types';
import { methodologyLabel } from '../methodology-identity';

/**
 * How the run began, in one line with its date.
 *
 * The trigger is stated only when the run recorded one, because an older run genuinely does not
 * say and "by hand" would be a guess presented as provenance — on the one panel in the app whose
 * whole purpose is to be checkable.
 */
function started(scan: Scan): string {
  const when = new Date(scan.startedAt).toLocaleString();
  const how = startedBy(scan.stamp);
  return how == null ? when : `${when}, ${how}`;
}

/**
 * Who measured it, over what, when, and against which requirement set.
 *
 * Every field is a reason two runs are not comparable, which is why they are presented
 * together rather than scattered: the set of them is the answer to "can I read these two
 * scores as a trend", and a reader who has to assemble it from four places will not.
 */
export function RunProvenance({ scan }: { scan: Scan }) {
  return (
    <Surface tone="raised" title="What this result covers">
      <div className="space-y-3">
        <p className="wa-body-compact text-wa-text-secondary">
          Stated so two scans can be compared honestly, and so a smaller denominator reads as fact rather than as a
          score flattered by skipped questions.
        </p>
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Field label="Measured as">
            {ranAsServicePrincipal(scan.stamp)
              ? `the service principal ${whoRanInFull(scan.stamp)}, seeing only what it has been granted`
              : `${scan.stamp.actor}, using that account's own access`}
          </Field>
          <Field label="Started">{started(scan)}</Field>
          <Field label="Scope">{scan.stamp.scope.description}</Field>
          <Field label="Lookback">{scan.stamp.lookbackDays} days of usage and audit history</Field>
          <Field label="Methodology">{methodologyLabel(scan.stamp)}</Field>
          <Field label="Technical provenance">Catalogue revision {scan.stamp.catalogueVersion}</Field>
          <Field label="Finished">{new Date(scan.finishedAt).toLocaleString()}</Field>
          <Field label="Duration">{(scan.footprint.durationMs / 1000).toFixed(1)}s</Field>
        </dl>
        <Workspaces estate={scan.estate} />
      </div>
    </Surface>
  );
}

/** What the run consumed, measured rather than estimated. */
export function RunCost({ scan }: { scan: Scan }) {
  return (
    <Surface tone="raised" title="What the scan cost you" label="What the scan cost">
      <div className="space-y-3">
        <p className="wa-body-compact text-wa-text-secondary">
          A tool that assesses cost discipline should account for its own. Every number here is measured rather than
          estimated.
        </p>

        {scan.footprint.surfaces.length === 0 ? (
          <EmptyState
            reason="no-evidence"
            heading="No operations recorded"
            detail="The scan finished without attempting a single collection, which means its plan was empty rather than cheap."
          />
        ) : (
          <ul className="wa-body-compact space-y-1 text-wa-text-secondary">
            {scan.footprint.surfaces.map((surface) => (
              <li key={surface.surface}>
                <span className="text-wa-text">{surface.surface}</span>: {surface.succeeded} of {surface.budget}{' '}
                permitted operations used
                {surface.failed > 0 && `, ${surface.failed} failed${refusalClause(surface)}`}
                {surface.retries > 0 && `, ${surface.retries} retried`}
                {surface.skipped > 0 && `, ${surface.skipped} not attempted`}
              </li>
            ))}
          </ul>
        )}

        {scan.spend.map((spend) => (
          <p key={`${spend.surface}-${spend.name}`} className="wa-body-compact text-wa-text-secondary">
            The {spend.name} collector ran {spend.calls} {spend.calls === 1 ? 'statement' : 'statements'}
            {spend.bytesRead != null && `, scanning ${formatBytes(spend.bytesRead)}`}
            {spend.rowsReturned != null && ` and returning ${spend.rowsReturned.toLocaleString()} rows`}.
          </p>
        ))}

        <p className="wa-body-compact text-wa-text-secondary">
          {scan.footprint.concurrencyReductions > 0
            ? `The warehouse pushed back ${scan.footprint.concurrencyReductions} ` +
              `${scan.footprint.concurrencyReductions === 1 ? 'time' : 'times'} and the scan reduced its own ` +
              'concurrency in response, which is the load discipline working rather than a fault.'
            : 'The warehouse never pushed back, so the scan ran at its starting concurrency throughout.'}
        </p>

        <p className="wa-caption">
          DBUs are not shown. The same work does not reach the billing tables for up to a day, so any figure here now
          would be an estimate presented as a measurement. The statement ids are recorded with the scan, so this
          footprint can be audited against your own query history rather than taken on trust.
        </p>
      </div>
    </Surface>
  );
}

/**
 * What the failures on a surface ended as, where the run recorded it.
 *
 * Every word here is a field. The kinds are the scheduler's own `FailureKind` spellings,
 * hyphens turned to spaces and nothing else — this may not say a throttled surface will
 * succeed on a later run, or that a permission denial is the operator's to fix, because
 * a count by kind is all the payload carries. Runs recorded before ADR 0093 have no
 * `refusals`, and an absent breakdown reads as no breakdown rather than as none needed.
 */
function refusalClause(surface: SurfaceFootprint): string {
  const refusals = surface.refusals ?? [];
  if (refusals.length === 0) return '';
  return ` (${refusals.map((refusal) => `${refusal.tasks} ${refusal.kind.replace(/-/g, ' ')}`).join(', ')})`;
}

/** Bytes at the precision a reader can act on, which is never more than one decimal. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The workspaces behind the numbers.
 *
 * Here rather than in the field grid because the excluded set needs naming, not counting.
 * A user who knows their account has 68 workspaces and sees a scan report 4 needs to see
 * which 4, and that the other 64 were cancelled rather than missed.
 */
function Workspaces({ estate }: { estate: Scan['estate'] }) {
  if (estate.undeterminedReason != null) {
    return (
      <p className="wa-body-compact border-t border-wa-divider pt-3 text-wa-text-secondary">
        {estate.undeterminedReason}
      </p>
    );
  }
  const unasked = estate.outOfScope ?? [];
  if (estate.assessed.length === 0 && estate.excluded.length === 0 && unasked.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-wa-divider pt-3">
      {estate.note != null && <p className="wa-body-compact text-wa-text">{estate.note}</p>}
      <ul className="wa-body-compact space-y-1 text-wa-text-secondary">
        {estate.assessed.map((workspace) => (
          <li key={workspace.id}>
            {workspace.url != null ? (
              <a href={workspace.url} target="_blank" rel="noreferrer" className="text-wa-text hover:underline">
                {workspace.name}
              </a>
            ) : (
              <span className="text-wa-text">{workspace.name}</span>
            )}{' '}
            <span className="wa-numeric">({workspace.id})</span>
          </li>
        ))}
      </ul>
      {/*
       * Named, not counted, and kept apart from the excluded sentence below. A reader looking at a
       * narrowed run has a decision to make about these — widen the assessment, or leave them out on
       * purpose — where an excluded workspace offers them nothing to decide.
       */}
      {unasked.length > 0 && (
        <p className="wa-body-compact text-wa-text-secondary">
          Outside the scope this assessment names, so {unasked.length === 1 ? 'it was' : 'they were'} not read:{' '}
          {unaskedNames(unasked)}.
        </p>
      )}
      {estate.excluded.length > 0 && (
        <p className="wa-body-compact text-wa-text-secondary">
          Resource counts exclude {estate.excluded.length === 1 ? 'this workspace' : 'these workspaces'}, so a total
          here can be smaller than one taken from the account console: {excludedNames(estate.excluded)}.
        </p>
      )}
    </div>
  );
}

/**
 * Bounded, because an account can hold dozens of cancelled workspaces and none of them is news.
 *
 * The parenthetical is the reason, not the status, for the one case where they differ: a workspace
 * excluded for its region is `RUNNING`, and "acme-prod (running)" in a list of workspaces left out
 * reads as a defect in the tool.
 */
function excludedNames(excluded: Scan['estate']['excluded']): string {
  const shown = excluded
    .slice(0, 5)
    .map((workspace) =>
      workspace.reason === 'other-region'
        ? `${workspace.name} (another region)`
        : `${workspace.name} (${workspace.status.toLowerCase()})`
    );
  const rest = excluded.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${String(rest)} more` : shown.join(', ');
}

/**
 * Bounded like the excluded list, and without a parenthetical.
 *
 * Every one of these is running and assessable — that is what put it in this set rather than the other —
 * so a status beside the name would add nothing and invite the reader to look for a difference.
 */
function unaskedNames(unasked: readonly { name: string }[]): string {
  const shown = unasked.slice(0, 5).map((workspace) => workspace.name);
  const rest = unasked.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${String(rest)} more` : shown.join(', ');
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="wa-label">{label}</dt>
      <dd className="wa-body-compact text-wa-text">{children}</dd>
    </div>
  );
}
