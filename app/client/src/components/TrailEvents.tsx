// One page of the trail, as rows.
//
// Its own module rather than a function inside `TrailPage`, for the reason every other testable
// component here has one: the page imports the app kit's select, which does not resolve outside a
// browser build, and a component that cannot be imported by a test is a component whose empty states
// are asserted by hand or not at all. These particular empty states are worth asserting — see the
// test — because the two of them look identical and only one of them is a claim about the install.

import { DataTable, type Column } from './ui/DataTable';
import { Badge, IdentifierBadge } from './ui/StatusBadge';
import {
  NOTHING_MATCHED,
  OUTCOME_LABEL,
  digestBrief,
  executionPhrase,
  momentOf,
  outcomePresentation,
  targetLabel,
} from '../pages/trail-language';
import type { AuditEvent, AuditTrail } from '../api/types';

export interface TrailEventsProps {
  readonly trail: AuditTrail;
  /** Whether the URL asks for less than the whole trail. Decides which kind of empty this is. */
  readonly narrowed: boolean;
  readonly onClear: () => void;
}

export function TrailEvents({ trail, narrowed, onClear }: TrailEventsProps) {
  const phrases = new Map(trail.actions.map((one) => [one.id, one.phrase]));

  const columns: readonly Column<AuditEvent>[] = [
    {
      key: 'sequence',
      header: 'Event',
      numeric: true,
      // The trail's own identity for an act, and what a reader quotes when they raise it with
      // somebody. Shown rather than a row number for that reason.
      cell: (event) => <span className="wa-numeric">{event.sequence}</span>,
    },
    { key: 'at', header: 'When', cell: (event) => <span className="wa-numeric">{momentOf(event.at)}</span> },
    {
      key: 'actor',
      header: 'Who',
      cell: (event) => {
        const as = executionPhrase(event.executionMode);
        return (
          <span className="flex flex-col">
            <span>{event.actor}</span>
            {/* Only when it is not a person. A note beside every row saying "acting as themselves" is
                furniture, where a note on a row the app wrote under its own identity is the answer to
                "who authorised this". No build has written one yet — every act is the caller's own until
                A4 lands the job worker, per `permitted` in routes.ts — so this renders on nothing today
                and is here to be right on the run that changes that. */}
            {as != null && <span className="wa-caption text-wa-text-muted">acting as {as}</span>}
          </span>
        );
      },
    },
    {
      key: 'action',
      header: 'Asked to',
      // The server's phrase, falling back to the identifier. A client open across a deploy that added
      // an act has no phrase for it, and the identifier is worse prose than the phrase and far better
      // than an empty cell.
      cell: (event) => phrases.get(event.action) ?? event.action,
    },
    {
      key: 'target',
      header: 'Against',
      cell: (event) =>
        event.target == null ? (
          // Not a blank. An act with no object is the ordinary shape of a create that failed before it
          // minted an id, and an empty cell reads as a column the app forgot to fill in.
          <span className="wa-caption text-wa-text-muted">Nothing yet named</span>
        ) : (
          <span className="flex flex-col">
            <span className="wa-caption text-wa-text-muted">{targetLabel(event.target.kind)}</span>
            <span className="wa-code">{event.target.id}</span>
            {/* A file's digest, on the only kind of row where the object of the act left the app and
                cannot be looked up here. Brief, like every other digest in this table, with the whole
                of it on the element so a reader comparing a recipient's `shasum` output has it
                without leaving the page. The run page publishes the same value beside the command
                that produces it, which is where somebody doing the check properly should be. */}
            {event.target.digest != null && (
              <span className="wa-caption text-wa-text-muted" title={event.target.digest}>
                content {digestBrief(event.target.digest)}
              </span>
            )}
          </span>
        ),
    },
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (event) => (
        <span className="flex flex-col items-start gap-1">
          <Badge tone={outcomePresentation(event.outcome).tone} Icon={outcomePresentation(event.outcome).Icon}>
            {OUTCOME_LABEL[event.outcome]}
          </Badge>
          {event.reason != null && <IdentifierBadge>{event.reason}</IdentifierBadge>}
        </span>
      ),
    },
    {
      key: 'digest',
      header: 'Digest',
      cell: (event) => <span className="wa-code text-wa-text-muted">{digestBrief(event.digest)}</span>,
    },
  ];

  return (
    <DataTable
      caption="Every event this app recorded, newest first, with who asked and how it ended"
      columns={columns}
      rows={trail.events}
      rowKey={(event) => String(event.sequence)}
      empty={
        narrowed
          ? {
              reason: 'filtered-out',
              detail: NOTHING_MATCHED,
              action: (
                <button type="button" className="wa-button-secondary" onClick={onClear}>
                  Clear filters
                </button>
              ),
            }
          : {
              reason: 'not-yet-collected',
              heading: 'Nothing has been done yet',
              detail:
                'The trail records events that change something — a run started, a requirement answered, a risk accepted. Reading the app records nothing, so an install nobody has changed anything on has an empty trail rather than a broken one.',
            }
      }
    />
  );
}
