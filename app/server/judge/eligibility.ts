// The one thing in the judgment routing that is authored rather than derived.
//
// A requirement reaches this table because somebody wrote down what a rubric would weigh. It is the
// only route that fails closed: `route.ts` derives the other three from the catalogue and the
// registry, and a `partial-telemetry` question absent from here is `evidence-incomplete` rather than
// eligible. That asymmetry is the point — "there is always an argument for one more" is how a list
// like this becomes the whole catalogue.
//
// # What each entry must say
//
// `why` says what a model would synthesize *that the reading does not already settle*. Not a restated
// title, and not a copy of the catalogue's `askedBecause.why`, which says what is and is not recorded
// and renders beside this. The test is whether a reader can tell what the rubric would be about.
//
// `packet` says what it would be judged over, and `check-judgment-routes.mts` holds it to ADR 0071's
// verdict rather than trusting it:
//
// - `evidence` — the packet carries readings, and the declaration is one input among them. Only where
//   the catalogue records `partial-telemetry`, because that verdict is the assertion that a reading
//   exists at all.
// - `declarations-only` — nothing recorded bears on the requirement, so the packet holds what somebody
//   said and nothing else. Required where the catalogue records `beyond-telemetry`. The verdict then
//   inherits the declaration's authority and cannot exceed it, which is the advisor plan's own
//   condition for permitting these and the reason the class is stated per control rather than assumed.
//
// # Where this list came from
//
// The advisor plan's 34 candidates, revalidated against the catalogue on 2026-08-10 as that document
// requires. Twenty-two survived unchanged, eight are here as `declarations-only`, and four were
// dropped because they are answered by a reading now — `DG-01-06`, `IU-04-01`, `IU-04-02` and
// `OE-01-06`. Nothing was added: sixteen `partial-telemetry` requirements are eligible on the
// catalogue's evidence alone and are deliberately not here, because nobody has said what a rubric over
// them would weigh, and that sentence is the entry requirement.
//
// The reasoning is in `route.ts`, which is where the derivation and the revalidation are recorded
// together.

/** What a rubric for this requirement would be judged over. */
export type PacketClass = 'evidence' | 'declarations-only';

export interface Eligibility {
  readonly packet: PacketClass;
  readonly why: string;
}

export const ELIGIBLE: Readonly<Record<string, Eligibility>> = {
  // ---------------------------------------------------------------- data and AI governance
  'DG-01-01': {
    packet: 'evidence',
    why: 'Whether ownership is applied consistently to new assets, weighed across the owners recorded on the estate, is a pattern over many readings rather than a threshold on one.',
  },
  'DG-03-01': {
    packet: 'evidence',
    why: 'Whether declared constraints amount to stated quality expectations, or are incidental to a few tables, is a reading of what was declared against what the estate does.',
  },

  // ---------------------------------------------------------- interoperability and usability
  'IU-01-01': {
    packet: 'declarations-only',
    why: 'Whether integrations follow a reusable pattern is a claim about how designs were arrived at, and a rubric can only weigh how consistently the described patterns are told.',
  },
  'IU-01-04': {
    packet: 'evidence',
    why: 'Whether a pipeline has been simplified or has only accreted is a shape read off lineage over time, which is a trend a rubric can weigh and a threshold cannot.',
  },
  'IU-02-03': {
    packet: 'evidence',
    why: 'What a move away from a vendor SDK would cost is a judgment over which served entities are portable artefacts and which are not.',
  },

  // ------------------------------------------------------------------ operational excellence
  'OE-01-03': {
    packet: 'evidence',
    why: 'Whether deployment provenance across the estate is consistent enough to evidence a pipeline, or is patchy in a way that suggests hand edits, is a pattern over jobs rather than a count of them.',
  },
  'OE-01-05': {
    packet: 'evidence',
    why: 'Which grants held across environments amount to a break in isolation needs the meaning of the catalogues they are on, not the count of them.',
  },
  'OE-02-07': {
    packet: 'evidence',
    why: 'Distinguishing a promoted training run from a copied binary that carried its history is a reading of the run and version records together, and the catalogue says the separation is unreliable in the general case.',
  },
  'OE-02-10': {
    packet: 'evidence',
    why: 'Whether ML work shares the data platform’s infrastructure is a comparison of two populations, one of which is only visible by its absence.',
  },
  'OE-03-02': {
    packet: 'declarations-only',
    why: 'A forward view of capacity is a plan, so a rubric can only weigh whether the plan described accounts for the growth and seasonality the customer states.',
  },

  // ---------------------------------------------------------------- performance efficiency
  'PE-03-03': {
    packet: 'declarations-only',
    why: 'How a slowdown is diagnosed is a method, and a rubric can weigh whether the method described covers the chain the customer says they run.',
  },
  'PE-03-07': {
    packet: 'evidence',
    why: 'Whether registered Python UDFs sit in hot paths, as against being incidental, is a reading of where they are called from rather than a count of them.',
  },
  'PE-03-09': {
    packet: 'evidence',
    why: 'Whether hardware matches workload character is a judgment over utilisation shapes against instance families, which no single ratio settles.',
  },
  'PE-03-14': {
    packet: 'evidence',
    why: 'Which heavy statements have joins going badly, read from shuffle and spill together, is a diagnosis over several readings at once.',
  },
  'PE-04-01': {
    packet: 'declarations-only',
    why: 'Nothing records which estate is the test one, so a rubric weighs the customer’s account of their test data against the production volumes they describe.',
  },
  'PE-04-03': {
    packet: 'declarations-only',
    why: 'Whether bottlenecks were identified from evidence or from expectation is a claim about practice, and the rubric weighs how specifically the evidence is described.',
  },

  // -------------------------------------------------------------------------- reliability
  'REL-01-03': {
    packet: 'evidence',
    why: 'Whether malformed records are captured rather than lost is read from what pipeline expectations do on violation, which is a policy to interpret rather than a value to compare.',
  },
  'REL-02-01': {
    packet: 'evidence',
    why: 'Whether lineage depth is deliberate layering or accidental depth is a reading of the graph’s shape, and the same number means both.',
  },
  'REL-02-02': {
    packet: 'evidence',
    why: 'Column fan-out looks the same in a well-built mart and in a redundant copy, and telling them apart needs the meaning of the tables the edges join.',
  },
  'REL-02-03': {
    packet: 'evidence',
    why: 'Whether an audited schema change was handled or silently dropped a column somebody was reading is a join between the change and what read the table.',
  },
  'REL-02-05': {
    packet: 'declarations-only',
    why: 'What an investigation started with leaves no mark, so the rubric weighs the described sequence against the outcomes the customer reports.',
  },
  'REL-04-01': {
    packet: 'evidence',
    why: 'Whether a streaming resume was clean rather than merely successful is inferred from what the run timeline shows around the failure.',
  },
  'REL-04-02': {
    packet: 'evidence',
    why: 'An audited restore evidences the capability; whether the estate has a recovery practice needs that read against how often bad writes happen in it.',
  },
  'REL-04-03': {
    packet: 'evidence',
    why: 'Whether retries resumed safely or repeated work is read from the attempt pattern, and the configured policy behind it is in no system table.',
  },
  'REL-04-04': {
    packet: 'declarations-only',
    why: 'A recovery objective and an exercise are both statements, so the rubric weighs whether the objective stated is consistent with the architecture described.',
  },

  // ------------------------------------------------------ security, compliance and privacy
  'SCP-01-02': {
    packet: 'evidence',
    why: 'Whether grants follow least privilege is a judgment over which principals hold what on which securables, and the group-versus-individual split is only its first term.',
  },
  'SCP-03-01': {
    packet: 'declarations-only',
    why: 'Network topology has no workspace-readable source, so the rubric weighs the described design against the connectivity the customer says they need.',
  },
  'SCP-03-02': {
    packet: 'evidence',
    why: 'The IP access-list half is read; whether egress is constrained needs the serverless egress log interpreted against the network design described, since an empty log means both good and unlogged.',
  },
  'SCP-03-13': {
    packet: 'evidence',
    why: 'The egress log covers serverless and the question asks about classic compute, so a rubric weighs what was reached against what the customer says was tested.',
  },
};
