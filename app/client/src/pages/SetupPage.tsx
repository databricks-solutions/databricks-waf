// Writing an assessment, over as many sittings as it takes.
//
// The form this replaces asked for a name, a purpose, the people accountable, which workspaces and
// how far back — all at once, in one panel, holding every answer in a component. "Which workspaces"
// is usually not the author's question, and the honest thing to do at that point is stop and go and
// ask somebody. Doing that lost everything typed, because a reload is a new component. So the form
// taught authors to finish in one sitting with whatever they could guess, which is how a definition
// comes to name a scope nobody agreed to.
//
// Two things here are worth reading twice.
//
// What is unfinished, and where the reader is put back, come from the server rather than from a copy
// of those rules in the browser. The contents strip therefore describes what is *saved*, not what is
// on screen, which is why the panel says when it was last kept — a strip that reported the state of
// the textbox would be a second implementation of the validation the confirmation is refused by, and
// the two would disagree within a month.
//
// And the two steps with no field on them are not padding. `sources` says what a run will read and
// what it cannot read at all; `policies` says how the result will be judged. An author who does not
// know that an under-granted scan still produces a score will read that score as an assessment of
// the estate rather than of the part of it the app could see, and this is the only place in the app
// that tells them before they run one.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CircleDashed, Info, Trash2 } from 'lucide-react';
import {
  useDefinitions,
  useKeepDraft,
  usePlan,
  useSaveDefinition,
  useScopePreview,
  useSelectableWorkspaces,
  useSetupDrafts,
  type DefinitionDraft,
  type DraftContent,
} from '@/api/hooks';
import type { AssessmentDefinition, DraftTarget, PillarPlan, SetupDraft } from '@/api/types';
import { ScopePreview } from '../components/ScopePreview';
import { AssessmentJourney } from '../components/AssessmentJourney';
import { WorkspacePicker } from '../components/WorkspacePicker';
import { CustomerPage, Surface, TaskWorkspace } from '../components/system';
import { EmptyState } from '../components/ui/EmptyState';
import {
  POLICIES,
  SETUP_STEPS,
  STEPS,
  describePillars,
  describeSaving,
  describeSources,
  describeTargets,
  listTargets,
  standingOfStep,
  stepFrom,
  troublesOn,
  type SetupStep,
} from './setup-language';

const MIN_LOOKBACK = 1;
const MAX_LOOKBACK = 365;

export function SetupPage() {
  const [params] = useSearchParams();
  const target = params.get('for') ?? undefined;

  const drafts = useSetupDrafts();
  const definitions = useDefinitions();

  // Both are needed before the fields can be initialised, and initialising them twice is what a
  // wizard must not do: the second pass would overwrite whatever the reader typed in the first.
  // So the form is not mounted until there is something to mount it from, and it is keyed on the
  // target so switching assessments remounts rather than reuses.
  if (drafts.loading || definitions.loading) {
    return (
      <CustomerPage>
        <AssessmentJourney current="prepare" detail="Reading any saved preparation before collection begins." />
        <Surface tone="task" label="Loading assessment preparation">
          <EmptyState
            reason="not-yet-collected"
            heading="Reading what you have written"
            detail="Fetching any unfinished assessment, and the versions of the one being revised."
          />
        </Surface>
      </CustomerPage>
    );
  }

  if (drafts.error != null || definitions.error != null) {
    return (
      <CustomerPage>
        <AssessmentJourney
          current="prepare"
          detail="Preparation is the first stage. The Dashboard remains available while setup access is restored."
        />
        <Surface tone="task" label="Assessment setup unavailable">
          <EmptyState
            reason="collector-failed"
            heading="The setup could not be opened"
            detail={drafts.error ?? definitions.error ?? ''}
            action={
              <button
                type="button"
                className="wa-button-secondary"
                onClick={() => {
                  drafts.reload();
                  definitions.reload();
                }}
              >
                Try again
              </button>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  const draft = drafts.data?.drafts.find((one) => one.definitionId === target);
  const definition = target == null ? undefined : definitions.data?.definitions.find((one) => one.id === target);

  // A revision of something that is not there. The draft's own `standing` says the same thing when
  // there is a draft; this is the case where the reader followed a link to revise an assessment that
  // has since gone, and there is nothing to put on the screen but the reason.
  if (target != null && definition == null) {
    return (
      <CustomerPage>
        <AssessmentJourney
          current="prepare"
          detail="The requested assessment cannot be revised, but a new preparation can still be started."
        />
        <Surface tone="task" label="Assessment not found">
          <EmptyState
            reason="nothing-to-report"
            heading="That assessment is not here"
            detail={
              'The link asked to revise an assessment this app cannot find. It was removed, or this install lost ' +
              'the database it keeps definitions in. Defining a new one is still possible.'
            }
            action={
              <Link className="wa-button-secondary" to="/definitions/setup">
                Define a new assessment
              </Link>
            }
          />
        </Surface>
      </CustomerPage>
    );
  }

  return (
    <Setup
      key={target ?? 'new'}
      {...(draft != null ? { draft } : {})}
      {...(definition != null ? { definition } : {})}
      durable={drafts.data?.durable ?? false}
      onSaved={() => {
        // The server forgets the draft when the definition lands, so the list this page read on the
        // way in is now wrong. Re-read rather than patch: the definitions list changed too.
        drafts.reload();
        definitions.reload();
      }}
    />
  );
}

interface SetupProps {
  readonly draft?: SetupDraft;
  readonly definition?: AssessmentDefinition;
  readonly durable: boolean;
  readonly onSaved: () => void;
}

function Setup({ draft, definition, durable, onSaved }: SetupProps) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const workspaces = useSelectableWorkspaces();
  const plan = usePlan();
  const kept = useKeepDraft();

  const current = definition?.versions.at(-1);

  // The draft wins over the definition, field by field, because a draft is a revision in progress
  // and its whole purpose is to hold what the author changed. Where the draft is silent the
  // definition's current version is the honest starting point.
  const [name, setName] = useState(draft?.name ?? current?.attribution.name ?? '');
  const [purpose, setPurpose] = useState(draft?.purpose ?? current?.attribution.purpose ?? '');
  const [owners, setOwners] = useState((draft?.owners ?? current?.attribution.owners ?? []).join(', '));
  const [lookback, setLookback] = useState(String(draft?.lookbackDays ?? current?.measurement.lookbackDays ?? 30));
  const [wholeAccount, setWholeAccount] = useState(
    (draft?.scope?.kind ?? current?.measurement.scope.kind ?? 'account') !== 'selected'
  );
  const [selected, setSelected] = useState<readonly string[]>(
    draft?.scope?.workspaceIds ?? current?.measurement.scope.workspaceIds ?? []
  );
  const [chosenPillars, setChosenPillars] = useState<readonly string[] | undefined>(
    draft?.pillars ?? current?.measurement.pillars
  );
  const [targets, setTargets] = useState<readonly DraftTarget[]>(draft?.targets ?? current?.targets ?? []);
  const [note, setNote] = useState(draft?.note ?? '');

  /*
   * The version this revision was started from.
   *
   * Taken from the draft when there is one, and from the definition only when starting fresh. Reading
   * it from the definition every time would defeat the check it exists for: the server compares it
   * with what is current in order to notice that somebody else revised the assessment while this
   * draft sat unfinished, and a value re-read on load always agrees.
   */
  const fromVersion = draft?.fromVersion ?? current?.version;

  const lookbackDays = Number(lookback);
  const owned = useMemo(
    () =>
      owners
        .split(',')
        .map((owner) => owner.trim())
        .filter((owner) => owner !== ''),
    [owners]
  );

  const content = useMemo<DraftContent>(
    () => ({
      ...(definition != null ? { definitionId: definition.id } : {}),
      ...(fromVersion != null ? { fromVersion } : {}),
      name,
      purpose,
      owners: owned,
      scope: wholeAccount ? { kind: 'account' } : { kind: 'selected', workspaceIds: selected },
      // Sent only when it is a number the server can hold. A half-typed "3" on the way to "30" is a
      // legitimate keystroke and not a lookback anybody chose, and sending `NaN` would come back as
      // a complaint about a value the reader never typed.
      ...(Number.isFinite(lookbackDays) && lookback.trim() !== '' ? { lookbackDays } : {}),
      ...(chosenPillars != null ? { pillars: chosenPillars } : {}),
      // Half-written rows are sent as they are, because that is what the step is for: the trouble
      // beside it is the server's reading of the same row, and dropping it here would lose the
      // author's work and the complaint about it in one go. A row with no pillar at all is not sent,
      // being an empty line somebody added and has not used yet.
      ...(named(targets).length > 0 ? { targets: named(targets) } : {}),
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
    }),
    [
      definition,
      fromVersion,
      name,
      purpose,
      owned,
      wholeAccount,
      selected,
      lookback,
      lookbackDays,
      chosenPillars,
      targets,
      note,
    ]
  );

  /*
   * Kept as it is written, but never on arrival.
   *
   * The first run is skipped deliberately. Without that, opening the page would write a draft nobody
   * asked for — so the definitions list would offer to resume an assessment whose author had looked
   * at the first step and left, forever.
   *
   * On the content and the one function, never on the whole hook. `useKeepDraft` returns a fresh
   * object every render, so depending on it would re-run this on the render that reports the save —
   * which schedules another save, which reports again. A save loop, at one request per 600ms, against
   * the customer's database, for as long as the tab is open.
   *
   * And "nothing has been typed" is decided by comparing the content with what the page opened
   * holding, rather than by skipping the first run. Skipping the first run was the first attempt and
   * it wrote a draft on arrival anyway: an effect runs twice on mount under React's strict mode, and
   * the second run found the flag already lowered. Comparing is true however many times it runs.
   */
  const keep = kept.keep;
  const opened = useRef(JSON.stringify(content));
  const written = useRef(false);
  useEffect(() => {
    const held = JSON.stringify(content);
    // Once something has been kept, everything after it is kept too — including a change back to
    // what the page opened with, which is a deliberate edit and not the absence of one.
    if (!written.current && held === opened.current) return;
    written.current = true;
    keep(content);
  }, [content, keep]);

  const scope = useMemo(
    () => (wholeAccount ? { kind: 'account' as const } : { kind: 'selected' as const, workspaceIds: selected }),
    [wholeAccount, selected]
  );
  const preview = useScopePreview(scope);

  const saved = useSaveDefinition(() => {
    onSaved();
    void navigate('/definitions');
  });

  // The server's reading of the draft, which is where the strip and the confirmation get their
  // answers. Before the first save that is whatever was loaded; after it, the last response.
  const state = kept.kept ?? draft;

  /*
   * When it was last kept, from the draft rather than from this session.
   *
   * `useKeepDraft` only knows about saves it made, so a reader resuming yesterday's draft was told
   * "nothing is saved yet" about work that was plainly saved — the wizard had just filled five steps
   * in from it.
   */
  const saving = {
    saving: kept.saving,
    ...(state?.savedAt != null ? { savedAt: state.savedAt } : {}),
    ...(kept.error != null ? { error: kept.error } : {}),
  };

  /*
   * The step on screen: the one asked for, or the one the server says the work stopped at.
   *
   * A step in the URL wins so the setup is linkable and the back button works. Without one it
   * resumes, and the resume point is derived from what is unfinished rather than stored — so a draft
   * edited from a phone opens on what is actually missing rather than on wherever the laptop had got
   * to. See ADR 0036 and setup.ts.
   */
  const asked = stepFrom(params.get('step'));
  const showing: SetupStep = asked ?? stepFrom(state?.resumeAt) ?? 'purpose';

  const go = (next: SetupStep): void => {
    const query = new URLSearchParams(params);
    query.set('step', next);
    setParams(query);
  };

  /*
   * The URL catches up with the step on screen.
   *
   * Without this the address bar says `/definitions/setup` while the pane shows the scope step, so
   * copying the link to hand the setup to whoever owns the estate sends them back to wherever *their*
   * resume lands. Replaced rather than pushed: the resume is not a navigation the reader made, and a
   * back button that returns to the same page is a trap.
   */
  useEffect(() => {
    if (asked != null) return;
    const query = new URLSearchParams(params);
    query.set('step', showing);
    setParams(query, { replace: true });
    // `params` and `setParams` are stable enough for this to be about the step alone: depending on
    // the search params would re-run it on every other parameter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, showing]);

  const at = SETUP_STEPS.indexOf(showing);
  const previous = SETUP_STEPS[at - 1];
  const next = SETUP_STEPS[at + 1];

  const measured = (plan.data?.pillars ?? []).filter((pillar) => pillar.measured);

  // The catalogue's own title for a pillar, falling back to its id. The id is what a target stores and
  // what the plan may not have loaded yet, and showing `cost-optimization` in a sentence about a
  // commitment is the app putting its internals in front of somebody making a promise.
  const titleOf = (pillarId: string): string =>
    measured.find((pillar) => pillar.pillarId === pillarId)?.title ?? pillarId;

  // A revision of something that can no longer take one. The draft keeps everything that was written;
  // what changes is where it lands.
  const orphaned = state?.standing === 'archived' || state?.standing === 'gone';

  function submit(): void {
    const request: DefinitionDraft = {
      measurement: {
        scope: wholeAccount ? { kind: 'account' } : { kind: 'selected', workspaceIds: selected },
        lookbackDays,
        ...(chosenPillars != null ? { pillars: chosenPillars } : {}),
      },
      attribution: {
        name: name.trim(),
        ...(purpose.trim() !== '' ? { purpose: purpose.trim() } : {}),
        owners: owned,
      },
      ...(fromVersion != null ? { fromVersion } : {}),
      // Only the whole ones. A definition has no shape for half a commitment, and the button that
      // gets here is disabled while the draft still holds one — so this filter is what makes the
      // types honest rather than a second place the rule lives.
      ...(whole(targets).length > 0 ? { targets: whole(targets) } : {}),
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
    };
    // Whatever is pending goes first, so a draft left behind by a failed save is the one the reader
    // was looking at rather than the one they had before their last sentence.
    kept.flush();
    // An archived assessment cannot take another version, and the warning at the top of the page says
    // what is left: this becomes a new assessment. Posting the revision anyway would be a refusal the
    // reader had already been told about and could do nothing with.
    saved.save(orphaned ? undefined : definition?.id, request);
  }

  return (
    <CustomerPage>
      <AssessmentJourney
        current="prepare"
        detail="Agree the assessment purpose, ownership, scope, evidence sources and policies before collection begins."
      />
      {/* The standing of the draft against the world, before anything else on the page. A reader who
          is about to re-read five steps and press the last button needs to know now that somebody
          else has revised the assessment underneath them — the alternative is a 409 at the end. */}
      {state?.warning != null && (
        <div className="wa-notice-warning flex items-start gap-2" role="alert">
          <AlertTriangle aria-hidden className="text-wa-warning mt-0.5 h-4 w-4 shrink-0" />
          <p className="wa-body-compact">{state.warning}</p>
        </div>
      )}

      <TaskWorkspace
        queueLabel="The steps of this setup"
        taskLabel={STEPS[showing].title}
        queue={
          <Surface
            tone="raised"
            label="The steps of this setup"
            title={definition == null ? 'A new assessment' : 'Revising'}
            action={
              <Link className="wa-button-secondary shrink-0" to="/definitions">
                All assessments
              </Link>
            }
          >
            <ol>
              {SETUP_STEPS.map((one) => {
                const standing = standingOfStep(state, one);
                const troubles = troublesOn(state, one);
                return (
                  <li key={one}>
                    <button
                      type="button"
                      className="wa-row flex w-full items-start gap-2 text-left"
                      data-selected={one === showing}
                      onClick={() => go(one)}
                    >
                      {standing === 'done' ? (
                        <Check aria-hidden className="text-wa-success mt-0.5 h-4 w-4 shrink-0" />
                      ) : standing === 'nothing-to-fill-in' ? (
                        <Info aria-hidden className="text-wa-text-muted mt-0.5 h-4 w-4 shrink-0" />
                      ) : (
                        <CircleDashed aria-hidden className="text-wa-text-muted mt-0.5 h-4 w-4 shrink-0" />
                      )}
                      <span className="flex min-w-0 flex-col">
                        <span className="text-wa-text font-medium">{STEPS[one].title}</span>
                        {/* What is outstanding, in the server's words, rather than a red dot. A reader
                          coming back after a week needs to know which answer is missing, and they
                          are already looking at the list of steps. */}
                        {troubles.length > 0 && <span className="wa-caption">{troubles.join(' ')}</span>}
                        {standing === 'nothing-to-fill-in' && <span className="wa-caption">Nothing to fill in.</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="border-wa-divider border-t p-2">
              <p className="wa-caption">{describeSaving(saving, durable)}</p>
              {state != null && (
                <button
                  type="button"
                  className="wa-button-secondary mt-2"
                  onClick={() => {
                    kept.discard(definition?.id);
                    onSaved();
                    void navigate('/definitions');
                  }}
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                  Throw this away
                </button>
              )}
            </div>
          </Surface>
        }

        task={
          <Surface
            tone="task"
            label={STEPS[showing].title}
            title={STEPS[showing].title}
            action={<span className="wa-caption">{`Step ${String(at + 1)} of ${String(SETUP_STEPS.length)}`}</span>}
          >
            <div className="flex flex-col gap-4 px-4 py-3">
              <p className="wa-body-compact text-wa-text-secondary max-w-prose">{STEPS[showing].blurb}</p>

              {showing === 'purpose' && (
                <PurposeStep
                  name={name}
                  onName={setName}
                  purpose={purpose}
                  onPurpose={setPurpose}
                  owners={owners}
                  onOwners={setOwners}
                />
              )}

              {showing === 'scope' && (
                <ScopeStep
                  wholeAccount={wholeAccount}
                  onWholeAccount={setWholeAccount}
                  selected={selected}
                  onSelected={setSelected}
                  lookback={lookback}
                  onLookback={setLookback}
                  workspaces={workspaces}
                  preview={preview}
                />
              )}

              {showing === 'sources' && (
                <SourcesStep
                  pillars={measured}
                  loading={plan.loading}
                  chosen={chosenPillars}
                  onChosen={setChosenPillars}
                />
              )}

              {showing === 'targets' && (
                <TargetsStep
                  pillars={measured}
                  chosen={chosenPillars}
                  targets={targets}
                  onTargets={setTargets}
                  pillarTitle={titleOf}
                  troubles={troublesOn(state, 'targets')}
                />
              )}

              {showing === 'policies' && <PoliciesStep />}

              {showing === 'confirm' && (
                <ConfirmStep
                  state={state}
                  definition={definition}
                  pillarCount={measured.length}
                  chosen={chosenPillars}
                  targets={targets}
                  pillarTitle={titleOf}
                  preview={preview}
                  orphaned={orphaned}
                  note={note}
                  onNote={setNote}
                  saving={saved.saving}
                  {...(saved.error != null ? { error: saved.error } : {})}
                  onSubmit={submit}
                  onGo={go}
                />
              )}
            </div>

            <div className="border-wa-divider border-t p-3">
              {/* The saving sentence is beside the discard button on the strip and not repeated here: two
                copies of "nothing is saved yet" on one screen read as two different claims about two
                different things, and a reader looks for the difference. */}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="wa-button-secondary"
                    disabled={previous == null}
                    onClick={() => previous != null && go(previous)}
                  >
                    <ArrowLeft aria-hidden className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    type="button"
                    className="wa-button-primary"
                    disabled={next == null}
                    onClick={() => next != null && go(next)}
                  >
                    Next
                    <ArrowRight aria-hidden className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </Surface>
        }
      />
    </CustomerPage>
  );
}

/** The rows worth sending: an empty line the author added and has not used yet is not one. */
function named(targets: readonly DraftTarget[]): readonly DraftTarget[] {
  return targets.filter((target) => target.pillar.trim() !== '');
}

/** The rows a definition can hold: a pillar, a score and a date. */
function whole(targets: readonly DraftTarget[]): readonly { pillar: string; atLeast: number; by: string }[] {
  return named(targets).flatMap((target) =>
    target.atLeast != null && (target.by ?? '') !== ''
      ? [{ pillar: target.pillar.trim(), atLeast: target.atLeast, by: target.by ?? '' }]
      : []
  );
}

function PurposeStep({
  name,
  onName,
  purpose,
  onPurpose,
  owners,
  onOwners,
}: {
  readonly name: string;
  readonly onName: (value: string) => void;
  readonly purpose: string;
  readonly onPurpose: (value: string) => void;
  readonly owners: string;
  readonly onOwners: (value: string) => void;
}) {
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="wa-label text-wa-text">Name</span>
        <input
          className="wa-field wa-body-compact"
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="Q3 platform review"
        />
        <span className="wa-caption">
          What somebody will ask for it by, in a mail six months from now. “Assessment 1” is a name nobody can ask for.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="wa-label text-wa-text">Why this assessment exists</span>
        <textarea
          className="wa-textarea wa-body-compact"
          rows={3}
          value={purpose}
          onChange={(event) => onPurpose(event.target.value)}
        />
        <span className="wa-caption">
          The reason there is a review at all — a board date, a migration, a customer’s questionnaire. It is what tells
          the next reader whether the result answered the question that was asked.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="wa-label text-wa-text">Owners</span>
        <input className="wa-field wa-body-compact" value={owners} onChange={(event) => onOwners(event.target.value)} />
        <span className="wa-caption">
          Separated by commas. An assessment nobody has claimed yet is allowed — it is a real state, and recording a
          placeholder instead would be worse.
        </span>
      </label>
    </div>
  );
}

function ScopeStep({
  wholeAccount,
  onWholeAccount,
  selected,
  onSelected,
  lookback,
  onLookback,
  workspaces,
  preview,
}: {
  readonly wholeAccount: boolean;
  readonly onWholeAccount: (value: boolean) => void;
  readonly selected: readonly string[];
  readonly onSelected: (value: readonly string[]) => void;
  readonly lookback: string;
  readonly onLookback: (value: string) => void;
  readonly workspaces: ReturnType<typeof useSelectableWorkspaces>;
  readonly preview: ReturnType<typeof useScopePreview>;
}) {
  const days = Number(lookback);
  const valid = Number.isInteger(days) && days >= MIN_LOOKBACK && days <= MAX_LOOKBACK;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="wa-label text-wa-text">Which workspaces</legend>

        <label className="flex items-start gap-2">
          <input
            type="radio"
            className="mt-1"
            name="scope"
            checked={wholeAccount}
            onChange={() => onWholeAccount(true)}
          />
          <span className="flex flex-col">
            <span className="wa-body-compact text-wa-text">Every workspace the scanning identity can see</span>
            <span className="wa-caption">
              What the app has always done. It follows the identity’s grants, so a change to those changes what this
              assessment is of.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2">
          <input
            type="radio"
            className="mt-1"
            name="scope"
            checked={!wholeAccount}
            onChange={() => onWholeAccount(false)}
          />
          <span className="flex flex-col">
            <span className="wa-body-compact text-wa-text">Workspaces I choose</span>
            <span className="wa-caption">
              A claim the app can be held to: a run says how much of it was covered, and why any of it was not.
            </span>
          </span>
        </label>

        {!wholeAccount && (
          <div className="pt-1">
            <WorkspacePicker
              workspaces={workspaces.data?.workspaces ?? []}
              selected={selected}
              onChange={onSelected}
              {...(workspaces.data?.asOf != null ? { asOf: workspaces.data.asOf } : {})}
              {...(workspaces.data?.unavailable != null ? { unavailable: workspaces.data.unavailable } : {})}
            />
          </div>
        )}
      </fieldset>

      <div className="flex min-w-0 max-w-prose flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="wa-label text-wa-text">Days of history to read</span>
          <input
            className="wa-field wa-body-compact"
            inputMode="numeric"
            value={lookback}
            onChange={(event) => onLookback(event.target.value)}
          />
          <span className={valid ? 'wa-caption' : 'wa-caption text-wa-danger'}>
            {valid
              ? 'How far back the usage, job and query history is read. It decides what a run measures, not which workspaces are in it.'
              : `The system tables keep between ${String(MIN_LOOKBACK)} and ${String(MAX_LOOKBACK)} days.`}
          </span>
        </label>

        <div className="flex flex-col gap-2">
          <span className="wa-label text-wa-text">What this would cover</span>
          <ScopePreview
            {...(preview.data != null ? { preview: preview.data } : {})}
            loading={preview.loading}
            {...(preview.error != null ? { error: preview.error } : {})}
          />
        </div>
      </div>
    </div>
  );
}

function SourcesStep({
  pillars,
  loading,
  chosen,
  onChosen,
}: {
  readonly pillars: readonly PillarPlan[];
  readonly loading: boolean;
  readonly chosen: readonly string[] | undefined;
  readonly onChosen: (value: readonly string[] | undefined) => void;
}) {
  const picked = new Set(chosen ?? pillars.map((pillar) => pillar.pillarId));

  function toggle(pillarId: string): void {
    const next = new Set(picked);
    if (next.has(pillarId)) next.delete(pillarId);
    else next.add(pillarId);
    onChosen([...next].sort());
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="wa-body-compact text-wa-text-secondary max-w-prose">{describePillars(chosen, pillars.length)}</p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="wa-button-secondary"
          onClick={() => onChosen(undefined)}
          disabled={chosen == null}
        >
          Measure every pillar
        </button>
        {chosen == null && pillars.length > 0 && (
          <button
            type="button"
            className="wa-button-secondary"
            onClick={() => onChosen(pillars.map((pillar) => pillar.pillarId))}
          >
            Choose them one by one
          </button>
        )}
      </div>

      {loading && <p className="wa-body-compact text-wa-text-muted">Reading what a run executes…</p>}

      <ul className="flex flex-col gap-1" aria-label="Pillars in this assessment">
        {pillars.map((pillar) => (
          <li key={pillar.pillarId}>
            <label className="wa-row flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={picked.has(pillar.pillarId)}
                // Every pillar means every pillar, including ones added by a later build, so the
                // boxes are shown ticked and read-only until the author says otherwise. Editing one
                // would have to write a list, which is a different choice from having made none.
                disabled={chosen == null}
                onChange={() => toggle(pillar.pillarId)}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-wa-text font-medium">{pillar.title}</span>
                <span className="wa-caption">{describeSources(pillar)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <p className="wa-caption max-w-prose">
        Every table and endpoint behind these counts is listed on the{' '}
        <Link className="text-wa-action hover:underline" to="/checks">
          Checks
        </Link>{' '}
        page, with the permission each one needs. Whether this identity actually has them is a separate question, and
        the answer is on the assessment itself once it is defined.
      </p>
    </div>
  );
}

/**
 * What the assessment is aiming for, a pillar at a time.
 *
 * Rows rather than a field beside every pillar. Most assessments commit to two or three of them, and
 * a column of empty boxes down all nine would read as nine promises left blank — which is the
 * opposite of what an absent target means. Adding a row is a deliberate act, and that is the point.
 *
 * The date is a plain date input rather than a quarter or a "in 90 days" offset. A commitment is made
 * to somebody, on a day, and both of the alternatives turn into a different day depending on when
 * they are read.
 */
function TargetsStep({
  pillars,
  chosen,
  targets,
  onTargets,
  pillarTitle,
  troubles,
}: {
  readonly pillars: readonly PillarPlan[];
  readonly chosen: readonly string[] | undefined;
  readonly targets: readonly DraftTarget[];
  readonly onTargets: (value: readonly DraftTarget[]) => void;
  readonly pillarTitle: (pillarId: string) => string;
  readonly troubles: readonly string[];
}) {
  // Only the pillars this assessment covers can be committed to, because a target on a pillar it does
  // not measure could never be reported against. The server refuses it too; offering it here and
  // refusing it later would be the wizard asking a question it intends to reject the answer to.
  const covered = pillars.filter((pillar) => chosen == null || chosen.includes(pillar.pillarId));
  const taken = new Set(targets.map((target) => target.pillar));
  const free = covered.filter((pillar) => !taken.has(pillar.pillarId));

  function change(at: number, fields: Partial<DraftTarget>): void {
    onTargets(targets.map((target, index) => (index === at ? { ...target, ...fields } : target)));
  }

  function remove(at: number): void {
    onTargets(targets.filter((_target, index) => index !== at));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="wa-body-compact text-wa-text-secondary max-w-prose">{describeTargets(targets, pillarTitle)}</p>

      {troubles.length > 0 && (
        <p className="wa-body-compact text-wa-danger max-w-prose" role="alert">
          {troubles.join(' ')}
        </p>
      )}

      {targets.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="What this assessment commits to">
          {targets.map((target, at) => {
            const pillar = pillars.find((one) => one.pillarId === target.pillar);
            return (
              <li key={`${target.pillar}:${String(at)}`} className="wa-row flex flex-wrap items-end gap-3">
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="wa-label text-wa-text">Pillar</span>
                  <select
                    className="wa-field wa-body-compact"
                    value={target.pillar}
                    onChange={(event) => change(at, { pillar: event.target.value })}
                  >
                    {/* The pillar it is already on stays in its own list even when the assessment has
                        stopped covering it, so the row can be read and fixed rather than silently
                        renaming itself to something the author never chose. */}
                    <option value={target.pillar}>{pillar?.title ?? target.pillar}</option>
                    {free.map((one) => (
                      <option key={one.pillarId} value={one.pillarId}>
                        {one.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="wa-label text-wa-text">Reach at least</span>
                  <input
                    className="wa-field wa-body-compact w-24"
                    inputMode="numeric"
                    aria-describedby="wa-target-score"
                    value={target.atLeast == null ? '' : String(target.atLeast)}
                    onChange={(event) => {
                      const typed = event.target.value.trim();
                      const score = Number(typed);
                      change(at, typed !== '' && Number.isFinite(score) ? { atLeast: score } : { atLeast: undefined });
                    }}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="wa-label text-wa-text">By</span>
                  <input
                    type="date"
                    className="wa-field wa-body-compact"
                    value={target.by ?? ''}
                    onChange={(event) => change(at, { by: event.target.value })}
                  />
                </label>

                <button type="button" className="wa-button-secondary" onClick={() => remove(at)}>
                  <Trash2 aria-hidden className="h-4 w-4" />
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p id="wa-target-score" className="wa-caption max-w-prose">
        A score out of 100, weighted by how serious each failing requirement is — the same number the pillar shows on a
        run, so a commitment and the result it is held against are the same unit.
      </p>

      <div>
        <button
          type="button"
          className="wa-button-secondary"
          disabled={free.length === 0}
          onClick={() => {
            const first = free[0];
            if (first != null) onTargets([...targets, { pillar: first.pillarId }]);
          }}
        >
          Commit to a pillar
        </button>
        {free.length === 0 && (
          <p className="wa-caption pt-1">
            {covered.length === 0
              ? 'This assessment covers no pillar yet, so there is nothing to commit to. Choose them on the previous step.'
              : 'Every pillar in this assessment already has one.'}
          </p>
        )}
      </div>

      <p className="wa-caption max-w-prose">
        A target changes what a run reports beside the score, and nothing about how the score is worked out. It is not
        part of what makes two runs comparable, so raising one does not start a new trend.
      </p>
    </div>
  );
}

function PoliciesStep() {
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <ol className="flex flex-col gap-3">
        {POLICIES.map((policy) => (
          <li key={policy.rule} className="flex flex-col gap-1">
            <span className="wa-body-compact text-wa-text font-medium">{policy.rule}</span>
            <span className="wa-caption">{policy.detail}</span>
          </li>
        ))}
      </ol>
      <p className="wa-caption">
        None of these is a setting. Every one is enforced by the run, the score or the record, so a control here that
        did not change any of them would be a switch that appears to do something.
      </p>
    </div>
  );
}

function ConfirmStep({
  state,
  definition,
  pillarCount,
  chosen,
  targets,
  pillarTitle,
  preview,
  orphaned,
  note,
  onNote,
  saving,
  error,
  onSubmit,
  onGo,
}: {
  readonly state?: SetupDraft;
  readonly definition?: AssessmentDefinition;
  readonly pillarCount: number;
  readonly chosen: readonly string[] | undefined;
  readonly targets: readonly DraftTarget[];
  readonly pillarTitle: (pillarId: string) => string;
  readonly preview: ReturnType<typeof useScopePreview>;
  /** The assessment being revised can no longer take a version, so this becomes a new one. */
  readonly orphaned: boolean;
  readonly note: string;
  readonly onNote: (value: string) => void;
  readonly saving: boolean;
  readonly error?: string;
  readonly onSubmit: () => void;
  readonly onGo: (step: SetupStep) => void;
}) {
  const outstanding = state?.troubles ?? [];
  const ready = state?.ready === true && !saving;

  return (
    <div className="flex flex-col gap-4">
      {/* The saved reading, not the typed one. A confirmation that enabled itself from the state of a
          textbox would let a reader press it before the draft it is confirming had been kept. */}
      {outstanding.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="wa-body-compact text-wa-text">This is not finished yet.</p>
          <ul className="flex flex-col gap-1">
            {outstanding.map((trouble) => (
              <li key={`${trouble.step}:${trouble.trouble}`} className="wa-body-compact text-wa-text-secondary">
                {trouble.trouble}{' '}
                <button
                  type="button"
                  className="text-wa-action hover:underline"
                  onClick={() => onGo(stepFrom(trouble.step) ?? 'purpose')}
                >
                  Go there
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state != null && (
        <dl className="flex flex-col gap-2">
          <Fact label="Name" value={state.name ?? '—'} />
          {state.purpose != null && <Fact label="Why" value={state.purpose} />}
          <Fact
            label="Owners"
            value={
              state.owners == null || state.owners.length === 0
                ? 'Nobody yet, which is a state this app records rather than a field it insists on.'
                : state.owners.join(', ')
            }
          />
          <Fact
            label="Covers"
            value={
              preview.data?.unavailable ??
              preview.data?.description ??
              (state.scope?.kind === 'selected'
                ? `${String(state.scope.workspaceIds?.length ?? 0)} chosen workspaces`
                : 'Every workspace the scanning identity can see')
            }
          />
          <Fact label="Reads" value={`${String(state.lookbackDays ?? 0)} days of history`} />
          <Fact label="Pillars" value={describePillars(chosen, pillarCount)} />
          {/* Listed rather than counted. This is the last thing read before the button, and "1
              commitment" is the one fact about a commitment that leaves out the commitment. */}
          <Facts label="Aiming for" values={listTargets(targets, pillarTitle)} empty={describeTargets(undefined)} />
        </dl>
      )}

      {definition != null && !orphaned && (
        <label className="flex max-w-prose flex-col gap-1">
          <span className="wa-label text-wa-text">What changed, and why</span>
          <input className="wa-field wa-body-compact" value={note} onChange={(event) => onNote(event.target.value)} />
          <span className="wa-caption">
            Kept with the version. The app already works out whether the change altered the question or only its
            description; this is the part only you know.
          </span>
        </label>
      )}

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="wa-button-primary" onClick={onSubmit} disabled={!ready}>
          {saving
            ? 'Saving…'
            : definition == null
              ? 'Define it'
              : orphaned
                ? 'Define it as a new assessment'
                : 'Save as a new version'}
        </button>
        <Link className="wa-button-secondary" to="/definitions">
          Leave it for now
        </Link>
      </div>
    </div>
  );
}

/** Several lines under one label, for a fact that is a list rather than a sentence. */
function Facts({
  label,
  values,
  empty,
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly empty: string;
}) {
  if (values.length === 0) return <Fact label={label} value={empty} />;

  return (
    <div className="flex flex-col gap-0.5">
      <dt className="wa-label text-wa-text-secondary">{label}</dt>
      <dd className="wa-body-compact text-wa-text max-w-prose">
        <ul className="flex flex-col">
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="wa-label text-wa-text-secondary">{label}</dt>
      <dd className="wa-body-compact text-wa-text max-w-prose">{value}</dd>
    </div>
  );
}
