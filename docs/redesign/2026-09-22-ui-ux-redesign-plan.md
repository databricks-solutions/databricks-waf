# WAF UI/UX Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every implementer task MUST first load the UI skills named in Global Constraints and read the spec.

**Goal:** Redesign the entire UI/UX of the Databricks WAF assessment app (editorial-minimal, progressive disclosure, solid motion) across all 34 pages, with zero functional impact, and deploy as a new parallel app on deep-test-1.

**Architecture:** Foundation-first. Retune the design tokens, upgrade the shared page template + primitives, add a motion module and a progressive-disclosure (`PlainSummary` + `DetailDisclosure`) + plain-language layer. Then redesign every page bespoke on that foundation, in parallel batches. The existing 892-test vitest suite + `check:design-system`/`check:a11y`/`check:viewport` are the regression net; they stay green throughout.

**Tech Stack:** React 19, TypeScript, Vite (rolldown), React Router 8, Tailwind v4, `@databricks/appkit-ui`, lucide-react, `@xyflow/react` (topology), vitest.

**Spec:** `docs/redesign/2026-09-22-ui-ux-redesign-design.md`

## Global Constraints

- **Skills to load per task:** `redesign-existing-projects`, `minimalist-ui`, `ui-ux-pro-max`, and (for any motion) `design-motion-principles`. Load before editing.
- **FROZEN — never change:** endpoints/paths/methods and wire shapes in `app/shared/api/contract.ts`; the endpoints/hooks in `app/client/src/api/hooks.ts`; React Router paths in `app/client/src/App.tsx`; `x-forwarded-*` auth handling; build output (`app/client/dist/index.html` + static assets served by appkit SPA catch-all; base path `/`).
- **No raw colors** — all color via `wa-*` CSS variables/tokens (enforced by `check:design-system`).
- **Accessibility** — WCAG AA contrast, visible focus, keyboard paths, viewport-fit; `check:a11y` stays green. All motion is `prefers-reduced-motion` aware.
- **Contract/behavior tests must stay green untouched.** Only presentation tests that assert old copy/markup may be updated to match new intent — never weaken an assertion about an API call, data flow, permission gate, or wire shape.
- **Regression gate (run in `app/`):** `npm run typecheck` && `npm run lint` && `npm run test` && `npm run check:design-system` && `npm run check:a11y` && `npm run check:viewport`. Baseline note: `main` may carry a small number of pre-existing failures — the gate is **no NEW failures beyond the recorded baseline**, and all `check:*` green.
- **Commits:** frequent, per task; end every commit message with `Co-authored-by: Isaac <no-reply@databricks.com>`.

---

## Phase 0 — Baseline & Foundation (gates all page work)

### Task 0.1: Record the green baseline
**Files:** none (verification only).
- [ ] Run `cd app && npm run verify` and `npm run check:design-system && npm run check:a11y && npm run check:viewport`; record pass/fail counts to `docs/redesign/BASELINE.md` (the "no new failures" reference).
- [ ] Commit `docs/redesign/BASELINE.md`.

### Task 0.2: Editorial-minimal token retune
**Files:** Modify `app/client/src/styles/wa-theme.css`, `app/client/src/styles/wa-tailwind.css`, `app/client/src/styles/customer-system.css`; Test: `app/client/src/styles/tokens.test.ts`.
**Interfaces — Produces:** the retuned `--wa-*` token set (type scale, spacing, surfaces, accent, softened verdicts, shadows) that every later task consumes.
- [ ] Load `minimalist-ui` + `ui-ux-pro-max`. Retune type scale (taller line-height, clearer hierarchy), spacing rhythm, neutral canvas, single calm accent, softened verdict palette, lighter shadows — light + dark. Keep all values as tokens.
- [ ] Keep `tokens.test.ts` green (update token-name expectations only if a token is renamed, never remove semantic tokens other code depends on).
- [ ] Run the regression gate. Fix contrast regressions until `check:a11y` + `check:design-system` pass.
- [ ] Commit.

### Task 0.3: Motion module
**Files:** Create `app/client/src/components/system/motion.ts` (duration/easing tokens + helpers) and motion primitives `Reveal.tsx`, `CountUp.tsx`, `Skeleton.tsx`, `PageTransition.tsx` under `app/client/src/components/system/`; Test: co-located `*.test.tsx`.
**Interfaces — Produces:** `<Reveal>`, `<CountUp value>`, `<Skeleton>`, `<PageTransition>`, and `motion` tokens for reuse.
- [ ] Load `design-motion-principles`. Implement primitives; every one no-ops/short-circuits under `prefers-reduced-motion`.
- [ ] Write component tests: renders children, respects reduced-motion (assert no animation attrs when reduced).
- [ ] Run gate (incl. `check:a11y`). Commit.

### Task 0.4: Page template + progressive-disclosure + plain-language layer
**Files:** Modify `app/client/src/components/system/CustomerPage.tsx`, `PageLead.tsx`, `Surface.tsx`; Create `app/client/src/components/system/PlainSummary.tsx`, `app/client/src/components/system/DetailDisclosure.tsx`, `app/client/src/components/system/plain-language.ts` (vocabulary map + `Term`/glossary helper); Tests: co-located.
**Interfaces — Consumes:** motion primitives (0.3), tokens (0.2). **Produces:** `<PlainSummary status meaning nextAction>`, `<DetailDisclosure label>`, `<Term id>` + `PLAIN` vocabulary map — the pattern every page composes.
- [ ] Implement the page template (eyebrow + title + plain summary band + content + detail disclosures), editorial spacing, reveal-on-mount.
- [ ] Implement plain-language map (Pillar→focus area, Finding→check result, Attestation→your confirmation, Evidence→what we checked, Coverage→how much we measured, Unmeasurable→couldn't check automatically, Provenance→where data came from, Differential→what changed) + hover glossary; precise term remains accessible.
- [ ] Tests: renders summary + expands detail; glossary term shows plain label + precise on hover/focus.
- [ ] Run gate. Commit.

### Task 0.5: Primitive restyle
**Files:** Modify `app/client/src/components/ui/DataTable.tsx`, `StatusBadge.tsx`, `Segments.tsx`, `Pagination.tsx`, `EmptyState.tsx`, `charts.tsx`; Tests: co-located.
**Interfaces — Consumes:** tokens (0.2), motion (0.3). **Produces:** restyled primitives with unchanged prop APIs.
- [ ] Restyle to editorial-minimal (quiet tables, softer badges, friendly empty states, skeleton loading, editorial SVG charts). **Keep every component's prop signature identical** so pages don't break.
- [ ] Keep existing component tests green (update only copy/markup assertions, not behavior).
- [ ] Run gate. Commit.

### Task 0.6: Shell restyle
**Files:** Modify `app/client/src/components/shell/Chrome.tsx`, `ReviewHeader.tsx`, `DifferentialStrip.tsx`, `Palette.tsx`; keep `nav.ts` structure/routes intact; Tests: co-located.
- [ ] Restyle navy chrome/rail, header, differential strip, command palette to editorial-minimal + subtle motion. Do NOT change nav routes or labels' destinations.
- [ ] Keep nav/shell tests green. Run gate. Commit.

**PHASE 0 REVIEW GATE:** foundation reviewed + full gate green before any page task starts.

---

## Phase 1 — Assess core (parallel after Phase 0)

> Each page task: load skills; apply the page template + `PlainSummary` + `DetailDisclosure` + editorial layout + motion; keep the page's data hooks/routes/handlers identical; update only presentation-level tests; run the gate; commit. Files listed are the page + its page-specific components + co-located tests.

### Task 1.1: Overview (dashboard)
**Files:** `app/client/src/pages/Overview.tsx` + `components/CoverageHero.tsx`, `HealthReadings.tsx`, `PriorityFindings.tsx`, `ScoreStrip.tsx`; tests co-located.
- [ ] Plain summary: workspace status in one line + areas healthy/attention + next action. Animate coverage hero + score meters (CountUp/Reveal). Disclose evidence-gap detail. Keep all hooks/links.
- [ ] Run gate. Commit.

### Task 1.2: Start (onboarding)
**Files:** `app/client/src/pages/Start.tsx`.
- [ ] Editorial welcome; plain-language explanation of the app with glossary; clear primary/secondary CTAs; keep skip + routes.
- [ ] Run gate. Commit.

### Task 1.3: Findings
**Files:** `app/client/src/pages/Findings.tsx` + `components/FindingDetail.tsx`, `PriorityFindings.tsx`; tests co-located.
- [ ] Plain summary of unmet vs met; editorial list + detail pane; disclose evidence/signals/provenance; keep filters, pagination (10/page), and the exact API calls.
- [ ] Run gate. Commit.

### Task 1.4: Pillars (+ pillar detail)
**Files:** `app/client/src/pages/Pillars.tsx`, `pages/PillarDetail.tsx` (or equivalent) + `components/PillarMatrix.tsx`, `ScoreStrip.tsx`.
- [ ] Plain summary per focus area; editorial matrix (keep framework/urgency toggle); disclose per-requirement detail. Keep routes `/pillars`, `/pillars/:pillarId`.
- [ ] Run gate. Commit.

### Task 1.5: Review (+ review detail)
**Files:** `app/client/src/pages/Review.tsx`, `pages/ReviewDetail.tsx` (or equivalent) + review components.
- [ ] Plain summary of what needs confirming; editorial per-pillar sections; make skip a clear, less-destructive-feeling confirm; keep confirm/skip/answers POSTs and routes exactly.
- [ ] Run gate. Commit.

### Task 1.6: Run flow
**Files:** `app/client/src/components/RunScanDialog.tsx`, `SchedulePanel.tsx`, `WorkspacePicker.tsx`, `PreflightReport.tsx`.
- [ ] Editorial scope picker; friendly progress; keep scan POST payloads, preflight, status polling identical.
- [ ] Run gate. Commit.

---

## Phase 2 — Investigate (parallel)

### Task 2.1: Investigate workbench
**Files:** `app/client/src/pages/Investigate.tsx` + workbench components.
- [ ] Editorial multi-pane workbench with progressive disclosure; keep resizable panels + data wiring.
- [ ] Run gate. Commit.

### Task 2.2: Topology
**Files:** `app/client/src/pages/Topology.tsx` + xyflow graph components.
- [ ] Add first-use guidance/legend + plain summary; editorial node styling via tokens; keep `@xyflow/react` graph data + `/topology` call.
- [ ] Run gate. Commit.

### Task 2.3: Workloads / Task 2.4: Warehouses / Task 2.5: Jobs / Task 2.6: Writes / Task 2.7: Serverless
**Files:** the respective `app/client/src/pages/{Workloads,Warehouses,Jobs,Writes,Serverless}.tsx` + `components/SpecialistOpportunity.tsx`, `ValueReport.tsx`.
- [ ] (Each) Plain summary of the advisory finding; editorial metric layout; disclose raw metrics; keep "raise as improvement" action + advisory API calls.
- [ ] Run gate. Commit (one commit per page).

---

## Phase 3 — Improve (parallel)

### Task 3.1: Improvements (+ plan detail, actions, validations)
**Files:** `app/client/src/pages/Improvements.tsx`, `pages/ImprovementDetail.tsx` + `components/ActionForm.tsx`, `ActionPanel.tsx`, validation components.
- [ ] Editorial plans + actions with owner/deadline; plain status; keep create/close/action/validation POST/PUT + export links + routes.
- [ ] Run gate. Commit.

### Task 3.2: Decisions
**Files:** `app/client/src/pages/Decisions.tsx` + `DecisionForm.tsx`, `DecidePanel.tsx`, `NoteThread.tsx`.
- [ ] Editorial decision records; plain language; keep decision POST + note thread APIs.
- [ ] Run gate. Commit.

### Task 3.3: Exceptions (+ risk acceptance)
**Files:** `app/client/src/pages/Exceptions.tsx` + `AcceptRiskForm.tsx`, `AcceptRiskPanel.tsx`.
- [ ] Editorial exceptions with expiry; plain language; keep risk accept/revoke + applicability APIs.
- [ ] Run gate. Commit.

---

## Phase 4 — Govern / Record (parallel)

### Task 4.1: Answers / Walk
**Files:** `app/client/src/pages/Answers.tsx`, `pages/AnswersWalk.tsx` + `AnswerForm.tsx`, `AnswerGuidance.tsx`.
- [ ] Guided one-question-per-screen wizard, plain language + guidance; keep attestation POST + routes.
- [ ] Run gate. Commit.

### Task 4.2: Months (+ month detail)
**Files:** `app/client/src/pages/Months.tsx`, `pages/MonthDetail.tsx`.
- [ ] Editorial monthly cadence + snapshots; keep publish/supersede + download links + routes.
- [ ] Run gate. Commit.

### Task 4.3: Report (+ result detail)
**Files:** `app/client/src/pages/Report.tsx`, `pages/ReportDetail.tsx`; verify `app/client/src/styles/wa-print.css` still flattens cleanly.
- [ ] Editorial printable document; keep print stylesheet correctness + export.csv/json links + routes.
- [ ] Run gate + print-preview check. Commit.

### Task 4.4: History (+ scan detail)
**Files:** `app/client/src/pages/History.tsx`, `pages/HistoryDetail.tsx`.
- [ ] Editorial run history + differential; keep comparison/changes API + routes.
- [ ] Run gate. Commit.

### Task 4.5: Trail (audit)
**Files:** `app/client/src/pages/Trail.tsx`.
- [ ] Editorial audit log; plain summary; keep `/audit` + verification calls.
- [ ] Run gate. Commit.

---

## Phase 5 — Method / Admin (parallel)

### Task 5.1: Methodology / Task 5.2: Definitions (+ Setup) / Task 5.3: Checks / Task 5.4: Diagnostics / Task 5.5: Retention / Task 5.6: Foundation / Task 5.7: Operate
**Files:** the respective `app/client/src/pages/*.tsx` (+ `pages/DefinitionsSetup.tsx`, `FoundationDeclarationForm.tsx`).
- [ ] (Each) Apply page template + plain summary + progressive disclosure + editorial layout + motion. `/checks` especially: translate technical columns (gates/enriches/decides) into plain language with disclosure. Keep every data call, form POST/PUT/DELETE, preflight, retention actions, and routes identical.
- [ ] Run gate. Commit (one per page).

**PHASES 1-5 REVIEW GATE:** full `npm run verify` + all `check:*` green across the whole app; visual consistency reviewed.

---

## Phase 6 — Integrate, deploy, test

### Task 6.1: Full-app verification
- [ ] `cd app && npm run verify && npm run check:design-system && npm run check:a11y && npm run check:viewport`. Confirm no new failures vs `docs/redesign/BASELINE.md`. Fix any drift. Commit.

### Task 6.2: Production build
- [ ] `cd app && npm run bundle`. Confirm `client/dist/index.html` + assets produced, no build errors. 

### Task 6.3: Deploy new parallel app
**Skill:** load `fe-databricks-tools:databricks-apps` + `databricks-core`.
- [ ] Verify reuse targets from `app/.databricks/bundle/customer/variable-overrides.json` (sql_warehouse_id, postgres_branch, postgres_database, assessor_group) against deep-test-1; confirm warehouse `b6c60cff15c895fa` + `databricks-waf` Lakebase are live.
- [ ] Configure the bundle app name/target so this deploys as **`databricks-waf-redesign`** (NOT the existing `databricks-waf-assessment`).
- [ ] Deploy via `npm run lifecycle` with explicit `--profile deep-test-1`. Do not trust exit code 2 (benign re-plan); verify actual app state.
- [ ] Confirm app RUNNING and `/api/health` healthy.

### Task 6.4: Live + responsive smoke test
**Agent:** `fe-specialized-agents:web-devloop-tester` (or Chrome DevTools MCP).
- [ ] Click through ALL pages at 320/768/900/1512px on the deployed app: data loads, forms/mutations hit the API (network tab), no console errors, deep-link refresh works, reduced-motion honored. Log results.

### Task 6.5: Independent verification (CLAUDE.md)
- [ ] Spawn 1 verification agent (different model) to confirm: zero contract/route/auth changes (diff `app/shared/api/contract.ts`, `app/client/src/api/hooks.ts` endpoints, `App.tsx` routes vs `main`), all gates green, app deployed + healthy, redesign applied to all 34 pages. Reconcile any findings before completion.

---

## Self-review (against spec)

- **Spec coverage:** §4 visual → Task 0.2; §5 progressive disclosure/plain-language → 0.4; §6 motion → 0.3; §7 foundation → 0.2-0.6; §8 all 34 pages → Phases 1-5; §10 deploy → 6.3; §11 testing → 6.1/6.4/6.5. No gaps.
- **Placeholders:** tasks specify exact files, intent, and verification; implementation code is generated by the named UI skills per task (a deliberate adaptation for a skill-driven visual redesign, stated in the header).
- **Type consistency:** foundation `Produces` interfaces (`PlainSummary`, `DetailDisclosure`, `Term`, motion primitives, tokens) are consumed by all page tasks; primitive prop APIs kept identical so pages don't break.
