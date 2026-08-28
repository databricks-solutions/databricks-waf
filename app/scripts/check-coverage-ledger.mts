#!/usr/bin/env -S npx tsx
// Every one of the 184 requirements, and the thing that answers it.
//
// # Why a committed file and not a test
//
// The claim is already true and already tested: `plan/descriptors.test.ts` asserts the backlog is
// empty, and `resolve/resolvers/resolvers.test.ts` holds the registry and the catalogue to each
// other in both directions. What none of that produces is something a reader can hold. An auditor
// asking "which of these 184 requirements does this tool actually answer, and how?" cannot be sent
// to a green tick on a pull request; the answer has to be a document, at a URL, that they can read
// against the catalogue and disagree with line by line.
//
// So this generates one, and CI fails when it drifts — the same shape as `check-counts.mjs`, for the
// same reason a hand-maintained number drifts silently. Nothing here decides anything: every fact in
// the ledger is read out of the catalogue, the resolver registry, the attestation questions and the
// administrator evidence script's own manifest. If the ledger is wrong, one of those is wrong, and
// that is the point.
//
// # Why it runs under tsx
//
// It is the first check to do so, and it is deliberate. The alternative — re-parsing the pillar YAML
// the way `check-counts.mjs` does — would produce a ledger that restates the catalogue's claims about
// itself. The catalogue says a requirement is `implemented`; a ledger derived from the catalogue then
// says the same thing, and both are wrong together if no resolver was ever registered. Loading the
// real registry means the ledger reports what the code does. The equivalence between the two is a
// test's job, not this file's, and that test exists.
//
// # What the ledger does not claim
//
// That the answers are right. A requirement answered by a question a person ticks is answered by
// somebody's word for it, and this counts that as an answer path because the alternative — leaving 63
// requirements unaccounted — is what the ledger exists to make impossible. The column that says how a
// requirement is answered is the honest part: a reader who thinks an attested practice is weaker
// evidence than a measured one is right, and can see which is which.
//
// Run `npm run check:coverage -- --write` after changing the catalogue, a resolver, or the evidence
// script.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, type CatalogueControl, type TelemetryVerdict } from '../server/catalogue/catalogue.js';
import { buildRegistry } from '../server/resolve/resolvers/index.js';
import { beyondAnyInstall, descriptorsById } from '../server/plan/plan.js';
import { BLOCKED_QUESTIONS } from '../server/attest/blocked-questions.js';
import { judgmentRoutes, type JudgmentRoute } from '../server/judge/route.js';
import { revivable } from '../server/import/signals.js';
import type { SignalId } from '../server/collect/signal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_SCRIPT = join(HERE, '..', 'config', 'evidence', 'collect-evidence.py');
const LEDGER = join(HERE, '..', '..', 'docs', 'coverage-ledger.md');

/**
 * How a requirement gets an answer.
 *
 * Three, and the order they are decided in is load-bearing rather than stylistic — see `pathOf`.
 * They are named for the reader rather than for the code: `measured` is not "has a resolver", it is
 * "this app reads it", and a requirement with a perfectly good resolver whose every signal needs a
 * scope no install is granted is not measured by anything, however much code was written for it.
 */
type Path = 'measured' | 'setting' | 'practice';

/** How much the administrator evidence script does for a requirement no install can read. */
type Support = 'import' | 'collected' | 'none';

interface Row {
  readonly id: string;
  readonly pillar: string;
  readonly path: Path;
  /** The specific thing that answers it, for a reader checking the claim rather than counting it. */
  readonly answer: string;
  readonly support?: Support;
}

const catalogue = loadCatalogue();
const registry = buildRegistry();
const descriptors = descriptorsById();

/**
 * The signals the administrator script collects, from the script's own `--manifest`.
 *
 * Asked of the script rather than transcribed, for the reason `check-evidence-script.mjs` asks the
 * same question the same way: a table in this file would be a second account of what the script does
 * and would be wrong the first time somebody added a probe.
 *
 * A failure here is fatal rather than degraded. A ledger that quietly reported 52 requirements as
 * having no administrator path because `python3` was missing would be a document that reads as a
 * product gap and is really a missing interpreter, and the reader has no way to tell.
 */
function collectedByAdministrator(): ReadonlySet<string> {
  try {
    const manifest = JSON.parse(execFileSync('python3', [EVIDENCE_SCRIPT, '--manifest'], { encoding: 'utf8' })) as {
      readonly probes: readonly { readonly signals: readonly string[] }[];
    };
    return new Set(manifest.probes.flatMap((probe) => probe.signals));
  } catch (problem) {
    console.error(
      `\ncollect-evidence.py --manifest did not run: ${(problem as Error).message}\n` +
        'The ledger reports what the administrator script collects, so it cannot be generated without\n' +
        'asking the script. This needs python3 on the path — the same requirement check:evidence-script has.\n'
    );
    process.exit(1);
  }
}

const collected = collectedByAdministrator();
const revived = new Set(revivable([...collected] as readonly SignalId[]));

/**
 * Which of the three answers a requirement has, decided in the only order that is not misleading.
 *
 * `practice` first: a requirement the catalogue classes as attestation is one no telemetry reaches
 * for anybody, and asking whether an install could be authorised to read it is asking about a
 * capability that does not exist.
 *
 * `setting` before `measured`, which is the one that would be easy to get backwards. A resolver
 * whose every required signal needs a scope Databricks Apps does not grant is written, correct, and
 * unable to run anywhere (ADR 0016) — so the requirement is answered by a person reading a screen,
 * and reporting it as measured would count code as coverage.
 */
function pathOf(control: CatalogueControl): Path | undefined {
  if (control.measurability === 'attestation') return 'practice';
  if (beyondAnyInstall(control, registry, descriptors)) {
    return BLOCKED_QUESTIONS[control.id] != null ? 'setting' : undefined;
  }
  return registry.get(control.id) != null ? 'measured' : undefined;
}

function supportOf(control: CatalogueControl): Support {
  const collector = control.collector ?? '';
  if (revived.has(collector as SignalId)) return 'import';
  return collected.has(collector) ? 'collected' : 'none';
}

function rowOf(control: CatalogueControl, path: Path): Row {
  const pillar = catalogue.pillars.find((candidate) => candidate.id === control.pillarId);
  const base = { id: control.id, pillar: pillar?.code ?? control.pillarId, path };

  if (path === 'measured') {
    const resolver = registry.get(control.id);
    return { ...base, answer: (resolver?.requires ?? []).map((signal) => `\`${signal}\``).join(', ') };
  }
  if (path === 'setting') {
    return { ...base, answer: `\`${control.collector ?? 'unnamed'}\``, support: supportOf(control) };
  }
  return { ...base, answer: `every ${control.attestation?.cadenceDays ?? '?'} days` };
}

const unanswered: string[] = [];
const rows: Row[] = [];

for (const control of catalogue.controls) {
  const path = pathOf(control);
  if (path == null) {
    unanswered.push(control.id);
    continue;
  }
  rows.push(rowOf(control, path));
}

// Refused before anything is written. A ledger with a gap in it is not a ledger to regenerate, it is
// a requirement nobody can answer — and the two states have to fail differently, because one is
// "run the command" and the other is "there is work to do".
if (unanswered.length > 0) {
  console.error(
    `\n${unanswered.length} requirement${unanswered.length === 1 ? '' : 's'} have no answer path:\n\n` +
      unanswered.map((id) => `  ${id}`).join('\n') +
      '\n\nEvery requirement in the catalogue must be measured by a resolver, answered by a question ' +
      'about a\nsetting no install can read, or answered by a question about practice. A requirement in ' +
      'none of\nthe three reports to a reader as an unmeasured gap with no owner, which is the state ' +
      'this ledger\nexists to make impossible. See docs/decisions/0016-*.md and server/plan/plan.ts.\n'
  );
  process.exit(1);
}

rows.sort((a, b) => a.id.localeCompare(b.id));

/**
 * Every practice question with the recorded reason it is a question rather than a measure.
 *
 * Refused when one is missing, for the same reason the ledger is refused when a requirement has no
 * answer path. A question with no stated reason is one nobody has checked against the platform, and
 * the way that fails is silent: the telemetry arrives and the question survives it, because nothing
 * ever wrote down what it was standing in for. `enrich-catalogue.mjs` refuses first; this is the
 * second lock, on the generated catalogue rather than on the table behind it.
 */
interface Asked {
  readonly id: string;
  readonly title: string;
  readonly verdict: TelemetryVerdict;
  readonly why: string;
  readonly signal?: string;
}

const unexplained: string[] = [];
const asked: Asked[] = [];

for (const control of catalogue.controls) {
  if (control.measurability !== 'attestation') continue;
  const because = control.attestation?.askedBecause;
  if (because == null) {
    unexplained.push(control.id);
    continue;
  }
  asked.push({
    id: control.id,
    title: control.title,
    verdict: because.verdict,
    why: because.why,
    ...(because.signal != null ? { signal: because.signal } : {}),
  });
}

if (unexplained.length > 0) {
  console.error(
    `\n${unexplained.length} question${unexplained.length === 1 ? '' : 's'} put to a person with no recorded reason:\n\n` +
      unexplained.map((id) => `  ${id}`).join('\n') +
      '\n\nEvery question has to say what a machine would have to observe and whether anything records ' +
      'it.\nA questionnaire is the most expensive answer this tool gives, so reaching for one is a claim ' +
      'that\ngets reviewed. Add asked_because in config/controls/questions.mjs — see ADR 0071.\n'
  );
  process.exit(1);
}

asked.sort((a, b) => a.id.localeCompare(b.id));
const askedOf = (verdict: TelemetryVerdict) => asked.filter((entry) => entry.verdict === verdict);

const PATH_LABEL: Readonly<Record<Path, string>> = {
  measured: 'Measured',
  setting: 'Question — setting',
  practice: 'Question — practice',
};

const SUPPORT_LABEL: Readonly<Record<Support, string>> = {
  import: 'imported',
  collected: 'collected, held',
  none: 'not collected',
};

const ROUTE_LABEL: Readonly<Record<JudgmentRoute, string>> = {
  deterministic: 'Deterministic',
  'llm-eligible': 'LLM-eligible',
  'evidence-incomplete': 'Evidence-incomplete',
  'human-accountable': 'Human-accountable',
};

const routes = judgmentRoutes(catalogue, registry, descriptors);
const routed = (route: JudgmentRoute) => [...routes.values()].filter((one) => one.route === route).length;
const declarationsOnly = [...routes]
  .filter(([, one]) => one.packet === 'declarations-only')
  .map(([id]) => id)
  .sort();

const count = (path: Path) => rows.filter((row) => row.path === path).length;
const supported = (support: Support) => rows.filter((row) => row.support === support).length;

/**
 * The narrowing from "the framework says to do this automatically" to "this install read it".
 *
 * Four numbers, and the ledger has to reconcile them or it reads as contradicting the README. That
 * document counts 184 catalogue entries, 167 scored requirements once the ones belonging to two
 * pillars are collapsed, and the automatable subset — which is a *declaration* on each requirement
 * about whether a machine could answer it, not a claim that anything does. Then a resolver has to
 * exist, and then it has to be runnable somewhere. Each step loses some, every step is defensible,
 * and a reader shown only the first and the last concludes one of them is a lie.
 */
// The same three values `check-counts.mjs` calls automatable, listed a second time because that check
// parses the pillar YAML and cannot import a TypeScript module. Listed rather than derived as the
// complement of the other two: a sixth `Measurability` would then be silently counted as automated,
// which is the direction that overstates. `unclassified` below is what catches the sixth instead.
const AUTOMATABLE: readonly string[] = ['system-table', 'rest-api', 'cloud-api'];
const ANSWERED_BY_A_PERSON: readonly string[] = ['attestation', 'derived'];
const unclassified = catalogue.controls.filter(
  (control) => !AUTOMATABLE.includes(control.measurability) && !ANSWERED_BY_A_PERSON.includes(control.measurability)
);
if (unclassified.length > 0) {
  console.error(
    `\n${unclassified.length} requirement(s) declare a measurability this ledger does not know how to count: ` +
      `${[...new Set(unclassified.map((control) => control.measurability))].join(', ')}\n` +
      'Add it to AUTOMATABLE or ANSWERED_BY_A_PERSON here and to AUTOMATABLE in check-counts.mjs. Both\n' +
      'documents publish a coverage figure, and a value neither list holds is counted as not automated in\n' +
      'one and not at all in the other.\n'
  );
  process.exit(1);
}

const declared = catalogue.controls.filter((control) => AUTOMATABLE.includes(control.measurability));
const resolved = catalogue.controls.filter((control) => registry.get(control.id) != null);

/** One member of each alias group, so a requirement filed under two pillars is counted once. */
const collapsed = new Set(
  [...catalogue.aliasGroups.values()].flatMap((group) =>
    group
      .map((member) => member.id)
      .sort()
      .slice(1)
  )
);

const ladder = {
  entries: catalogue.controls.length,
  scored: catalogue.controls.length - collapsed.size,
  declared: declared.length,
  /** The same declaration counted the way the README counts it, so the two documents can be compared. */
  scoredDeclared: declared.filter((control) => !collapsed.has(control.id)).length,
  resolved: resolved.length,
  /** Declared automatable with no resolver. Every one is out of reach rather than outstanding. */
  declaredUnbuilt: declared.filter((control) => registry.get(control.id) == null).length,
  /** Resolved without being declared automatable: answered from signals another requirement collected. */
  resolvedUndeclared: resolved.filter((control) => !AUTOMATABLE.includes(control.measurability)).length,
  /** Resolved and unable to run in any install. ADR 0016. */
  resolvedUngrantable: rows.filter((row) => row.path === 'setting' && registry.get(row.id) != null).length,
};

function render(): string {
  const measured = count('measured');
  const setting = count('setting');
  const practice = count('practice');

  return [
    '<!-- Generated by app/scripts/check-coverage-ledger.mts. Do not edit: run `npm run check:coverage -- --write`. -->',
    '',
    '# Coverage ledger',
    '',
    `Every one of the ${rows.length} requirements in the catalogue, and the thing that answers it.`,
    '',
    'This document exists to be disagreed with. An assessment tool that reports a score over some',
    'unstated subset of a framework is asking to be trusted; this says which requirements it reads for',
    'itself, which it asks a person about, and why each one is in the group it is in. A reader who',
    'thinks an answer of the second kind is weaker evidence than one of the first is right, and can see',
    'from the table below exactly which requirements that applies to.',
    '',
    'It is generated from the catalogue, the resolver registry, the attestation questions and the',
    "administrator evidence script's own manifest, and CI fails when it drifts from them. Nothing here",
    'is maintained by hand, because a hand-maintained coverage claim is wrong within a month and',
    'nobody finds out.',
    '',
    '## Every requirement has an answer path',
    '',
    '| How it is answered | Requirements | What that means |',
    '| --- | --- | --- |',
    `| **Measured** | ${measured} | The app reads the platform and reaches a verdict. No person is asked. |`,
    `| **Question — setting** | ${setting} | Configuration this app could read and no install of it may. ` +
      'A check is written and cannot be authorised to run anywhere, so a person reads the screen instead. ' +
      'ADR 0016. |',
    `| **Question — practice** | ${practice} | A practice no telemetry reaches for anybody — whether a runbook ` +
      'is rehearsed, whether a review happens. A person describes it, and is asked again on a cadence. |',
    `| **Total** | **${rows.length}** | Every entry in the catalogue. ${ladder.scored} of them are scored — ` +
      'the rest are the same requirement filed under a second pillar, and the next section says why both ' +
      'halves still need an answer. |',
    '',
    'There is no fourth row, and that is the claim. A requirement with no check, no question and no plan',
    'would report to a reader as an unmeasured gap belonging to nobody; the generator refuses to write',
    'this file while one exists.',
    '',
    '### Why this counts differently from the README',
    '',
    `The README says **${ladder.scoredDeclared} of ${ladder.scored} scored controls are automatable**, and this document says`,
    `**${measured} of ${ladder.entries} are measured**. Both are true, and the gap between them is where the honest`,
    'part of this tool lives, so it is worth four sentences rather than a footnote.',
    '',
    `**${ladder.entries} against ${ladder.scored}** is the alias collapse. ${ladder.entries - ladder.scored} entries are one requirement filed under two`,
    'pillars — Delta history retention is a cost concern and a recovery concern — and a score counts each',
    'once so overlap cannot inflate it. This ledger enumerates entries rather than scored requirements,',
    'because every entry has to have an answer and both halves are read by somebody. Every count below is',
    `over entries, so the README's ${ladder.scoredDeclared} is ${ladder.declared} here.`,
    '',
    `**Declared automatable is a statement, not a capability.** ${ladder.declared} requirements say a machine could`,
    'answer them. That is a property of the requirement, written when the catalogue was authored, and it',
    'is what the README counts.',
    '',
    `**${ladder.resolved} have a resolver**, and the two sets are not nested, which is the part a subtraction would`,
    `get wrong. ${ladder.declaredUnbuilt} requirements are declared automatable with no resolver — and not one of them is a`,
    'backlog item: every one names an account-plane endpoint or a workspace scope no Databricks App is',
    `granted, so the check cannot be written to run. Meanwhile ${ladder.resolvedUndeclared} have a resolver without being`,
    'declared automatable, answered from signals collected for something else.',
    '',
    `**${measured} are measured in an install**, because ${ladder.resolvedUngrantable} of those ${ladder.resolved} resolvers need a scope no install is`,
    'offered either. They are written and correct and cannot be authorised to run anywhere (ADR 0016), so',
    'they appear below under **Question — setting** rather than under Measured. Counting them as coverage',
    `would be counting effort. They and the ${ladder.declaredUnbuilt} above are the reason the administrator evidence`,
    'script exists.',
    '',
    '## What the administrator evidence script does for the requirements no install can read',
    '',
    `The ${setting} above are the requirements a Databricks App cannot be granted the scope to read (ADR 0016). An`,
    'administrator can run `config/evidence/collect-evidence.py` under their own authority and import the',
    'result, which turns some of those questions back into readings. Three states, because they are three',
    'different amounts of progress and reporting them as one number would overstate the first:',
    '',
    '| Administrator script | Requirements | What a reader gets today |',
    '| --- | --- | --- |',
    `| Imported | ${supported('import')} | The script collects it and the app revives it into a finding. ` +
      'Evidence, marked as administrator-collected rather than observed. |',
    `| Collected, held | ${supported('collected')} | The script collects it and the app does not yet read it ` +
      'back. Held and named rather than discarded, so the import is not lossy — but the answer is still the ' +
      "person's. |",
    `| Not collected | ${supported('none')} | Neither collected nor revived. The question is the whole answer. |`,
    '',
    '## Why every question is a question',
    '',
    `The ${practice} practice questions above are the expensive answers: each costs a person's attention and`,
    'buys an answer no better than their word. So each one records what a machine would have to observe',
    'and whether anything records it, and the verdict that follows is published here rather than kept',
    'where only the catalogue can see it. The uncomfortable row is the third one.',
    '',
    '| Verdict | Questions | What it means |',
    '| --- | --- | --- |',
    `| Beyond telemetry | ${askedOf('beyond-telemetry').length} | Nothing the platform records bears on the answer. ` +
      'A person is the only source there is. |',
    `| Partial telemetry | ${askedOf('partial-telemetry').length} | Something is recorded, it narrows the answer, ` +
      'and it does not settle it. The question stands and names what bears on it. |',
    `| Owed a measure | ${askedOf('owed-a-measure').length} | The platform records enough to answer this and the ` +
      'app does not read it yet. A debt, not a design. |',
    '',
    `**${askedOf('owed-a-measure').length} of the ${practice} questions should not be questions.** That is the number this section exists to`,
    'publish. Each one below names the signal that would answer it, so the claim can be checked rather',
    'than taken on trust — and so that a question standing in for a measurement cannot quietly become',
    'permanent, which is what happens when the only record of the compromise is that somebody once knew.',
    '',
    '### Owed a measure',
    '',
    'The platform records enough to answer these. Until each is read, a person is asked instead.',
    '',
    ...(askedOf('owed-a-measure').length === 0
      ? ['None remain.']
      : askedOf('owed-a-measure').flatMap((entry) => [
          `- **\`${entry.id}\`** ${entry.title}`,
          `  ${entry.why}`,
          ...(entry.signal != null ? [`  Answered by \`${entry.signal}\`.`] : []),
        ])),
    '',
    '### Partial telemetry',
    '',
    'Something is recorded and it is not enough. The question stands, and names what bears on it so a',
    'reader can judge how much of the answer is really the person’s.',
    '',
    ...askedOf('partial-telemetry').flatMap((entry) => [
      `- **\`${entry.id}\`** ${entry.title}`,
      `  ${entry.why}`,
      ...(entry.signal != null ? [`  Bears on it: \`${entry.signal}\`.`] : []),
    ]),
    '',
    '### Beyond telemetry',
    '',
    'No signal bears on these, and none is expected to: they are facts about people, plans and',
    'intentions rather than about the estate. This is the claim most worth disagreeing with, so each one',
    'says what a machine would have had to see.',
    '',
    ...askedOf('beyond-telemetry').flatMap((entry) => [`- **\`${entry.id}\`** ${entry.title}`, `  ${entry.why}`]),
    '',
    '## By pillar',
    '',
    '| Pillar | Requirements | Measured | Question — setting | Question — practice |',
    '| --- | --- | --- | --- | --- |',
    ...catalogue.pillars.map((pillar) => {
      const mine = rows.filter((row) => row.pillar === pillar.code);
      const of = (path: Path) => mine.filter((row) => row.path === path).length;
      return `| ${pillar.title} | ${mine.length} | ${of('measured')} | ${of('setting')} | ${of('practice')} |`;
    }),
    '',
    '## What may produce a verdict',
    '',
    'A second axis, and a different question from the one above. **How it is answered** says where the',
    'evidence comes from today. **Judgment route** says what may ever reach a conclusion from it — and it',
    'exists so that eligibility for model-assisted judgment is settled once, here, rather than argued',
    'control by control at the point somebody writes the call.',
    '',
    '| Route | Requirements | What it means |',
    '| --- | --- | --- |',
    `| **Deterministic** | ${routed('deterministic')} | A resolver answers it from readings, or the reading is ` +
      'owed and the debt is paid with the reading. Nothing is sent anywhere. |',
    `| **LLM-eligible** | ${routed('llm-eligible')} | Somebody wrote down what a rubric would weigh that the ` +
      'reading does not settle. Eligible is not scored: no model verdict enters the published assessment. |',
    `| **Evidence-incomplete** | ${routed('evidence-incomplete')} | Nothing collected bears on a verdict — either ` +
      'no install may read it, or something narrows it and no rubric has been authored over what that is. |',
    `| **Human-accountable** | ${routed('human-accountable')} | Nothing recorded bears on it and no rubric claims ` +
      'otherwise, so the answer is a person’s. |',
    '',
    'Three of the four are derived from the catalogue and the registry. `llm-eligible` is not, and cannot',
    'be: the catalogue records that a reading exists for a requirement and never whether that reading is a',
    'number to compute or evidence to read, which is the whole of the route. So it is authored per',
    'requirement with a reason, and the default is not eligible — a `partial-telemetry` requirement nobody',
    'has written a reason for stays `evidence-incomplete`.',
    '',
    ...(declarationsOnly.length > 0
      ? [
          `**${declarationsOnly.length} of the ${routed('llm-eligible')} would be judged over declarations alone.**` +
            ' Nothing recorded bears on them, so a verdict inherits the authority of what somebody said and cannot' +
            ' exceed it. They are marked below and the routing gate holds that label to the catalogue’s own' +
            ` verdict: ${declarationsOnly.map((id) => `\`${id}\``).join(', ')}.`,
          '',
        ]
      : []),
    '## Every requirement',
    '',
    'Ordered by requirement id. **What answers it** names the signals a measured requirement rests on, the',
    'endpoint a setting question is about, or the review cadence of a practice question — so a reader can',
    'check a row rather than only count it.',
    '',
    '| Requirement | Pillar | How it is answered | What answers it | Judgment route |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => {
      const how = row.support != null ? `${PATH_LABEL[row.path]} (${SUPPORT_LABEL[row.support]})` : PATH_LABEL[row.path];
      const routing = routes.get(row.id);
      const packet = routing?.packet === 'declarations-only' ? ' (declarations only)' : '';
      return `| \`${row.id}\` | ${row.pillar} | ${how} | ${row.answer} | ${ROUTE_LABEL[routing?.route ?? 'evidence-incomplete']}${packet} |`;
    }),
    '',
  ].join('\n');
}

const expected = render();
const current = (() => {
  try {
    return readFileSync(LEDGER, 'utf8');
  } catch {
    return undefined;
  }
})();

if (process.argv.includes('--write')) {
  writeFileSync(LEDGER, expected);
  console.log(
    `docs/coverage-ledger.md updated: ${rows.length} requirements, ` +
      `${count('measured')} measured, ${count('setting')} asked about a setting, ${count('practice')} asked about practice.`
  );
} else if (current !== expected) {
  console.error(
    'docs/coverage-ledger.md is out of date. Run `npm run check:coverage -- --write`.\n\n' +
      'The ledger is the answer to "which requirements does this tool answer, and how", and it is only\n' +
      'worth having while it is derived. A stale one is a coverage claim about a catalogue that has moved.\n'
  );
  process.exit(1);
} else {
  console.log(`docs/coverage-ledger.md matches the catalogue: every one of ${rows.length} requirements has an answer path.`);
}
