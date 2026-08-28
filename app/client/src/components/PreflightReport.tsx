// What an assessment would produce as things stand, and what to ask for if that is not enough.
//
// The shape of this is an argument about who reads it. A scan that runs under-granted still finishes:
// the checks it could not read report themselves unmeasured, the score is computed from the rest, and
// the number looks like an answer. So the reader of this panel is somebody deciding whether to press
// the button, and what they need is not a diagnostic dump — it is the one or two lines to send a
// metastore admin, in the order worth chasing, with what each buys.
//
// Hence grants first and sources second. The per-table detail is behind a disclosure because it is
// the evidence for the ask rather than the ask, and a reader who trusts the summary should not have
// to scroll past twenty-eight rows of `readable` to find the button.

import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import type { Preflight } from '@/api/types';
import {
  describeFreshness,
  describeOmission,
  describeReading,
  remediesFor,
  unfixable,
} from '../pages/preflight-language';
import { Disclosure } from './ui/Disclosure';

export interface PreflightReportProps {
  readonly preflight: Preflight;
}

export function PreflightReport({ preflight }: PreflightReportProps) {
  const remedies = remediesFor(preflight);
  const stuck = unfixable(preflight);
  const total = preflight.ready + preflight.blocked.length;
  const omitted = preflight.scope?.omitted ?? [];

  return (
    <section className="border-wa-divider flex flex-col gap-3 border-t pt-3" aria-label="What this assessment can read">
      <div className="flex items-start gap-2">
        {preflight.blocked.length > 0 && (
          <AlertTriangle aria-hidden className="text-wa-warning mt-0.5 h-4 w-4 shrink-0" />
        )}
        <div className="flex flex-col gap-1">
          <p className="wa-body-compact text-wa-text">{preflight.verdict}</p>
          <p className="wa-caption">{describeFreshness(preflight)}</p>
        </div>
      </div>

      {remedies.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="wa-label text-wa-text">What to ask for</p>
          {remedies.map((remedy) => (
            <div key={remedy.grant} className="wa-notice-warning flex flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <code className="wa-code-block min-w-0 flex-1 break-all">{remedy.grant}</code>
                <CopyButton text={remedy.grant} />
              </div>
              <p className="wa-caption">
                {/* The number is the point of the grouping: one line to run, and this is what it
                    buys. Without it the reader is choosing between asks on the strength of a schema
                    name. */}
                Unblocks {remedy.checks} {remedy.checks === 1 ? 'check' : 'checks'} of {total}, by opening{' '}
                {remedy.tables.join(', ')}.
              </p>
            </div>
          ))}
        </div>
      )}

      {stuck.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {/* Not "what a grant will not fix", which was wrong for one of the three things that land
              here: a denial the server declined to write a statement for is a denial a grant would
              fix. What the group has in common is that there is nothing to copy. */}
          <p className="wa-label text-wa-text">Blocked, with no statement to run</p>
          {stuck.map((source) => (
            <div key={source.table} className="flex flex-col gap-0.5">
              <p className="wa-body-compact text-wa-text">{source.table}</p>
              <p className="wa-caption">{describeReading(source)}</p>
              <p className="wa-caption text-wa-text-muted break-words">{source.detail}</p>
            </div>
          ))}
        </div>
      )}

      {/* The verdict already carries the scope in a sentence, so this names the workspaces instead of
          repeating it. "Half the estate" is a fact somebody can act on only once they know which
          half. */}
      {omitted.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="wa-label text-wa-text">
            Not covered ({omitted.length} of {String(omitted.length + (preflight.scope?.assessed.length ?? 0))}{' '}
            workspaces)
          </p>
          <ul className="flex flex-col gap-1">
            {omitted.map((workspace) => (
              <li key={workspace.workspaceId} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-wa-text font-medium">{workspace.name ?? workspace.workspaceId}</span>
                <span className="wa-caption">{describeOmission(workspace.reason)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preflight.sources.length > 0 && (
        <Disclosure summary={`Every source this assessment reads (${String(preflight.sources.length)})`}>
          <ul className="flex flex-col gap-1">
            {preflight.sources.map((source) => (
              <li key={source.table} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-wa-text font-medium">{source.table}</span>
                <span className="wa-caption">{describeReading(source)}</span>
                <span className="wa-caption text-wa-text-muted">
                  {source.blocks.length} {source.blocks.length === 1 ? 'check' : 'checks'}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </section>
  );
}

/**
 * Copies the grant, and says it did.
 *
 * Worth a component rather than an inline handler because the confirmation is the whole value: a copy
 * button that looks identical before and after leaves the reader clicking it twice and then pasting to
 * find out. Falls back to leaving the text selectable — the clipboard API is refused in some embedded
 * contexts, and a button that silently did nothing would be worse than no button.
 */
function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="wa-button-secondary shrink-0"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
