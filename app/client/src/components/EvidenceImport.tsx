// Handing this app a reading it could never have taken itself.
//
// `AdminScript` above is the door out — download the script, run it under your own authority. This is
// the door back in, and it is the half where the app has to be honest about what it is doing: a file
// arriving here was produced somewhere this app cannot see, by somebody it cannot authenticate, and
// everything it goes on to state on the strength of that file rests on four checks the reader cannot
// see running. So the surface says what was checked and what it concluded, in the server's own words.
//
// Every refusal is shown at once rather than one at a time. An admin who forwards last quarter's file
// for the wrong workspace should learn both things now; told one, they fix it, wait for a collection,
// and come back to learn the other. That is a day lost to a design choice.
//
// The cautions are as prominent as the refusals on purpose. They are the ones that matter *after* the
// import succeeded — the account tier that did not run, the three calls that were denied — and a
// reader who sees a green heading and stops reading is exactly who they are written for.

import { AlertTriangle, Check, Upload, X } from 'lucide-react';
import { useRef } from 'react';
import type { EvidenceImport as Imported, EvidenceImports, EvidenceNote } from '../api/types';
import { useImportEvidence } from '../api/hooks';
import { ageSentence, collectedBySentence, durabilityWarning, importedSentence, noteKey, shortDigest, tiersSentence, verdictTitle } from './import-language';
import { Disclosure } from './ui/Disclosure';

export interface EvidenceImportProps {
  /** What the app holds, or nothing while it is being fetched. */
  readonly imports?: EvidenceImports;
  /** Re-reads the list after an accepted upload, so the page shows what it now holds. */
  readonly onImported?: () => void;
}

export function EvidenceImport({ imports, onImported }: EvidenceImportProps) {
  const { send, sending, verdict, error } = useImportEvidence(onImported);
  const picker = useRef<HTMLInputElement>(null);

  // Nothing while it loads, matching `AdminScript` beside it: this is an aside on a page about
  // something else, and a spinner here would interrupt what the reader came for.
  if (imports == null) return null;

  const warning = durabilityWarning(imports.durable);

  return (
    <section className="flex flex-col gap-2" aria-label="Import admin-collected evidence">
      <p className="wa-body-compact text-wa-text-secondary">
        Once it has run, upload the file it wrote. This app checks that the readings are unchanged since
        collection, that they describe this estate, that they are recent enough to be about the present, and that they
        have not been imported before — and it says what it concluded either way.
      </p>

      <p>
        {/* A hidden input driven by a button rather than a styled `file` input, because the native
            control cannot be given the button treatment the rest of the app uses and a reader should
            not have to recognise a second visual language for one action. */}
        <input
          ref={picker}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file != null) send(file);
            // Cleared so choosing the same file twice fires again. Without it a reader who re-ran the
            // script, overwrote the file and picked it again would get no response at all.
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="wa-button-secondary flex items-center gap-1.5"
          disabled={sending}
          onClick={() => picker.current?.click()}
        >
          <Upload aria-hidden className="h-4 w-4 shrink-0" />
          {sending ? 'Checking the file…' : 'Upload a collected file'}
        </button>
      </p>

      {warning != null && (
        <p className="wa-notice-warning wa-caption">
          <AlertTriangle aria-hidden className="text-wa-warning mr-1.5 inline h-4 w-4 shrink-0" />
          {warning}
        </p>
      )}

      {error != null && (
        <p className="wa-notice-warning wa-caption" role="alert">
          {/* Distinct from a refusal on purpose: the file was never judged. Reporting this as
              "not imported" would send the reader to check a file that nothing has looked at. */}
          The file could not be sent, so nothing has been checked: {error}
        </p>
      )}

      {verdict != null && (
        <div className="flex flex-col gap-1.5" role="status">
          <p className="wa-label text-wa-text flex items-center gap-1.5">
            {verdict.accepted ? (
              <Check aria-hidden className="text-wa-success h-4 w-4 shrink-0" />
            ) : (
              <X aria-hidden className="text-wa-danger h-4 w-4 shrink-0" />
            )}
            {verdictTitle(verdict)}
          </p>

          {verdict.imported != null && (
            <p className="wa-caption">
              {importedSentence(verdict.imported)} {tiersSentence(verdict.imported)}
            </p>
          )}

          <Notes notes={verdict.refusals} weight="refusal" />
          <Notes notes={verdict.cautions} weight="caution" />
        </div>
      )}

      {imports.imports.length > 0 && (
        <Disclosure
          summary={`${String(imports.imports.length)} ${imports.imports.length === 1 ? 'collection' : 'collections'} imported`}
        >
          <ul className="flex flex-col gap-2">
            {imports.imports.map((held) => (
              <li key={held.digest}>
                <Held held={held} acceptedForDays={imports.acceptedForDays} />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </section>
  );
}

/**
 * The server's own sentences, listed.
 *
 * Not rewritten here, and not summarised. The server is the only place that knows what was compared
 * against what — which workspace id, how many days, whose digest — and a component paraphrasing that
 * would be reimplementing the checks in order to describe them.
 */
function Notes({ notes, weight }: { readonly notes: readonly EvidenceNote[]; readonly weight: 'refusal' | 'caution' }) {
  if (notes.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1">
      {notes.map((note, at) => (
        <li key={noteKey(note, at)} className="flex items-start gap-1.5">
          {weight === 'refusal' ? (
            <X aria-hidden className="text-wa-danger mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle aria-hidden className="text-wa-warning mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span className="wa-caption">{note.message}</span>
        </li>
      ))}
    </ul>
  );
}

function Held({ held, acceptedForDays }: { readonly held: Imported; readonly acceptedForDays: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="wa-caption text-wa-text">
        {/* The short digest first, because it is how a reader matches this row against the file on
            their disk and against the number the script printed when it ran. */}
        <span className="wa-code">{shortDigest(held.digest)}</span> · {ageSentence(held.generatedAt, acceptedForDays)}
      </p>
      <p className="wa-caption text-wa-text-muted">
        {importedSentence(held)} {tiersSentence(held)} {collectedBySentence(held)}
      </p>
      <Notes notes={held.cautions} weight="caution" />
    </div>
  );
}
