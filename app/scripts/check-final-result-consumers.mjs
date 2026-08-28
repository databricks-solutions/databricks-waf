#!/usr/bin/env node
// The customer-result consumer census.
//
// A latest raw run is still needed to open and resume review. It is not a customer score. This
// check holds the boundary at the places where a regression is otherwise one innocent hook change:
// the provider, the seven result surfaces, the report and the download menu.

import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const requireText = (path, text) => {
  if (!read(path).includes(text)) throw new Error(`${path} must contain ${JSON.stringify(text)}.`);
};
const forbid = (path, expression, reason) => {
  if (expression.test(read(path))) throw new Error(`${path} ${reason}.`);
};

const consumers = [
  'client/src/pages/OverviewPage.tsx',
  'client/src/pages/PillarsPage.tsx',
  'client/src/pages/FindingsPage.tsx',
  'client/src/pages/ReportPage.tsx',
  'client/src/components/ChangeSummary.tsx',
  'client/src/components/shell/DifferentialStrip.tsx',
  'client/src/components/ExportMenu.tsx',
];

for (const path of consumers) {
  forbid(
    path,
    /useLatestScan|useScanHistory|\/api\/scans\/latest/,
    'must not resolve a customer outcome from a latest raw run'
  );
}

requireText('client/src/api/assessment.tsx', 'const scan = result?.assessment;');
requireText('client/src/api/assessment.tsx', 'const latestRun = fresh ?? latest.data;');
requireText('client/src/api/final-result.ts', '...frozen.finding');
requireText('client/src/pages/OverviewPage.tsx', 'useResultHistory');
requireText('client/src/pages/PillarsPage.tsx', 'useResultHistory');
requireText('client/src/pages/ReportPage.tsx', 'useResult(');
requireText('client/src/components/ChangeSummary.tsx', 'useResultChanges');
requireText('client/src/components/ExportMenu.tsx', '/api/results/${resultId}/export.csv');
requireText('client/src/components/shell/provenance.ts', "'Published report'");
forbid(
  'client/src/components/shell/provenance.ts',
  /Final result \$\{result\.id\}|source run \$\{result\.runId\}/,
  'must keep result and source-run keys in technical provenance rather than primary customer chrome'
);
requireText('server/api/review-routes.ts', "app.get('/api/results'");
requireText('server/api/routes.ts', "app.get('/api/results/:id/changes'");
requireText('server/api/routes.ts', "app.get('/api/results/:id/exports'");

forbid(
  'client/src/pages/HistoryPage.tsx',
  /header:\s*['"]Posture['"]|header:\s*['"]Results['"]|scoreTone\(|scoreVerdict\(/,
  'must present raw runs as technical evidence, not as score history'
);

console.log(
  `Final-result consumer census passed: ${String(consumers.length)} customer surfaces follow a result identity.`
);
