// What a scope would cover, shown while it can still be changed.
//
// The failure this exists to prevent is quiet. A scope naming eleven workspaces of which four were
// decommissioned in July reads as an assessment of eleven, and the run that follows says "assessed 7
// of 11" in a footnote on a page nobody opens before the meeting. The place to find that out is
// here, where the fix is a checkbox rather than a revision.
//
// It resolves against the last scan's directory, not a live read, and says when that was. A live read
// means a second path into the collector and it spends the customer's warehouse; the thing that reads
// the estate live is the preflight, which is a separate action for exactly that reason.

import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import type { ScopePreview as Preview } from '@/api/types';
import { describeOmission } from '../pages/preflight-language';
import { describePreview } from '../pages/setup-language';
import { Disclosure } from './ui/Disclosure';

export interface ScopePreviewProps {
  readonly preview?: Preview;
  readonly loading: boolean;
  /** A sentence, when the preview could not be worked out at all. */
  readonly error?: string;
}

export function ScopePreview({ preview, loading, error }: ScopePreviewProps) {
  if (error != null) {
    return (
      <p className="wa-body-compact text-wa-danger" role="alert">
        {error}
      </p>
    );
  }

  // Loading before the previous answer, because a stale count under a scope the reader has just
  // changed is the one thing this panel must not show: they would act on a number that describes
  // the selection they abandoned.
  if (loading) {
    return <p className="wa-body-compact text-wa-text-muted">Working out what this covers…</p>;
  }

  const omitted = preview?.omitted ?? [];
  const unresolved = preview?.unavailable != null;
  const Icon = unresolved ? Clock : omitted.length > 0 ? AlertTriangle : CheckCircle2;
  const tone = unresolved ? 'text-wa-text-muted' : omitted.length > 0 ? 'text-wa-warning' : 'text-wa-success';

  return (
    <div className="flex flex-col gap-2">
      <p className="wa-body-compact flex items-start gap-2">
        <Icon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
        <span>{describePreview(preview)}</span>
      </p>

      {/* The workspaces that would not be measured, named. A count of four would leave the reader to
          find out which four from the picker above, and the whole point is that one of them is
          probably a surprise. */}
      {omitted.length > 0 && (
        <Disclosure summary={`${String(omitted.length)} would not be measured`}>
          <ul className="flex flex-col gap-1">
            {omitted.map((workspace) => (
              <li key={workspace.workspaceId} className="wa-body-compact text-wa-text-secondary">
                <span className="text-wa-text font-medium">{workspace.name ?? workspace.workspaceId}</span>
                <span className="wa-caption block">{describeOmission(workspace.reason)}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      {preview?.asOf != null && !unresolved && (
        <p className="wa-caption">
          Held against the account directory as the last scan read it, on {new Date(preview.asOf).toLocaleDateString()}.
          A workspace created since then is not in this count.
        </p>
      )}
    </div>
  );
}
