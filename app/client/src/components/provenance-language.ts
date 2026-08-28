// Where a reading came from, in one sentence.
//
// The finding pane already said when a reading was taken and which signal took it. What it could
// not say was whose permissions it was taken with, or where — and those are the two facts a customer
// asks for first when they disagree with a number. A storage finding is the common case: told that a
// table carries months of reclaimable history, the reasonable next question is "read by whom, on
// what", because the answer decides whether the number is wrong or the permissions are.
//
// Written as a sentence rather than a row of labelled fields. Four labelled fields on a detail pane
// that already carries eight is furniture; one line the reader can read at a glance and act on is
// not, and the field names ("authority", "surface") are ours rather than theirs anyway.

import type { Provenance } from '../api/types';

/**
 * How the reading was authorised, phrased to complete "read as …".
 *
 * The distinction is not cosmetic. A reading taken as the signed-in user shows that person's own
 * estate, and a disagreement about it is a disagreement about permissions. One taken as a service
 * principal or a service credential shows an estate the reader may never have seen, and the same
 * number then needs checking against a different identity than their own.
 *
 * The principal is named and not described. `authority` says what kind of identity read, and whose
 * it is nobody's to say from that field: a scheduled run authenticates as whichever principal the
 * customer created for it, which is not this app's own. Saying "the app's" was true only while the
 * mode was a literal nothing ever set to this value.
 */
const AS: Readonly<Record<Provenance['authority'], (actor: string) => string>> = {
  'on-behalf-of-user': (actor) => `as ${actor}, with your own permissions`,
  'service-principal': (actor) => `as the service principal ${actor}`,
  'service-credential': (actor) => `with the ${actor} service credential`,
  // Phrased so the reader cannot mistake it for something this app read. "Not by this app" is the
  // load-bearing part: the number is only as good as the file it arrived in, and the person to take a
  // disagreement to is the administrator named here rather than whoever is looking at the screen.
  'admin-cli': (actor) => `by ${actor} with the Databricks CLI, and imported — not by this app`,
};

/**
 * The sentence, or nothing when there is no provenance to report.
 *
 * Nothing rather than a hedge: evidence carried forward from an earlier scan, or produced by a
 * fixture, has no authority to name, and "read as unknown" is worse than silence — it invites the
 * reader to go looking for an identity that was never recorded.
 */
export function provenanceSentence(provenance: Provenance | undefined): string | undefined {
  if (provenance == null) return undefined;
  const where = provenance.from == null ? '' : `, from ${provenance.from}`;
  return `Read ${AS[provenance.authority](provenance.actor)}${where}.`;
}

/**
 * The collector, for a reader who wants to find the code that produced this.
 *
 * Separate from the sentence because it is for a different reader. The sentence is for the customer
 * disputing a number; this is for whoever is asked to explain how it was arrived at, and putting
 * both in one line serves neither.
 */
export function collectorNote(provenance: Provenance | undefined): string | undefined {
  return provenance == null ? undefined : `${provenance.collector} collector on the ${provenance.surface} surface`;
}
