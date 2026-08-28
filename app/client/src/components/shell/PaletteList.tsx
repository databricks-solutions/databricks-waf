// The palette's results, as a listbox.
//
// Its own file rather than a section of Palette.tsx, and the reason is testability rather than size:
// Palette.tsx imports AppKit's dialog, and AppKit's entry point reaches its chart components, which do
// not resolve under vitest's node environment. A view that cannot be imported by a test is a view
// whose markup is only ever checked by looking at it — and the four things worth checking here are
// invisible in a screenshot. See PaletteList.test.tsx.
//
// Nothing in here holds state or knows about routing. It is handed groups and told which row is
// active, and it reports a pick by id.

import type { ReactNode } from 'react';
import { OUTCOME_LABEL } from '../verdict-language';
import type { PaletteGroup } from './palette-search';

export interface PaletteListProps {
  readonly groups: readonly PaletteGroup[];
  /** The row that hands an unmatched phrase to the findings page's own search. */
  readonly fallback?: string;
  readonly activeId?: string;
  readonly onPick: (id: string) => void;
}

export function PaletteList({ groups, fallback, activeId, onPick }: PaletteListProps) {
  return (
    <div role="listbox" id="wa-palette-list" aria-label="Results" className="wa-palette-list">
      {groups.map((group) => (
        <div key={group.kind} role="group" aria-labelledby={`wa-palette-heading-${group.kind}`}>
          <p id={`wa-palette-heading-${group.kind}`} className="wa-palette-heading">
            {group.heading}
            {/* A cap that says so. A list that silently stops at twelve teaches the reader that the
                thirteenth requirement is not in the app. */}
            {group.hidden > 0 && ` · ${String(group.hidden)} more, keep typing`}
          </p>
          {group.entries.map((entry) => (
            <Option
              key={entry.id}
              id={entry.id}
              active={entry.id === activeId}
              onPick={onPick}
              {...(entry.detail != null ? { detail: entry.detail } : {})}
              trailing={
                entry.outcome == null ? undefined : (
                  // What the run said, where it said anything. The word rather than a badge: a row of
                  // twelve tinted pills in a menu is a colour chart, and this is a caption on a
                  // destination rather than a verdict being reported.
                  <span className="wa-caption ml-auto shrink-0">{OUTCOME_LABEL[entry.outcome]}</span>
                )
              }
            >
              {entry.label}
            </Option>
          ))}
        </div>
      ))}

      {fallback != null && (
        <div role="group" aria-labelledby="wa-palette-heading-elsewhere">
          {/*
           * The escape hatch, and it is a row of the listbox rather than a note under it so that a
           * reader who has typed a phrase this file cannot place reaches it with the same Enter as
           * everything else. A palette with a dead end is one people stop opening.
           */}
          <p id="wa-palette-heading-elsewhere" className="wa-palette-heading">
            Not a name
          </p>
          <Option
            id="elsewhere"
            active={activeId === 'elsewhere'}
            onPick={onPick}
            detail="The findings page searches inside each requirement, not only its title"
          >
            {fallback}
          </Option>
        </div>
      )}
    </div>
  );
}

function Option({
  id,
  active,
  detail,
  trailing,
  onPick,
  children,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly detail?: string;
  readonly trailing?: ReactNode;
  readonly onPick: (id: string) => void;
  readonly children: ReactNode;
}) {
  return (
    /*
     * A div with a role rather than a button, and that is the combobox pattern rather than a shortcut.
     * A button here would be a tab stop, and a palette whose twelve results are twelve tab stops is one
     * where Tab no longer closes the loop the dialog is holding. The pointer path is this click
     * handler; the keyboard path is the field above, which owns the whole interaction.
     */
    <div
      id={`wa-palette-${id}`}
      role="option"
      aria-selected={active}
      data-active={active}
      className="wa-palette-option"
      onClick={() => onPick(id)}
    >
      <span className="min-w-0">
        <span className="wa-body-compact block truncate">{children}</span>
        {detail != null && <span className="wa-caption block truncate">{detail}</span>}
      </span>
      {trailing}
    </div>
  );
}
