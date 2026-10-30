# WAF Assessment App — UI/UX Redesign Design Spec

**Date:** 2026-09-22
**Branch:** `feat/ui-ux-redesign`
**Author:** Deep Basu (with Claude)
**Status:** Approved design, pre-implementation

## 1. Goal

Redesign the entire UI/UX of the Databricks Well-Architected Framework (WAF) assessment app so it is **easy for both technical and non-technical people**, delivers a **premium experience**, and has **solid, purposeful motion** — while impacting **zero functionality**.

Approved directional choices:
- **Progressive disclosure** — one experience; plain-language summary first, technical depth on demand (no mode toggle).
- **Minimal / editorial** visual direction — calm, whitespace-forward, big readable type, restrained palette.
- **All 34 pages** redesigned bespoke, on a shared foundation.
- Deploy as a **new parallel app** `databricks-waf-redesign` on **deep-test-1**, reusing the existing warehouse + Lakebase bindings.

## 2. Non-negotiable constraints (zero functional impact)

**MUST NOT change** (the wire + behavior contract):
- HTTP route paths/methods and request/response shapes. Wire types live in `app/shared/api/contract.ts` (source of truth) and are re-exported via `app/client/src/api/types.ts`.
- The client data layer endpoints in `app/client/src/api/hooks.ts` (2,300+ lines) — same hooks, same endpoints, same response handling.
- React Router paths in `app/client/src/App.tsx` (45+ routes) — every path stays identical (deep links must keep working).
- Auth: on-behalf-of-user via `x-forwarded-*` headers; assessor-group gating on mutations. No frontend auth logic added.
- Build output: still produces `app/client/dist/index.html` + static assets served by the Express appkit SPA catch-all; base path `/`; relative asset paths.
- No new frontend build-time env coupling (same bundle across envs).

**SAFE to change** (the redesign surface):
- Page component internals, composition/hierarchy, layout, visual structure.
- Styling (Tailwind classes, CSS, design tokens — within the token system).
- Loading / empty / error states; client-side form-validation UX.
- Icons, colors, typography, spacing (via tokens / appkit theme).
- Animations and transitions.
- Responsive behavior.

**Safety net:** `npm run verify` (typecheck + lint + 892 vitest tests) plus `check:design-system` (no raw colors — tokens only), `check:a11y` (WCAG AA contrast/focus/viewport-fit), `check:viewport` (320/768/900/1512px). Every batch must keep all of these green.

## 3. Design principles

1. **Plain-language first, depth on demand.** Each screen opens with a jargon-free summary of what's true and the next step; dense evidence/signals/tables sit one disclosure away.
2. **Editorial minimalism.** Fewer borders, more whitespace and rhythm; larger readable type scale; one restrained accent; verdict colors reserved for status meaning. Reads like a well-set document, not a control panel.
3. **Quiet, high-craft motion.** Restraint + polish (Emil Kowalski / Jakub Krehel school). Smooth reveals, elegant transitions, tasteful number count-ups, buttery micro-interactions. Always `prefers-reduced-motion` aware.
4. **Zero functional impact.** Only component internals, layout, styling, and motion change.
5. **Accessibility is not optional.** Keep/raise the existing WCAG AA bar; `check:a11y` stays green.

## 4. Visual system (editorial-minimal, token-based)

Built **on top of `app/client/src/styles/wa-theme.css` tokens** so `check:design-system` stays green (no raw colors).

- **Type:** taller scale + line-height for reading; clearer display/page/section hierarchy; tabular numerals for metrics.
- **Space:** generous section spacing; borderless "quiet" surfaces separated by whitespace rather than lines; wider content rhythm.
- **Color:** restrained neutral canvas; a single calm accent; verdict palette (danger/warning/caution/success/unmeasured) kept for status only, softened. Dark + light both retuned.
- **Depth:** softer, fewer shadows; elevation used sparingly for true layering.
- **States:** larger, friendlier empty and loading states; skeletons over bare spinners.

Skills: `minimalist-ui` (aesthetic protocol) + `ui-ux-pro-max` (palette / type / UX guidelines) drive concrete values.

## 5. Progressive-disclosure pattern + plain-language layer

**Shared page template** every page composes:

```
[ Area eyebrow ]  Page title
PLAIN SUMMARY — 1-2 plain sentences: what this shows, headline status, next step.  [ Primary action ]
────────────────────────────────────────────────────────────
Key content (editorial layout, generous space)
  ▸ Show technical detail  → evidence, signals, coverage %, provenance, raw tables
```

**New/upgraded shared components:**
- `PlainSummary` — the friendly lead band (status + meaning + next action).
- `DetailDisclosure` — consistent expander for the dense technical content (wraps existing `Disclosure`).
- **Plain-language layer** — pairs each domain term with an everyday phrase + hover glossary; precise terms remain available for technical users.

**Vocabulary map (plain ↔ precise):**
| Precise (kept) | Plain-language lead |
|---|---|
| Pillar | focus area |
| Finding / Requirement / Control | check / check result |
| Attestation | your confirmation |
| Evidence | what we checked |
| Coverage | how much we measured |
| Unmeasurable | couldn't check automatically |
| Provenance | where the data came from |
| Differential | what changed since last time |

## 6. Motion system

One shared motion module (duration/easing tokens) applied through primitives, all reduced-motion aware, audited with `design-motion-principles` to avoid AI-slop patterns (no pulsing spam, no stagger overuse):
- Route/page transitions (subtle fade/slide).
- Reveal-on-mount for cards/sections.
- Animated score/coverage meters + number count-ups.
- Skeleton loaders replacing bare spinners.
- Micro-interactions on controls (hover/press/focus), building on the existing 140ms token.

## 7. Foundation-first architecture

Build/upgrade the shared foundation **before** page work, so 34 bespoke pages stay consistent:
- Token retune in `app/client/src/styles/` (`wa-theme.css`, `wa-tailwind.css`, `customer-system.css`).
- Page template: upgrade `components/system/CustomerPage.tsx`, `PageLead.tsx`, `Surface.tsx`.
- New `PlainSummary`, `DetailDisclosure`, plain-language/glossary helper.
- Restyle primitives: `components/ui/DataTable.tsx`, `StatusBadge.tsx`, `Segments.tsx`, `Pagination.tsx`, `EmptyState.tsx`, `charts.tsx`.
- Motion module + integration into the above.
- Shell: `components/shell/Chrome.tsx`, `ReviewHeader.tsx`, `DifferentialStrip.tsx`, `Palette.tsx`.

## 8. Page inventory & batches (34 pages)

- **Batch 0 — Foundation** (section 7): shared tokens, template, PlainSummary/DetailDisclosure, primitives, motion, shell.
- **Batch 1 — Assess core:** Overview, Start, Findings, Pillars (+ pillar detail), Review (+ review detail), Run flow (RunScanDialog).
- **Batch 2 — Investigate:** Investigate, Topology, Workloads, Warehouses, Jobs, Writes, Serverless.
- **Batch 3 — Improve:** Improvements (+ plan detail), Decisions, Exceptions, Actions/Validations surfaces.
- **Batch 4 — Govern / Record:** Answers/Walk, Attestations surfaces, Months (+ month detail), Report (+ result detail), History (+ scan detail), Trail (audit).
- **Batch 5 — Method / Admin:** Methodology, Definitions, Definitions/Setup, Checks, Diagnostics, Retention, Foundation, Operate.

Dev-only surfaces (`/design-system`, `/preview/*`) restyled incidentally via shared components; not bespoke targets.

## 9. Execution strategy

- Branch `feat/ui-ux-redesign` off `main` (done).
- Establish green baseline (`npm run verify`) before any change.
- **Subagent-driven, parallel batches.** Foundation built + reviewed first (it gates everything). Then page batches redesigned in parallel by focused implementer subagents, each keeping to the zero-impact contract.
- **Gate every batch** on: `npm run typecheck`, `npm run lint`, `npm run test`, `check:design-system`, `check:a11y`, `check:viewport`. No batch merges into the branch state until green.
- Implementation skills invoked here: `redesign-existing-projects`, `minimalist-ui`, `ui-ux-pro-max`, `design-motion-principles`.

## 10. Deploy plan

- New parallel app **`databricks-waf-redesign`** on **deep-test-1** (profile `deep-test-1`).
- Reuse existing bindings: warehouse `b6c60cff15c895fa`, the `databricks-waf` Lakebase project/production branch/`databricks-postgres`, assessor group `admins` (set in `app/.databricks/bundle/customer/variable-overrides.json`).
- Deploy via the DAB `npm run lifecycle` path with explicit `--profile deep-test-1` (the lifecycle wrapper strips `DATABRICKS_HOST/TOKEN/CONFIG_PROFILE`).
- Installer idempotency guard can exit 2 on a benign re-plan even when RUNNING — verify actual app state + effective scopes, don't trust the exit code.
- Verify RUNNING + `/api/health` healthy before hand-off.
- Existing `databricks-waf-assessment` app left untouched for side-by-side comparison.

## 11. Testing plan

- **Automated:** full `npm run verify` + the three `check:*` gates on foundation and every batch.
- **Manual (web-devloop-tester / Chrome DevTools):** click-through of all pages at 320/768/900/1512px; confirm data loads, forms/mutations still hit the API (network tab), no console errors/warnings, reduced-motion honored, deep-link refresh works.
- **Live deploy smoke:** open the deployed app, exercise the core journey against real deep-test-1 data.
- **Independent verification agent** (different model) per CLAUDE.md before completion.

## 12. Success criteria

- All 34 pages visibly redesigned to the editorial-minimal direction with the progressive-disclosure pattern.
- Non-technical readability: every page leads with plain language; jargon behind glossary/disclosure.
- Solid, reduced-motion-aware motion throughout.
- `npm run verify` + all `check:*` gates green; 892 tests still pass.
- New app deployed and RUNNING on deep-test-1 with real data; existing app untouched.

## 13. Key file paths

- Router: `app/client/src/App.tsx`
- Pages: `app/client/src/pages/*.tsx` (34)
- Components: `app/client/src/components/` (137)
- Styles/tokens: `app/client/src/styles/{wa-theme,wa-tailwind,customer-system,wa-print,index}.css`
- API hooks (frozen endpoints): `app/client/src/api/hooks.ts`
- Wire contract (frozen): `app/shared/api/contract.ts`
- Build: `app/client/vite.config.ts`, `app/package.json`
- Deploy: `app/databricks.yml`, `app/app.yaml`, `app/.databricks/bundle/customer/variable-overrides.json`
