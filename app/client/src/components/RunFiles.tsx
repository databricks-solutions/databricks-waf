// What this run can be taken away as, what each file is for, and what a copy should hash to.
//
// The mirror of `AdminScript`, and here for the same reason in the other direction. There, the app
// publishes a digest so an admin can check a file somebody sent them before running it. Here, the
// person reading is the sender: they have already mailed an export to a regulator, an auditor or a
// board, and what they need is the value that recipient should compute — read off a page, not out of
// a response header of a download they no longer have.
//
// It is only worth showing because an export carries nothing about the download that produced it.
// Until the document stopped recording the time it was taken, this panel could not have existed: two
// downloads of one run hashed differently, so any published digest would have been a number nobody
// could reproduce. Publishing one that fails to reproduce is worse than publishing none — a recipient
// who checks and finds a mismatch has been handed evidence of tampering that is really evidence of a
// timestamp. ADR 0050.
//
// The same reasoning is why the panel says what *does* change the value, in two places. An export
// describes the run and the decisions standing against it, and the second of those moves: accept a
// risk, download again, and the bytes differ. That is the file working, and it is also exactly the
// mismatch a recipient would report as tampering. So it is said once as a caution about the digests
// below, and then answered concretely by the last section — every export this run has already
// produced, with whether a download now would still match it. A sender who is asked "this does not
// hash to what you told me" can read the answer off the page instead of spending an afternoon on it.
//
// Four files rather than one, because one run has four readers and `server/export/variant.ts` says
// what each carries. The sentence beside each variant is the server's, not this page's: the same words
// are written into the file, and a page that phrased it differently would be a second description of
// one thing.

import type { RunExports } from '../api/types';
import { AlreadyTaken, DigestCaveat, ExportVariant } from './ExportedFiles';
import { Surface } from './system';

export interface RunFilesProps {
  /** What the app publishes about this run's exports, or nothing while it is still being fetched. */
  readonly exports?: RunExports;
}

export function RunFiles({ exports: published }: RunFilesProps) {
  // Nothing while it loads or if it failed, like the script aside. A reader who came to this view for
  // provenance and cost has not asked about checksums, and an error box about one would be louder
  // than anything else on the screen.
  if (published == null || published.variants.length === 0) return null;

  return (
    <Surface tone="raised" title="Files taken from this run">
      <div className="space-y-4">
        <p className="wa-body-compact text-wa-text-secondary">
          An export carries nothing about the download that produced it, so the digest below identifies the file rather
          than the moment. Send it with the file and the person who receives it can establish that what they hold is
          what left here — without an account on this app.
        </p>

        {published.variants.map((variant) => (
          <ExportVariant key={variant.variant} variant={variant} />
        ))}

        {/* Said plainly, for the reason the script panel says its own version plainly: a checksum
            invites a reader to believe more than it establishes. */}
        <DigestCaveat />
        <p className="wa-caption text-wa-text-muted">
          {/* The one way a recipient gets an honest mismatch. Said here because the alternative is that
              they report tampering and somebody spends an afternoon on it. */}
          These values describe the files as they stand. Recording a decision about a requirement changes what an export
          of this run says, and so changes its digest — if you have already sent a copy, read these again before telling
          anybody what to expect.
        </p>

        <AlreadyTaken
          taken={published.taken}
          caption={
            'Every export of this run the trail recorded, newest first, with what its bytes hashed to at the time. A ' +
            'copy marked as no longer matching is not evidence of tampering: it is a file taken before something was ' +
            'decided about a requirement, and it is the answer to give the person holding it.'
          }
        />
      </div>
    </Surface>
  );
}
