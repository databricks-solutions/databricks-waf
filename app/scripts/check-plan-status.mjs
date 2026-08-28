#!/usr/bin/env node
// Does docs/plan-status.md still describe this repository?
//
// The file exists because the plan stopped being tracked: six of eleven phases fell out of the
// working task list during the interface rebuild, and the visible consequence was that the largest
// gap in the product — 82 requirements with no way to answer them — sat unbuilt while smaller work
// went ahead of it. Writing the phases down fixes that once. Keeping them true needs a check,
// because a status document is exactly the kind of file that is accurate on the day it is written
// and quietly wrong a month later.
//
// What this can and cannot verify is worth being precise about. It cannot tell whether a phase is
// *finished* — that is a judgement about a plan, and no grep decides it. It can tell whether the
// documents are describing this codebase or a different one, in four directions:
//
//   A phase recorded as done whose code is absent. The failure mode that matters, because it is the
//   one that reads as progress.
//
//   A phase recorded as not done whose code has since landed. Less dangerous but more corrosive: a
//   list of gaps that includes things already built is a list nobody believes, and once it is not
//   believed the first direction stops being caught either.
//
//   A phase with a section and no ledger row. This is the original failure exactly: six phases fell
//   out of the working list and stayed described but unscheduled. A pre-ledger phase is allowed to
//   have no row because it landed before the ledger existed, so the rule is narrower than "every
//   phase has a row" — an unfinished phase with no row is what fails.
//
//   A summary of the phases that disagrees with the phases. Added 2026-08-12, when the table under
//   "Where each phase is written down" was found wrong in twelve of its twenty-three rows — every one
//   of them derivable from what this file already read. See `indexProblems`.
//
// The detail moved out of plan-status.md into docs/plan/ on 2026-08-05, one file per phase family,
// because 88% of the single file's bytes sat inside table cells that cannot hold a paragraph. What
// this check reads changed with it: a phase's state is the `**Status:**` line under its own heading
// rather than which of two tables its row was in.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const DOCS = join(APP, '..', 'docs');
const STATUS = join(DOCS, 'plan-status.md');
const PLAN = join(DOCS, 'plan');

/**
 * The evidence for each phase: a file that exists only if the phase was built.
 *
 * Deliberately a file rather than a phrase in the document. A check that greps the document for a
 * word it also wrote is a check that passes on any document, and this one has to fail on a stale
 * one.
 */
const EVIDENCE = [
  {
    phase: '3 (resolvers)',
    what: 'the resolvers for the two pillars that had none',
    // These two are the evidence because they are what the phase was behind on: every other
    // pillar had evaluators from phase 3's first pass, and these had zero between them. The
    // stronger claim — that no requirement is left in the `planned` bucket at all — is asserted
    // in server/plan/descriptors.test.ts, where it can be computed rather than grepped for.
    files: ['server/resolve/resolvers/interoperability.ts', 'server/resolve/resolvers/operational-excellence.ts'],
  },
  {
    phase: '3 (reach)',
    what: 'the remedy on an unmeasured finding and the note that renders it',
    // Both halves, because either alone was the state this phase was in: the server knew why a
    // reading failed and said nothing about it, and a note with nothing to render would be worse.
    files: ['server/resolve/remedy.ts', 'client/src/components/RemedyNote.tsx'],
  },
  {
    phase: '6',
    what: 'the attestation workflow',
    // The store rather than the page: an install with no UI still has to record answers, and the
    // API is what the phase actually promised.
    files: ['server/attest/store.ts', 'server/attest/postgres-store.ts', 'client/src/pages/AttestationsPage.tsx'],
  },
  {
    phase: '7a (provenance)',
    what: 'storage findings carrying the surface and identity that produced them',
    files: ['server/collect/provenance.ts'],
  },
  {
    phase: '7 (serverless)',
    what: 'the serverless readiness analyzer',
    files: ['server/analyze/serverless.ts'],
  },
  {
    phase: '6a (AI)',
    what: 'AI augmentation through AI Gateway',
    files: ['server/ai/gateway.ts'],
  },
  {
    phase: '7a (tier three)',
    what: 'the cloud-side storage bill, off without a service credential',
    files: ['server/collect/cloud/collector.ts'],
  },
  {
    phase: '8 (export)',
    what: 'the assessment as a downloadable file',
    // Both halves again. The builder alone is an endpoint nobody finds, and the menu alone would
    // be a control linking to a route that does not exist.
    files: ['server/export/document.ts', 'client/src/components/ExportMenu.tsx'],
  },
  {
    phase: '8 (deep links)',
    what: 'the link from a named resource to the page that configures it',
    // The URL table rather than a call site. Which resolvers name resources will keep changing;
    // that a link can be computed at all is the phase. The test beside it pins the shapes.
    files: ['server/resolve/locate.ts'],
  },
  {
    phase: '8 (print)',
    what: 'the document the browser prints',
    // The stylesheet and the route together. Either alone is half of it: a print stylesheet over
    // the interactive pages prints a truncated workbench, and the route without the stylesheet
    // prints the rail, the tabs and the buttons.
    files: ['client/src/styles/wa-print.css', 'client/src/pages/ReportPage.tsx'],
  },
  {
    phase: '8 (lifecycle)',
    what: 'recording that somebody accepted, deferred or fixed a finding',
    // Three files, because any two without the third is the state this phase could plausibly be
    // left in and still look finished. The standing is the half that makes it worth building — a
    // store without it records intentions nothing ever checks — and the register is where a
    // decision taken in a pane is still findable a fortnight later.
    files: ['server/decide/store.ts', 'server/decide/standing.ts', 'client/src/pages/DecisionsPage.tsx'],
  },
  {
    phase: '8 (remainder)',
    what: 'a CLI or Terraform snippet for every requirement the app can measure as failing',
    // A script rather than a module: the work is catalogue content, and what makes it done is a
    // gate that fails when a failable requirement has no fix to run.
    files: ['scripts/check-remediation.mjs'],
  },
  {
    phase: '7b (scheduled)',
    what: 'the job that starts an assessment nobody is watching',
    // The job's two files rather than the endpoint. `/api/scan/scheduled` shares routes.ts with the
    // interactive path, so no file's existence proves it is there — that claim is asserted where it
    // can be executed instead, in server/api/routes.test.ts under "a run started by a schedule".
    // These two are the right evidence anyway: an endpoint with nothing calling it is not the phase.
    files: ['schedule/trigger.py', 'resources/scheduled-scan.yml'],
  },

  /*
   * Release A of the product audit — docs/audit/, gap register rows GAP-020, 016, 021, 001, 002,
   * 012, 003, 004, 005, 011.
   *
   * These are here for the direction this check was mostly not built for: a phase listed as
   * missing whose code has since landed. All seven are unbuilt today, so what these entries do is
   * fail the build on the day one of them ships without this document moving — which is precisely
   * how the audit came to be invisible in the first place. The plan file said pilot-ready, the
   * audit said five P0 blockers, and nothing held the two against each other.
   *
   * The paths are predictions, and that is the known weakness. They follow the layout the roadmap
   * describes and the conventions the rest of server/ uses, but an implementer who puts
   * authorization in server/api/ rather than server/authz/ will leave this check passing while the
   * phase is built. That is a soft failure the existing entries share, and the instruction in
   * plan-status.md is to correct the path in the same change. It is still worth having: a wrong
   * path is a one-line fix a reviewer will spot, and no entry at all is a phase nobody notices.
   */
  {
    phase: 'A1a (mutation gate)',
    what: 'the check that decides whether a caller may mutate, not merely who they are',
    // One file, where the original A1 entry named two. That phase was re-scoped on 2026-08-02 by
    // ADR 0029: the seven roles and the ownership model are deferred past a pilot as A1b, and what
    // remains is a group check at identify(). So there is no policy table to consult, and naming
    // one would leave this entry unsatisfiable by the phase that is actually going to ship.
    //
    // The path was predicted as `server/authz/gate.ts` and corrected when the phase landed, which
    // is what the paragraph above says to do. `authorize` rather than `authz` because every other
    // directory under server/ is a whole word — attest, decide, collect, resolve, analyze — and
    // `group` rather than `gate` because the file's subject is the group, the gate being what it is
    // used for.
    files: ['server/authorize/group.ts'],
  },
  {
    phase: 'A3b (durable store)',
    what: 'the database the records are kept in, and the scan store over it',
    // Two files where the old A3b named two others, and the difference is the whole re-scope. This
    // phase was "a guard that refuses a production write with no durable store" — a guard being
    // necessary because a store could be absent. It cannot be absent: `openPostgres` throws and the
    // app serves the fallback page, so the guard is the connection and there is no
    // `server/store/durability.ts` to point at. The scan store is named alongside it because a
    // connection nothing writes through would satisfy a check and not the phase.
    files: ['server/store/postgres.ts', 'server/scan/postgres-store.ts'],
  },
  {
    phase: 'A3c (record digests)',
    what: 'the digest that makes a stored record checkable by somebody who did not write it',
    // Two files, and the path moved from the `server/store/digest.ts` this entry predicted — which
    // the paragraph above says to correct here when the phase lands. `server/records/` rather than
    // `server/store/` because a digest is not a property of the database: the same function covers a
    // record on its way out of the app as covers one on its way into a table, and putting it under
    // the store would have made the export import the store to hash a document.
    //
    // `verify.ts` alongside it because a digest nothing recomputes is a column, not a check, and
    // this phase is the check. What is deliberately not named here is the chain and the signature:
    // those are A3d, and naming them would leave this entry unsatisfiable by the phase that shipped.
    files: ['server/records/digest.ts', 'server/records/verify.ts'],
  },
  {
    phase: 'A3d (reproducible export)',
    what: 'the sealed export, and the digest published where the person who sent a file can read it',
    // The phase this entry predicted was `A3d (tamper-evident log)` at `server/records/chain.ts`, and
    // both halves of that are now wrong in the way the paragraph above says to correct here. The chain
    // landed as `server/store/audit-log.ts` under A5a, because a chain over audit events belongs with
    // the log rather than beside the record digests. What was left split in two, and this is the half
    // that shipped.
    //
    // Two files, because the sealer alone is the state this was in for an afternoon: a digest computed
    // on every download, recorded in the trail, and published nowhere a person could read it — which
    // is the same as not publishing one, for the reason `AdminScript` exists in the other direction.
    files: ['server/export/artefact.ts', 'client/src/components/RunFiles.tsx'],
  },
  {
    phase: 'A3d (managed-key signatures)',
    what: 'the signature that establishes where an exported file came from, not only that it is unchanged',
    // Predicted, not landed, and the path is a guess of the kind this file admits to making. One file
    // rather than two: the verification surface a third party reaches is a publication decision rather
    // than a module, so naming a second would predict the answer to the question the phase is about.
    files: ['server/records/sign.ts'],
  },
  {
    phase: 'A2 (definitions)',
    what: 'a named, versioned assessment definition and the setup that produces one',
    // Four files, and only the orientation is absent. Both pages are named because they turned out
    // to be two things rather than one: `DefinitionsPage` is the list of definitions and their
    // version history, which a reader returns to, and `SetupPage` is the flow that writes one, which
    // they pass through — over as many sittings as it takes, since a draft is kept. Naming only the
    // list would have left the phase reading as done with no way to produce what it lists.
    //
    // The preflight landed on 2026-08-03 and is named here because a definition an author cannot
    // check was half the phase: "what is in this review" and "can it run as this identity, and which
    // grant is each blocked check missing" are two questions, and a phase reading as done at the
    // point a scope could be typed would have taken the second off the list.
    //
    // The orientation is the fourth, and is not in the tree. It is named because the gap the Not done
    // table states for this phase is two-sided — no answer to "what is in this review", and a novice
    // asked to scan before being told what the app reads or what it will not do. Three files satisfy
    // the first side. Without a fourth, the phase reads as done while the second side is untouched,
    // which is the failure this whole check exists to catch.
    files: [
      'server/define/definition.ts',
      'client/src/pages/DefinitionsPage.tsx',
      'server/define/preflight.ts',
      'client/src/pages/SetupPage.tsx',
      'client/src/components/Orientation.tsx',
    ],
  },
  {
    phase: 'A2b (archive)',
    what: 'a confirmation before an assessment is closed, and the way back',
    // Exempted from having an entry when it was split out, on the grounds that both halves land inside
    // `define/definition.ts` — a file-existence test cannot separate built from unbuilt when the work
    // is a branch inside a file that is already there. The drive script ended that: the arrangement is
    // the thing this phase got wrong twice, so proving the arrangement got its own file, and a phase
    // that can be pointed at should be. See the note at the end of this list for the general form.
    files: ['scripts/drive-archive.mjs'],
  },
  {
    phase: 'A3 (run snapshot)',
    what: 'what produced a run, what it answers to, and the split of a delta across a catalogue',
    // Named `snapshot.ts` while this was pending, on the assumption that the record would be one
    // object. It landed as three, each of which is a different question: what produced the run,
    // what the catalogue did between two of them, and how much of a movement either explains. The
    // point of the check is unchanged — none of these files existed before the phase, so listing it
    // as done without doing it still fails.
    files: ['server/scan/identity.ts', 'server/catalogue/changelog.ts', 'server/scan/attribution.ts'],
  },
  {
    phase: 'A4 (orchestration)',
    what: 'the run that survives a restart, and the job that supervises it',
    // Predicted as `server/scan/worker.ts` and `resources/scan-worker.yml`, which was the literal
    // reading of AUD-DEC-102: a worker process the app hands the assessment to, provisioned by a
    // bundle. ADR 0060 refused it — a Lakeflow task runs Python, SQL, dbt or a JAR and the engine is
    // TypeScript, so a worker task means a second implementation of 184 requirements in a second
    // language — and split the work the other way: the run became a record any process can carry on,
    // and the job became the thing that triggers, supervises, retries and cancels.
    //
    // So the files moved with the decision. Both of these are the phase in the same sense the
    // predicted pair would have been: neither existed before it, and neither can be faked by listing
    // the phase as done.
    files: ['server/run/runs.ts', 'scripts/check-supervision.mjs'],
  },
  {
    phase: 'A5a (audit trail)',
    what: 'the chained log, the check that refuses a mutation which does not record the act, and the page that reads it',
    // The check is evidence rather than apparatus. Without it the log is a convention, and a
    // convention is what the refusal line in `group.ts` was for eight months — so a phase claiming
    // complete coverage on a store alone would be claiming the thing that was already true.
    //
    // The page is listed for the reason `A5b` and `A5c` list theirs, and here it is the sharpest case
    // of it: this phase's own argument for leaving the trail ungated is that the auditor is the person
    // who cannot hold the assessor group, and a trail readable only with a shell and a token serves a
    // narrower audience than the group it declined to gate on. A store and a check without it is a
    // capability nobody the phase was built for can exercise.
    files: ['server/store/audit-log.ts', 'scripts/check-audit-coverage.mjs', 'client/src/pages/TrailPage.tsx'],
  },
  {
    phase: 'A5b (retention)',
    what: 'retention with a legal hold',
    // Split from `A5 (administration)` on 2026-08-04, when the trail landed and this did not, for the
    // reason `A6a` and `A6c` were split from `A6b`: one phase name carries one status, and a phase
    // reading as done because a searchable log shipped beside an unbuilt retention policy is the
    // half-truth these documents exist to prevent.
    //
    // Two files, because a stated period nobody can state is not the phase. The gap this closes is
    // that there was no way to *say* what the retention position is, and a model an administrator
    // cannot reach leaves that exactly as it was — so the page is the phase rather than its
    // presentation, the same reasoning as `A5c` below.
    //
    // `A5d (anonymisation)` is the rest of the original `A5b` and has no entry of its own: it is
    // deliberately deferred, and naming a file for deferred work would make this check demand it.
    files: ['server/admin/retention.ts', 'client/src/pages/RetentionPage.tsx'],
  },
  {
    phase: 'A5e (full reset)',
    what: 'emptying an install, including the tables retention exempts',
    // Split from `A5b` on 2026-08-05 and predicted, not landed, so the path is a guess of the kind
    // this file admits to making. One file, and a new one rather than a function inside
    // `retention.ts`, because the two do opposite things to the audit log: the sweep cuts it as a
    // prefix and leaves a head that still descends from its root, and this discards the root and
    // writes a new one. Sharing a module would put both behaviours behind one import and make the
    // dangerous one reachable from the routine one.
    files: ['server/admin/reset.ts'],
  },
  {
    phase: 'A5c (resource health)',
    what: 'the health surface that says which binding is behind the symptoms',
    // Two files, because the model alone is not the phase. The gap this closes is that an install
    // reports its symptoms one page at a time and never names the cause, and a reading nobody can
    // read leaves that exactly as it was — so the page is evidence rather than presentation.
    files: ['server/health/health.ts', 'client/src/pages/DiagnosticsPage.tsx'],
  },
  {
    phase: 'A6a (verification)',
    what: 'the accessibility gate over the rendered app',
    // Split from `A6b (finding confidence)` on 2026-08-02, when this half landed and the other did
    // not: one phase name carries one status, and the alternative was a phase reading as done on a
    // harness that shipped beside a field nobody had built.
    files: ['scripts/check-a11y.mjs'],
  },
  {
    phase: 'A6b (finding confidence)',
    what: 'what a finding rests on, and how long it has held',
    // Two files, because either alone is a state this was in. A confidence with no occurrence says
    // how firmly the outcome is established and nothing about whether it is new, which is the half
    // that decides what somebody works on next; an occurrence with no confidence counts runs of a
    // reading nobody has been told the strength of.
    //
    // Neither is the client prose. `confidence-language.ts` renders these two and would exist for
    // no other reason, so pointing at it would mark the phase done on a file that cannot be written
    // before them.
    //
    // `A6c (release gate)` is the rest of the original `A6b` and has no entry: it is deliberately
    // deferred, and naming a file for deferred work would make this check demand it.
    files: ['server/resolve/confidence.ts', 'server/scan/occurrence.ts'],
  },

  /*
   * The high-value gaps plan's phases, from docs/plans/high-value-gaps.md.
   *
   * H1 is the one entry here that is not a prediction. It names a check rather than a feature,
   * because the defect it closes is an absence — two statements that return a row per object — and
   * an absence has no file. A check that refuses the next such statement does, and it is also the
   * part of the phase that keeps working after the two known statements are fixed.
   *
   * H5 was three independent small pieces with no single file that means the phase landed, so it had
   * no entry at all — naming one of the three would have marked the phase done at a third. The third
   * piece then landed on its own and the phase split, which is what an entry can be written against:
   * `H5 (coverage ledger)` is named below, and `H5 (programme surfaces)` still is not, for the
   * original reason. H6's own layout followed from H1's ceilings, so it was held back until it landed
   * rather than guessed at — the same reason B1 to D1 are held back below. `H6d` has landed and is
   * named; `H6` itself has not finished and so still is not.
   */
  {
    phase: 'H1a (declared bounds)',
    what: 'the row-bound declaration, and the two halves that hold statements to it',
    // The mechanism, not the fixed statements. Editing jobs_inventory.sql to add a GROUP BY closes
    // today's instance of this defect and does nothing about the next one, and the next one is a
    // statement somebody adds in a year against a customer nobody has yet.
    //
    // Both files, because either alone is the state this was in. The check without the runtime guard
    // is a lint over comments nobody has to keep true; the guard without the check enforces a
    // declaration a statement is free not to make.
    files: ['scripts/check-statement-bounds.mjs', 'server/collect/sql/bounds.ts'],
  },
  {
    phase: 'H1b (scale measured)',
    what: 'the declared scale targets, and the fixtures that measure what a statement costs at them',
    // The targets and the fixtures rather than the rewritten statements, because "rewritten" has no
    // file: a bounded jobs_inventory is the same path as the unbounded one. These two are what make
    // the claim checkable, and separating them from the rework is what let the measurement happen
    // first — which mattered, because it found the rework's premise wrong.
    files: ['server/collect/sql/scale.ts', 'server/collect/sql/scale-fixtures.ts'],
  },
  {
    phase: 'H1c (slice rule)',
    what: 'the axis a statement is allowed to slice on, and the check that its declaration is true',
    // Slicing is only exact where the predicate partitions the statement's grouping key, so the axis is
    // a declared property of the statement rather than a choice the collector makes — a slice on a
    // column the aggregates consume double-counts, and `serverless_job_readiness` has twelve
    // count(DISTINCT) expressions that would. Separated from the execution below because that premise
    // carries two phases, and proving it first is what found the checker exempting every unsafe window.
    files: ['server/collect/sql/slices.ts'],
  },
  {
    phase: 'H6d (the Optimisation group)',
    what: 'the Optimisation group\'s own page, which is the half of the phase a file can stand for',
    // The page rather than the nav entry, though the group is what the phase is named for. A nav
    // entry is three lines in an array and would still be there if the page it points at were
    // deleted — which is the state this check exists to fail on. The page cannot be present and
    // the group absent: `check-routes` fails a route with no way to reach it.
    //
    // Nothing here names the run kind, retention or the audit vocabulary, which were the other four
    // things this phase owed. They are all edits to files that already existed, so no path means
    // they happened; the tests in server/advise/ and server/api/ are what hold them.
    files: ['client/src/pages/WorkloadsPage.tsx'],
  },
  {
    phase: 'E1 (correct populations)',
    what: 'the rule that refuses a lifecycle filter applied before the window that picks the current row',
    // Names the check rather than the three corrected statements, because the statements were the
    // symptom. Three of them reported deleted resources as live — 212x on warehouses, 45x on clusters,
    // 5x on jobs — and the third was found by this file after the first two had been fixed by reading
    // them. A rule that fires is what stops the fourth.
    files: ['server/collect/sql/history.ts'],
  },
  {
    phase: 'H1d (sliced execution)',
    what: 'expanding a statement into one execution per workspace, and reassembling the answer in order',
    // The rule above says which axis is safe; these two spend it. Both, because the loop without the
    // re-sort is a concatenation whose first rows come from whichever workspace ran first, and
    // `offenders()` quotes exactly those as a finding's examples — so a loop alone would satisfy a
    // check here and change what the customer reads.
    files: ['server/collect/sql/sliced.ts', 'server/collect/sql/concat.ts'],
  },
  {
    phase: 'H1e (adaptive sub-slicing)',
    what: 'sub-dividing a slice that is still too large, and the backstop for when it still overruns',
    // The workspace axis assumes estates are spread across workspaces, and the skew is the whole risk:
    // one workspace holding 100,000 jobs reproduces the problem H1d solves for the mean case. Hash
    // buckets on the key subdivide without limit and stay exact for the same reason the workspace axis
    // does.
    files: ['server/collect/sql/buckets.ts'],
  },
  {
    phase: 'H2 (evidence classes)',
    what: 'the evidence class on a finding, and the composition it produces per pillar',
    // One file where this entry predicted two, and the second is the correction the paragraph above
    // asks for. `server/score/composition.ts` would have been a module holding one function that
    // counts findings by class — which belongs beside the class it counts, not in the score, because
    // the exports and the UI need it too and neither should import the scorer to describe a finding.
    // What keeps this from being a field nothing reads is not a second file: it is that `score.ts`,
    // both exports and the coverage framing all take their composition from here.
    files: ['server/resolve/evidence-class.ts'],
  },
  {
    phase: 'H3 (guidance and questionnaire)',
    what: 'the guidance content the questions need, its completeness gate, and the pass that asks them',
    // The gate is listed with the content because guidance that may ship half-written is the
    // failure this phase exists to prevent: a question with a stub answer rubric is worse than a
    // question with none, since it reads as authored.
    //
    // This predicted `server/attest/session.ts` for the third file and there is no such module, which
    // is the correction rather than an omission: ADR 0036 decided a pass has no session record. The
    // resume point is derived from the answers — the first question in scope whose answer does not
    // still count — because a stored cursor is wrong the moment a colleague answers three of them
    // from the other page, and wrong again next year when they expire. A server module would have
    // been a table nothing could keep true. What the phase is held to instead is the ordering the
    // pass is built on and the page that walks it.
    files: ['config/guidance/reliability.yaml', 'scripts/check-guidance.mjs', 'client/src/components/walk.ts'],
  },
  {
    phase: 'H3b (guidance gates)',
    what: 'the two gates over what a guidance author cannot see',
    // This phase was listed below as one that could not have evidence, on the grounds that both gates
    // land inside `check-guidance.mjs` and a file-existence test cannot separate a new branch in an
    // existing file from no branch at all. Row 11b made that untrue: the staleness rules moved into a
    // module of their own because they had to be testable — every review date in the tree is days old,
    // so the gate cannot fire on a real run, and without tests it would have been an intention whose
    // first execution was six months away.
    //
    // The grain check landed as `.mts` rather than the `.mjs` predicted here, because it imports the
    // rule from the server tree and so runs under tsx like `check-coverage-ledger.mts` does. The path
    // was corrected rather than the line removed, which is what the prediction asked for.
    //
    // The rule and its tests are named alongside the runner, because the runner is the part that could
    // be reduced to a no-op without anything else in the tree noticing.
    files: [
      'scripts/guidance-review.mjs',
      'scripts/check-grain.mts',
      'server/collect/sql/grain.ts',
      'server/collect/sql/grain.test.ts',
    ],
  },
  {
    phase: 'H5 (coverage ledger)',
    what: 'the generator, and the document it generates',
    // Both, because either alone is a state this was in for an hour. A generator with nothing
    // committed is a check that passes against a file no reader can open, which is the whole
    // complaint the phase answers — the claim was already tested and still had no reader. A document
    // with no generator is the hand-maintained count this file exists because of.
    //
    // The document is outside `app/`, unlike every other path here, and that is deliberate rather
    // than untidy: it is read by an auditor rather than served by the app, so it belongs with the
    // other documents at `docs/` and not in the bundle.
    files: ['scripts/check-coverage-ledger.mts', '../docs/coverage-ledger.md'],
  },
  {
    phase: '84 (the schema enforces no relational invariants)',
    what: 'the declared constraints and the decision that named each candidate',
    // Both, because the module alone could hold a constraint the ADR declined, and the ADR alone
    // is a decision nothing applies. Paths from `app/`, so the record sits next to the other
    // documents rather than in the bundle.
    files: [
      'server/store/invariants.ts',
      '../docs/decisions/0100-relational-invariants-are-declared-where-the-parent-key-is-unique.md',
    ],
  },
  {
    phase: '64 (the history budget against Lakebase, and the maximum it supports)',
    what: 'the decision that names the supported maximum',
    // The ADR, not the recording. `history-reads.json` has existed since `46a`, so a
    // file-existence test on it would have marked this done the day the local warm
    // reading shipped. The maximum is what this row adds, and it lives in the ADR.
    files: [
      '../docs/decisions/0101-history-reads-support-the-derived-volume-against-an-assumed-three-second-median.md',
    ],
  },
  {
    phase: 'M1b (the debt paid)',
    what: 'the decision that the quality monitor reports and does not band',
    // The ADR, not the fieldeng recording. `large-estate-quality-monitoring.json` has existed
    // since `78`, so a file-existence test on it would have marked this done the day the
    // premise was measured. The product decision is what this row adds.
    files: ['../docs/decisions/0102-the-quality-monitor-reports-and-does-not-band.md'],
  },
  {
    phase: '98 (the report page fetches twice per control)',
    what: 'the two collection paths and the test that they do not name a control',
    // The paths rather than ReportPage itself: the page already existed, and a file-existence
    // test on it would have marked this done the day the report shipped. The module is new,
    // and the test beside it is what fails when a finding starts fetching for itself again.
    files: ['client/src/api/report-reads.ts', 'client/src/api/report-reads.test.ts'],
  },
  {
    phase: 'H4 (admin evidence)',
    what: 'the read-only collection script and the import that refuses to trust it',
    // The import is named alongside the script because the script is the easy half. The file it
    // produces is untrusted input that becomes a score, and this is the only phase in the plan
    // whose acceptance is mostly negative tests.
    //
    // This predicted `scripts/collect-evidence.py`, and the script landed in `config/evidence`
    // instead. Not a rename for tidiness: `scripts/` is build-time tooling that is not shipped, and
    // this file has to be served to an admin by the running app at a URL whose checksum the app
    // publishes. Shipping it under `config` puts it where `shippedConfigDirectory` already looks,
    // which is what makes the copy an admin downloads the copy this build's resolvers were written
    // against. A script served from a path that is not deployed is a 404 on the one page that needs
    // it.
    // The import predicted one file and landed as four, because the four things it does are things
    // each of which may not assume the next has happened: read bytes under a cap, parse text that is
    // trying to be hostile, validate a shape, decide whether to believe it. One file doing all four
    // would be one file in which a later check could be reached without an earlier one having run.
    // `signals.ts` is the fifth and is a different job again — turning a believed reading into
    // something a resolver consumes, which is the only part that touches the score.
    files: [
      'config/evidence/collect-evidence.py',
      'server/import/read.ts',
      'server/import/parse.ts',
      'server/import/envelope.ts',
      'server/import/trust.ts',
      'server/import/signals.ts',
    ],
  },

  {
    phase: 'Q1a (runtime baseline)',
    what: 'the measurement harness, its recorded run and the gate that holds the record to shape',
    // All three, because any one alone is a state this could be left in and still look finished. The
    // harness without a committed run is a tool nobody has pointed at a warehouse; a run with no gate
    // is a JSON file that goes stale the day a statement is added or renamed and nothing notices; the
    // gate without the harness that produced its input would have nothing to check against a live
    // connection ever again.
    files: [
      'scripts/measure-sql-baseline.mjs',
      'server/collect/sql/runtime-baseline/labs.json',
      'server/collect/sql/runtime-baseline.test.ts',
    ],
  },

  {
    phase: 'B1 (plan records)',
    what: 'the two records, the reading of how they are doing, and where they are kept',
    // Four files rather than one, and each is here because the phase is a state this project has been
    // in with the others present.
    //
    // `action.ts` alone is a lifecycle nothing can persist. `store.ts` alone is a table with no rules
    // about what may go in it. `progress.ts` is the one a reader might think optional and is the least
    // so: without it the obvious next move is a `status` column on the plan, which is the defect A6b
    // refused for a finding's confidence and would be reintroduced here with more people looking at
    // the number. Naming it holds the phase to deriving progress rather than storing it.
    //
    // `plan.ts` is deliberately thin and is still named, because a plan that is only a foreign key on
    // an action is the spreadsheet this phase exists to replace.
    files: [
      'server/improve/action.ts',
      'server/improve/plan.ts',
      'server/improve/progress.ts',
      'server/improve/store.ts',
    ],
  },

  {
    phase: 'B1 (plan routes)',
    what: 'the endpoints over those records',
    // One file, because that is the shape the phase has: the routes for a resource live together, and
    // splitting them by verb would put the six moves in six places that each have to agree with the
    // one table in the domain that decides which of them are legal.
    files: ['server/api/improve-routes.ts'],
  },

  {
    phase: 'B1 (plan export)',
    what: 'the improvement plan as a document somebody can send, rather than a page they have to visit',
    // Predicted, not landed. One file, beside `document.ts` and `variant.ts` rather than inside
    // either: the report's builder is what an executive receives and this is what they ask about
    // afterwards, and the decision on 2026-08-05 was that folding one into the other makes the wrong
    // reader's document longer while leaving the plan unsendable.
    files: ['server/export/plan-document.ts'],
  },

  {
    phase: 'B1 (plan pages)',
    what: 'the pages over those endpoints, and the words they use',
    // The language module is named alongside the pages for the reason the other four language modules
    // are: nearly every sentence on this surface is conditional on a date or on what the last run
    // measured, and "due in 12 days" and "overdue by 12 days" differ by one comparison while meaning
    // opposite things to whoever has to act. Inline, neither branch is ever tested.
    //
    // `RaisedWork.tsx` is the one a reader might think incidental. It is the only thing that closes
    // the loop the other way — from the evidence to the work already raised against it — and without
    // it somebody looking at a failing requirement raises a second action for what a colleague is
    // already doing, which is how a tracker starts disagreeing with itself.
    files: [
      'client/src/pages/ImprovementsPage.tsx',
      'client/src/pages/PlanPage.tsx',
      'client/src/pages/improve-language.ts',
      'client/src/components/ActionForm.tsx',
      'client/src/components/ActionPanel.tsx',
      'client/src/components/RaisedWork.tsx',
    ],
  },

  {
    phase: 'C2 (monthly)',
    what: 'the publication record, the write path, and the page that previews and reads it',
    // Four files, because each alone is a state this could be left in and still look finished. The
    // record without the route is a type nothing writes; the route without the page is an endpoint
    // nobody finds; the page without the language module would bury the preview note, the standing
    // count and the digest caveat in JSX, which is how ADR 0072's sentences stop being testable;
    // the wire types are named because a second, browser-only shape is how preview and published
    // drift.
    files: [
      'server/monthly/publication.ts',
      'server/api/publication-routes.ts',
      'client/src/pages/MonthsPage.tsx',
      'client/src/pages/month-language.ts',
      'shared/api/month.ts',
    ],
  },

  {
    phase: 'C3 (reports)',
    what: 'the four export variants and the panel that publishes a digest for each',
    // The variant table and the panel, because either alone is a state this could be left in and
    // still look finished. A server that can shape four files nothing links to is four endpoints
    // nobody finds, and a panel listing variants a server does not produce would 400 on every link.
    files: ['server/export/variant.ts', 'client/src/components/RunFiles.tsx'],
  },

  {
    phase: 'D1 (methodology read)',
    what: 'the recorded scoring shape, the endpoint over it, and the page that reads it',
    // Three files, because each alone is a state this could be left in and still look finished. The
    // reader without the route is a projection nothing serves; the route without the page is an
    // endpoint nobody finds; the page without the reader would have to derive the methodology from the
    // loaded YAML, which is the one presentation that hides a hand-edited install — see ADR 0059.
    //
    // The agreement test is named too, and it is not incidental. `catalogue-version.mjs` computes the
    // same projection in JavaScript and cannot import this build, so the two agree by convention about
    // a field list; if they drift, the page accuses every customer of editing their configuration.
    // Deleting that test would leave the drift check reporting a refactor as tampering.
    files: [
      'server/catalogue/methodology.ts',
      'server/catalogue/methodology-agreement.test.ts',
      'server/api/methodology-routes.ts',
      'client/src/pages/MethodologyPage.tsx',
      'client/src/pages/methodology-language.ts',
    ],
  },

  {
    phase: '109a (the pilot methodology baseline is one manifest)',
    what: 'the generated public Methodology Version 1 contract and the release record that identifies its state',
    // Both files are required because their separation is the phase's central decision. The generated
    // manifest freezes executable assessment semantics; the small release record carries approval,
    // effective date and commit without making those release facts part of their own digest.
    files: [
      'config/methodology/version-1.manifest.json',
      'config/methodology/version-1.release.json',
      'scripts/methodology-manifest.mts',
    ],
  },

  {
    phase: '107i (the pilot journey is proved as one system)',
    what: 'the generated manifest that joins the two customer journeys to served and durable release evidence',
    // The checker itself landed before the proof it checks. Naming the generated record here is what
    // lets the checker report that absence as pending while still making it impossible to mark 107i
    // done without the release evidence, or to leave 107i open after that evidence lands.
    files: ['scripts/recordings/customer-journey.json'],
  },

  {
    phase: '118 (estate objects lead with platform ids)',
    what: 'the bounded platform-name resolver and the shared visual resource-kind treatment',
    // Both halves are the evidence because either alone recreates the defect: exact names with no
    // visible kind leave unlike resources visually interchangeable, while coloured kinds beside
    // opaque ids still ask the customer to recognise GUIDs. Both files are new in this row.
    files: ['server/collect/topology/names.ts', 'client/src/pages/topology/resource-kind.tsx'],
  },

  {
    phase: '121 (an open month claims it closed)',
    what: 'the shared open-versus-closed month language and its regression tests',
    // Both are new in this row. The route already existed, so naming it as evidence would have marked
    // the defect fixed before this change; the language module is the single place every publication
    // refusal now gets the month-boundary claim from, and the test holds both sides of that boundary.
    files: ['server/monthly/publication-language.ts', 'server/monthly/publication-language.test.ts'],
  },

  {
    phase: '122 (topology opens below readable scale)',
    what: 'the readable viewport policy and its regression tests',
    // Both are new in this row. The renderer and stylesheet predate it, so naming either would have
    // marked this defect fixed while the live canvas still opened at 8.64 CSS-pixel resource names.
    files: ['client/src/pages/topology/viewport.ts', 'client/src/pages/topology/viewport.test.ts'],
  },

  {
    phase: '123 (internal delivery names reach the customer UI)',
    what: 'the served customer-language guard and its regression tests',
    // These are new in this row. The generic route driver predated the defect and therefore cannot
    // stand as file evidence that it now rejects implementation vocabulary on customer screens.
    files: ['scripts/customer-language.mjs', 'scripts/customer-language.d.mts', 'scripts/customer-language.test.ts'],
  },

  {
    phase: '124 (investigation opens on an unfiltered estate)',
    what: 'the finding-to-resource focus and requirement-to-action handoff, with their regression tests',
    // InvestigatePage and the plan pages predate this defect. These modules are the new contracts
    // that keep their composition finding-led rather than letting existing files mark the row done.
    files: [
      'client/src/pages/investigation-focus.ts',
      'client/src/pages/investigation-focus.test.ts',
      'client/src/pages/investigation-filter.ts',
      'client/src/pages/investigation-filter.test.ts',
      'client/src/pages/InvestigatePage.test.tsx',
      'client/src/pages/requirement-link.ts',
      'client/src/pages/requirement-link.test.ts',
    ],
  },

  {
    phase: '125 (focused resources reserve an empty graph)',
    what: 'the context-aware investigation layout and its focused-state regression',
    files: [
      'client/src/pages/investigation-focus.ts',
      'client/src/pages/investigation-focus.test.ts',
      'client/src/styles/wa-tailwind.css',
    ],
  },

  {
    phase: '126a (one customer design authority replaces the inherited constraints)',
    what: 'the canonical customer specification and the decision that makes its deprecation map effective',
    // Both files are new in this row. The historical kit and composition remain in the tree by design,
    // so their presence cannot prove the reset; the authority and its superseding decision can.
    files: [
      '../docs/design/customer-design-system.md',
      '../docs/decisions/0107-one-customer-design-authority-replaces-the-inherited-constraints.md',
    ],
  },

  {
    phase: '141a (the deprecated system has an executable boundary)',
    what: 'the executable legacy-design census and its permanent zero-tolerance regression gate',
    files: [
      'scripts/legacy-design.mjs',
      'scripts/legacy-design.test.ts',
      'scripts/check-design-system.mjs',
    ],
  },

  /*
   * The rest of Releases B, C and D have no entry yet, deliberately.
   *
   * Every phase named here must appear in one of the document's tables, but not every row of those
   * tables needs an entry here — so B2 onward are tracked in the document without a prediction about
   * their file layout. That layout follows from Release A's authorization model and run records, none
   * of which exist, so a guess made now would be a guess about a guess. Add each entry when its
   * release starts — the three `B1` entries above are the first of them to have one, and each was
   * written after its files existed rather than before, which is the honest way round.
   *
 * `D1 (methodology read)` above is the read half only. The customer applicability half has no entry
 * because it is not built, and the two are separate phase names rather than one for that reason.
 *
 * Two of the phases split out on 2026-08-05 have no entry either, and for a reason worth writing
 * down rather than leaving as an omission: `A3e (renumbering flag)` and `A5f (audit strictness)` each
 * land inside a module that already exists — `catalogue/changelog.ts`, `audit/record.ts`. Naming
 * either as evidence would mark the phase done today, which is the exact failure this check exists to
 * catch, pointing the wrong way. A file-existence test cannot separate built from unbuilt when the
 * work is a branch inside a file that is already there, so the document's tables carry these two
 * alone and a reviewer is what holds them. `A5e (full reset)` and `B1 (plan export)` were split in the
 * same pass and do have entries, because both are new files.
 *
 * Both of those have since shipped — rows 18b and 23d — and neither gained an entry, which is the
 * outcome the paragraph above predicted rather than an oversight. Worth saying plainly, because "no
 * entry" now means two different things in this list and only one of them is pending: `A4
 * (orchestration)` has an entry naming files that do not exist, and its absence from the tree is the
 * evidence. `A5f` has no entry at all, and nothing here can tell you whether it is built. What holds
 * it instead is that a posture is a behaviour rather than a file: `refuseIfUnrecordable` is exercised
 * by `server/api/routes.test.ts`, which asserts that a refused act left the store untouched, and by
 * `server/audit/record.test.ts` over both postures. A test naming the behaviour is the closest thing
 * to evidence this phase can have, and it is stronger than a filename would have been — which is an
 * argument for teaching this check to read tests rather than paths, and not one to make while
 * inventing a file to satisfy it.
 *
 * Two more were on that list and came off it, which is the direction to move an entry in: absent
 * because the work has no file of its own is a fair reason, and it expires the moment the work has
 * one. `H3b (guidance gates)` came off when row 11b landed and the staleness rules needed to be
 * testable, so they became a module rather than a branch. `A2b (archive)` came off when row 14b
 * landed and the thing that needed proving turned out to be the arrangement rather than either half
 * of the logic — a browser walking the journey is a file, where a branch inside `definition.ts` is
 * not.
 */
];

if (!existsSync(STATUS)) {
  process.stderr.write(
    'docs/plan-status.md is missing.\n\n' +
      'It is the only record of which of the eleven phases are built. Deleting it does not\n' +
      'simplify anything — it returns the project to the state where a whole phase can be\n' +
      'forgotten without anyone noticing.\n'
  );
  process.exit(1);
}

if (!existsSync(PLAN)) {
  process.stderr.write(
    'docs/plan/ is missing.\n\n' +
      'It holds the detail for every phase, one file per family. Without it the ledger is a\n' +
      'list of pull request numbers with nothing saying what any of them were for.\n'
  );
  process.exit(1);
}

/** The ledger's status vocabulary. Three values, because a fourth would need a rule for what it means. */
const STATUSES = ['Merged', 'In review', 'Not started'];

/**
 * Number words by value, so `WORDS[152]` is "one hundred and fifty-two".
 *
 * Generated rather than listed. This was a literal array, and its own comment said the list "runs out every
 * few weeks" — splitting a ledger row raises the total, and the check then fails on a true sentence with
 * advice to come and add a word here. It ran out twice in one day when `33m` and `33i` split. What the check
 * is for is that the sentence above the ledger and the table under it agree; the vocabulary it reads them
 * with is not a decision anyone should have to maintain.
 *
 * Held to one anchor per shape the spelling takes, because a generator with an off-by-one reads every count as
 * the one beside it and nothing else here would notice. There are five shapes, not three: below twenty, a
 * round ten, a ten with a one after it, a round hundred, and a hundred with a remainder. Dropping the
 * round-ten branch yields "forty-zero", which the first three anchors all accepted.
 */
const WORDS = (() => {
  const ones = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
    'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  ];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const under100 = (value) =>
    value < 20 ? ones[value] : `${tens[Math.floor(value / 10)]}${value % 10 === 0 ? '' : `-${ones[value % 10]}`}`;
  return Array.from({ length: 1000 }, (_unused, value) => {
    if (value < 100) return under100(value);
    const hundreds = `${ones[Math.floor(value / 100)]} hundred`;
    return value % 100 === 0 ? hundreds : `${hundreds} and ${under100(value % 100)}`;
  });
})();

for (const [value, word] of [
  [7, 'seven'],
  [40, 'forty'],
  [52, 'fifty-two'],
  [100, 'one hundred'],
  [152, 'one hundred and fifty-two'],
  [170, 'one hundred and seventy'],
]) {
  if (WORDS[value] !== word) {
    throw new Error(`check-plan-status spells ${String(value)} "${WORDS[value]}", not "${word}"`);
  }
}

const text = readFileSync(STATUS, 'utf8');
const { phases, problems } = phaseSections();

for (const entry of EVIDENCE) {
  const present = entry.files.filter((file) => existsSync(join(APP, file)));
  const built = present.length === entry.files.length;
  const section = phases.get(entry.phase);

  if (section === undefined) {
    problems.push(
      `Phase ${entry.phase} has no section under docs/plan/.\n` +
        '      Every phase this check knows about has to be written down somewhere. Being written\n' +
        '      down nowhere is how six of them were lost the first time.'
    );
    continue;
  }

  if (section.status === 'done' && !built) {
    problems.push(
      `Phase ${entry.phase} is recorded as done in ${section.file}, but ${entry.what} is not in the tree.\n` +
        `      Absent: ${entry.files.filter((file) => !present.includes(file)).join(', ')}\n` +
        '      Either the phase is not done, or the evidence in check-plan-status.mjs names the\n' +
        '      wrong files. Fix whichever is actually wrong — a phase that reads as done and is\n' +
        '      not is the failure this check exists for.'
    );
  }

  if (section.status !== 'done' && built) {
    problems.push(
      `Phase ${entry.phase} is recorded as ${section.status} in ${section.file}, but ${entry.what} is in the tree.\n` +
        `      Present: ${present.join(', ')}\n` +
        '      Set its status to done in the same change that finished it, and write what shipped\n' +
        '      where the gap was. A list of gaps containing things already built is a list nobody reads.'
    );
  }
}

problems.push(...ledgerProblems(text));
problems.push(...indexProblems(text, phases));

if (problems.length > 0) {
  process.stderr.write('The plan documents no longer describe this repository.\n\n');
  for (const problem of problems) process.stderr.write(`  - ${problem}\n\n`);
  process.exit(1);
}

process.stdout.write(
  `docs/plan-status.md and docs/plan/ match the tree ` +
    `(${String(phases.size)} phases, ${String(EVIDENCE.length)} with file evidence).\n`
);

/**
 * Does "Where each phase is written down" still list what is written down?
 *
 * That table names every plan file, the phases inside it and how many are done, not done and
 * deferred. All of it is derivable from the sections this check already read, and none of it was
 * checked — so on 2026-08-12 twelve of its twenty-three rows were wrong: `A4` read "1 not done"
 * while `A4` was done, `Q1k` and `H6c` through `H6e` were missing entirely, and four families
 * undercounted what had landed. Nobody had misread the plan; the table had simply never been
 * updated by a change that added a phase, because nothing failed when it was not.
 *
 * This is the rule `AGENTS.md` states as enforce it rather than write it, applied to a claim that
 * had been written eleven times and enforced none. The counts are the part that rots first, because
 * a phase changes status in a different pull request from the one that added it.
 *
 * Phases are compared as a sorted list rather than in document order: `a3-run-records.md` opens with
 * `A3b` and `a5-administration.md` interleaves its six, so document order would make the table an
 * accident of which half shipped first.
 */
function indexProblems(text, phases) {
  const found = [];
  const header = '| File | Phases | State |\n| --- | --- | --- |\n';
  const start = text.indexOf(header);
  if (start < 0) {
    return [
      'docs/plan-status.md has no "Where each phase is written down" table.\n' +
        '      It is the only place a reader learns which file a family lives in. If it moved, this\n' +
        '      check has to move with it.',
    ];
  }

  // A blank line ends the table, and a table that ends the file has none — `indexOf` returning -1 would
  // otherwise silently drop its last row, which is the drift this check is for.
  const bodyStart = start + header.length;
  const blank = text.indexOf('\n\n', bodyStart);
  const rows = text
    .slice(bodyStart, blank < 0 ? text.length : blank)
    .split('\n')
    .filter((line) => line.startsWith('|'));

  const expected = new Map();
  for (const [phase, section] of phases) {
    const file = section.file.replace('docs/plan/', '');
    const entry = expected.get(file) ?? { phases: [], counts: new Map() };
    entry.phases.push(phase);
    entry.counts.set(section.status, (entry.counts.get(section.status) ?? 0) + 1);
    expected.set(file, entry);
  }

  const listed = new Set();
  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    const [, name, phaseCell, stateCell] = cells;
    const file = /\(plan\/([^)]+)\)/.exec(name ?? '')?.[1];
    if (file === undefined) {
      found.push(
        `A row of the phase table names no file under plan/: ${(name ?? row).slice(0, 60)}\n` +
          '      Every row links the family file it describes, which is what makes the table navigable.'
      );
      continue;
    }
    if (listed.has(file)) {
      found.push(
        `The phase table has more than one row for docs/plan/${file}.\n` +
          '      One row per family, or the counts in it stop summing to the plan and a reader gets\n' +
          '      whichever row they happened to look at.'
      );
    }
    listed.add(file);

    const entry = expected.get(file);
    if (entry === undefined) {
      found.push(
        `The phase table lists docs/plan/${file}, which has no phase sections.\n` +
          '      Either the file went away or its phases lost their status lines.'
      );
      continue;
    }

    const want = [...entry.phases].sort((one, two) => one.localeCompare(two, 'en', { numeric: true }));
    if ((phaseCell ?? '') !== want.join(', ')) {
      found.push(
        `The phase table's row for docs/plan/${file} lists different phases than the file holds.\n` +
          `      Table: ${phaseCell ?? ''}\n` +
          `      File:  ${want.join(', ')}\n` +
          '      A phase missing from this row is a phase a reader cannot find from the ledger.'
      );
    }

    const wantState = ['done', 'not done', 'deferred']
      .filter((status) => entry.counts.has(status))
      .map((status) => `${String(entry.counts.get(status))} ${status}`)
      .join(', ');
    if ((stateCell ?? '') !== wantState) {
      found.push(
        `The phase table's state for docs/plan/${file} disagrees with the file's own status lines.\n` +
          `      Table: ${stateCell ?? ''}\n` +
          `      File:  ${wantState}\n` +
          '      The status lines are the source: a count in a summary table cannot make a phase done.'
      );
    }
  }

  for (const file of expected.keys()) {
    if (listed.has(file)) continue;
    found.push(
      `docs/plan/${file} has phase sections and no row in the phase table.\n` +
        '      A family nobody can reach from plan-status.md is the condition that lost six phases:\n' +
        '      described somewhere, listed nowhere.'
    );
  }

  return found;
}

/**
 * Every phase's state, read from its own section under docs/plan/, and what is wrong with the files.
 *
 * A phase section is a level-two heading whose next non-blank line declares a status. That shape
 * rather than "every level-two heading" because the family files also carry closing sections — why
 * authorization is two phases, what A2 left open — and reading those as phases would have the check
 * demanding a status for a paragraph.
 *
 * One pass returning both, rather than a parse for the map and a parse for the complaints. Two
 * implementations of "what counts as a phase section" would drift, and the one that drifted would be
 * the one deciding whether a phase is claimed twice.
 *
 * The duplicate check earns its place: a phase's status is now in one file rather than in one of two
 * tables, and nothing about markdown stops the same heading appearing in two families. Two sections
 * for one phase is worse than none, because `set` keeps whichever was read last and the check would
 * report a state no reader would find.
 */
function phaseSections() {
  const phases = new Map();
  const problems = [];

  for (const file of readdirSync(PLAN)
    .filter((name) => name.endsWith('.md'))
    .sort()) {
    const where = `docs/plan/${file}`;
    const contents = readFileSync(join(PLAN, file), 'utf8');
    const lines = contents.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const heading = /^## (.+)$/.exec(lines[index]);
      if (heading == null) continue;
      const next = lines.slice(index + 1).find((line) => line.trim() !== '') ?? '';
      const declared = /^\*\*Status:\*\* (done|not done|deferred)\b/.exec(next);
      if (declared == null) {
        // A heading that opens with a status this check does not know is a typo rather than a prose
        // section, and passing over it silently would leave the phase unchecked in every direction.
        if (/^\*\*Status:\*\*/.test(next)) {
          problems.push(
            `${where} declares "${heading[1].trim()}" as ${next.slice(0, 60).trim()}\n` +
              '      A status is done, not done or deferred. Nothing else is read.'
          );
        }
        continue;
      }

      const phase = heading[1].trim();
      if (phases.has(phase)) {
        problems.push(
          `Phase "${phase}" has a section in both ${phases.get(phase).file} and ${where}.\n` +
            '      A phase belongs to one family. Two sections means two statuses that can disagree,\n' +
            '      and this check would report whichever it read last.'
        );
      }

      const listed = /\*\*Ledger:\*\* (.+?)\s*$/.exec(next);
      phases.set(phase, {
        status: declared[1],
        file: where,
        // The row labels the section claims, so the two can be held against each other. A list opening
        // with `none` is the pre-ledger or deferred case and carries prose rather than labels.
        rows:
          listed == null || listed[1].startsWith('none')
            ? []
            : listed[1]
                .split(',')
                .map((part) => part.trim())
                .filter((part) => part !== ''),
      });
    }

    if (!contents.includes('](../plan-status.md)')) {
      problems.push(
        `${where} does not link back to the ledger.\n` +
          '      A detail file read on its own says nothing about whether the work is scheduled. The\n' +
          '      link is how a reader gets from a phase to its place in the order.'
      );
    }
  }

  return { phases, problems };
}

/**
 * Whether the ledger and the phase sections tell the same story.
 *
 * The document grew a second problem on top of the one it was written to solve. It said what was done
 * and what was not, across five tables in three sections, and separately carried an order by pull
 * request with no status on it at all — so "where are we, and which GitHub PR was that" took reading
 * four hundred lines and still could not be answered. The ledger is the fix, and a summary table that
 * can disagree with the detail it summarises is worse than no summary: it is the more convenient of
 * two answers, which is the one that gets believed.
 *
 * So the ledger owns status and the phase sections own detail, and this holds them together. A phase
 * spanning several rows is only claimable as done when all of them are, which is what stops H3
 * reading as finished because the first of its four PRs merged.
 */
function ledgerProblems(document) {
  const found = [];
  const rows = ledgerRows(document);

  if (rows.length === 0) {
    return ['The ledger table is missing or unparseable, so nothing below it is being checked.'];
  }

  found.push(...orderProblems(rows));

  /** Every ledger row that names a phase, so a phase split across PRs is judged on all of them. */
  const byPhase = new Map();
  for (const row of rows) {
    if (!STATUSES.includes(row.status)) {
      found.push(`Ledger PR ${row.pr} has status "${row.status}", which is not one of ${STATUSES.join(', ')}.`);
    }

    const landed = /\[#(\d+)\]\(https:\/\/github\.com\/\S+?\/pull\/\1\)/.test(row.landed);
    if (row.status === 'Not started' && row.landed !== '—') {
      found.push(`Ledger PR ${row.pr} is "Not started" but names ${row.landed}. Use an em dash.`);
    }
    if (row.status !== 'Not started' && !landed) {
      found.push(
        `Ledger PR ${row.pr} is "${row.status}" and does not link a GitHub pull request.\n` +
          '      Write it as [#39](https://github.com/example/project/pull/39).\n' +
          '      The number is the whole point of the column: without it, tracing a phase back to the\n' +
          '      change that made it means reading 278-file commits, which is how this file got here.'
      );
    }

    for (const phase of row.phases) {
      if (!byPhase.has(phase)) byPhase.set(phase, []);
      byPhase.get(phase).push(row);
    }
  }

  for (const [phase, naming] of byPhase) {
    // In review counts as done because the convention is to move the status in the same change that
    // finishes it, so a phase reads as done in the PR that is still open. Merging is what makes it
    // true, and the reviewer of that PR is who checks it.
    const settled = naming.every((row) => row.status !== 'Not started');
    const section = phases.get(phase);
    const where = naming.map((row) => `PR ${row.pr}`).join(', ');

    if (section === undefined) {
      found.push(
        `The ledger names phase "${phase}" at ${where}, and no file under docs/plan/ has a section for it.\n` +
          '      The name has to match a level-two heading exactly, so a reader can go from the ledger\n' +
          '      to the detail. Check for a missing qualifier.'
      );
      continue;
    }

    if (settled && section.status !== 'done') {
      found.push(
        `Every ledger row for "${phase}" is landed or in review (${where}), but ${section.file} still\n` +
          '      records it as not done. Set the status in the change that finishes it, and replace\n' +
          '      what is missing with what shipped.'
      );
    }

    if (!settled && section.status === 'done') {
      const outstanding = naming.filter((row) => row.status === 'Not started').map((row) => `PR ${row.pr}`);
      found.push(
        `${section.file} records "${phase}" as done, but the ledger still has ${outstanding.join(', ')}\n` +
          '      not started. A phase spanning several pull requests is done when all of them are.\n' +
          '      Split the phase if part of it has genuinely shipped — H1 became H1a and H1b for this.'
      );
    }

    // The section's own row list, held against the ledger. A phase that gains a pull request and
    // does not say so reads as smaller than it is, which is how a split gets forgotten.
    const claimed = section.rows.join(', ');
    const actual = naming.map((row) => row.pr).join(', ');
    if (claimed !== actual) {
      found.push(
        `${section.file} lists "${phase}" against ledger rows ${claimed || '(none)'}, but the ledger\n` +
          `      names it at ${actual}. The two have to agree — the section's list is what a reader\n` +
          '      sees first, and a stale one hides a row that was added or split.'
      );
    }
  }

  // A phase described but not scheduled is the original failure, and this is the direction the old
  // check could not see: it read the ledger and asked whether each row had detail, never the reverse.
  //
  // Two exemptions, both narrow. A phase recorded as done needs no row because it may have landed
  // before the ledger existed. A phase recorded as `deferred` needs none because that is the claim —
  // described in full and scheduled nowhere, which A1b, A3d, A5d and A6c each are for a reason their own
  // sections give. The third status exists so that claim has to be made out loud: while they sat in a
  // Not-done table they were indistinguishable from work somebody was about to start.
  for (const [phase, section] of phases) {
    if (byPhase.has(phase)) {
      if (section.status === 'deferred') {
        found.push(
          `${section.file} records "${phase}" as deferred, but the ledger schedules it at ` +
            `${byPhase
              .get(phase)
              .map((row) => `PR ${row.pr}`)
              .join(', ')}.\n` +
            '      Deferred means scheduled nowhere. Either it is in the plan, or it is not.'
        );
      }
      continue;
    }
    if (section.status !== 'not done') continue;
    found.push(
      `${section.file} records "${phase}" as not done, and no ledger row names it.\n` +
        '      This is the failure the whole document exists for: six phases fell out of the working\n' +
        '      list and stayed described but unscheduled. Give it a ledger row, or record it as\n' +
        '      deferred and say why — the way A1b, A3d, A5d and A6c do.'
    );
  }

  found.push(...countProblems(document, rows));
  return found;
}

/**
 * Whether the ledger's PR labels run in order, with every number present and none repeated.
 *
 * Labels rather than integers because splitting is the sanctioned response to a phase turning out
 * larger than one reviewable change — H1 became H1a and H1b, H1b then became H1b and H1c the moment
 * its apparatus was separable from its rework, and H1c split again once its rule was separable from
 * the loop over it. This is the third split and each one found something the combined PR would not. If a split renumbered everything below it,
 * every PR number already written into a commit message, a code comment or this file's own prose
 * would go stale, and the cost of an honest split would be a hundred-line diff. So a split gets a
 * letter, `3` becomes `3a` and `3b`, and nothing downstream moves.
 *
 * A second letter is allowed for the same reason the first one is, and was added when a row that was
 * already lettered needed splitting for the first time: `33m` became `33ma` and `33mb` once its
 * retrieval was separable from the two safeguards watching it. The rule this replaces read "a number,
 * or a number and a letter", which was true of every split until one happened to a lettered row —
 * and the only alternatives it left were renumbering, which this whole scheme exists to avoid, or
 * appending `33o` and filing the second half of a phase five rows away from the first.
 *
 * A third is allowed on the same argument, one split later: `33if` became `33ifa`, `33ifb` and `33ifc`
 * when the second of its two rules turned out to rest on a premise nothing had measured, so the
 * measurement had to come out as its own row. The alternative here was worse than last time, because
 * the row it would have appended after — `33ig` — is the one row of the family that depends on none of
 * the others, so the two halves of a broadcast rule would have been filed either side of a catalogue
 * read. Each widening has been one letter and one reason, which is the point: the depth is not a
 * budget, it is a record of how many times a row has turned out to contain two decisions.
 *
 * What is still checked is that the sequence is a sequence: strictly ascending, no repeats, and no
 * missing integer. A gap reads as a decision when it is a copy-paste slip. Ascending is a string
 * comparison over the suffix, which is why the letters stay lower-case and why it holds at any depth:
 * `ie` sorts before `ifa`, and `ifc` before `ig`.
 */
function orderProblems(rows) {
  const labels = rows.map((row) => row.pr);
  const parsed = labels.map((label) => {
    const parts = /^(\d+)([a-z]{0,3})$/.exec(label);
    return parts == null ? undefined : { number: Number(parts[1]), suffix: parts[2] };
  });

  const malformed = labels.filter((label, index) => parsed[index] === undefined);
  if (malformed.length > 0) {
    return [
      `The ledger has PR labels that are neither a number nor a number and up to three letters: ${malformed.join(', ')}.\n` +
        '      Use 4, then 3a and 3b when a pull request splits, then 3ba and 3bb when a split splits,\n' +
        '      and 3bba when that one does. A letter per split so nothing downstream renumbers.',
    ];
  }

  const problems = [];
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1];
    const current = parsed[index];
    const ascending =
      current.number > previous.number || (current.number === previous.number && current.suffix > previous.suffix);
    if (!ascending) {
      problems.push(
        `The ledger has ${labels[index]} after ${labels[index - 1]}, which is not ascending.\n` +
          '      Out of order or repeated, and either way the row is not where a reader will look for it.'
      );
    }
  }

  const numbers = new Set(parsed.map((entry) => entry.number));
  const highest = Math.max(...numbers);
  const missing = [];
  for (let number = 1; number <= highest; number += 1) if (!numbers.has(number)) missing.push(number);
  if (missing.length > 0) {
    problems.push(
      `The ledger skips PR ${missing.join(', ')}, counting to ${String(highest)}.\n` +
        '      A missing number reads as work that was dropped rather than as a typo.'
    );
  }

  return problems;
}

/**
 * The ledger's rows, parsed from the table under its heading.
 *
 * Bounded to that one table rather than every table in the file, because the detail tables also lead
 * with a number in places — "0, 1" and "9" are phase names — and reading those as ledger rows would
 * make the check fail on a document that is correct.
 */
function ledgerRows(document) {
  const at = document.indexOf('## The ledger');
  if (at === -1) return [];
  const section = document.slice(at, indexAfter(document, at));

  return (
    section
      .split('\n')
      // Any row whose first cell starts with a digit, rather than only well-formed labels. A stricter
      // filter drops a malformed label out of the ledger entirely, and the row then fails the count
      // check instead — sending the reader to look for a miscount when the defect is a typo.
      .filter((line) => /^\|\s*\d[^|]*\|/.test(line))
      .map((line) => {
        const cells = line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim());
        const [pr = '', status = '', landed = '', phase = ''] = cells;
        return {
          pr,
          status,
          landed,
          // Each phase is a link to its own section, so the name is the link text and the markup comes
          // off here rather than being written twice. An em dash means the row belongs to no phase,
          // which PR 1's reconciliation does.
          phases:
            phase === '—'
              ? []
              : phase
                  .split(/,\s*(?=\[)/)
                  .map((part) => (/^\[([^\]]+)\]\(/.exec(part.trim())?.[1] ?? part.trim()).replace(/\*\*/g, ''))
                  .filter((part) => part !== ''),
        };
      })
  );
}

function indexAfter(document, at) {
  const next = document.indexOf('\n## ', at + 1);
  return next === -1 ? document.length : next;
}

/**
 * Whether the sentence above the ledger still counts the ledger.
 *
 * Checked because a hand-written total is the first thing to rot, and a wrong one at the top of the
 * file is read by people who never scroll to the table.
 */
function countProblems(document, rows) {
  // The review clause is optional because it is only true sometimes: between a merge and the next
  // branch there is nothing in review, and demanding the clause anyway would put "None is in review."
  // at the top of the file — a sentence written for this checker rather than for a reader.
  // Hyphens in every number word, not only the total. "Twenty-one of forty-four landed." is the
  // twenty-first merge and the first hyphenated count, and the earlier pattern rejected it — a check
  // that fails on a true sentence teaches the next reader to edit the sentence rather than the code.
  // Spaces are allowed inside a number word, and only for the ones that need them: every count up to
  // ninety-nine is a single hyphenated word, "one hundred" is two, and past it they are four.
  // Rejecting them would leave the
  // failure below telling a reader to add a word to WORDS that this expression then cannot read —
  // which is worse than not anticipating the total at all, because the advice is wrong rather than
  // absent. There is exactly one " of " in the sentence, so the greedy class cannot swallow the
  // separator.
  const claim = /^([\w -]+) of ([\w -]+) landed\.(?: ([\w -]+) (?:is|are) in review\.)?$/m.exec(document);
  if (claim == null) {
    return [
      'The sentence above the ledger no longer reads "<N> of <M> landed." or "<N> of <M> landed. <K> is in review."\n' +
        '      It is the only part of this file most readers see, so it is checked rather than trusted.',
    ];
  }

  const [, merged, total, reviewing] = claim;
  const actual = {
    merged: rows.filter((row) => row.status === 'Merged').length,
    total: rows.length,
    reviewing: rows.filter((row) => row.status === 'In review').length,
  };
  const words = { merged, total, reviewing: reviewing ?? 'zero' };
  const said = {
    merged: numberFrom(words.merged),
    total: numberFrom(words.total),
    reviewing: numberFrom(words.reviewing),
  };

  // An unreadable number is named as one rather than left to the mismatch below, which would otherwise
  // report "says thirty-six of fifty-one; the table says 36 of 51" — two identical numbers, and a reader
  // sent to look for a miscount when what is wrong is the spelling. The vocabulary is generated to a
  // thousand, so this now means a misspelling or a hyphen in the wrong place, not a missing entry.
  const unreadable = Object.keys(said)
    .filter((key) => Number.isNaN(said[key]))
    .map((key) => `"${words[key]}"`);
  if (unreadable.length > 0) {
    return [
      `The sentence above the ledger uses a number this check cannot read: ${unreadable.join(', ')}.\n` +
        "      Numbers are spelled out because the file's prose spells them out, and the spelling is\n" +
        '      matched against a vocabulary generated to 999 in this file. So this is a misspelling or a\n' +
        '      missing hyphen — "one hundred and fifty-two", not "one hundred fifty two".',
    ];
  }

  const wrong = Object.keys(actual).filter((key) => said[key] !== actual[key]);
  if (wrong.length === 0) return [];
  // Naming the omission rather than reporting "says zero" keeps the message true to what is written:
  // an absent clause and a clause claiming zero are the same count but not the same edit.
  const claimed = reviewing == null ? 'no review clause' : `${reviewing} in review`;
  return [
    `The sentence above the ledger says ${merged} of ${total} landed with ${claimed}; ` +
      `the table says ${String(actual.merged)} of ${String(actual.total)} with ${String(actual.reviewing)}.`,
  ];
}

/** A spelled-out number, or NaN. Spelled out because the file's prose spells numbers out. */
function numberFrom(word) {
  const index = WORDS.indexOf(word.toLowerCase());
  return index === -1 ? Number.NaN : index;
}
