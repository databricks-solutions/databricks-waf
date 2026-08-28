// What somebody noticed, where they noticed it.
//
// The same component on a run, on a pillar and in a finding pane, because the observation a reader
// wants to record is the same shape in all three and the place it belongs is wherever they were when
// they had it. A notes page reached from a menu would collect the notes of people who set out to write
// one, which is nobody.
//
// Three things it says out loud, each because a reader would otherwise assume the opposite.
//
// It cannot be unsaid. There is no edit and no delete here because there is none in the API, and a
// surface that offered either would be promising something the record refuses. The line under the box
// says so before somebody writes something they would rather retract.
//
// A mistake is corrected by writing another one. The corrected note stays and stays readable, with the
// correction under it — which is what makes the pair evidence about what was understood then, rather
// than a single note whose earlier reading has vanished.
//
// It changes nothing. Not the outcome, not the score, not whether a finding is decided. A reader who
// thinks a note parks a finding will write one instead of parking it, and the finding stays live with
// an explanation nobody reads sitting next to it.

import { useState } from 'react';
import { useNotes, useWriteNote } from '../api/hooks';
import type { Note, NoteSubject } from '../api/types';
import { AlertTriangle } from 'lucide-react';
import { Surface } from './system';
import { writtenWhen } from '../pages/note-language';

export interface NoteThreadProps {
  readonly subject: NoteSubject;
  /**
   * The run the reader is looking at, recorded on a note about a pillar or a requirement.
   *
   * It is what makes "this only fails in the sandbox" a claim a later reader can check against what
   * was measured that day, rather than a remark. Absent on a run's own thread, where the subject is
   * the run.
   */
  readonly observedIn?: string;
  /** How the section is labelled, since a finding pane and a run page want different words. */
  readonly label?: string;
  /**
   * Whether the reader may add to the thread. False on the report.
   *
   * A report is an artefact somebody prints, mails and files, and everything about writing has to come
   * off it: the box, the corrections, and the warning that notes are being held in memory — which is
   * true, and is advice to whoever runs the app rather than to whoever is holding the paper. Its cost
   * was measured on the labs report, where the same warning appeared thirty-four times, once per
   * finding, because the thread that carries it renders once per finding.
   *
   * An empty thread also renders as nothing here rather than as a heading over a blank space. Live, an
   * empty thread is an invitation; printed, it is thirty-four headings saying nobody wrote anything.
   */
  readonly writable?: boolean;
  /**
   * Notes already read for this subject. Passed by the report, which asks once for every control.
   * Absent, this pane fetches for itself — a run page and a findings pane show one thread.
   */
  readonly notes?: readonly Note[];
}

export function NoteThread({
  subject,
  observedIn,
  label = 'Notes',
  writable = true,
  notes: preloaded,
}: NoteThreadProps) {
  const thread = useNotes(preloaded == null ? subject : undefined);
  const write = useWriteNote(subject, observedIn, () => {
    thread.reload();
  });

  if (!writable && !thread.loading && (thread.data?.notes ?? []).length === 0) return null;

  return (
    <NoteThreadView
      subject={subject}
      label={label}
      writable={writable}
      notes={preloaded ?? thread.data?.notes ?? []}
      reading={thread.loading}
      minNote={thread.data?.minNote ?? MIN_NOTE}
      maxNote={thread.data?.maxNote ?? MAX_NOTE}
      {...(writable && thread.data?.durable === false && thread.data.durabilityNote != null
        ? { durabilityNote: thread.data.durabilityNote }
        : {})}
      {...(thread.error != null ? { error: thread.error } : {})}
      saving={write.saving}
      {...(write.error != null ? { writeError: write.error } : {})}
      onWrite={async (body, corrects) =>
        (await write.send({ body, ...(corrects != null ? { corrects } : {}) })) != null
      }
    />
  );
}

/*
 * What the floors are before the server has said.
 *
 * The response carries them — see the thread payload — and these are what the form uses for the frame
 * before it arrives. Wrong in the safe direction if they ever diverge: a form that asked for ten
 * characters where the server wanted twenty shows the server's own sentence about it, whereas one that
 * asked for more than the server needs would be refusing a note the server would have taken.
 */
const MIN_NOTE = 10;
const MAX_NOTE = 4000;

export interface NoteThreadViewProps {
  readonly subject: NoteSubject;
  readonly label: string;
  /** Oldest first, as the server sends them. Not re-sorted here: the order is the conversation. */
  readonly notes: readonly Note[];
  /**
   * True while the thread is still being fetched, which withholds the box rather than the notes.
   *
   * An empty thread and a thread not yet read look identical, and the box under them does not: a reader
   * shown one before the notes arrive is a reader writing beside somebody else's note about the same
   * thing, or writing again what they wrote a minute ago. The pane says it is reading and asks nothing
   * in the meantime.
   */
  readonly reading?: boolean;
  /** False renders the thread as a record: no box, no corrections, nothing that offers to write. */
  readonly writable?: boolean;
  readonly minNote: number;
  readonly maxNote: number;
  /** Present when notes are being kept somewhere a restart empties. */
  readonly durabilityNote?: string;
  /** Why the thread could not be read. */
  readonly error?: string;
  readonly saving: boolean;
  /** Why the last note could not be written, in the server's own words. */
  readonly writeError?: string;
  /**
   * Writes a note, resolving true when it was kept.
   *
   * The answer is what decides whether the box empties. A form cleared on submit loses the paragraph
   * the moment the server refuses it, and the reader is then left with a message about a note they no
   * longer have — the one failure mode of a write surface that costs somebody their words rather than
   * their time.
   */
  readonly onWrite: (body: string, corrects?: string) => Promise<boolean>;
}

/**
 * The thread and the box under it, with no fetching of its own.
 *
 * Split from the container above so the rendering can be tested against a thread rather than against a
 * loading state. What is worth holding is what the markup says — that a correction quotes what it
 * corrects, that there is no button which edits or removes anything — and neither is reachable through
 * a component that only renders once its own request has resolved.
 */
export function NoteThreadView({
  subject,
  label,
  notes,
  reading = false,
  writable = true,
  minNote,
  maxNote,
  durabilityNote,
  error,
  saving,
  writeError,
  onWrite,
}: NoteThreadViewProps) {
  const [correcting, setCorrecting] = useState<string | undefined>(undefined);

  return (
    <Surface
      tone="inset"
      title={label}
      description={notes.length === 0 ? undefined : `${String(notes.length)} notes`}
      headingLevel={3}
    >
      {/* Advice about where notes are kept is advice to whoever writes one. Held here rather than only
          in the container above, so a caller that composes this view directly cannot print it either. */}
      {writable && durabilityNote != null && (
        <div className="wa-notice-warning flex items-start gap-2" role="alert">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-wa-warning" />
          {/* `min-w-0 break-words` because this sentence names an environment variable, and a note
              thread is now a pane's width rather than a page's: WAF_DEMO_NO_PERSISTENCE is 192px of
              unbreakable token, so beside a 16px icon and an 8px gap it set the paragraph's minimum
              wider than the 240px pane the pillar summary and the run notes both sit in — measured at
              15px of sideways scroll on `/pillars/:id` at both windows in both themes. */}
          <p className="wa-body-compact min-w-0 break-words">{durabilityNote}</p>
        </div>
      )}

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      {notes.length > 0 && (
        <ol className="space-y-2">
          {notes.map((note) => (
            <li key={note.id}>
              <Written note={note} corrects={notes.find((one) => one.id === note.corrects)} />
              {!writable ? null : correcting === note.id ? (
                <WriteForm
                  formId={`correct-${note.id}`}
                  minNote={minNote}
                  maxNote={maxNote}
                  saving={saving}
                  {...(writeError != null ? { error: writeError } : {})}
                  onCancel={() => setCorrecting(undefined)}
                  onSubmit={async (body) => {
                    // Closed on success only. A correction whose write was refused still has to know
                    // which note it corrects, and a box that shut itself would have thrown that away
                    // along with the paragraph.
                    const kept = await onWrite(body, note.id);
                    if (kept) setCorrecting(undefined);
                    return kept;
                  }}
                  correcting
                />
              ) : (
                <button
                  type="button"
                  className="wa-caption mt-0.5 text-wa-action hover:underline"
                  onClick={() => setCorrecting(note.id)}
                >
                  Correct this
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* Nothing to write in until the thread has been read — see `reading`. A reader shown a box
          beside notes that have not arrived writes beside somebody else's note about the same thing. */}
      {reading && writable && <p className="wa-caption">Reading what has been written about this…</p>}

      {/* One box at a time. A reader half way through a correction who also has an empty new-note box
          below it has two places to put the sentence they are writing, and the wrong one is the one
          that loses the link to what they were correcting. */}
      {writable && !reading && correcting == null && (
        <WriteForm
          formId={`note-${subject.kind}-${subject.id}`}
          minNote={minNote}
          maxNote={maxNote}
          saving={saving}
          {...(writeError != null ? { error: writeError } : {})}
          onSubmit={(body) => onWrite(body)}
        />
      )}
    </Surface>
  );
}

/**
 * One note, with what it corrects quoted above it.
 *
 * Quoted rather than linked, even though both are on the page. A correction read on its own says
 * nothing — "December, not November" — and a reader who has to find the note above it to understand
 * this one is a reader who does not bother.
 */
function Written({ note, corrects }: { readonly note: Note; readonly corrects?: Note }) {
  return (
    <div>
      {corrects != null && (
        <p className="wa-caption border-l-2 border-wa-border pl-2 italic">Corrects: &ldquo;{corrects.body}&rdquo;</p>
      )}
      <p className="wa-body-compact whitespace-pre-wrap text-wa-text">{note.body}</p>
      <p className="wa-caption">
        {note.by} · {writtenWhen(note.at)}
        {note.observedIn != null && ` · reading run ${note.observedIn}`}
      </p>
    </div>
  );
}

interface WriteFormProps {
  readonly formId: string;
  readonly minNote: number;
  readonly maxNote: number;
  readonly saving: boolean;
  readonly error?: string;
  /** Resolves true when the note was kept, which is the only thing that empties the box. */
  readonly onSubmit: (body: string) => Promise<boolean>;
  readonly onCancel?: () => void;
  readonly correcting?: boolean;
}

function WriteForm({
  formId,
  minNote,
  maxNote,
  saving,
  error,
  onSubmit,
  onCancel,
  correcting = false,
}: WriteFormProps) {
  const [body, setBody] = useState('');
  const short = Math.max(0, minNote - body.trim().length);
  const over = body.trim().length - maxNote;
  const ready = short === 0 && over <= 0;

  return (
    <form
      className="mt-1.5 flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || saving) return;
        // Emptied on success only. The refusal a reader is most likely to meet here is a correction
        // naming a note on another subject, and a box that had already cleared itself would answer
        // that with an explanation and a blank space where their paragraph was.
        void onSubmit(body.trim()).then((kept) => {
          if (kept) setBody('');
        });
      }}
    >
      <label className="wa-label" htmlFor={formId}>
        {correcting ? 'What it should have said' : 'Write a note'}
      </label>
      <textarea
        className="wa-textarea wa-body-compact"
        id={formId}
        rows={correcting ? 2 : 3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={
          correcting
            ? 'The account closes in December, not November.'
            : 'Both clusters this fails on are in the lab account, which closes in November.'
        }
        aria-describedby={`${formId}-help`}
      />
      <p className="wa-caption" id={`${formId}-help`}>
        {over > 0
          ? `${String(over)} characters too many. Anything this long is a document, and a document in a thread is a thread nobody reads to the bottom of.`
          : short > 0 && body !== ''
            ? `At least ${String(short)} more characters.`
            : correcting
              ? 'The note above stays and stays readable. This is filed under it as the correction.'
              : 'Kept as written, by you, dated. There is no edit and no delete — a mistake is corrected by writing another note.'}
      </p>

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="wa-caption">Changes nothing but the record.</span>
        <div className="flex items-center gap-2">
          {onCancel != null && (
            <button type="button" className="wa-button-secondary" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
          )}
          <button type="submit" className="wa-button-primary" disabled={!ready || saving}>
            {saving ? 'Saving…' : correcting ? 'File the correction' : 'Write it down'}
          </button>
        </div>
      </div>
    </form>
  );
}
