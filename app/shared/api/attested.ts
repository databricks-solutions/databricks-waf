// Which attestation records a run named, in one implementation the writer and the reader share.
//
// This is runtime code shared by the server and browser, not a second wire contract, and it is here
// rather than in either of them because both need the same answer for different purposes. The server
// writes these ids into a pillar record when somebody confirms a pillar; the review page has to be
// able to say, before they press the button, how many that will be.
//
// It was two implementations for one change, and the reason it is now one is what went wrong with
// having none: the page counted the live attestation store instead and captioned the result
// "reused", which reads as the contents of the confirm and is a different set. Two copies of this
// rule would drift the same way more slowly.

/**
 * The shape this rule needs off a finding, and no more.
 *
 * Generic over nothing: `attested.at` and `reviewBy` differ between the server's `Date` and the
 * payload's `string`, and this reads neither, so a structural parameter keeps both callers exact
 * without either converting.
 */
export interface AttestedNaming {
  readonly pillarId: string;
  readonly attested?: { readonly id?: string };
}

/**
 * The attestation ids a run named for one pillar, in the order its findings carry them.
 *
 * A finding recorded before `attested.id` existed contributes nothing rather than an invented id — a
 * record must not cite an attestation the run never named. So an empty result is a real answer about
 * a real run, not an empty state, and a caller rendering it has to say so: on such a run a confirm
 * writes a record citing nothing, which somebody about to confirm is owed before they do.
 */
export function attestationIdsIn(findings: readonly AttestedNaming[], pillarId: string): readonly string[] {
  const ids: string[] = [];
  for (const finding of findings) {
    if (finding.pillarId !== pillarId) continue;
    const id = finding.attested?.id;
    if (id != null && id !== '') ids.push(id);
  }
  return ids;
}
