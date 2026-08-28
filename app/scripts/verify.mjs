#!/usr/bin/env node
// Everything CI checks about the source, in one command.
//
// This exists because of a specific waste: a pull request failed CI on a stale
// typecheck, then on a README count, then on a missing catalogue bump — three
// sequential pushes, each about ninety seconds, for three faults that were all
// detectable locally in seconds. The checks were not the problem. Not having one
// command that ran them was.
//
// Two properties matter and neither is negotiable:
//
// It runs every check even after one fails, then reports all of them. A GitHub
// Actions job stops at the first failing step, which is what turned one bad push
// into three. Locally that behaviour is worse than useless: it hides the second
// fault behind the first and teaches you to push to find out.
//
// CI invokes this same script rather than repeating the list. A second copy of
// the sequence in ci.yml would drift, and the direction of drift is always the
// same — the local one gets forgotten, stops matching, and stops being trusted,
// at which point everyone goes back to pushing to find out.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Ordered fastest-first, so the common failures surface while the slower checks
// are still running. The reason each check exists is recorded here rather than in
// the workflow file, because here it sits next to the command it justifies.
const CHECKS = [
  {
    name: 'the branch-published Pages site matches its Markdown sources',
    // The official organization disables Actions, so Pages serves committed HTML directly from
    // main/docs. This prevents a guide edit from leaving that static publication stale.
    run: ['npm', 'run', 'check:docs-build'],
  },
  {
    name: 'lint',
    run: ['npm', 'run', 'lint'],
  },
  {
    name: "AppKit's own lint rules",
    // `databricks apps deploy` runs these as part of its validation and refuses to
    // deploy on a violation, so a rule this misses is not a style opinion — it is a
    // deploy that fails after the code is already merged. Eight violations had
    // accumulated in test files before this was added, and the first anyone knew was
    // a blocked deploy.
    run: ['npm', 'run', 'lint:ast-grep'],
  },
  {
    name: 'catalogue is internally consistent',
    // The catalogue is the substance of the product and its correctness rules fail
    // quietly: an extension that acquires a source anchor starts claiming to be
    // published Databricks guidance, a control claiming automated measurement with
    // no collector promises coverage that does not exist, and a one-member alias
    // group scores nothing at all.
    run: ['npm', 'run', 'validate:catalogue'],
  },
  {
    name: 'catalogue matches the enrichment table',
    // Which signal answers a control, what counts as a pass, which thresholds
    // apply — all live in one reviewable table and are applied into the pillar
    // files. Editing a threshold in the YAML directly would move scores with no
    // diff against the table that documents them.
    run: ['npm', 'run', 'enrich:catalogue', '--', '--check'],
  },
  {
    name: 'README control count matches the catalogue',
    // The README states how many controls exist. Deriving it means the number
    // cannot drift from the catalogue, which is how it was wrong before.
    run: ['npm', 'run', 'check:counts'],
  },
  {
    name: 'catalogue version records any change to what is scored',
    // Scans record the catalogue version they were scored against and the trend
    // view refuses to compare across a bump. That only works if the version
    // actually changes when the scored requirements do, which is exactly the kind
    // of manual step that gets forgotten.
    run: ['npm', 'run', 'catalogue:version'],
  },
  {
    name: 'Methodology Version 1 matches the executable assessment contract',
    // The public methodology is wider than the catalogue fingerprint: it also freezes which
    // evidence and questions answer each requirement, answer cadence and the scoring tables. The
    // committed manifest is what a customer and the release record cite, so drift is refused rather
    // than left as a stale document that still carries an authoritative digest.
    run: ['npm', 'run', 'check:methodology-manifest'],
  },
  {
    name: 'the REST collector only reads',
    // The serving endpoints scope is package-wide and carries write authority the app
    // does not want. This is what turns "we only read" from a promise into a check.
    run: ['npm', 'run', 'check:read-only'],
  },
  {
    name: 'the admin evidence script only reads, and answers what it claims to',
    // The script a customer's admin runs against production under their own authority. Everything
    // that makes it acceptable to run is a claim a security review checks once, for the version they
    // read: that it only reads, that it keeps only the fields it names, that it never asks for a
    // secret, and that the requirements it collects are the ones the catalogue is waiting on. This
    // is what keeps those true for the next version.
    run: ['npm', 'run', 'check:evidence-script'],
  },
  {
    name: 'the scheduled job supervises the run and the app executes it',
    // ADR 0060 split the work between a notebook and a job definition, and nothing connects the two
    // ends: a renamed parameter reads back as a default, a dropped retry policy turns a restarted app
    // into a lost week, and a blindness rule copied into the notebook would report an unread estate as
    // a good one from the day the real rule changed. None of it typechecks.
    run: ['npm', 'run', 'check:supervision'],
  },
  {
    name: 'the skill vendoring arrangement is the one ADR 0002 records',
    // ADR 0002 left one condition open and the repository has been sitting on its fallback branch
    // ever since, with nothing saying so. What said so was a weekly job asserting a pin file that
    // never existed, which failed on its first line every run and therefore never checked anything.
    // Here rather than there because it reads the source and needs no network, and because the way
    // this goes wrong is a pull request adopting vendoring without bringing the drift gate back.
    run: ['npm', 'run', 'check:skill-vendoring'],
  },
  {
    name: 'declared resources match what the app reads',
    // app.yaml and databricks.yml describe the same bindings from opposite ends, and a
    // name that drifts degrades a feature silently rather than failing.
    run: ['npm', 'run', 'check:resources'],
  },
  {
    name: 'the client follows the design system',
    // The design system is meant to be the UX for all subsequent work, and nothing about a
    // stylesheet makes that true. A raw palette colour is faster to type than finding the
    // semantic name, invisible in review, and wrong in one of the two themes; a shadow on a
    // panel undoes the console-native depth model in a single line. Checked, so the system
    // cannot decay one shortcut at a time.
    run: ['npm', 'run', 'check:design-system'],
  },
  {
    name: 'customer visual baselines match the client',
    // The deterministic customer states are the reviewable visual contract for the release candidate.
    // Their manifest holds the complete width/theme/state matrix, exact PNG pixels and a fingerprint of
    // every client visual source. A visual change therefore cannot pass ordinary verification by leaving
    // an old screenshot set in place; accepting new pixels remains a separate, explicit browser action.
    run: ['npm', 'run', 'customer-baselines:check'],
  },
  {
    name: 'every in-app link goes somewhere, with a filter that page applies',
    // A link to `/attestations` — the API's path for the answers page, not the router's — shipped
    // and typechecked, because `to` is a string. Clicking it replaced the whole application with
    // React Router's 404 boundary, shell and navigation included. The component test that should
    // have caught it had been written by reading the component, so it pinned the broken path.
    //
    // The query string is held to the same standard now that the numbers on every page are links.
    // "3 critical" carries `?pillar=…&severity=critical&outcome=unmet`, and a page that ignores one
    // of those three opens a list disagreeing with the figure that sent the reader there — which is
    // harder to notice than the 404, because nothing about it looks like a failure.
    run: ['npm', 'run', 'check:routes'],
  },
  {
    name: 'every customer outcome follows one immutable final assessment',
    // The latest raw run remains an operational input to review. It may never become a convenient
    // fallback for the State of the Nation, findings, trends, report or downloads: that is how one
    // application gives two answers to "current score". The census holds the seven consumer edges
    // and the provider boundary together.
    run: ['npm', 'run', 'check:final-result-consumers'],
  },
  {
    name: 'no method is called with its receiver dropped',
    // `(this.options.newId ?? crypto.randomUUID)()` shipped. `??` evaluates to the function's value, so
    // the call passes no `crypto`, and Node answers a detached `randomUUID` with "Illegal invocation" —
    // on the one path that finalises a review whose last pillar was retried. Typechecked, linted and
    // tested, all three green: the tests injected a `newId`, so the failing operand never ran.
    //
    // `@typescript-eslint/unbound-method` was measured against the same expression, on that same file
    // inside the server project, with `recommendedTypeChecked` in force: "No issues found". So this is a
    // check of our own rather than a line in `eslint.config.js`.
    run: ['npm', 'run', 'check:unbound-calls'],
  },
  {
    name: 'every statement declares how many rows it can return',
    // Results come back inline, and an inline result is capped at 25 MiB and fails past the cap
    // rather than truncating. So an uncapped inventory query is not a slow scan on a large estate,
    // it is no scan at all — and it fails first for the biggest customers, which is the opposite of
    // how every other limit in this tool degrades. Eight statements were written that way before
    // anything checked; this refuses a ninth.
    run: ['npm', 'run', 'check:statement-bounds'],
  },
  {
    name: 'every read of a change-log or timeline table gets down to one thing',
    // `system.lakeflow.pipelines` keeps a row per configuration change, and the inventory over it took
    // no latest row. On an internal estate it returned 101,207 rows where 8,934 pipelines exist: 1.7x
    // from counting each live pipeline once per edit, and the rest from `delete_time IS NULL` matching
    // the pre-deletion history of 50,061 deleted pipelines, which the filter therefore resurrected
    // rather than excluded. Nothing failed. Every finding about ETL frameworks was a share over that.
    //
    // `historyProblem` could not see it, by construction: it inspects a window's own WHERE, and this
    // statement had no window. That is the gap — pick the latest row, and pick it from everything.
    run: ['npm', 'run', 'check:grain'],
  },
  {
    name: 'the SQL quality release gate holds',
    // Bounds and grain catch undeclared growth and a known historical-grain mistake. They do not
    // hold price coverage, unit compatibility, identity uniqueness, generated identifier safety
    // or the Q1a performance budgets. Without one command that runs those together, the audit
    // can be completed once and drift immediately.
    run: ['npm', 'run', 'check:sql-release'],
  },
  {
    name: 'every failable requirement has a fix to run',
    // A run that reports forty unmet requirements is a to-do list unless each row says what to do
    // about it, and "move scheduled work onto job compute" is a diagnosis rather than a fix. This
    // is the gate that keeps the catalogue's remediation runnable — or, where no command exists,
    // explicit about that and specific about the alternative.
    run: ['npm', 'run', 'check:remediation'],
  },
  {
    name: 'answering guidance is complete where it claims to be',
    // 63 of the requirements are questions a person answers, and an answer given without guidance is a
    // guess that becomes a score. The failure mode this catches is not the unwritten entry — those are
    // scaffolded and the app says so — it is the entry that claims `status: authored` with three of its
    // nine fields written, which renders as headings with nothing under them and reads as a bug in the
    // product rather than as work not yet done. The same check holds a coverage floor that only rises,
    // so a pillar that gets written stays written.
    run: ['npm', 'run', 'check:guidance'],
  },
  {
    name: 'every mutating route records the act',
    // The audit log's value comes from what is absent from it: a reader who finds no event for last
    // Tuesday concludes nothing happened, and that only holds while the app cannot change anything
    // without recording the attempt. One route added without an act makes every absence in the table
    // meaningless, and nothing else here would notice — the feature works, the tests pass, and the
    // only symptom is a silence that reads like innocence.
    run: ['npm', 'run', 'check:audit-coverage'],
  },
  {
    name: 'every route handler is registered through the containment proxy',
    // The express AppKit serves on is 4.22.2, which lets a rejected async handler reach Node's
    // default and end the process — so on labs one TypeError reading one stored scan meant 502 on
    // every route and a hand redeploy to come back. `api/contain.ts` wraps handlers at the single
    // point registerApi hands the app to the route modules, and this holds the three ways that can
    // still be bypassed: registerApi stopping wrapping, a module building its own Router, or a
    // second server.extend. Each works in every test and takes the app down once, in production.
    run: ['npm', 'run', 'check:contained-handlers'],
  },
  {
    name: 'every requirement has an answer path, and the ledger says which',
    // The one document a customer's auditor reads instead of trusting us. It lists all 184
    // requirements and what answers each — measured here, a question about a setting no install can
    // read, or a question about practice — and the generator refuses to write it while any
    // requirement is in none of the three. That refusal is the check; the file is what makes it
    // reviewable by somebody who cannot run the tests. It also reconciles its own count with the
    // README's, which is how it found that the README had been pairing two numbers counted in
    // different spaces.
    run: ['npm', 'run', 'check:coverage'],
  },
  {
    name: 'every declared threshold is a measurement somebody takes',
    // A threshold in the catalogue that no resolver reads is a sentence about a
    // measurement that is not taken. DG-01-02 declared pass_share: 1 after the
    // measurement those numbers judged was removed, and the criteria
    // written from them reached a reader. Row 104. The walk is of the resolver
    // source, with an apparatus floor, because a silent walk produces an empty
    // unread list and a gate that passes forever.
    run: ['npm', 'run', 'check:thresholds'],
  },
  {
    name: 'every requirement has one judgment route, and no rubric outranks a reading',
    // The check that makes the model deferral enforceable. Three of the four routes are derived and
    // cannot drift; the eligible set is authored, and every way it can be wrong is a way a
    // requirement reaches a model that should not have — an id the catalogue now answers with a
    // reading, a debt still owed, a packet claiming evidence over a requirement nothing records.
    // Prose cannot refuse a call; this can.
    run: ['npm', 'run', 'check:judgment-routes'],
  },
  {
    name: 'the plan status document matches the tree',
    // Six of the eleven phases were dropped from tracking during the interface rebuild, and the
    // consequence was that the biggest gap in the product went unbuilt while smaller work was
    // picked up ahead of it. The document that fixes that is only useful while it is true, and a
    // status file is precisely the kind that is right the day it is written and wrong a month on.
    run: ['npm', 'run', 'check:plan-status'],
  },
  {
    name: 'the published runtime baseline quotes the recording it names',
    // The table in docs/design/q1a-runtime-baseline.md was transcribed by hand from labs.json and
    // drifted nine statements, one arity and a threefold duration away from it, while reading as a
    // measurement. It is generated now, and this is what keeps it that way: a recording that moves
    // without the document moving fails here rather than being noticed by whoever next needed the
    // number.
    run: ['npm', 'run', 'check:baseline-table'],
  },
  {
    name: 'the read-path census quotes the recording it names',
    // `56` exists because the first count of these reads published no apparatus. The table in
    // docs/plan/56-read-paths.md is generated from the recording, and this is what keeps the two
    // together: a read added without re-recording, or a table edited by hand, fails here.
    run: ['npm', 'run', 'check:read-paths'],
  },
  {
    name: 'the history read budget quotes the recording it names',
    // `46a` measured what the reads that load a whole record history cost at the volume this app's own
    // retention default and cadence table imply, and `46b` reworks whichever of them the numbers show
    // failing. The table in docs/design/history-read-budget.md is generated from the recording, and a
    // budget that stops describing the reads is worse than no budget: it is the document `46b`'s scope
    // is argued from. Not a re-measurement — a duration taken on one laptop is not a duration on
    // another, so this holds the table against the committed numbers, as check:baseline-table does.
    run: ['npm', 'run', 'check:history-reads'],
  },
  {
    name: 'the retention sweep table quotes the recording it names',
    // `83` priced an index for each of the sixteen stamps retention filters on that no index led, and
    // shipped five. The table in docs/design/retention-sweep-cost.md is generated from the recording,
    // and the sentences under it name every index the reading declined and why. That is the half of
    // the row that has to survive: a declined index with its number attached does not get re-proposed
    // by the next reader of the DDL, and a table edited by hand loses the number. Holds the document
    // against the committed recording rather than re-measuring, as the two checks above do.
    run: ['npm', 'run', 'check:retention-sweeps'],
  },
  {
    name: 'the import list table quotes the recording it names',
    // `85` priced the imports list against two envelope sizes and found the two candidate fixes were
    // not equivalent: paging leaves the cost where it is until an install exceeds a page and never
    // gets it down, and the promoted summary is flat. The table is generated, and the paragraph under
    // it is the argument for a column that otherwise looks like duplicated state. Losing the numbers
    // would leave the column with no reason attached, which is how it gets removed as redundant.
    run: ['npm', 'run', 'check:import-list'],
  },
  {
    name: 'the live Lakebase suite has passed against this SQL',
    // `postgres.live.test.ts` is what settles the questions the fake cannot, and it skips unless an
    // endpoint is bound, which nothing here does. Two of its assertions were wrong for five months
    // before `46b` ran it for an unrelated reason. CI has no Lakebase and a fork cannot be given
    // one, so this does not run the suite — it fails when a store's SQL has moved since the suite
    // last passed, which turns "run it when you change a statement" from an instruction into a gate.
    // ADR 0090.
    run: ['npm', 'run', 'check:live-suite'],
  },
  {
    name: 'the served-app stamp quotes the recording it names',
    // The one verification that has found defects no static check can see — deploying and driving the
    // real app — had no recorded date, so its staleness was invisible: five days and eleven merged rows
    // went by, and the deploy that ended that found `88`, `89` and `90` within three minutes. This does
    // not fail on age, deliberately. It needs a workspace, and a gate nobody can satisfy offline is how
    // the design-system check became the design authority (ADR 0027). It holds the stamp in
    // docs/estates.md to its recording and prints how old the two facts are. `87`.
    run: ['npm', 'run', 'check:served'],
  },
  {
    name: 'the pilot customer journey identities reconcile across release evidence',
    // The browser path, served route census and real-Lakebase suite are three independent green
    // checks unless something joins them. This refuses a stale deployment, source drift, a missing
    // restart read, or a raw run substituted where report/export/month require a final result.
    run: ['npm', 'run', 'check:customer-journey'],
  },
  {
    name: 'the shape of a stored scan has not moved without the codec version',
    // `81` added a field to the stored task counters and left `CODEC_VERSION` at 2, so a version 2 document
    // may or may not carry it and the number cannot say which. Every scan already in the served app then
    // crashed the route rendering it, and `88` was the refusal written afterwards. The refusal was the right
    // remedy for documents already written; this is what stops the next one being written at all. It reads
    // the shape out of the type declarations rather than out of a sample, so a field no fixture happens to
    // carry is still seen — the failure mode `H1`'s first measurement had. `90`.
    run: ['npm', 'run', 'check:shape'],
  },
  {
    name: 'the advisor provenance census quotes the contract it walked',
    // `44a` measured what an advisor finding carries of the four things an action made from it would
    // have to keep, and `44b` is the row that changes those payloads. A census of what was missing is
    // worth having only while it is a census of what is missing, so a field added to a finding without
    // re-recording fails here rather than leaving a table that reads as current.
    run: ['npm', 'run', 'check:action-provenance'],
  },
  {
    name: 'the decision index lists every decision',
    // Sixty decisions in sixty files is right for writing and wrong for finding, and the index that
    // fixes that is only worth having while it is complete. A hand-maintained one would have been
    // stale within a week, and a stale index is worse than none: it answers confidently with a list
    // missing the decision the reader needed, which is how a settled question gets reopened.
    run: ['npm', 'run', 'check:decisions'],
  },
  {
    name: 'every citation in the documentation resolves',
    // Twenty-eight markdown links pointed at nothing, and the ones that mattered pointed at decisions
    // by a description of what they decided rather than by their filename — which is what a writer
    // produces who knows the decision and not the file. This repository makes a claim checkable by
    // citing it, so a citation that 404s is worse than an uncited claim: it reads as sound to every
    // reader who does not follow it, and the three that were wrong had been wrong for months.
    //
    // Anchors are checked too, because the ledger points every row at a heading and a heading renamed
    // without its referrers is the same failure one level down.
    run: ['npm', 'run', 'check:doc-links'],
  },
  {
    name: 'a figure table quotes the recording it names',
    // Every number that decides what gets built here was transcribed by hand out of a JSON recording,
    // and until this ran nothing compared the two. The baseline table had drifted nine statements, one
    // arity and a threefold duration from its recording while reading exactly like a measurement, and
    // `check:baseline-table` above holds that one file. The review of `47` then found three figures in
    // one plan table wrong on arrival, each right about the arithmetic and wrong about which population
    // it described — which is the only kind of wrong number that reads as right.
    //
    // Opt-in, and deliberately so: prose carries its denominator in words, and a check that tried to
    // parse "of the 689 the worker join reaches" would either be wrong or be a language model.
    run: ['npm', 'run', 'check:figure-tables'],
  },
  {
    // Here for the reason the bundle check below is: CI's version of it failed on a change this
    // list had already passed four times. A dependency install behind an internal npm proxy writes
    // that proxy's host into the lockfile's tarball URLs, and nothing outside the network can
    // resolve them — which, as the CI step says, arrives as a hang rather than an error. Cheap to
    // run and remedied by `npm run lockfile:fix`, so there is no reason it was only on the runner.
    name: 'every tarball resolves from the public registry',
    run: ['npm', 'run', 'lockfile:check'],
  },
  {
    name: 'typecheck',
    run: ['npm', 'run', 'typecheck'],
  },
  {
    name: 'test',
    run: ['npm', 'run', 'test'],
  },
  {
    // Last, because it is the only check that writes to the working tree — it runs the
    // bundler, and leaving the rebuild in place is half the remedy. Anything it reports
    // is fixed by committing what it has already produced.
    //
    // It is here at all because CI's version of it failed on three consecutive pull
    // requests, each costing a push that carried nothing but a rebuild. Every other
    // check in this list was added for the same reason; this one was simply missed.
    name: 'the committed bundle is what this source builds',
    run: ['npm', 'run', 'check:bundle'],
  },
];

const failures = [];

// The distribution repository intentionally withholds private delivery plans, estate records and served
// release evidence. Their checks remain in the working-history source, while this fresh public root runs
// every product, security, catalogue, type, test and bundle check that is reproducible from shipped files.
const PRIVATE_EVIDENCE_CHECKS = new Set([
  'customer-baselines:check',
  'check:plan-status',
  'check:baseline-table',
  'check:read-paths',
  'check:action-provenance',
  'check:history-reads',
  'check:retention-sweeps',
  'check:import-list',
  'check:served',
  'check:customer-journey',
  'check:decisions',
]);
const activeChecks = existsSync('../docs/plan-status.md')
  ? CHECKS
  : CHECKS.filter((check) => !PRIVATE_EVIDENCE_CHECKS.has(check.run[2]));

for (const check of activeChecks) {
  const started = Date.now();
  const [command, ...args] = check.run;
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const failed = result.status !== 0;

  process.stdout.write(`${failed ? 'FAIL' : '  ok'}  ${check.name.padEnd(46)} ${elapsed}\n`);

  if (failed) {
    failures.push({
      name: check.name,
      // npm puts a script's own output on stdout and its own noise on stderr, and
      // which one carries the diagnosis differs per tool. Keeping both means the
      // reason is present whichever the tool chose.
      output: [result.stdout, result.stderr].filter((part) => part != null && part.trim() !== '').join('\n'),
    });
  }
}

if (failures.length === 0) {
  process.stdout.write('\nEverything CI checks about the source, and the bundle built from it, passes here.\n');
  process.exit(0);
}

for (const failure of failures) {
  process.stdout.write(`\n${'-'.repeat(72)}\n${failure.name}\n${'-'.repeat(72)}\n${failure.output}\n`);
}

process.stdout.write(
  `\n${failures.length} of ${activeChecks.length} checks failed: ${failures.map((f) => f.name).join(', ')}.\n` +
    'All of them are listed above rather than only the first, so this can be one fix rather than one push each.\n'
);
process.exit(1);
