// Which controls a model may ever judge, decided once and derived rather than argued at the call site.
//
// [The advisor plan](../../../docs/plans/llm-driven-well-architected-advisor.md) asks for exactly one
// recorded judgment route per requirement with the reason it has that route, so that eligibility is
// settled before anything is sent anywhere. Without it the first integration decides control by
// control where the call is made, which is how every control ends up eligible: there is always an
// argument for one more.
//
// Three of the four routes are derived from the catalogue and the resolver registry. The fourth is
// not, and this file is mostly about why.
//
// # What the catalogue can decide, and what it cannot
//
// `deterministic`, `evidence-incomplete` and `human-accountable` follow from facts the catalogue and
// the registry already carry: whether a resolver runs, whether every signal a resolver needs wants a
// scope no install is granted (ADR 0016), and which of ADR 0071's three telemetry verdicts a question
// records. Nothing is authored for those and nothing can drift.
//
// `llm-eligible` cannot be derived. Of the 184 requirements, 38 record `partial-telemetry` — something
// is recorded that narrows the question without settling it — and that verdict says a reading exists;
// it does not say whether the reading is a number this app should compute or evidence a model should
// read. That distinction is the whole of the route, and no field carries it. So eligibility is
// authored, once, in `ELIGIBLE` below, with the reason and the packet class per control — and the
// gate refuses an entry the catalogue contradicts.
//
// # What the revalidation found
//
// The plan supplies a candidate list of 34 and requires the first phase to revalidate it rather than
// adopt it. Measured against the catalogue on 2026-08-10, it holds for 22 of them and its two named
// exceptions have swapped size.
//
// **The rule the plan leads with now catches nothing.** "An owed measure outranks eligibility" is
// argued from `DG-01-06`, which was on the eligible list and recorded as owed a measure. `37k` paid
// that one and `37j` paid the last remaining debt, so no catalogue question is `owed-a-measure`.
// The rule is kept and gated because an editor will add a candidate one day, but it is a
// guardrail rather than the correction the phase was scheduled for.
//
// **The exception the plan treats as a caveat is the one that bites.** Eight named candidates are
// `beyond-telemetry`: nothing recorded bears on them, so the packet holds customer declarations and
// nothing else. The plan permits that and states the condition — the verdict inherits the
// declaration's authority and must be labelled as judgment over what somebody said — so they stay
// eligible here with `packet: 'declarations-only'`, and the gate holds the label to the verdict.
//
// **Four candidates are now answered by a reading.** `DG-01-06`, `IU-04-01`, `IU-04-02` and `OE-01-06`
// were attestations when the list was written and are measured now. They are `deterministic` for the
// same reason the owed-a-measure rule exists: a requirement with a reading is answered by the reading.
//
// # Why a partial-telemetry question nobody authored is not eligible
//
// Sixteen requirements record `partial-telemetry` and appear in no authored rubric — thirteen because
// the plan lists them as deterministic-first, three because it mentions them nowhere. They are
// `evidence-incomplete`, not `deterministic`, and the difference matters: none of them has a reading
// today, so calling them deterministic would claim a rule was applied when none was. The plan's
// "should remain deterministic" is a statement about which route they take *when* they gain a
// reading, and eight of the twenty-one on that list already have.
//
// The default therefore fails closed. A requirement is eligible because somebody wrote down why, not
// because nothing else claimed it.

import type { Catalogue, CatalogueControl } from '../catalogue/catalogue.js';
import { beyondAnyInstall, descriptorsById } from '../plan/plan.js';
import type { ResolverRegistry } from '../resolve/resolver.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { ELIGIBLE, type PacketClass } from './eligibility.js';

/**
 * What may produce a verdict for a requirement.
 *
 * One per requirement, and never two. The gate in `check-judgment-routes.mts` fails on a requirement
 * with none or with more than one, which is the property that makes the deferral of the model phases
 * enforceable: a check can refuse a control reaching a model without a route, and prose cannot.
 */
export type JudgmentRoute = 'deterministic' | 'llm-eligible' | 'evidence-incomplete' | 'human-accountable';

export interface Routing {
  readonly route: JudgmentRoute;
  /** Why this requirement has this route, in the terms a reader of the coverage ledger can check. */
  readonly why: string;
  /** What a rubric would be judged over. Only on `llm-eligible`, where a packet is ever built. */
  readonly packet?: PacketClass;
}

/**
 * The route for every requirement in the catalogue.
 *
 * Order is load-bearing and reads downwards from the strongest evidence. A resolver that runs answers
 * the requirement, so nothing else is consulted; an owed measure is a debt paid with a reading rather
 * than with a model reasoning around the absence of one; a scope no install may hold cannot be argued
 * past. Only what survives all three is eligible, and only where a rubric was authored for it.
 */
export function judgmentRoutes(
  catalogue: Catalogue,
  registry: ResolverRegistry = buildRegistry(),
  descriptors = descriptorsById()
): ReadonlyMap<string, Routing> {
  const routed = new Map<string, Routing>();
  for (const control of catalogue.controls) routed.set(control.id, routeOf(control, registry, descriptors));
  return routed;
}

function routeOf(
  control: CatalogueControl,
  registry: ResolverRegistry,
  descriptors: ReturnType<typeof descriptorsById>
): Routing {
  const verdict = control.attestation?.askedBecause?.verdict;
  const authored = ELIGIBLE[control.id];

  if (control.measurability !== 'attestation') {
    // The same order `pathOf` in the coverage ledger uses, and for the same reason: a resolver whose
    // every signal wants an ungrantable scope is written, correct, and unable to run anywhere.
    if (beyondAnyInstall(control, registry, descriptors)) {
      return {
        route: 'evidence-incomplete',
        why: 'Every reading it needs wants a scope no install of this app is granted, so nothing it could be judged over is collected.',
      };
    }
    return registry.get(control.id) != null
      ? { route: 'deterministic', why: 'A resolver answers it from readings, so the reading is the verdict.' }
      : {
          route: 'evidence-incomplete',
          why: 'The catalogue expects a reading for it and no resolver is registered, so there is nothing to judge yet.',
        };
  }

  if (verdict === 'owed-a-measure') {
    return {
      route: 'deterministic',
      why: 'The platform records enough to settle it and this app does not read it yet. A debt is paid with the reading, not with a model reasoning around the absence of one.',
    };
  }

  if (authored != null) {
    return { route: 'llm-eligible', why: authored.why, packet: authored.packet };
  }

  if (verdict === 'beyond-telemetry') {
    return {
      route: 'human-accountable',
      why: 'Nothing recorded bears on it and no rubric claims otherwise, so the answer is a person’s and the model can only prepare one.',
    };
  }

  return {
    route: 'evidence-incomplete',
    why: 'Something recorded narrows it without settling it, and no rubric has been authored over what that is. Which of the two it becomes is a judgment nobody has made rather than one this file can derive.',
  };
}
