// The one door into a full assessment run.
//
// A scan spends the customer's warehouse and creates the result every other journey is built on. The
// old global actions posted immediately, so the default scope was both invisible and irreversible. This
// dialog makes the two parts of that question explicit and keeps the final start as a separate action.

import { useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  AlertDescription,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Spinner,
} from '@databricks/appkit-ui/react';
import { Play } from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import type { AssessmentChoice, Chosen } from '../api/assessment-choice';
import { useSelectableWorkspaces, type ScanRequest } from '../api/hooks';
import { WorkspacePicker } from './WorkspacePicker';

interface RunScanDialogProps {
  readonly children: ReactNode;
}

export interface ScanScopeChoice {
  readonly basis: 'saved' | 'custom';
  readonly definitionId?: string;
  /** Undefined means every pillar offered by this basis. */
  readonly pillars?: readonly string[];
  readonly workspaceScope: 'account' | 'selected';
  readonly workspaces: readonly string[];
}

export interface ConfirmedScan {
  readonly request: ScanRequest;
  /** Custom scope is outside the saved assessment currently selected elsewhere in the app. */
  readonly chosen?: Chosen;
}

/**
 * Turn the confirmed form into the wire request.
 *
 * Pure because the dangerous boundary is absence: the form can change all day without a request, and
 * only its final submit calls this. Explicit null is how custom scope declines the assessment currently
 * selected elsewhere in the product; it is intentionally omitted from the JSON body by `scanBody`.
 */
export function confirmedScanRequest(choice: ScanScopeChoice): ScanRequest {
  if (choice.basis === 'saved' && choice.definitionId != null) {
    return choice.pillars == null ? { definitionId: choice.definitionId } : { pillars: choice.pillars };
  }

  return {
    definitionId: null,
    ...(choice.pillars != null ? { pillars: choice.pillars } : {}),
    ...(choice.workspaceScope === 'selected' ? { workspaces: choice.workspaces } : {}),
  };
}

/** The request and assessment context that must change together at the confirmation boundary. */
export function confirmedScan(choice: ScanScopeChoice): ConfirmedScan {
  return {
    request: confirmedScanRequest(choice),
    ...(choice.basis === 'custom' ? { chosen: { kind: 'none' } as const } : {}),
  };
}

/** Keep catalogued-but-unsupported pillars out of both saved and custom run choices. */
export function eligiblePillars<T extends { readonly id: string }>(
  all: readonly T[],
  measured: readonly string[] | null | undefined,
  saved: readonly string[] | undefined
): readonly T[] {
  const supported = measured == null ? all : all.filter((pillar) => measured.includes(pillar.id));
  if (saved == null) return supported;
  const included = new Set(saved);
  return supported.filter((pillar) => included.has(pillar.id));
}

/**
 * Undefined means the saved question or custom build-wide set can be sent as-is. When a saved
 * assessment still names a pillar this build no longer measures, send the visible supported set as
 * a targeted run instead of hiding the unsupported pillar and then asking the server for it anyway.
 */
export function pillarsForConfirmation(
  mode: 'all' | 'selected',
  basis: 'saved' | 'custom',
  offered: readonly string[],
  selected: readonly string[],
  saved: readonly string[] | undefined
): readonly string[] | undefined {
  if (mode === 'selected') return selected;
  if (basis === 'saved' && saved?.some((id) => !offered.includes(id)) === true) return offered;
  return undefined;
}

export function RunScanDialog({ children }: RunScanDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="wa-scan-dialog" showCloseButton>
        <DialogTitle>Set assessment scope</DialogTitle>
        <DialogDescription>Choose what to measure. Nothing starts until you confirm at the bottom.</DialogDescription>
        <RunScanForm onStarted={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RunScanForm({ onStarted }: { readonly onStarted: () => void }) {
  const { catalogue, selected, setChosen, runScan, scanning } = useAssessment();
  const directory = useSelectableWorkspaces();
  const [basis, setBasis] = useState<'saved' | 'custom'>(selected == null ? 'custom' : 'saved');
  const [workspaceScope, setWorkspaceScope] = useState<'account' | 'selected'>('account');
  const [workspaces, setWorkspaces] = useState<readonly string[]>([]);
  const [pillarMode, setPillarMode] = useState<'all' | 'selected'>('all');
  const [pillars, setPillars] = useState<readonly string[]>([]);

  const offered = useMemo(
    () =>
      eligiblePillars(
        catalogue?.pillars ?? [],
        catalogue?.measuredPillars,
        basis === 'saved' ? selected?.measurement.pillars : undefined
      ),
    [basis, catalogue?.measuredPillars, catalogue?.pillars, selected?.measurement.pillars]
  );
  const offeredIds = offered.map((pillar) => pillar.id);
  const savedPillars = basis === 'saved' ? selected?.measurement.pillars : undefined;
  const unavailableSavedPillars = savedPillars?.filter((id) => !offeredIds.includes(id)) ?? [];
  const chosenPillars = pillarsForConfirmation(pillarMode, basis, offeredIds, pillars, savedPillars);
  const invalidPillars = chosenPillars?.length === 0;
  const invalidWorkspaces = basis === 'custom' && workspaceScope === 'selected' && workspaces.length === 0;
  const invalid = scanning || invalidPillars || invalidWorkspaces || offered.length === 0;

  function choosePillar(id: string): void {
    const next = new Set(pillars);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPillars([...next].sort());
  }

  function changePillarMode(next: 'all' | 'selected'): void {
    setPillarMode(next);
  }

  function changeBasis(next: 'saved' | 'custom'): void {
    setBasis(next);
    // A saved assessment can offer fewer pillars than an ad-hoc run. Reset the pillar question so
    // a choice hidden by the new basis can never be submitted as though the reader still saw it.
    setPillarMode('all');
    setPillars([]);
  }

  const pillarCount = chosenPillars?.length ?? offered.length;
  const workspaceSummary =
    basis === 'saved' && selected != null
      ? selected.measurement.scope.kind === 'selected'
        ? `${String(selected.measurement.scope.workspaceIds?.length ?? 0)} workspace${selected.measurement.scope.workspaceIds?.length === 1 ? '' : 's'} from the saved assessment.`
        : 'The visible account from the saved assessment.'
      : workspaceScope === 'account'
        ? 'Every workspace the scanning identity can see.'
        : `${String(workspaces.length)} chosen workspace${workspaces.length === 1 ? '' : 's'}.`;
  const lookbackSummary =
    basis === 'saved' && selected != null
      ? ` · Last ${String(selected.measurement.lookbackDays)} day${selected.measurement.lookbackDays === 1 ? '' : 's'}.`
      : '';

  return (
    <form
      className="wa-scan-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        const confirmed = confirmedScan({
          basis,
          ...(basis === 'saved' && selected != null ? { definitionId: selected.id } : {}),
          ...(chosenPillars != null ? { pillars: chosenPillars } : {}),
          workspaceScope,
          workspaces,
        });
        if (confirmed.chosen != null) setChosen(confirmed.chosen);
        runScan(confirmed.request);
        onStarted();
      }}
    >
      {selected != null && (
        <fieldset className="wa-scan-section">
          <legend>Run basis</legend>
          <Choice
            name="run-basis"
            checked={basis === 'saved'}
            onChange={() => changeBasis('saved')}
            label={selected.name}
            detail={selected.scope}
          />
          <Choice
            name="run-basis"
            checked={basis === 'custom'}
            onChange={() => changeBasis('custom')}
            label="Custom scope for this run"
            detail="Choose workspaces without changing or stamping the saved assessment."
          />
        </fieldset>
      )}

      <div className="wa-scan-columns">
        <fieldset className="wa-scan-section">
          <legend>Pillars</legend>
          <Choice
            name="pillar-mode"
            checked={pillarMode === 'all'}
            onChange={() => changePillarMode('all')}
            label={
              basis === 'saved' && unavailableSavedPillars.length > 0
                ? 'All available pillars in this assessment'
                : basis === 'saved'
                  ? 'All pillars in this assessment'
                  : 'All pillars'
            }
            detail={
              `${String(offered.length)} pillar${offered.length === 1 ? '' : 's'} will be measured.` +
              (unavailableSavedPillars.length > 0
                ? ` ${String(unavailableSavedPillars.length)} saved pillar${unavailableSavedPillars.length === 1 ? ' is' : 's are'} not measured by this build.`
                : '')
            }
          />
          <Choice
            name="pillar-mode"
            checked={pillarMode === 'selected'}
            onChange={() => changePillarMode('selected')}
            label="Choose pillars"
            detail="Run one pillar or any subset."
          />
          {pillarMode === 'selected' && (
            <ul className="wa-scan-pillar-list" aria-label="Pillars to measure">
              {offered.map((pillar) => (
                <li key={pillar.id}>
                  <label className="wa-row flex items-center gap-3" data-selected={pillars.includes(pillar.id)}>
                    <input
                      type="checkbox"
                      checked={pillars.includes(pillar.id)}
                      onChange={() => choosePillar(pillar.id)}
                    />
                    <span className="font-medium text-wa-text">{pillar.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {invalidPillars && <p className="wa-caption text-wa-danger">Choose at least one pillar.</p>}
        </fieldset>

        <fieldset className="wa-scan-section">
          <legend>Workspaces</legend>
          {basis === 'saved' && selected != null ? (
            <SavedScope assessment={selected} />
          ) : (
            <>
              <Choice
                name="workspace-scope"
                checked={workspaceScope === 'account'}
                onChange={() => setWorkspaceScope('account')}
                label="Entire visible account"
                detail="Every assessable workspace the scanning identity can see."
              />
              <Choice
                name="workspace-scope"
                checked={workspaceScope === 'selected'}
                onChange={() => setWorkspaceScope('selected')}
                label="Choose workspaces"
                detail="Measure only the workspaces selected below."
              />
              {workspaceScope === 'selected' && (
                <div className="pt-2">
                  {directory.loading && directory.data == null ? (
                    <p className="wa-body-compact flex items-center gap-2 text-wa-text-secondary">
                      <Spinner className="h-3.5 w-3.5" /> Reading the account directory
                    </p>
                  ) : directory.error != null ? (
                    <Alert variant="destructive">
                      <AlertDescription>{directory.error}</AlertDescription>
                    </Alert>
                  ) : (
                    <WorkspacePicker
                      workspaces={directory.data?.workspaces ?? []}
                      selected={workspaces}
                      onChange={setWorkspaces}
                      {...(directory.data?.asOf != null ? { asOf: directory.data.asOf } : {})}
                      {...(directory.data?.unavailable != null ? { unavailable: directory.data.unavailable } : {})}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </fieldset>
      </div>

      <div className="wa-scan-confirmation">
        <div className="min-w-0">
          <p className="wa-label text-wa-text">Ready to run</p>
          <p className="wa-body-compact text-wa-text-secondary">
            {String(pillarCount)} pillar{pillarCount === 1 ? '' : 's'} · {workspaceSummary}
            {lookbackSummary}
          </p>
          {(invalidWorkspaces || invalidPillars) && (
            <p className="wa-caption text-wa-danger">Choose at least one pillar and one workspace.</p>
          )}
        </div>
        <button type="submit" className="wa-customer-primary-action" disabled={invalid}>
          {scanning ? <Spinner className="h-3.5 w-3.5" /> : <Play aria-hidden className="h-3.5 w-3.5" />}
          Start assessment
        </button>
      </div>
    </form>
  );
}

function Choice({
  name,
  checked,
  onChange,
  label,
  detail,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly label: string;
  readonly detail: string;
}) {
  return (
    <label className="wa-scan-choice" data-selected={checked}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span className="min-w-0">
        <span className="block font-medium text-wa-text">{label}</span>
        <span className="wa-caption block">{detail}</span>
      </span>
    </label>
  );
}

function SavedScope({ assessment }: { readonly assessment: AssessmentChoice }) {
  return (
    <div className="wa-scan-saved-scope">
      <p className="font-medium text-wa-text">{assessment.name}</p>
      <p className="wa-body-compact text-wa-text-secondary">{assessment.scope}</p>
      <p className="wa-caption">Choose Custom scope above to change the workspaces for this run.</p>
    </div>
  );
}
