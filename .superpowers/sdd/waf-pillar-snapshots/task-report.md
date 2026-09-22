# WAF pillar assessment snapshots: task report

## Status

Implemented on `feat/ui-ux-redesign`.

The landing page now renders 7 native `<details>` disclosures from the YAML control catalogue. Each summary shows the pillar code, title, total requirement count, and non-zero route counts. Open disclosures group controls by catalogue principle and show the control ID, exact title, source link where available, and the derived route label.

The preview-data paragraph has been removed. The trust-boundary card appears below the full-width snapshots.

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

## Concerns

None. The snapshot is intentionally large when a pillar is open, especially Security with 70 controls, but native disclosure keeps the closed landing-page view compact and avoids a JavaScript dependency.
