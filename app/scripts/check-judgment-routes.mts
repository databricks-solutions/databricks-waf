#!/usr/bin/env -S npx tsx
// Every requirement has exactly one judgment route, and no eligibility entry contradicts the catalogue.
//
// The routes themselves are derived in `server/judge/route.ts`, so most of what this could check is
// true by construction: a map cannot hold two values for one key, and the derivation returns a route
// for every control it iterates. Checking that here would be checking TypeScript.
//
// What is not true by construction is the authored half. `ELIGIBLE` is a hand-written table of
// requirement ids, and every way it can be wrong is a way a requirement reaches a model that should
// not have: an id that no longer exists, an id the catalogue now answers with a reading, an id whose
// debt is unpaid, or a packet class that claims evidence over a requirement nothing records.
//
// So this gate holds the authored table to the derived facts, in the direction that matters. It runs
// in `verify` beside `check:coverage`, which publishes the result of the same derivation — the
// intent being that the ledger cannot report a routing the gate would have refused.

import { loadCatalogue } from '../server/catalogue/catalogue.js';
import { buildRegistry } from '../server/resolve/resolvers/index.js';
import { beyondAnyInstall, descriptorsById } from '../server/plan/plan.js';
import { ELIGIBLE } from '../server/judge/eligibility.js';
import { judgmentRoutes } from '../server/judge/route.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();
const descriptors = descriptorsById();
const routes = judgmentRoutes(catalogue, registry, descriptors);
const byId = new Map(catalogue.controls.map((control) => [control.id, control]));

const problems: string[] = [];

for (const control of catalogue.controls) {
  const routing = routes.get(control.id);
  if (routing == null) {
    problems.push(`${control.id} has no judgment route. Every requirement needs one, so nothing reaches a model by default.`);
    continue;
  }
  if (routing.why.trim() === '') {
    problems.push(`${control.id} is routed ${routing.route} with no reason. The reason is what makes the route reviewable.`);
  }
  if (routing.route !== 'llm-eligible' && routing.packet != null) {
    problems.push(`${control.id} is routed ${routing.route} and declares a packet class. Only an eligible requirement is ever judged over a packet.`);
  }
}

for (const [id, entry] of Object.entries(ELIGIBLE)) {
  const control = byId.get(id);
  if (control == null) {
    problems.push(`ELIGIBLE names ${id}, which is not in the catalogue. A renamed or retired requirement leaves a rubric pointing at nothing.`);
    continue;
  }

  const verdict = control.attestation?.askedBecause?.verdict;

  // The rule the advisor plan leads with. It catches nothing today — 37j paid the last
  // owed-a-measure question — and it is here because the next editor will not have read that.
  if (verdict === 'owed-a-measure') {
    problems.push(
      `${id} is marked eligible and the catalogue records it as owed a measure. A debt is paid with the reading, ` +
        'not with a model reasoning around the absence of one. Route it deterministic until the measure lands.'
    );
  }

  // A requirement with a reading is answered by the reading, which is the same rule one step later.
  // Four of the plan's candidates crossed this line between the list being written and being read.
  if (control.measurability !== 'attestation' && !beyondAnyInstall(control, registry, descriptors) && registry.get(id) != null) {
    problems.push(
      `${id} is marked eligible and a resolver answers it from readings. Remove it from ELIGIBLE: a requirement ` +
        'this app measures is deterministic, whatever the candidate list said when it was written.'
    );
  }

  // The condition the plan attaches to permitting these at all. Derived and asserted rather than
  // trusted: the class is authored so that saying it wrong is a reviewable edit, and this is what
  // makes saying it wrong fail the build.
  const required = verdict === 'beyond-telemetry' ? 'declarations-only' : 'evidence';
  if (entry.packet !== required) {
    problems.push(
      `${id} declares a ${entry.packet} packet and the catalogue records it as ${String(verdict)}, which needs ${required}. ` +
        (required === 'declarations-only'
          ? 'Nothing recorded bears on it, so a verdict inherits the authority of what somebody said and has to say so.'
          : 'Something recorded bears on it, so a packet of declarations alone would discard the evidence that exists.')
    );
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} judgment routing problem(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nThe routes are derived in server/judge/route.ts and the eligible set is authored in\n' +
      'server/judge/eligibility.ts. Nothing here is a preference: each rule above is the reason a\n' +
      'requirement must not reach a model, and the gate exists because prose cannot refuse a call.\n'
  );
  process.exit(1);
}

const tally = new Map<string, number>();
for (const routing of routes.values()) tally.set(routing.route, (tally.get(routing.route) ?? 0) + 1);
console.log(
  `Every one of the ${catalogue.controls.length} requirements has one judgment route: ` +
    [...tally]
      .sort((a, b) => b[1] - a[1])
      .map(([route, n]) => `${n} ${route}`)
      .join(', ')
    + '.'
);
