// Choosing the workspaces an assessment covers.
//
// Three things this has to do that a list of checkboxes does not.
//
// It has to say which workspaces cannot be covered, and why, rather than leaving them out. A
// workspace absent from the list is indistinguishable from one nobody scrolled to, so a stopped
// workspace and a workspace in another region are both shown and both unselectable — the second
// especially, because it is `RUNNING` and its status alone explains nothing about why this
// deployment cannot read it.
//
// It has to keep a selected workspace that is no longer in the directory. This is the case a picker
// built from the directory alone gets wrong, and it gets it wrong silently: an author opens a
// definition written in June, the picker renders the workspaces it can see, the author changes
// something unrelated and saves — and the two workspaces that were cancelled in July have quietly
// left the scope, with the new version recording a narrower assessment that nobody chose. So a
// selected id with no row of its own gets one, marked as not in the directory, and removing it is
// something the author does rather than something that happens to them.
//
// And it has to say how old its list is. A fresh install reads the directory on demand; later reads
// can reuse the last scan's directory, and the date tells an author which one they are choosing from.

import { useState } from 'react';
import { Ban, CircleHelp, Globe2 } from 'lucide-react';
import type { SelectableWorkspace } from '@/api/types';
import { Badge } from './ui/StatusBadge';

/** A workspace in the definition that the directory has no row for. */
export interface UnknownWorkspace {
  readonly id: string;
}

export interface WorkspacePickerProps {
  /** The account directory, from the latest scan or an on-demand read on a fresh install. */
  readonly workspaces: readonly SelectableWorkspace[];
  readonly selected: readonly string[];
  readonly onChange: (selected: readonly string[]) => void;
  /** When the directory was read. Absent when there is no list. */
  readonly asOf?: string;
  /** Why there is no list, when there is none — no scan yet, or an unreadable directory. */
  readonly unavailable?: string;
  /** Set while a save is in flight, so a click cannot change what is being submitted. */
  readonly disabled?: boolean;
}

type RowKind = 'assessable' | 'not-running' | 'other-region' | 'unknown';

interface PickerRow {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly kind: RowKind;
  readonly selectable: boolean;
}

/**
 * What to say about a row, where there is anything to say.
 *
 * Nothing for an assessable workspace, on purpose. A badge on every row is a badge on none: the
 * ones that matter here are the four in fourteen that cannot be covered, and putting a green tick
 * beside the other ten hides them in a wall of decoration. An enabled checkbox already says the
 * workspace can be chosen.
 */
const LABEL: Readonly<Record<Exclude<RowKind, 'assessable'>, string>> = {
  'not-running': 'Not running',
  'other-region': 'Another region',
  unknown: 'Not in the directory',
};

const EXPLANATION: Readonly<Record<Exclude<RowKind, 'assessable'>, string>> = {
  'not-running': 'This workspace is not running, so it holds nothing to assess.',
  'other-region':
    'This workspace is running, in a region this deployment cannot read. A deployment in that region would cover it.',
  unknown:
    'This assessment names this workspace and the account directory has no row for it. It was cancelled, or the ' +
    'scanning identity can no longer see it — the two cannot be told apart from here. Until it is removed or ' +
    'explained, the assessment covers less than it claims.',
};

const BADGE: Readonly<
  Record<Exclude<RowKind, 'assessable'>, { tone: 'neutral' | 'warning' | 'info'; Icon: typeof Ban }>
> = {
  'not-running': { tone: 'neutral', Icon: Ban },
  'other-region': { tone: 'info', Icon: Globe2 },
  // Warning rather than neutral, because this is the one a reader has to do something about.
  unknown: { tone: 'warning', Icon: CircleHelp },
};

/**
 * The directory's rows, plus one for every selected workspace it does not account for.
 *
 * Exported for its own test. The assembly is the part with a decision in it — everything else here
 * is presentation — and a test that had to drive it through a rendered checkbox would be testing
 * React's event handling on the way to asserting that a cancelled workspace is still listed.
 */
export function rowsFor(workspaces: readonly SelectableWorkspace[], selected: readonly string[]): PickerRow[] {
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const rows: PickerRow[] = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    kind: workspace.assessable ? 'assessable' : (workspace.reason ?? 'unknown'),
    selectable: workspace.assessable,
  }));

  for (const id of selected) {
    if (known.has(id)) continue;
    rows.push({
      id,
      // Its id is the only name there is: a name would have come from the directory.
      name: id,
      kind: 'unknown',
      // Selectable so it can be deselected. An unremovable row would leave the author unable to
      // correct the very thing it is warning them about.
      selectable: true,
    });
  }

  return rows;
}

/** Above this many rows the list gets a filter and scrolls, rather than running off the page. */
const LONG_LIST = 12;

export function WorkspacePicker({ workspaces, selected, onChange, asOf, unavailable, disabled }: WorkspacePickerProps) {
  const [query, setQuery] = useState('');
  const rows = rowsFor(workspaces, selected);
  const chosen = new Set(selected);

  function toggle(id: string): void {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Sorted, so the value handed back matches the order the definition stores and two authors
    // selecting the same estate produce the same request.
    onChange([...next].sort());
  }

  if (rows.length === 0) {
    return (
      <p className="wa-body-compact text-wa-text-muted">
        {unavailable ??
          'The account directory has no workspace available to choose. Use the entire visible account, or check the scanning identity’s access.'}
      </p>
    );
  }

  const assessable = rows.filter((row) => row.kind === 'assessable');
  const long = rows.length > LONG_LIST;
  const term = query.trim().toLowerCase();
  // Filtered for display only. A row hidden by a filter stays selected, because a filter is how the
  // author found the row they wanted rather than a statement about scope — the alternative silently
  // narrows an assessment as a side effect of typing.
  const shown = term === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(term));
  const allChosen = assessable.length > 0 && assessable.every((row) => chosen.has(row.id));

  return (
    <div className="flex flex-col gap-2">
      {unavailable != null && <p className="wa-body-compact text-wa-text-muted">{unavailable}</p>}

      {long && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="wa-field wa-body-compact min-w-0 flex-1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a workspace by name"
            aria-label="Find a workspace by name"
          />
          <button
            type="button"
            className="wa-button-secondary"
            disabled={disabled === true || assessable.length === 0}
            onClick={() =>
              onChange(
                allChosen
                  ? // Only the assessable ones are cleared. An unknown workspace is the one thing here
                    // a reader has to decide about deliberately, and sweeping it out with a bulk action
                    // is how a scope quietly narrows.
                    selected.filter((id) => !assessable.some((row) => row.id === id))
                  : [...new Set([...selected, ...assessable.map((row) => row.id)])].sort()
              )
            }
          >
            {allChosen ? 'Clear the assessable ones' : 'Choose every assessable one'}
          </button>
        </div>
      )}

      <ul
        className={`flex flex-col gap-1${long ? ' max-h-80 overflow-y-auto' : ''}`}
        aria-label="Workspaces this assessment covers"
      >
        {shown.map((row) => {
          const isChosen = chosen.has(row.id);
          // The one thing there might be to say about this row, or nothing. Narrowed once here so
          // the badge, its tone and its explanation are all the same decision.
          const notable = row.kind === 'assessable' ? undefined : row.kind;

          return (
            <li key={row.id}>
              <label
                className={`wa-row flex items-start gap-3${row.selectable ? '' : ' opacity-60'}`}
                data-selected={isChosen}
              >
                <input
                  type="checkbox"
                  className="mt-1 shrink-0"
                  checked={isChosen}
                  disabled={disabled === true || !row.selectable}
                  onChange={() => toggle(row.id)}
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-wa-text truncate font-medium">{row.name}</span>
                    {notable != null && (
                      <Badge tone={BADGE[notable].tone} Icon={BADGE[notable].Icon}>
                        {LABEL[notable]}
                      </Badge>
                    )}
                    {/* The platform's own word, kept beside ours rather than instead of it: "Another
                        region" is why it cannot be covered and RUNNING is what the platform says. */}
                    {row.status != null && row.status !== 'RUNNING' && (
                      <span className="wa-caption font-mono">{row.status}</span>
                    )}
                  </span>
                  {notable != null && <span className="wa-caption">{EXPLANATION[notable]}</span>}
                </span>
              </label>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="wa-caption px-2 py-3">
            No workspace matches “{query}”. {String(selected.length)} chosen workspace
            {selected.length === 1 ? '' : 's'} {selected.length === 1 ? 'is' : 'are'} still in scope.
          </li>
        )}
      </ul>

      <p className="wa-body-compact text-wa-text-muted">
        {describeSelection(rows, selected)}
        {asOf != null && ` The account directory was read ${new Date(asOf).toLocaleDateString()}.`}
      </p>
    </div>
  );
}

/**
 * What the selection amounts to, in a sentence.
 *
 * Says how many of the assessable workspaces were chosen rather than only how many were chosen,
 * because "3 selected" leaves the reader to work out whether that is most of the estate or a corner
 * of it — which is the question a scope is for.
 *
 * The numerator counts only the selected rows that are assessable, and the rest are named separately.
 * Counting every selected id against the assessable total produced "3 of 2 assessable workspaces
 * selected" for a scope holding a stopped or since-deleted workspace, which is both arithmetically
 * impossible and an overstatement of what the run would cover.
 */
export function describeSelection(rows: readonly PickerRow[], selected: readonly string[]): string {
  const chosen = new Set(selected);
  const assessable = rows.filter((row) => row.kind === 'assessable');
  const covered = assessable.filter((row) => chosen.has(row.id)).length;
  const uncovered = selected.length - covered;

  if (selected.length === 0) {
    return 'Nothing selected. An assessment needs at least one workspace, or it can cover the whole account instead.';
  }

  const counted =
    covered === 0
      ? 'None of the assessable workspaces are selected.'
      : `${String(covered)} of ${String(assessable.length)} assessable workspace${assessable.length === 1 ? '' : 's'} selected.`;

  if (uncovered === 0) return counted;
  return (
    `${counted} ${String(uncovered)} other${uncovered === 1 ? '' : 's'} ${uncovered === 1 ? 'is' : 'are'} in scope ` +
    'but cannot be read, so nothing would be measured there.'
  );
}
