// Sentences about the run a month would publish.
//
// A preview is readable before its month closes. The selected run is real, but it is not yet the
// closing run because another run can still arrive before the month ends. Keeping that distinction
// here prevents each publication refusal from independently turning a current preview into a claim
// about a completed month.

/** A complete clause naming the selected run by recorded time rather than opaque id. */
export function selectedRun(month: string, finishedAt: string, closed: boolean): string {
  return closed
    ? `${month} closed on the run finished ${finishedAt}`
    : `${month} currently uses the run finished ${finishedAt} in this preview`;
}

/** A noun phrase for a later sentence about that same selected run. */
export function selectedRunReference(finishedAt: string, closed: boolean): string {
  return closed ? `the closing run finished ${finishedAt}` : `the run finished ${finishedAt} selected by this preview`;
}

/** The honest absence when the month has no run to select. */
export function noSelectedRun(month: string, closed: boolean): string {
  return closed
    ? `${month} has no readable closing run, so neither its review nor report can be shown.`
    : `${month} has no readable run in the month yet, so this preview cannot show a review or report.`;
}
