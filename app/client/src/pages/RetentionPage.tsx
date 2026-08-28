// How long this app keeps what it wrote, and the one place anything is deliberately removed.
//
// The gap this closes is not that data was kept too long. It is that there was no way to *state* a
// position: the first question an enterprise privacy review asks is what the retention period is, and
// "forever, and there is no setting" is an answer that ends a procurement conversation. So the periods
// are here, editable, with what each one currently makes eligible beside it — because a period nobody
// can see the effect of is a number somebody sets once and never revisits.
//
// # Why the sweep is the least convenient thing on the page
//
// It is the only act in this app that cannot be undone. Everything else is a statement that a later
// statement can supersede; a removed scan is gone, and the score it contributed to becomes a number
// nothing can be compared against. So it sits last, it states what it would remove before it offers to
// do it, and pressing it sends the count the reader was shown — which the server refuses if the plan has
// moved since. That refusal is the feature: two people on this page, one changing a period and the
// other sweeping, is exactly how a deletion nobody intended happens.
//
// # Why holds are here rather than on a separate page
//
// A hold is only meaningful against a period. Read apart from the numbers it suspends, "assessment is
// held" is a fact with no consequence attached; read beside them, it is the reason 400 records past
// their period are still here.

import { AlertTriangle, Lock, RotateCw, Trash2, Unlock } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useChangeRetention, useRetention } from '../api/hooks';
import type { Retention, RetentionClass } from '../api/types';
import { CustomerPage, PageLead, Surface } from '../components/system';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState } from '../components/ui/EmptyState';
import { Badge } from '../components/ui/StatusBadge';
import {
  CLASS_LABEL,
  CLASS_PURPOSE,
  dayOf,
  eligibilitySentence,
  heldSentence,
  holdSentence,
  inertNotice,
  periodPhrase,
  resetSentence,
  resetWarning,
  RETENTION_CLASSES,
  sweepWarning,
  sweptSentence,
} from './retention-language';

export function RetentionPage() {
  const retention = useRetention();
  const change = useChangeRetention(retention.reload);

  if (retention.error != null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Retention">
          <EmptyState
            reason="collector-failed"
            heading="Could not read the retention position"
            detail={`This page asks the app how long it keeps what it wrote, so this failing means the app could not answer for itself: ${retention.error}`}
            action={
              <button type="button" className="wa-button-secondary" onClick={retention.reload}>
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (retention.data == null) {
    return (
      <CustomerPage>
        <Surface tone="task" label="Retention">
          <EmptyState reason="not-yet-collected" heading="Reading" detail="Counting what is past its period." />
        </Surface>
      </CustomerPage>
    );
  }

  const position = retention.data;
  const inert = inertNotice(position);

  return (
    <CustomerPage>
      <PageLead
        eyebrow="Utility"
        headingLevel={2}
        title="Retention policy and holds"
        summary="Set how long assessment records are kept, preserve records under legal hold, and review removal before it happens."
        actions={
          <button type="button" className="wa-button-secondary" onClick={retention.reload} disabled={retention.loading}>
            <RotateCw aria-hidden className="h-3.5 w-3.5" />
            {retention.loading ? 'Reading' : 'Read again'}
          </button>
        }
      />
      {/* The icon beside the prose rather than inside it, which is the pattern the other three
          durability warnings use. Not only for consistency: an inline link in a paragraph that wraps
          has a bounding box spanning both lines, whose centre falls in the gap between them — which
          `check:a11y` reads at 2.4.11 as a focused control something is covering. */}
      {inert != null && (
        <div className="wa-notice-warning flex items-start gap-2">
          <AlertTriangle aria-hidden className="text-wa-warning mt-0.5 h-4 w-4 shrink-0" />
          <p className="wa-body-compact">
            {inert}{' '}
            <Link className="text-wa-action hover:underline" to="/diagnostics">
              What this install can reach →
            </Link>
          </p>
        </div>
      )}

      {change.error != null && (
        <p className="wa-notice-warning wa-caption" role="alert">
          {change.error}
        </p>
      )}

      {/* The three planes scroll as one column, which is the rule the shell states: a list paginates
          and prose scrolls inside itself, so the page header and the durability warning stay put. The
          alternative is what `check:viewport` measured before this — a canvas 68px taller than the
          window, taking the notice and the reload control off the top of the screen with it. */}
      <div className="space-y-4 pb-4">
        <Surface
          tone="task"
          label="How long records are kept"
          title="Retention periods"
          action={position.setBy != null ? <span className="wa-caption">Last set by {position.setBy}</span> : undefined}
        >
          <ul className="wa-zebra">
            {RETENTION_CLASSES.map((retentionClass) => {
              const planned = position.classes.find((one) => one.retentionClass === retentionClass);
              return planned == null ? null : (
                <ClassRow
                  // The period in the key, so a period changed elsewhere re-seeds the field rather
                  // than leaving the number this reader last typed over the server's own truth.
                  key={`${retentionClass}-${String(planned.periodDays)}`}
                  planned={planned}
                  bounds={position.bounds}
                  working={change.working}
                  onSet={(days) => change.setPeriod(retentionClass, days)}
                />
              );
            })}
          </ul>

          <div className="border-wa-border border-t px-3 py-2">
            <Disclosure summary="Records kept regardless of period">
              <div className="space-y-2" data-technical-evidence>
                {position.exempt.map((one) => (
                  <p key={one.table} className="wa-caption">
                    {one.because}
                  </p>
                ))}
              </div>
            </Disclosure>
          </div>
        </Surface>

        <Holds position={position} change={change} />

        <Sweep position={position} change={change} />

        {/* Last, below the sweep, because it is the sweep's argument taken to its end: the same
            irreversibility over everything rather than over what a period released. */}
        {position.reset != null && <Reset plan={position.reset} change={change} reading={retention.loading} />}
      </div>
    </CustomerPage>
  );
}

/** One class, its period, and what that period currently makes eligible. */
function ClassRow({
  planned,
  bounds,
  working,
  onSet,
}: {
  readonly planned: RetentionClass;
  readonly bounds: Retention['bounds'];
  readonly working: boolean;
  readonly onSet: (days: number) => void;
}) {
  const [days, setDays] = useState(String(planned.periodDays));
  const asked = Number(days);
  const valid = Number.isInteger(asked) && asked >= bounds.least && asked <= bounds.most;
  const changed = asked !== planned.periodDays;
  const held = heldSentence(planned.heldBy);

  return (
    <li className="space-y-2 px-3 py-2.5" data-retention-class={planned.retentionClass}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="wa-body-compact text-wa-text font-medium">{CLASS_LABEL[planned.retentionClass]}</span>
        <span className="wa-caption">{periodPhrase(planned.periodDays)}</span>
        {/* Not a badge: a badge asserts a status, and "the default was something else" is a fact
            about configuration rather than a standing the row is in. */}
        {planned.periodDays !== planned.defaultDays && (
          <span className="wa-caption">default {periodPhrase(planned.defaultDays)}</span>
        )}
        {held != null && (
          <Badge tone="warning" Icon={Lock}>
            Held
          </Badge>
        )}
      </div>

      <p className="wa-caption max-w-prose">{CLASS_PURPOSE[planned.retentionClass]}</p>

      <Disclosure summary={`${String(planned.tables.length)} stored record classes`}>
        <ul className="wa-caption space-y-0.5" data-technical-evidence>
          {planned.tables.map((table) => (
            <li key={table.table}>
              {table.holds}: {eligibilitySentence(table)}
            </li>
          ))}
        </ul>
      </Disclosure>

      {held != null && <p className="wa-caption text-wa-warning">{held}</p>}

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || !changed || working) return;
          onSet(asked);
        }}
      >
        <label className="wa-caption flex items-center gap-1.5">
          Keep for
          <input
            type="number"
            className="wa-field wa-body-compact w-24"
            value={days}
            min={bounds.least}
            max={bounds.most}
            onChange={(event) => setDays(event.target.value)}
            aria-label={`Days to keep ${CLASS_LABEL[planned.retentionClass].toLowerCase()}`}
          />
          days
        </label>
        <button type="submit" className="wa-button-secondary" disabled={!valid || !changed || working}>
          {working ? 'Saving' : 'Save'}
        </button>
        {/* The bound, said where the number is typed rather than after the server refuses it. */}
        {!valid && (
          <span className="wa-caption text-wa-warning">
            Between {String(bounds.least)} and {String(bounds.most)} days.
          </span>
        )}
      </form>
    </li>
  );
}

function Holds({
  position,
  change,
}: {
  readonly position: Retention;
  readonly change: ReturnType<typeof useChangeRetention>;
}) {
  const [reason, setReason] = useState('');
  const [covers, setCovers] = useState<readonly RetentionClass['retentionClass'][]>([]);
  const inForce = position.holds.filter((hold) => hold.releasedAt == null);
  const lifted = position.holds.filter((hold) => hold.releasedAt != null);
  const ready = reason.trim().length >= 10 && covers.length > 0;

  return (
    <Surface
      tone="raised"
      label="Legal holds"
      title="Legal holds"
      action={<span className="wa-caption">{String(inForce.length)} in force</span>}
    >
      <p className="wa-body-compact text-wa-text-secondary max-w-prose px-3 py-2">
        A hold suspends removal for whole classes of record, for as long as it stands. It covers classes rather than
        individual records because a hold exists before anybody knows which record matters.
      </p>

      {position.holds.length > 0 && (
        <ul className="wa-zebra">
          {[...inForce, ...lifted].map((hold) => (
            <li key={hold.id} className="space-y-1 px-3 py-2.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <Badge
                  tone={hold.releasedAt == null ? 'warning' : 'neutral'}
                  Icon={hold.releasedAt == null ? Lock : Unlock}
                >
                  {hold.releasedAt == null ? 'In force' : 'Lifted'}
                </Badge>
                <span className="wa-caption">
                  Placed by {hold.placedBy} on {dayOf(hold.placedAt)}
                </span>
                {hold.releasedAt == null && (
                  <button
                    type="button"
                    className="wa-button-secondary ml-auto"
                    disabled={change.working}
                    onClick={() => change.releaseHold(hold.id)}
                  >
                    <Unlock aria-hidden className="h-3.5 w-3.5" />
                    Lift
                  </button>
                )}
              </div>
              {/* Verbatim. Whoever lifts this will not be whoever placed it. */}
              <p className="wa-body-compact text-wa-text max-w-prose">{hold.reason}</p>
              <p className="wa-caption">{holdSentence(hold)}</p>
            </li>
          ))}
        </ul>
      )}

      <form
        className="border-wa-border flex flex-col gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || change.working) return;
          change.placeHold(reason.trim(), covers);
          setReason('');
          setCovers([]);
        }}
      >
        <label className="wa-caption flex flex-col gap-1">
          Why this hold exists
          <textarea
            className="wa-textarea wa-body-compact"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Litigation over the 2025 audit; preserve everything until counsel says otherwise"
          />
        </label>

        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="wa-caption">What it covers</legend>
          {RETENTION_CLASSES.map((retentionClass) => (
            <label key={retentionClass} className="wa-caption flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={covers.includes(retentionClass)}
                onChange={(event) =>
                  setCovers((chosen) =>
                    event.target.checked ? [...chosen, retentionClass] : chosen.filter((one) => one !== retentionClass)
                  )
                }
              />
              {CLASS_LABEL[retentionClass]}
            </label>
          ))}
        </fieldset>

        <p>
          <button type="submit" className="wa-button-secondary" disabled={!ready || change.working}>
            <Lock aria-hidden className="h-3.5 w-3.5" />
            {change.working ? 'Placing' : 'Place a hold'}
          </button>
        </p>
        {reason.trim() !== '' && reason.trim().length < 10 && (
          <p className="wa-caption text-wa-warning">
            A reason of at least ten characters. Whoever lifts this will not be whoever placed it.
          </p>
        )}
      </form>
    </Surface>
  );
}

/**
 * Removing what is past its period.
 *
 * Two presses rather than one, and the second says the count. Not friction for its own sake: the plan
 * on screen may be minutes old, and the difference between removing four drafts and four thousand scans
 * is one setting somebody changed in another tab.
 */
function Sweep({
  position,
  change,
}: {
  readonly position: Retention;
  readonly change: ReturnType<typeof useChangeRetention>;
}) {
  const [confirming, setConfirming] = useState(false);
  const notice = useId();
  const proceed = useRef<HTMLButtonElement | null>(null);
  const nothing = position.wouldRemove === 0;

  // The notice replaces the button that opened it, so focus is left on an element that no longer
  // exists and falls to the document body: a reader using a screen reader is told nothing, on the one
  // press in this plane that cannot be undone. Moved to the removing button and described by the
  // notice, which is what `43b` did on `/review`. No criterion `check:a11y` measures catches this.
  useEffect(() => {
    if (confirming) proceed.current?.focus();
  }, [confirming]);

  return (
    <Surface tone="raised" label="Remove what is past its period" title="Removal">
      <div className="space-y-2 p-3">
        <p className="wa-body-compact text-wa-text max-w-prose">{sweepWarning(position)}</p>

        <p className="wa-caption max-w-prose">
          Nothing is removed on a timer. This app has no unattended worker, and a retention policy enforced by a
          background timer in a web process stops being enforced the moment the platform scales the app to zero —
          silently, which is the worst way for a deletion guarantee to fail. So removal is something a named person asks
          for, and the trail records who.
        </p>

        {change.swept != null && (
          <p className="wa-body-compact text-wa-text" role="status">
            {sweptSentence(change.swept)}{' '}
            <Link className="text-wa-action hover:underline" to="/trail?action=retention.sweep">
              The event itself is recorded, with who asked for it →
            </Link>
          </p>
        )}

        {!confirming && (
          <button
            type="button"
            className="wa-button-secondary"
            disabled={nothing || change.working}
            onClick={() => setConfirming(true)}
          >
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
            Remove {String(position.wouldRemove)} {position.wouldRemove === 1 ? 'record' : 'records'}
          </button>
        )}

        {confirming && (
          <div className="wa-notice-warning space-y-2">
            <p className="wa-body-compact text-wa-text" id={notice}>
              This removes {String(position.wouldRemove)} {position.wouldRemove === 1 ? 'record' : 'records'} and cannot
              be undone. If somebody has changed a period or placed a hold since this page was read, nothing will be
              removed and you will be told what the plan says now.
            </p>
            <p className="flex flex-wrap gap-2">
              <button
                ref={proceed}
                type="button"
                className="wa-button-primary"
                aria-describedby={notice}
                disabled={change.working}
                onClick={() => {
                  change.sweep(position.wouldRemove);
                  setConfirming(false);
                }}
              >
                {change.working ? 'Removing' : 'Remove them'}
              </button>
              <button type="button" className="wa-button-secondary" onClick={() => setConfirming(false)}>
                Keep everything
              </button>
            </p>
          </div>
        )}
      </div>
    </Surface>
  );
}

/**
 * Emptying the install.
 *
 * The one thing here the sweep does not do is ask the reader to type the number. Two presses is
 * proportionate to removing what a period already released; it is not proportionate to removing the
 * definitions, the trail and every record at once, because two presses is also what a reader who
 * mistook this plane for the one above it would give it. Typing the count cannot be done by mistake,
 * and the number typed is the same number the server checks — so the confirmation and the check are one
 * act rather than a ritual in front of one.
 *
 * The count is `records` rather than every row for the reason the hook gives: `events` moves whenever
 * anybody does anything, this page included, so a number that contained it would be stale before it
 * could be typed.
 */
function Reset({
  plan,
  change,
  reading,
}: {
  readonly plan: NonNullable<Retention['reset']>;
  readonly change: ReturnType<typeof useChangeRetention>;
  /**
   * True while the position is being read again.
   *
   * Which matters here and nowhere else on the page: counting sixteen tables takes seconds, so for
   * those seconds after a reset the plan in hand is the one from before it, and the warning drawn from
   * it would sit directly beneath "75 rows removed" saying 30 records *would* be removed. Two numbers
   * about the same install contradicting each other, on the page whose whole job is to be believed
   * about what it destroyed.
   */
  readonly reading: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const notice = useId();
  const count = useRef<HTMLInputElement | null>(null);
  const held = plan.heldBy.length > 0;
  const nothing = plan.records === 0 && plan.events === 0;
  const matches = typed.trim() === String(plan.records);
  // Only after an act. A slow first read shows the warning when it arrives and has nothing to
  // contradict in the meantime, so suppressing it there would be a blank plane for no reason.
  const stale = reading && change.emptied != null;

  // The field rather than the submit button, which is the difference between this notice and the two
  // others: the submit button is disabled until the count is typed, focus cannot rest on a disabled
  // control, and the field is the next thing the reader has to do anyway. Described by the notice, so
  // the consequence is announced with it — the whole point of asking for the number is that this press
  // cannot be made by mistake, and a reader who was told nothing has been asked for nothing.
  useEffect(() => {
    if (confirming) count.current?.focus();
  }, [confirming]);

  return (
    <Surface
      tone="accent"
      label="Delete assessment data"
      title="Delete assessment data"
      action={
        held ? (
          <Badge tone="warning" Icon={Lock}>
            Held
          </Badge>
        ) : undefined
      }
    >
      <div className="space-y-2 p-3">
        <p className="wa-body-compact text-wa-text max-w-prose">
          {stale ? 'Reading what is left.' : resetWarning(plan)}
        </p>

        <p className="wa-caption max-w-prose">
          This exists for handing an install on: a workspace that was used for a pilot, or one that assessed an estate
          somebody no longer works with. It is not a way to correct a mistake — a wrong answer is superseded by
          answering again, and a scan that read the wrong estate is superseded by scanning the right one. Both leave the
          correction readable, which this does not.
        </p>

        {change.emptied != null && (
          <p className="wa-body-compact text-wa-text" role="status">
            {resetSentence(change.emptied)}{' '}
            <Link className="text-wa-action hover:underline" to="/trail">
              The trail now begins with that event →
            </Link>
          </p>
        )}

        {!confirming && (
          <button
            type="button"
            className="wa-button-secondary"
            disabled={held || nothing || stale || change.working}
            onClick={() => {
              setTyped('');
              setConfirming(true);
            }}
          >
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
            Delete assessment data
          </button>
        )}

        {confirming && (
          <form
            className="wa-notice-warning space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!matches || change.working) return;
              change.reset(plan.records);
              setConfirming(false);
              setTyped('');
            }}
          >
            <p className="wa-body-compact text-wa-text" id={notice}>
              Every table listed above will be deleted, along with the assessment definitions and the audit trail. There
              is no undo and no copy. If a hold is placed while this is being prepared, nothing will be removed.
            </p>

            {/* The tables named rather than counted. A reader about to empty sixteen tables should be
                able to see which sixteen, and the list is the same one the server works from. */}
            <details>
              <summary className="wa-caption cursor-pointer">What will be deleted</summary>
              <ul className="wa-caption mt-1 space-y-0.5">
                {plan.tables.map((table) => (
                  <li key={table.table}>
                    {table.holds}: {table.rows === 0 ? 'nothing' : `${String(table.rows)} rows`}
                    {table.swept ? '' : ', which no retention period ever removes'}
                  </li>
                ))}
              </ul>
            </details>

            <label className="wa-caption flex flex-wrap items-center gap-1.5">
              Type {String(plan.records)} to confirm
              <input
                ref={count}
                type="text"
                inputMode="numeric"
                className="wa-field wa-body-compact w-24"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                aria-label={`Type ${String(plan.records)} to confirm deleting assessment data`}
                aria-describedby={notice}
              />
            </label>

            <p className="flex flex-wrap gap-2">
              <button type="submit" className="wa-button-primary" disabled={!matches || change.working}>
                {change.working ? 'Deleting…' : 'Delete data'}
              </button>
              <button
                type="button"
                className="wa-button-secondary"
                onClick={() => {
                  setConfirming(false);
                  setTyped('');
                }}
              >
                Keep everything
              </button>
            </p>
          </form>
        )}
      </div>
    </Surface>
  );
}
