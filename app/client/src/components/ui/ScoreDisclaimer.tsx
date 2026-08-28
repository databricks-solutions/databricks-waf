// Whose score this is.
//
// The number this app computes is its own: a severity-weighted count of requirements it could
// measure, against a catalogue it assembled from published Databricks guidance. Databricks
// publishes no such score. A reader who takes 55 to be an official rating will carry it into a
// steering meeting as one, and the first person to ask "rated by whom?" will be right to.
//
// So the sentence appears wherever a score does. Not in a footer once per page, and not behind
// a tooltip: attached to the number, because the number is what travels — into a screenshot, a
// slide, an export.

export const SCORE_DISCLAIMER =
  'Posture is calculated by this application from published Databricks guidance. It is not an official Databricks score or certification.';

/** Attached under a headline score. */
export function ScoreDisclaimer() {
  return <p className="wa-caption text-wa-text-muted">{SCORE_DISCLAIMER}</p>;
}

/**
 * Where the layout has no room for the sentence.
 *
 * Renders the mark visibly and the sentence to assistive technology, so the disclaimer is never
 * only a hover — a keyboard or screen-reader user gets it without the pointer.
 */
export function ScoreDisclaimerMark() {
  return (
    <span className="wa-caption text-wa-text-muted" title={SCORE_DISCLAIMER}>
      <span aria-hidden>Application-defined</span>
      <span className="sr-only">{SCORE_DISCLAIMER}</span>
    </span>
  );
}
