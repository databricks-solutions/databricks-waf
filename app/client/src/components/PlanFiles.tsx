// What this plan can be sent as, and what a recipient should compute to check the copy they were sent.
//
// The plan's counterpart to `RunFiles`, and the shapes under it are shared — a file is a file, and
// `ExportedFiles` holds the parts where the two panels must not diverge.
//
// What is different is the caution, and it is a stronger one. An assessment export changes when
// somebody records a decision, which is occasional. A plan export changes when anybody moves an
// action, which is daily, and again when a new run disagrees with a claim somebody made — because an
// agreement is a comparison between a claim and a run rather than a stored field. So the digests on
// this panel go stale faster than a run's, and saying so is the difference between a sender who can
// answer "this does not hash to what you told me" in one sentence and one who spends an afternoon on
// a tampering scare.
//
// The revision is on the panel for the same reason. Two exports of one plan share a filename — see
// `planExportName` for why they have to, if the comparison below is to work at all — so the number
// that says which version these digests describe has to be readable somewhere, and this is it.

import { usePlanExports } from '../api/hooks';
import { AlreadyTaken, DigestCaveat, ExportVariant } from './ExportedFiles';

export interface PlanFilesProps {
  readonly planId: string;
}

export function PlanFiles({ planId }: PlanFilesProps) {
  const published = usePlanExports(planId);

  if (published.error != null) {
    return (
      <p className="wa-caption p-3 text-wa-text-muted" role="alert">
        The files this plan can be sent as could not be listed. {published.error}
      </p>
    );
  }

  if (published.data == null) {
    return <p className="wa-caption p-3 text-wa-text-muted">Working out what each file should hash to.</p>;
  }

  const { data } = published;

  return (
    <div className="space-y-4 border-b border-wa-divider p-3">
            <p className="wa-body-compact text-wa-text-secondary">
              Send one of these to whoever asked what is being done about the assessment. The digest beside each file
              identifies it, so the person who receives it can establish that what they hold is what left here — without an
              account on this app.{' '}
              {/* The run rather than a version number. A plan's own revision does not move when its actions do, so a
                  number here would have labelled two exports a fortnight apart as the same document — and the run is
                  what a sender actually needs when a recipient reports a mismatch, because half the reasons are the
                  estate rather than the plan. */}
              {data.judgedAgainst != null ? (
                <>
                  These describe the plan as it stands now, with every agreement in it judged against run{' '}
                  <span className="wa-code">{data.judgedAgainst.run}</span> of{' '}
                  {new Date(data.judgedAgainst.at).toLocaleString()}.
                </>
              ) : (
                <>No run has measured this estate yet, so nothing in these files claims the work has been confirmed.</>
              )}
            </p>

      {data.variants.map((variant) => (
        <ExportVariant key={variant.variant} variant={variant} />
      ))}

      <DigestCaveat />
      <p className="wa-caption text-wa-text-muted">
        {/* The honest mismatch, and on a plan it is the common case rather than the rare one. */}
        A plan moves. Moving an action changes what these files say and so changes their digests, and so does a new run
        that disagrees with something somebody reported done — an agreement is measured against the latest run rather
        than stored. If you have already sent a copy, read these again before telling anybody what to expect.
      </p>

      <AlreadyTaken
        taken={data.taken}
        caption={
          'Every export of this plan the trail recorded, newest first, with what its bytes hashed to at the time. A ' +
          'copy marked as no longer matching is not evidence of tampering: it is a file taken before somebody moved ' +
          'an action or before a run disagreed with one, and it is the answer to give the person holding it.'
        }
      />
    </div>
  );
}
