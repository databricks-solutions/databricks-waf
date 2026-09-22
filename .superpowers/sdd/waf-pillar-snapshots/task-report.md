# WAF pillar assessment snapshots: task report

## Status

Implemented on `feat/ui-ux-redesign`.

The homepage now shows a compact seven-pillar summary and links to a dedicated `/pillars/` landing-layout page. The dedicated page renders 7 native `<details>` disclosures from the YAML control catalogue. Each summary shows the pillar code, title, total requirement count, and non-zero route counts. Open disclosures group controls by catalogue principle and show the control ID, exact title, source link where available, and the derived route label.

The preview-data paragraph has been removed. The trust-boundary card remains on the homepage below its compact pillar summary.

## TDD evidence

### RED

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npm test -- landing-pillar-snapshots.test.ts
```

Result: exit 1. Vitest reported 1 failed test file and 5 failed tests. The failures covered the missing placeholder, missing disclosures, missing catalogue controls, missing totals and route labels, and missing source links/responsive snapshot styles.

### GREEN

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npm test -- landing-pillar-snapshots.test.ts
```

Result: exit 0. Vitest reported 1 passed test file and 5 passed tests.

The focused tests copy the complete `docs` tree to a temporary directory and invoke `build-pages.mjs --docs-dir <temporary-tree> --write`. This preserves the builder's temporary-tree test path while reading the versioned control catalogue from `app/config/controls`.

## Generated catalogue counts

| Pillar                                 |   Total | Automated evidence | Human review | Planned measurement |
| -------------------------------------- | ------: | -----------------: | -----------: | ------------------: |
| OE, Operational excellence             |      21 |                 15 |            6 |                   0 |
| SCP, Security, compliance, and privacy |      70 |                 46 |            5 |                  19 |
| REL, Reliability                       |      18 |                  8 |           10 |                   0 |
| PE, Performance efficiency             |      25 |                 13 |           12 |                   0 |
| CO, Cost optimization                  |      22 |                 17 |            5 |                   0 |
| DG, Data and AI governance             |      13 |                 10 |            3 |                   0 |
| IU, Interoperability and usability     |      15 |                 10 |            5 |                   0 |
| **Total**                              | **184** |            **119** |       **46** |              **19** |

The generator derives routes as follows:

1. `measurability: attestation` becomes `Human review`.
2. Non-attestation controls with `evaluator_status: implemented` become `Automated evidence`.
3. Remaining non-attestation controls become `Planned measurement`.

## Files changed

- `app/scripts/build-pages.mjs`
  - Reads the 7 catalogue YAML files in the required pillar order.
  - Escapes generated content.
  - Replaces `{{ pillar_snapshots }}` only on pages containing the placeholder.
  - Leaves all existing routes and `--docs-dir` handling intact.
- `app/tests/landing-pillar-snapshots.test.ts`
  - Adds focused source, generation, count, route, link, accessibility, mobile, and temporary-tree coverage.
- `docs/index.md`
  - Removes the preview-data paragraph and static pillar list.
  - Adds the requested heading, catalogue note, and `{{ pillar_snapshots }}` placeholder.
- `docs/assets/css/landing.css`
  - Adds restrained disclosure, badge, control-row, focus, and mobile styles.
- `docs/index.html`
  - Regenerated static landing page containing all 7 pillars and 184 controls.
- `.superpowers/sdd/waf-pillar-snapshots/task-report.md`
  - Records implementation and verification evidence.

No `.cursor/plans` file was changed.

## Verification commands and results

### Final automated verification

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npx prettier --write scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts
npm run docs:build
npm test -- landing-pillar-snapshots.test.ts
npm run check:docs-build
npm run check:doc-links
npx prettier --check scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts ../docs/index.md ../docs/assets/css/landing.css
npx eslint scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts
git diff --check
```

Results:

- Prettier write: 2 files unchanged on the final run.
- `npm run docs:build`: exit 0, 11 pre-rendered Pages documents generated.
- Focused Vitest: exit 0, 1 test file passed, 5 tests passed.
- `npm run check:docs-build`: exit 0, 11 pre-rendered Pages documents match their Markdown sources.
- `npm run check:doc-links`: exit 0, 16 relative links in 28 documents resolve, anchors included.
- Prettier check: exit 0, all matched files use Prettier style.
- ESLint: exit 0, no findings.
- `git diff --check`: exit 0, no whitespace errors.

An earlier Prettier check correctly returned exit 1 for the new generator and test file. Running Prettier fixed both files before the final verification above.

### Browser inspection

The generated site was served locally at its configured `/databricks-waf/` base path.

Checked at:

- Desktop: 1440 by 1000.
- Mobile: 390 by 844.

Inspection results:

- All 7 summaries appeared in the required order.
- Operational excellence opened and exposed its principle headings, control IDs, linked titles, and route labels.
- Security, compliance, and privacy opened successfully, including its automated, human-review, and planned-measurement counts.
- The mobile accessibility tree exposed each summary as an expandable `DisclosureTriangle`.
- The trust-boundary card remained present.
- Console check: no errors, warnings, or browser issues.
- Network check: 7 requests, all HTTP 200. No JavaScript request was made.

The first local browser attempt mounted `docs` at `/`, which produced expected 404s because the generated files use `/databricks-waf` as their base URL. The server was remounted at the configured base path, the page was reloaded without cache, and the clean results above were captured.

## Self-review

- Confirmed all 184 catalogue controls appear exactly once and in catalogue order.
- Confirmed all exact control titles and available `source_anchor` links are preserved.
- Confirmed route labels and per-pillar counts use the required derivation.
- Confirmed zero-valued route badges are omitted from summaries while numeric data attributes remain available for drift tests.
- Confirmed empty catalogue principles do not create empty visual groups.
- Confirmed generated catalogue values pass through HTML escaping.
- Confirmed no client-side JavaScript was introduced.
- Confirmed the generator only reads catalogue data when a page contains the placeholder.
- Confirmed the temporary `--docs-dir` workflow and all 11 existing generated routes still pass.
- Confirmed no plan, publish, push, deploy, or merge action was performed.

## Follow-up: full-width exclusive accordion

Browser review found that expanded pillar lists still occupied the left side of the former two-column trust-boundary grid. This follow-up moves the trust-boundary card below a full-width snapshot catalogue, adds native exclusive accordion grouping, and restricts generated source links to HTTPS anchors.

### Follow-up RED

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npm test -- landing-pillar-snapshots.test.ts
```

Result: exit 1. Vitest reported 3 failed and 4 passed tests. The failures showed:

- none of the 7 `<details>` elements had `name="pillar-snapshot"`;
- `.landing-boundary` still used a permanent two-column grid;
- the generator did not export or apply the HTTPS-only source-title helper.

The source-link helper test uses synthetic HTTPS, HTTP, `javascript:`, and invalid anchors. It does not alter any catalogue YAML.

### Follow-up GREEN and verification

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npx prettier --write scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts ../docs/assets/css/landing.css
npm run docs:build
npm test -- landing-pillar-snapshots.test.ts
npm run check:docs-build
npm run check:doc-links
npx prettier --check scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts ../docs/index.md ../docs/assets/css/landing.css
npx eslint scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts
git diff --check
```

Results:

- `npm run docs:build`: exit 0, 11 pre-rendered Pages documents generated.
- Focused Vitest: exit 0, 1 test file passed, 7 tests passed.
- `npm run check:docs-build`: exit 0, all 11 generated documents match their sources.
- `npm run check:doc-links`: exit 0, 16 relative links in 29 documents resolve, anchors included.
- Prettier check: exit 0.
- ESLint: exit 0.
- `git diff --check`: exit 0.

### Follow-up browser evidence

The regenerated page was inspected at a 1440 by 1000 desktop viewport and under the mobile media query.

- Opened OE, then opened SCP.
- Native details grouping left only `SCP` open.
- All 7 details shared `name="pillar-snapshot"`.
- The boundary and snapshot widths both measured 1180 pixels, with a 0-pixel difference.
- The trust-boundary card began below the snapshot list.
- Mobile used a single summary column with no horizontal overflow.
- Console: no errors, warnings, or browser issues.
- Network: 10 requests, all HTTP 200, with no JavaScript request.

### Follow-up self-review

- Preserved all 184 controls, established pillar order, principle grouping, counts, and route labels.
- Preserved the removed preview-data paragraph state.
- Confirmed the generated page contains exactly 7 pillar details.
- Confirmed `renderSourceTitle` escapes titles and emits an anchor only when URL parsing reports the `https:` protocol.
- Confirmed the page uses native details grouping and no product JavaScript.
- Confirmed no `.cursor/plans` file changed.

## Final state: dedicated Pillars page

The final product review moved the detailed catalogue off the homepage. The homepage now contains only the 7 pillar names, a short shared-evidence-model statement, a link to `/pillars/`, and the trust-boundary card. The generated `/pillars/` route owns the full interactive catalogue.

### Dedicated-page RED

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npm test -- landing-pillar-snapshots.test.ts
```

Result: exit 1. Vitest reported 7 failed and 2 passed tests. The failures confirmed:

- the homepage still contained the snapshot placeholder and disclosures;
- `docs/pillars.md` and `docs/pillars/index.html` did not exist;
- the dedicated output had no catalogue controls or counts;
- the landing header had no Pillars tab;
- journey and workflow links were still page-relative.

### Dedicated-page GREEN and verification

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npx prettier --write scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts ../docs/_layouts/landing.html ../docs/index.md ../docs/pillars.md ../docs/assets/css/landing.css
npm run docs:build
npm test -- landing-pillar-snapshots.test.ts
npm run check:docs-build
npm run check:doc-links
npx prettier --check scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts ../docs/_layouts/landing.html ../docs/index.md ../docs/pillars.md ../docs/assets/css/landing.css
npx eslint scripts/build-pages.mjs tests/landing-pillar-snapshots.test.ts
git diff --check
```

Results:

- `npm run docs:build`: exit 0, 12 pre-rendered Pages documents generated.
- Focused Vitest: exit 0, 1 test file passed, 9 tests passed.
- `npm run check:docs-build`: exit 0, all 12 generated documents match their sources.
- `npm run check:doc-links`: exit 0, 16 relative links in 29 documents resolve, anchors included.
- Prettier check: exit 0.
- ESLint: exit 0.
- `git diff --check`: exit 0.

### Dedicated-page browser evidence

Both `/` and `/pillars/` were inspected at 1440 by 1000 and under the mobile breakpoint.

Homepage:

- Contains 0 pillar disclosures.
- Shows all 7 pillar names and 2 links to `/pillars/` (header and section action).
- Keeps the trust-boundary card below the compact summary.
- Uses root-qualified links such as `/databricks-waf/#journey`.
- Has no horizontal overflow on desktop or mobile.

Pillars page:

- Contains 7 native details and all 184 control rows.
- Uses the full 1180-pixel content width on desktop.
- Opened OE, then SCP; only SCP remained open.
- All details retain `name="pillar-snapshot"`.
- Journey and workflow navigation resolves back to root-qualified homepage anchors.
- Uses a single summary column under the mobile breakpoint with no horizontal overflow.
- Contains 0 script elements.

Both pages had clean consoles. Homepage network requests returned HTTP 200. Pillars page requests returned HTTP 200 or the expected cached HTTP 304 for the shared stylesheet. Neither page requested JavaScript.

### Dedicated-page self-review

- Confirmed the homepage source and output contain no snapshot placeholder or details.
- Confirmed `pillars.md` uses the landing layout and owns the only snapshot placeholder.
- Confirmed the builder explicitly maps `pillars.md` to `pillars/index.html`.
- Confirmed all 184 controls, counts, groups, route labels, HTTPS-only links, and exclusive accordion behaviour remain intact.
- Confirmed the preview paragraph remains removed.
- Confirmed the landing header includes Pillars and every journey/workflow anchor is root-qualified.
- Confirmed temporary-tree generation still passes through `--docs-dir`.
- Confirmed no `.cursor/plans` file changed.

## Follow-up: stale preview-data tests

Isolated `npm run verify` on `238dd07` failed because `app/scripts/landing-source.test.ts` still required the removed preview-data paragraph. The same stale regex also lived in `app/scripts/build-pages.test.ts`. Two nearby landing-source and generated-layout assertions still expected hash-only nav links instead of the root-qualified `/databricks-waf/#journey` style.

### Test correction RED

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npm test -- landing-source.test.ts landing-pillar-snapshots.test.ts build-pages.test.ts
```

Result before the fix: exit 1. `landing-source.test.ts` required `deterministic, anonymized example data` and the inclusive hero regex. After that assertion was inverted, the same run still showed 2 landing-source failures and 1 generated-layout failure for hash-only Journey/Review links.

### Test correction GREEN

Command:

```text
cd /Users/deep.basu/Desktop/Dev/WAF/app
npx prettier --write scripts/landing-source.test.ts scripts/build-pages.test.ts
npm test -- landing-source.test.ts landing-pillar-snapshots.test.ts build-pages.test.ts
npm run docs:build
npm run check:docs-build
npm run check:doc-links
npx prettier --check scripts/landing-source.test.ts scripts/build-pages.test.ts
npx eslint scripts/landing-source.test.ts scripts/build-pages.test.ts
git diff --check
```

Results:

- Focused Vitest: exit 0, 3 test files passed, 29 tests passed.
- `npm run docs:build`: exit 0, 12 pre-rendered Pages documents generated.
- `npm run check:docs-build`: exit 0.
- `npm run check:doc-links`: exit 0, 16 relative links in 30 documents resolve, anchors included.
- Prettier, ESLint, and `git diff --check`: exit 0.

The landing-source block now asserts the preview-data paragraph remains absent. The generated-layout sibling does the same. No catalogue YAML, generated HTML, or uncommitted client work was changed.

## Concerns

None. Security remains a long disclosure with 70 controls, but it now lives on the dedicated catalogue page and the exclusive native accordion keeps one pillar open at a time.
