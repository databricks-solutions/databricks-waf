// Starting a run, and naming what it answers to.
//
// The server has read `definitionId` on `/api/scan` since A2 — it resolves the current version and
// takes scope, window and pillars from it — and the client had no way to send one. So every run
// started from the interface was the implicit assessment ADR 0037 was written to remove: scope was
// whatever the calling identity could see, and the run was stamped with nothing. An author could
// define an assessment, agree its scope with whoever owns the estate, check it would run, and then
// have no way to run it. This is the control that reaches it.
//
// A split control rather than a menu in place of the button. Running is the action, and putting it
// behind a disclosure would charge every reader a click to reach the thing they came for; choosing
// the assessment is a setting changed less often. The visible action label stays short and stable.
// The selected assessment's full name and scope belong in the adjacent menu, while the button's
// accessible name preserves the exact target for somebody using assistive technology.
//
// What it does when the install has no assessments is the part the phase left open, and this answers
// it the conservative way: the button still runs, unstamped, exactly as it did before. A first-time
// reader has nothing to name yet, and refusing to measure anything until a form is filled in would
// make the ordering claim on the start page true by making the app useless for the twenty minutes
// before it is. The menu says there are none and offers to define one, which is the nudge without
// the wall.
//
// Whether an unstamped run should stay possible at all once assessments exist is a product question
// rather than a UX one — it decides whether this app can be used without an author, and answering it
// changes what `/api/scan` accepts as much as what this renders. Raised in docs/review-morning.md.
// Until it is answered the option is offered, named for what it costs rather than for what it skips.

import { Link } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Spinner,
} from '@databricks/appkit-ui/react';
import { Check, ChevronDown, Play } from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import { RunScanDialog } from './RunScanDialog';

export function RunScanControl() {
  const { scanning, choices, selected, setChosen } = useAssessment();

  return (
    <div className="flex shrink-0 items-center">
      <RunScanDialog>
        <button
          type="button"
          className="wa-button-primary wa-button-split-start"
          disabled={scanning}
          aria-label={selected == null ? 'Set scope and run assessment' : `Set scope and run: ${selected.name}`}
        >
          {scanning ? (
            <>
              <Spinner className="h-3.5 w-3.5" />
              Scanning
            </>
          ) : (
            <>
              <Play aria-hidden className="h-3.5 w-3.5" />
              Run assessment
            </>
          )}
        </button>
      </RunScanDialog>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Negative margin so the two borders sit on one line rather than reading as 2px. */}
          <button
            type="button"
            className="wa-button-primary wa-button-split-end -ml-px"
            disabled={scanning}
            aria-label="Choose assessment"
          >
            <ChevronDown aria-hidden className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel>Assessment</DropdownMenuLabel>

          {choices.map((choice) => (
            <DropdownMenuItem key={choice.id} onSelect={() => setChosen({ kind: 'one', id: choice.id })}>
              <span className="flex min-w-0 items-start gap-2">
                {/* The tick marks what the button will run, so the menu answers the question the
                    reader opened it with before they read three scopes to work it out. */}
                <Check
                  aria-hidden
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${selected?.id === choice.id ? '' : 'invisible'}`}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{choice.name}</span>
                  {/* The scope, because two assessments on one install differ by it and by little else
                      a reader can see from a name somebody else chose. */}
                  <span className="wa-caption text-wa-text-secondary">{choice.scope}</span>
                </span>
              </span>
            </DropdownMenuItem>
          ))}

          {choices.length === 0 ? (
            <>
              <DropdownMenuLabel>
                <span className="wa-caption text-wa-text-secondary">
                  No saved assessment is available. This run will use the scanning identity’s current access.
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <Link to="/definitions/setup">Define an assessment</Link>
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuLabel>
                <span className="wa-caption text-wa-text-secondary">
                  Without a saved assessment, the run has no recorded scope beyond the scanning identity’s access.
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setChosen({ kind: 'none' })}>
                <span className="flex min-w-0 items-start gap-2">
                  <Check aria-hidden className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${selected == null ? '' : 'invisible'}`} />
                  <span>Without an assessment</span>
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
