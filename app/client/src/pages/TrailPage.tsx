// Every act this app was asked to perform, and how each one ended.
//
// Row 23a built the chained log, the recorder that writes to it and the gate that refuses a route
// which does not. It did not build this, so for two phases the trail was readable only with `curl` —
// which meant the app claimed a capability whose whole point is that somebody outside the team can
// read it, and the one person it was built for could not.
//
// # What this page has that no other page has
//
// The other registers in this app record results: an answer, a decision, a run. This records
// *attempts*, which is the part nobody keeps and everybody eventually needs. Somebody was refused at
// 09:41, somebody exported a run the week before it appeared in a board paper, an import failed twice
// before it took. None of that leaves a row anywhere else, and its absence is invisible.
//
// # Why the filtering happens on the server
//
// This is the one list here with no ceiling. Every mutation adds a row for the life of the install, so
// a page that fetched the lot and filtered in the browser would work for a month and then fail on the
// estate that used the app most. Every filter is therefore a query parameter, and the address bar is the
// whole statement of which acts are being read — which is what lets an auditor send a colleague the exact
// view they are looking at. Typed filters reach it on a settle rather than a keystroke, per `Who`; the
// bounded request size is deliberately not part of the shareable address.
//
// # Why paging is one-directional
//
// The store pages by a `before` cursor, and there is no reverse cursor. Rather than hold a stack of
// visited cursors in component state — a second, private record of where the reader has been, which the
// URL would then contradict — the page offers "earlier" and "back to the newest", and pushes a history
// entry for each. The browser's own back button restores the previous page exactly, because the URL was
// never lying about which page it was.
//
// # Why the page size is bounded
//
// The server returns a bounded page of 25 acts. The cursor exposes every earlier event without turning
// the audit trail into an unbounded client read, and normal document flow keeps the pager reachable at
// every supported width.
//
// The consequence is that the chain's own prose is folded away. What it says about the log is the most
// carefully worded thing in the app and it is four lines long, and four lines above the rows is four
// fewer acts on screen for a reader who has read it once.

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { SETTLE_MS, useAuditTrail, useAuditVerification } from '../api/hooks';
import { CustomerPage, Surface } from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import { Disclosure } from '../components/ui/Disclosure';
import { Badge } from '../components/ui/StatusBadge';
import { TrailEvents } from '../components/TrailEvents';
import { ALL, atPage, isNarrowed, requested, withFilter, withoutNarrowing } from './trail-address';
import {
  OUTCOME_LABEL,
  REASON_NOTE,
  digestBrief,
  headSentence,
  rangeSentence,
  verificationPresentation,
} from './trail-language';
import type { AuditEvent } from '../api/types';

/** The outcomes, in the order the page offers them. Refusals first: they are what most readers came for. */
const OUTCOMES: readonly AuditEvent['outcome'][] = ['refused', 'failed', 'performed'];

export function TrailPage() {
  const [params, setParams] = useSearchParams();
  const verification = useAuditVerification();

  // The fixed bound is request-only; the URL states filters and cursor so a shared address means the
  // same part of the chain without treating presentation density as audit state.
  const trail = useAuditTrail(requested(params, 25));

  const before = params.get('before');
  const action = params.get('action') ?? ALL;
  const outcome = params.get('outcome') ?? ALL;
  const target = params.get('target');

  // Filters replace, so a reader adjusting them does not have to press back once per adjustment to
  // leave the page. Paging pushes, so back goes to the page they were just on.
  const set = (key: string, value: string) => {
    setParams(withFilter(params, key, value), { replace: true });
  };

  const page = (cursor?: number) => {
    setParams(atPage(params, cursor));
  };

  const clear = () => {
    setParams(withoutNarrowing(params), { replace: true });
  };

  const narrowed = isNarrowed(params);

  if (trail.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="The trail">
          <EmptyState
            reason="collector-failed"
            heading="The trail could not be read"
            detail={trail.error}
            action={
              <button type="button" className="wa-button-secondary" onClick={trail.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  const data = trail.data;

  return (
    <CustomerPage>
      {/* Said before anything is read rather than before anything is written, for the reason the
          decisions page gives: by the time somebody is here the acts have happened, and what they need
          to know is that the record they are about to rely on does not survive a restart. */}
      {data != null && !data.durable && (
        <div className="wa-notice-warning flex items-start gap-2" role="alert">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-wa-warning" />
          {/* The link on its own line rather than trailing the sentence, which is the difference between
              this notice and the retention page's: the reason a bind is missing can be a paragraph long,
              and a link that begins mid-line and finishes on the next has a bounding box spanning both,
              whose centre lands in the gap. `check:a11y` reads that at 2.4.11 as a focused control
              something is covering, and measured it here at 860px wide. */}
          <span className="flex min-w-0 flex-col items-start gap-1">
            <p className="wa-body-compact">
              {data.unavailable ??
                'Events are being recorded in memory and will be lost when the app restarts. Bind a Lakebase instance to keep them.'}
            </p>
            <Link className="wa-body-compact text-wa-action hover:underline" to="/diagnostics">
              What this install can reach →
            </Link>
          </span>
        </div>
      )}

      <Surface
        tone="raised"
        label="Activity"
        title="Who did what, and how it ended"
        action={
          // `undefined` rather than `false`: `false != null`, and the header would render its aside
          // element around nothing while the digest is still being fetched.
          verification.data != null ? (
            <Badge
              tone={verificationPresentation(verification.data).tone}
              Icon={verificationPresentation(verification.data).Icon}
            >
              {verificationPresentation(verification.data).label}
            </Badge>
          ) : undefined
        }
      >
        {verification.error != null && (
          <p className="wa-body-compact border-b border-wa-divider px-3 py-2 text-wa-warning" role="status">
            {/* Not silently omitted. A page that showed the acts and quietly dropped the integrity
                claim reads as a verified trail to anybody who was not looking for the badge. */}
            The chain could not be checked, so nothing is being claimed about whether these events are still as they
            were written: {verification.error}
          </p>
        )}

        <search className="grid grid-cols-1 gap-2 border-b border-wa-divider p-2 sm:grid-cols-3">
          <Who applied={params.get('actor') ?? ''} onApply={(value) => set('actor', value)} />
          <Select value={action} onValueChange={(value) => set('action', value)}>
            <SelectTrigger className="wa-select w-full" aria-label="Filter by what was asked for">
              <SelectValue placeholder="Any event" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any event</SelectItem>
              {/* The whole vocabulary, not the values this page happens to hold. "Nobody has ever
                  been refused a definition change" is a question a filter built from what is present
                  cannot express — the answer is the absence. */}
              {(data?.actions ?? []).map((one) => (
                <SelectItem key={one.id} value={one.id}>
                  {one.phrase}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={outcome} onValueChange={(value) => set('outcome', value)}>
            <SelectTrigger className="wa-select w-full" aria-label="Filter by how the event ended">
              <SelectValue placeholder="Any outcome" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any outcome</SelectItem>
              {OUTCOMES.map((value) => (
                <SelectItem key={value} value={value}>
                  {OUTCOME_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </search>

        {target != null && (
          <p className="wa-caption border-b border-wa-divider px-3 py-2 text-wa-text-secondary">
            Showing only events against <span className="wa-code">{target}</span>.{' '}
            <button type="button" className="text-wa-action hover:underline" onClick={() => set('target', '')}>
              Show every event
            </button>
          </p>
        )}

        {data == null ? (
          <EmptyState reason="not-yet-collected" heading="Reading the trail" detail="Fetching the recorded events." />
        ) : (
          // The table takes the slack between the filters and the pager, and its body is what gets
          // measured: the wrapper's own height includes the sticky header row.
          //
          // `data-fit-total` where there is no page either side of this one, which is how a list tells
          // `check:viewport` that the space below its rows is the trail being short rather than a fit that
          // is wrong. Every other list in the app is exempted by the total in its pager's sentence, and
          // this one is cursor-paged — there is no total to state, so a workspace with three recorded acts
          // failed the sweep four times over for having three recorded acts.
          <div>
            <TrailEvents trail={data} narrowed={narrowed} onClear={clear} />
          </div>
        )}

        {/* Rendered whenever there is a cursor or a page below this one, and not only when there are
            rows: an empty page reached by a cursor is exactly where a reader most needs a way back to
            the newest, and a pager that appears with the rows disappears with them. */}
        {data != null && (data.events.length > 0 || before != null) && (
          <nav className="flex items-center justify-between gap-3 px-3 py-2" aria-label="Trail pages">
            <p className="wa-caption wa-numeric" aria-live="polite">
              {rangeSentence(data)}
            </p>
            <span className="flex items-center gap-1">
              <button
                type="button"
                className="wa-button-secondary"
                onClick={() => page(undefined)}
                disabled={before == null}
              >
                <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
                Newest
              </button>
              <button
                type="button"
                className="wa-button-secondary"
                onClick={() => page(data.next)}
                disabled={data.next == null}
              >
                Earlier
                <ChevronRight aria-hidden className="h-3.5 w-3.5" />
              </button>
            </span>
          </nav>
        )}

        <div className="space-y-2 border-t border-wa-divider p-3">
          {/* The head on its own line and always visible, because it is the one value on this page a
              customer is meant to copy somewhere this app cannot reach. What that buys them is inside
              the disclosure with the verification's own sentence, which is where four lines of the most
              carefully worded prose in the app belongs once it has been read. */}
          {data?.head != null && (
            <p className="wa-caption wa-numeric text-wa-text-muted">
              Chain ends at event {data.head.sequence}, digest{' '}
              <span className="wa-code">{digestBrief(data.head.digest)}</span>
            </p>
          )}
          <Disclosure summary="What the chain does and does not prove">
            {data?.head != null && <p>{headSentence(data.head)}</p>}
            {verification.data != null && <p>{verification.data.means}</p>}
            {data != null && data.events.some((event) => event.reason != null) && <p>{REASON_NOTE}</p>}
          </Disclosure>
        </div>
      </Surface>
    </CustomerPage>
  );
}

/**
 * The actor box, which is the one filter a reader types rather than picks.
 *
 * Its own component so it can hold what is being typed without the page holding it. Two things have to
 * be true at once and neither is free:
 *
 *   - Typing does not send a request per character. Each keystroke would be a `search` and a `head`
 *     against the log, and every prefix of an address matches nothing — the store compares the actor
 *     exactly — so the reader would watch "no matching acts" flash on every letter of their colleague's
 *     name. Debounced on the same interval as the draft and the scope preview.
 *   - What is in the box is what the trail is filtered by. The URL can change without the box: back and
 *     forward move between pushed pages, and `clear` empties the filters. So the applied value is
 *     watched, and a box the reader is not editing follows it.
 *
 * Keyed to the applied value by the caller would do the second on its own and lose the first, remounting
 * on every settle and taking the cursor with it.
 */
function Who({ applied, onApply }: { readonly applied: string; readonly onApply: (value: string) => void }) {
  const [typed, setTyped] = useState(applied);
  // What this box last asked for, so a URL change it caused is not read as one it has to follow.
  const [sent, setSent] = useState(applied);

  if (applied !== sent) {
    setSent(applied);
    setTyped(applied);
  }

  /*
   * The caller's latest handler, held so the timer does not depend on it.
   *
   * The page rebuilds `set` on every render, and a timer keyed to it would be cancelled and restarted by
   * any render at all — a page of results arriving, a verification badge appearing — so a reader typing
   * slowly on a busy page would never reach the settle.
   */
  const apply = useRef(onApply);
  useEffect(() => {
    apply.current = onApply;
  }, [onApply]);

  useEffect(() => {
    const value = typed.trim();
    if (value === sent) return;

    const timer = setTimeout(() => {
      setSent(value);
      apply.current(value);
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [typed, sent]);

  return (
    <input
      className="wa-field wa-body-compact w-full"
      placeholder="Who (an email address)"
      aria-label="Filter by who performed the event"
      value={typed}
      onChange={(event) => setTyped(event.target.value)}
    />
  );
}
