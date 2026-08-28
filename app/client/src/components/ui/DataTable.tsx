// A table whose numbers line up.
//
// The reason to have this rather than write <table> each time is not brevity, it is that three
// properties are easy to forget individually and the whole point of a table is lost without all
// three: numeric columns right-aligned with tabular figures so digits sit in columns, a header
// that stays put while a long list scrolls under it, and an empty state that says which kind of
// empty it is instead of rendering a headed table with no rows.
//
// Deliberately no row selection. A row that selects something has to be reachable by keyboard,
// which in a table means the grid pattern with arrow-key traversal rather than a click handler
// on <tr>. That belongs with the workbench shell where keyboard traversal is being built, not
// smuggled in here as an onClick that mouse users would find and nobody else could. Until then,
// a caller that needs a row to lead somewhere puts a link or a button in a cell.

import type { ReactNode } from 'react';
import { EmptyState, type EmptyStateProps } from './EmptyState';

export interface Column<TRow> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: TRow) => ReactNode;
  /**
   * Right-aligns and applies tabular figures. Set it for anything the reader might compare
   * down the column: counts, sizes, scores, dates.
   */
  readonly numeric?: boolean;
  /** Tailwind width utility. Left unset, the column takes its content's width. */
  readonly width?: string;
}

export interface DataTableProps<TRow> {
  readonly caption: string;
  readonly columns: readonly Column<TRow>[];
  readonly rows: readonly TRow[];
  readonly rowKey: (row: TRow) => string;
  /** Shown in place of the table when there are no rows. */
  readonly empty: EmptyStateProps;
}

export function DataTable<TRow>({ caption, columns, rows, rowKey, empty }: DataTableProps<TRow>) {
  if (rows.length === 0) {
    return <EmptyState {...empty} />;
  }

  return (
    <table className="wa-table" data-responsive-records>
      {/* Visually hidden rather than absent: the caption is what tells a screen-reader user
          what they have landed in, and a table announced only as "table" is a maze. */}
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={[column.numeric === true ? 'text-right' : undefined, column.width]
                .filter((part) => part != null)
                .join(' ')}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td
                key={column.key}
                data-label={typeof column.header === 'string' && column.header !== '' ? column.header : undefined}
                className={column.numeric === true ? 'text-right tabular-nums' : undefined}
              >
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
