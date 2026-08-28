// What this app is being asked to assess.
//
// The app ran one implicit assessment for its whole life before this page existed, whose scope was
// whatever the calling identity could read. That leaves "what was in this review" answerable only
// with a list the app discovered, and "who agreed to that" answerable with nothing.
//
// The page is built around one distinction that the version history makes visible and nothing else
// would. Two adjacent versions sharing a fingerprint changed the description; two with different
// fingerprints changed the question. A reader looking at a score that moved in July needs to know
// which of those happened, and the app knows, so it says.
//
// Each assessment can also be checked against the estate before it is run, which is the second thing
// this page is for. A scan started under-granted does not fail — it reports the checks it could not
// read as unmeasured and computes a score from the rest — so the only place to find out is before,
// and the only useful form of finding out is the exact grant to ask for.
//
// Writing one is not done here. It was, in a panel that asked for everything at once, and the setup
// at /definitions/setup replaced it rather than joining it: two ways to write a definition is two
// places for the validation to disagree, and the one thing the panel could not do is let somebody
// stop half way and go and ask who owns the estate. What this page keeps is the list, the version
// history, the preflight, and the offer to pick up whatever was left unfinished.
//
// What is deliberately not here yet: the first-visit orientation. That is the rest of A2.

import { AlertTriangle, Archive, ArchiveRestore, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useCheckDefinition, useDefinitions, useKeepDraft, useSaveDefinition, useSetupDrafts } from '@/api/hooks';
import type { AssessmentDefinition, Preflight, SetupDraft } from '@/api/types';
import { describeChange, describeOwners, describeScope } from './definitions-language';
import { PreflightReport } from '../components/PreflightReport';
import { CustomerPage, PageLead, Surface } from '../components/system/Surface';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState } from '../components/ui/EmptyState';
import { Pagination } from '../components/ui/Pagination';
import { usePaged } from '../components/ui/paging';

/** Where the setup opens, for a new assessment or for a revision of one. */
function setupFor(definitionId?: string): string {
  return definitionId == null ? '/definitions/setup' : `/definitions/setup?for=${encodeURIComponent(definitionId)}`;
}

export function DefinitionsPage() {
  const definitions = useDefinitions();
  const drafts = useSetupDrafts();
  const checked = useCheckDefinition();
  const kept = useKeepDraft();

  const saved = useSaveDefinition(() => {
    definitions.reload();
  });

  const all = definitions.data?.definitions ?? [];
  const unfinished = drafts.data?.drafts ?? [];

  /*
   * Measured rather than shown in full, which is what it did until 2026-08-05.
   *
   * The list is unbounded and its rows are the tallest in the app — a name, a scope sentence, a
   * purpose, the owners, a version disclosure and three buttons — so five assessments overflowed a
   * 1280x800 window by 293px. It went unnoticed because `check:viewport` needs a browser and an
   * install with assessments in it, and every install anybody had looked at had none.
   *
   * Rows here vary in height more than on any other paginated page: one carries a preflight report
   * and the rest do not, and the disclosure only appears past one version. Four keeps the page
   * bounded without hiding the controls for the selected assessment.
   *
   * Two is the floor rather than the default three, which is the one place this page departs from
   * every other paginated list. Measured: a row is 161px — the tallest in the app, being a name, a
   * scope sentence, a purpose, the owners and three buttons — and the pane is 434px at 1280x800 once
   * the durability banner has taken 76px of it. Three rows is 483px, so the default floor guarantees
   * the overflow it exists to avoid. Holding the floor at three and shortening the row instead was
   * the other way out, and it does not reach: every line here answers a different question a reader
   * has about an assessment, and cutting the gaps to nothing saves twelve pixels of the forty-nine.
   */
  const paged = usePaged(all, 4);

  // Nothing defined yet, and nothing part-written either, so the empty state is the whole page.
  const first = all.length === 0 && unfinished.length === 0 && !definitions.loading && definitions.error == null;

  if (first) {
    return (
      <CustomerPage>
        {definitions.data?.durable === false && (
          <div className="wa-notice-warning flex items-start gap-2" role="alert">
            <AlertTriangle aria-hidden className="text-wa-warning mt-0.5 h-4 w-4 shrink-0" />
            <p className="wa-body-compact">
              {definitions.data.storage ??
                'Definitions are being held in memory and will be lost when the app restarts.'}
            </p>
          </div>
        )}
        <Surface tone="task" title="Assessments">
          <EmptyState
            reason="not-yet-collected"
            heading="No assessment has been defined"
            detail="Define what is in scope, the evidence window and who owns the answer before running the first assessment."
            layout="compact"
            action={
              <Link className="wa-customer-primary-action" to={setupFor()}>
                Define an assessment
              </Link>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <CustomerPage>
      <PageLead
        headingLevel={2}
        title="Assessments"
        summary="Define scope, evidence window, and accountable owners before a run begins."
        actions={
          <Link className="wa-button-primary" to={setupFor()}>
            <Plus aria-hidden className="h-4 w-4" />
            Define an assessment
          </Link>
        }
      />
      {/* Before anything else, because a definition is the thing every later run is stamped with. An
          install that loses them on restart leaves finished assessments unable to say what they were
          of, which is a worse outcome than never having defined one — so it is a banner, not a note
          under the list. */}
      {definitions.data?.durable === false && (
        <div className="wa-notice-warning flex items-start gap-2" role="alert">
          <AlertTriangle aria-hidden className="text-wa-warning mt-0.5 h-4 w-4 shrink-0" />
          <p className="wa-body-compact">
            {definitions.data.storage ?? 'Definitions are being held in memory and will be lost when the app restarts.'}
          </p>
        </div>
      )}

      {/* Archive is pressed from a row rather than from the form, so its refusals have nowhere else to
          land. Without this a denied or lost archive looked like a no-op: the button re-enabled, the
          assessment stayed listed, and nothing said why. */}
      {saved.error != null && (
        <div className="wa-notice-warning flex items-start gap-2" role="alert">
          <AlertTriangle aria-hidden className="text-wa-warning mt-0.5 h-4 w-4 shrink-0" />
          <p className="wa-body-compact">{saved.error}</p>
        </div>
      )}

      {/* Above the assessments, because it is the only thing on this page with something outstanding
          on it. A reader who wrote half an assessment yesterday came back here to finish it, and a
          resume offer under fourteen definitions is one they will not find. */}
      {unfinished.length > 0 && (
        <Surface tone="task" title="Unfinished" description={`${String(unfinished.length)} part-written`}>
          {unfinished.map((draft) => (
            <UnfinishedRow
              key={draft.definitionId ?? 'new'}
              draft={draft}
              onDiscard={() => {
                kept.discard(draft.definitionId);
                drafts.reload();
              }}
            />
          ))}
        </Surface>
      )}

      {/* Takes the canvas, so an install with nothing defined does not draw a short panel above two
          thirds of empty ground — which reads as a page still loading. */}
      <Surface
        tone="raised"
        label="Assessment definitions"
        title="Assessments"
        description={all.length > 0 ? `${String(all.length)} defined` : undefined}
      >
        {definitions.loading && (
          <p className="wa-body-compact text-wa-text-muted px-4 py-3">Reading the definitions…</p>
        )}

        {definitions.error != null && (
          <EmptyState
            reason="collector-failed"
            heading="The definitions could not be read"
            detail={definitions.error}
          />
        )}

        {!definitions.loading && definitions.error == null && all.length === 0 && (
          <EmptyState
            reason="not-yet-collected"
            heading="No assessment has been defined"
            detail={
              'Every run so far has covered whatever the scanning identity could see on the day, which leaves a ' +
              'finished result unable to say what it was of. Define an assessment to record what is in scope, ' +
              'over what window, and who owns the answer.'
            }
            action={
              <Link className="wa-button-primary" to={setupFor()}>
                Define an assessment
              </Link>
            }
          />
        )}

        {all.length > 0 && (
          <>
            <ul className="wa-zebra">
              {paged.rows.map((definition) => (
                <li key={definition.id}>
                  <DefinitionRow
                    definition={definition}
                    onArchive={() => saved.archive(definition.id)}
                    onUnarchive={() => saved.unarchive(definition.id)}
                    onCheck={() => checked.check(definition.id)}
                    busy={saved.saving}
                    checking={checked.checking && checked.forDefinition === definition.id}
                    // Result and refusal both keyed to the assessment they came from. A panel of
                    // grants shown under a different definition would be read as that definition's,
                    // and acting on it would mean asking for grants for a scope nobody checked.
                    {...(checked.forDefinition === definition.id && checked.result != null
                      ? { preflight: checked.result }
                      : {})}
                    {...(checked.forDefinition === definition.id && checked.error != null
                      ? { checkError: checked.error }
                      : {})}
                  />
                </li>
              ))}
            </ul>
            <Pagination paged={paged} noun="assessments" />
          </>
        )}
      </Surface>
    </CustomerPage>
  );
}

/**
 * One assessment somebody started and did not finish.
 *
 * Says what is left rather than how far through it is. A progress bar would need a denominator, and
 * the steps are not equal work: naming it is a sentence, agreeing the scope can be a week.
 */
function UnfinishedRow({ draft, onDiscard }: { readonly draft: SetupDraft; readonly onDiscard: () => void }) {
  const title =
    draft.name ??
    (draft.definitionName != null ? `A revision of ${draft.definitionName}` : 'An assessment with no name yet');

  return (
    <div className="wa-row flex flex-col items-start gap-2">
      <div className="flex w-full flex-wrap items-baseline justify-between gap-2">
        <span className="text-wa-text min-w-0 truncate font-medium">{title}</span>
        <span className="wa-caption shrink-0">Kept {new Date(draft.savedAt).toLocaleDateString()}</span>
      </div>

      {/* The server's own sentence about the assessment having moved underneath this draft. Shown
          here as well as in the setup, because the decision it invites — resume, or throw it away —
          is one a reader can take from the list without opening it. */}
      {draft.warning != null && <p className="wa-body-compact text-wa-warning">{draft.warning}</p>}

      <p className="wa-body-compact text-wa-text-secondary">
        {draft.ready
          ? 'Everything it needs is written. It has not been confirmed, so nothing has been recorded yet.'
          : draft.troubles.map((trouble) => trouble.trouble).join(' ')}
      </p>

      <div className="flex flex-wrap gap-2 pt-1">
        <Link className="wa-button-secondary" to={setupFor(draft.definitionId)}>
          {draft.ready ? 'Confirm it' : 'Pick it up'}
        </Link>
        <button type="button" className="wa-button-secondary" onClick={onDiscard}>
          Throw it away
        </button>
      </div>
    </div>
  );
}

function DefinitionRow({
  definition,
  onArchive,
  onUnarchive,
  onCheck,
  busy,
  checking,
  preflight,
  checkError,
}: {
  readonly definition: AssessmentDefinition;
  readonly onArchive: () => void;
  readonly onUnarchive: () => void;
  readonly onCheck: () => void;
  readonly busy: boolean;
  readonly checking: boolean;
  readonly preflight?: Preflight;
  readonly checkError?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const notice = useId();
  const advice = useId();
  const proceed = useRef<HTMLButtonElement | null>(null);

  // The notice replaces the button that opened it, so without this focus is left on an element that
  // no longer exists and lands on the document body: the warning renders where focus is not, and a
  // screen reader says nothing at all. Moving to the archiving button, described by both paragraphs of
  // the notice, announces what pressing it does and leaves "Leave it open" one tab away. The same fix
  // `43b` made on `/review`, and no criterion `check:a11y` measures would have found either.
  useEffect(() => {
    if (confirming) proceed.current?.focus();
  }, [confirming]);

  const current = definition.versions.at(-1);
  if (current == null) return null;

  const archived = definition.archivedAt != null;

  return (
    <div className="wa-row flex flex-col items-start gap-2">
      <div className="flex w-full flex-wrap items-baseline justify-between gap-2">
        {/* The state goes beside the name rather than into the version caption on the far right, which
            is where it was. An archived assessment is styled like an open one and sits in the same
            list, so on a page of fourteen the only thing distinguishing it was four words at the end
            of a line nobody reads — and the row a reader would then act on is the wrong one. */}
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-wa-text min-w-0 truncate font-medium">{current.attribution.name}</span>
          {archived && <span className="wa-badge shrink-0">Archived</span>}
        </span>
        <span className="wa-caption shrink-0">Version {current.version}</span>
      </div>

      <p className="wa-body-compact text-wa-text-secondary">{describeScope(current)}</p>

      {current.attribution.purpose != null && (
        <p className="wa-body-compact text-wa-text-muted">{current.attribution.purpose}</p>
      )}

      <p className="wa-caption">{describeOwners(current.attribution.owners)}</p>

      {definition.versions.length > 1 && (
        <Disclosure summary={`${String(definition.versions.length)} versions`}>
          <ol className="flex flex-col gap-2">
            {[...definition.versions].reverse().map((version, index, ordered) => (
              <li key={version.version} className="wa-body-compact text-wa-text-secondary">
                <span className="text-wa-text font-medium">Version {version.version}</span>
                {` · ${new Date(version.createdAt).toLocaleDateString()} · ${version.createdBy}`}
                {version.note != null && <span className="text-wa-text-muted"> · {version.note}</span>}
                <p className="wa-caption">{describeChange(version, ordered[index + 1])}</p>
              </li>
            ))}
          </ol>
        </Disclosure>
      )}

      {/* An archived assessment gets one action, and it is the way back. Everything else stays hidden
          because none of it applies: it cannot be run, and revising it is refused by the server. */}
      {archived && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className="wa-button-secondary" onClick={onUnarchive} disabled={busy}>
            <ArchiveRestore aria-hidden className="h-4 w-4" />
            {busy ? 'Putting it back…' : 'Put it back'}
          </button>
        </div>
      )}

      {!archived && !confirming && (
        <div className="flex flex-wrap gap-2 pt-1">
          {/* First of the three, because it is the one to do before a run rather than after a
              change of mind. It executes statements on the customer's warehouse, so it is worded as
              the check it is and not as a preview. */}
          <button type="button" className="wa-button-secondary" onClick={onCheck} disabled={busy || checking}>
            <ShieldCheck aria-hidden className="h-4 w-4" />
            {checking ? 'Checking the sources…' : 'Check it can run'}
          </button>
          <Link className="wa-button-secondary" to={setupFor(definition.id)}>
            Revise
          </Link>
          <button type="button" className="wa-button-secondary" onClick={() => setConfirming(true)} disabled={busy}>
            <Archive aria-hidden className="h-4 w-4" />
            Archive
          </button>
        </div>
      )}

      {/* Two presses, following the removal on the retention page, and for a narrower reason: this
          button sits beside Revise in a list of assessments whose names differ by a word, so the
          mis-click to protect against is archiving the wrong one rather than not meaning to archive.
          What the notice does that a modal would not is name the assessment, which is the fact that
          tells somebody they had the wrong row.

          It says the effect is reversible because it is, and overstating it would be its own bug: the
          text that reads "cannot be undone" beside a button offering to undo it teaches a reader that
          the warnings here are decoration. What it does not soften is the part that is not reversible
          by pressing the other button — a run in flight and a trend somebody is mid-way through. */}
      {!archived && confirming && (
        <div className="wa-notice-warning mt-1 space-y-2">
          <p className="wa-body-compact text-wa-text" id={notice}>
            Archive <span className="font-medium">{current.attribution.name}</span>? It closes to new runs of both kinds
            — a scan and an advisory run — and leaves the list either can be started against. Nothing is deleted: every
            version stays resolvable, finished runs still read back, and you can put it back from this page.
          </p>
          <p className="wa-caption" id={advice}>
            Worth checking first that nobody is part-way through a programme built on it. A trend across its runs stops
            here until it is put back.
          </p>
          <p className="flex flex-wrap gap-2">
            <button
              ref={proceed}
              type="button"
              className="wa-button-primary"
              aria-describedby={`${notice} ${advice}`}
              disabled={busy}
              onClick={() => {
                onArchive();
                setConfirming(false);
              }}
            >
              <Archive aria-hidden className="h-4 w-4" />
              {busy ? 'Archiving…' : 'Archive it'}
            </button>
            <button type="button" className="wa-button-secondary" onClick={() => setConfirming(false)}>
              Leave it open
            </button>
          </p>
        </div>
      )}

      {checkError != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {checkError}
        </p>
      )}

      {preflight != null && <PreflightReport preflight={preflight} />}
    </div>
  );
}
