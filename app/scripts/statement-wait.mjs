// Waiting for a statement in a measurement script, and stopping it when we stop waiting.
//
// Thirteen scripts submit statements to a warehouse and poll for the result, and every one of
// them wrote the same six lines: while the state is pending, sleep, ask again, and give up after
// a fixed number of turns. None of them cancelled anything on the way out.
//
// That is the defect `74` owns, and it is the app's defect as well — `statements.ts` had the same
// hole, from the other end. **A client that stops waiting does not stop the warehouse.** `61a` met
// it first: its harness gave up at a 450-poll cap after 3,323 seconds and the warehouse finished
// the statement 584 seconds later, so the duration that measurement reports came out of query
// history rather than out of the script. `70` met it again and paid more for it — its output was
// killed 48 minutes into a form, the warehouse ran that form to completion 18 minutes after that,
// and the three forms had been holding a shared estate's warehouse for three hours by then.
//
// What is deliberately *not* changed here is how long each script waits. Every caller keeps the
// bound it already had, expressed the way it already expressed it, because a measurement whose
// waiting changed in the same commit as its cancelling is a measurement that cannot be compared
// with the one before it. The only new behaviour is the POST on the way out.

/** A status the API returns while a statement is still going. */
export const PENDING = new Set(['PENDING', 'RUNNING']);

/**
 * Polls until the statement settles or the caller's poll budget runs out, cancelling if it does.
 *
 * Returns the last response either way rather than throwing, so each caller's own handling of a
 * state that is not `SUCCEEDED` runs exactly as it did before — several of them read the status
 * JSON out of the error text they build from it, and `measure-discovery-cost.mjs` distinguishes a
 * statement that outlasted its budget from one that was refused on precisely that string.
 *
 * `cancelled` is attached for a caller that reports what happened to a person: `true` means the
 * warehouse accepted the cancellation, `false` means it did not and the work may still be running.
 * It is absent when the statement settled on its own.
 */
export async function settled(response, { call, polls, pollIntervalMs = 2000 }) {
  const statementId = response.statement_id;

  for (let poll = 0; PENDING.has(response.status?.state ?? ''); poll += 1) {
    if (poll >= polls || statementId == null) {
      return { ...response, cancelled: statementId == null ? false : await cancel(call, statementId) };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
    response = await call(`/api/2.0/sql/statements/${statementId}`, { method: 'GET' });
  }

  return response;
}

/**
 * Whether the warehouse accepted the cancellation.
 *
 * Swallows the failure and reports it, rather than throwing: the caller is already on its way out
 * with a statement that did not finish, and replacing that with a transport error would lose the
 * only thing it learned. What it may not do is claim the statement was stopped when the POST
 * failed, which is why this returns a boolean rather than nothing.
 */
async function cancel(call, statementId) {
  try {
    await call(`/api/2.0/sql/statements/${statementId}/cancel`, { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}

/** What to print, or write into a recording, about a statement this script stopped waiting for. */
export function abandoned(response, seconds) {
  if (!PENDING.has(response.status?.state ?? '')) return null;
  return (
    `did not finish within ${String(Math.round(seconds))}s, so this script stopped waiting for it and ` +
    `${response.cancelled === true ? 'cancelled it on the warehouse' : 'could not confirm it was cancelled on the warehouse'}`
  );
}
