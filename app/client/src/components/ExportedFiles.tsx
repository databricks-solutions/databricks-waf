// The parts of a "files you can take away" panel that are the same whatever the document is.
//
// Two panels use this: the run's, and an improvement plan's. What they share is not presentation but a
// claim — a digest published beside a filename, and a list of copies that have already left with
// whether each still matches. Getting either of those subtly different between two panels would be
// worse than a little duplication, because the reader of one is being told what to expect from a file
// and the reader of the other is being told the same thing in different words.
//
// What is deliberately *not* here is the prose around them. A run's digests change when somebody
// records a decision; a plan's change when anybody moves an action, and again when a new run disagrees
// with a claim. Those are different cautions and each panel writes its own.

import type { ExportFile, ExportRecord, ExportVariantFiles } from '../api/types';

/**
 * One audience, its sentence, and the formats it comes in.
 *
 * The description sits above the files rather than beside each, because it is a fact about the variant
 * and not about the format: the CSV and the JSON of one variant carry the same columns as each other.
 *
 * The sentence is the server's. The same words are written into the file, and a page that phrased it
 * differently would be a second description of one thing.
 */
export function ExportVariant({ variant }: { readonly variant: ExportVariantFiles }) {
  return (
    <section className="space-y-2" aria-label={`The ${variant.variant} export`}>
      <div>
        <h2 className="wa-label-eyebrow text-wa-text">{variant.variant}</h2>
        <p className="wa-caption max-w-prose">
          {variant.says}
          {variant.omits != null && <> {variant.omits}</>}
        </p>
      </div>
      <div className="space-y-3">
        {variant.files.map((file) => (
          <ExportedFile key={file.format} file={file} />
        ))}
      </div>
    </section>
  );
}

export function ExportedFile({ file }: { readonly file: ExportFile }) {
  return (
    <div className="space-y-1">
      <p className="wa-body-compact">
        {/* A plain anchor with `download`, like every other download in this app: the server names the
            file and a router link would navigate away from the page to render it. */}
        <a className="wa-row-link font-medium text-wa-text" href={file.href} download={file.name}>
          {file.name}
        </a>{' '}
        <span className="wa-caption">{file.bytes.toLocaleString()} bytes</span>
      </p>
      <ul className="wa-caption space-y-0.5">
        {file.verify.map((line) => (
          <li key={line} className="wa-code break-all">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface AlreadyTakenProps {
  readonly taken: readonly ExportRecord[];
  /**
   * Why a copy might no longer match, in the words of whatever this document is.
   *
   * Required rather than defaulted, because a wrong answer here is worse than no panel: telling a
   * sender their copy predates a decision, when what happened was somebody moving an action, sends
   * them to look at the wrong record.
   */
  readonly caption: string;
}

/**
 * What has already left, and whether a download now would still match it.
 *
 * Absent rather than shown empty when nothing has been exported: a heading over no rows reads as a
 * feature that is not working, and on an install with no trail bound there is nothing this could ever
 * say. The rows come from the audit log, which is where an export is already recorded — a second store
 * would be a second answer to one question.
 */
export function AlreadyTaken({ taken, caption }: AlreadyTakenProps) {
  if (taken.length === 0) return null;

  return (
    <section className="space-y-2 border-t border-wa-border pt-3" aria-label="Exports already taken">
      <h2 className="wa-label-eyebrow text-wa-text">Already taken</h2>
      <p className="wa-caption max-w-prose">{caption}</p>
      <ul className="space-y-2">
        {taken.map((one) => (
          <li key={`${one.name}-${one.at}`} className="wa-caption">
            <span className="wa-code break-all text-wa-text">{one.name}</span>
            <span className="block">
              {new Date(one.at).toLocaleString()} by {one.by} — {matchPhrase(one)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What the recorded digest is worth now, in a sentence.
 *
 * Three answers rather than two, because "this app can no longer build those bytes" is a different
 * statement from "those bytes are out of date", and only the first is true of a file exported by an
 * earlier version of this app. Saying the second would tell a sender their copy had been superseded by
 * a change to the record when what happened was a deploy.
 */
function matchPhrase(record: ExportRecord): string {
  if (record.current == null) {
    return 'this build no longer produces a file of that name, so there is nothing to compare it against';
  }
  return record.current
    ? 'a download now still hashes to the same value'
    : 'a download now hashes to something else, because the record has moved since';
}

/**
 * The sentence about what a digest does and does not establish.
 *
 * Shared verbatim, because it is the one paragraph on either panel that is about cryptography rather
 * than about the document: a checksum invites a reader to believe more than it establishes, and the
 * correction should not be phrased two ways.
 */
export function DigestCaveat() {
  return (
    <p className="wa-caption text-wa-text-muted">
      A digest establishes that a file has not changed. It is not a signature: anybody who can produce the same bytes
      can produce the same digest, so it answers “has this been altered” and not “who wrote it”. The trail records every
      export with this value beside it, which is where the second question is answered.
    </p>
  );
}
