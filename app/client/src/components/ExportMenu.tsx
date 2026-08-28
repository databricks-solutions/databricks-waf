// Take the assessment away with you.
//
// Plain anchors to the two export routes rather than a fetch into a blob. The server already sets
// the filename and the disposition, so the browser's own download handling is both less code and
// better behaviour: it streams, it survives a slow response without a spinner nobody wrote, and the
// file lands in the reader's downloads folder with the name the server chose rather than
// `download.csv`.
//
// The run being exported is the one in view, not whichever is newest. On a historic run record
// those differ, and a reader who opened last month's run and pressed Export has asked for last
// month's run — silently handing them today's would be the kind of wrong that only shows up in a
// meeting where somebody has both files open.

import { Download } from 'lucide-react';
import { Link } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@databricks/appkit-ui/react';
import { useAssessmentId, withAssessment } from '../api/assessment-id';

export interface ExportMenuProps {
  /** The immutable final result to export. Raw runs never enable this customer-result control. */
  readonly resultId?: string;
  /** The technical run that supplied the automated evidence, for the checksum record. */
  readonly runId?: string;
  /**
   * Where the printable version of this run lives.
   *
   * Passed in rather than derived from `scanId`, because the two routes are not equivalent: the
   * bare one reads the run the app already has in hand, and the addressed one fetches by id and can
   * legitimately answer "not in the recorded history" on an install running without persistence. The
   * header knows which case it is in; this menu does not.
   */
  readonly reportTo?: string;
}

export function ExportMenu({ resultId, runId, reportTo = '/report' }: ExportMenuProps) {
  const definitionId = useAssessmentId();
  const href = (path: string): string => withAssessment(path, definitionId ?? null) ?? path;
  // Nothing to export is stated by absence rather than by a disabled button. A greyed control on a
  // fresh install invites a reader to wonder what they are missing; there is no scan, and the empty
  // state two inches below already says so.
  if (resultId == null) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="wa-button-secondary">
          <Download aria-hidden className="h-3.5 w-3.5" />
          Export
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {/*
         * The caption is a child of the label rather than the label itself. AppKit's own `text-sm`
         * lives on `DropdownMenuLabel` and beats a class handed to it, so `wa-caption` there kept its
         * colour and lost its 12px — leaving a three-line description set at the same size as the
         * three items under it, reading as a fourth. On a child element it wins normally.
         *
         * `text-wa-text-secondary` rather than the muted grey `wa-caption` carries, for the reason
         * the callout's caption is darkened: this sits on AppKit's popover fill, which is a step
         * above the page surface, and the muted grey measured 4.44:1 against it in dark — just under
         * AA. The secondary tone reaches 6.93:1 there and 9.27:1 in light.
         */}
        <DropdownMenuLabel>
          <span className="wa-caption text-wa-text-secondary">
            Every requirement, including the ones that did not apply, with what was measured and as whom.
          </span>
        </DropdownMenuLabel>
        {/* First, because it is the only one of the three a person reads. The other two are for a
            spreadsheet and for a pipeline, and a reader who wants to forward the review to somebody
            should not have to decide between two machine formats to do it. */}
        <DropdownMenuItem asChild>
          <Link to={reportTo}>Printable report</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          {/* download, so a browser that would rather render text/csv still saves it. */}
          <a href={href(`/api/results/${resultId}/export.csv`)} download>
            Spreadsheet (CSV)
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={href(`/api/results/${resultId}/export.json`)} download>
            Structured data (JSON)
          </a>
        </DropdownMenuItem>

        {/*
         * The same run for a different reader. Three items rather than six, each in the format its
         * reader opens: the two spreadsheet audiences get CSV and the auditor gets the structured
         * form, which is the one that carries what produced the run. Both formats of all four are on
         * the run's own record, with the digest to quote beside each — and that page is where somebody
         * choosing what to send belongs, so it is the last item rather than a fourth column here.
         *
         * The word "audience" is deliberately not on screen. What a reader is choosing is who they are
         * sending it to, and the label says that.
         */}
        <DropdownMenuLabel>
          <span className="wa-caption text-wa-text-secondary">The same run, shaped for who you are sending it to.</span>
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={href(`/api/results/${resultId}/export.csv?variant=executive`)} download>
            For a board or steering group (CSV)
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={href(`/api/results/${resultId}/export.csv?variant=improvement`)} download>
            For whoever is doing the work (CSV)
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={href(`/api/results/${resultId}/export.json?variant=audit`)} download>
            For an auditor (JSON)
          </a>
        </DropdownMenuItem>
        {runId != null && (
          <DropdownMenuItem asChild>
            <Link to={`/history/${runId}?view=cost`}>Every file, with its checksum</Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
