// Raw-run history is technical evidence, not a second history of customer posture.
//
// The State of the Nation and result history own score language. This table owns when a run
// finished, what it measured, which identity measured it and whether review produced a final
// assessment. Keeping that boundary here prevents one provisional raw score from reappearing as a
// plausible alternative to the immutable result.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { columns } from './HistoryPage';
import type { ScanSummary } from '../api/types';

function summary(over: Partial<ScanSummary> = {}): ScanSummary {
  return {
    id: 'scan-1',
    startedAt: '2026-08-10T09:00:00.000Z',
    finishedAt: '2026-08-10T09:05:00.000Z',
    state: 'complete',
    overall: 65.3,
    actor: 'analyst@example.com',
    executionMode: 'on-behalf-of-user',
    catalogueVersion: 'v1',
    measuredPillars: ['reliability'],
    freshPillars: ['reliability'],
    counts: { pass: 1, fail: 0, partial: 0, unmeasurable: 0, notApplicable: 0 },
    pillarScores: { reliability: 65.3 },
    ...over,
  };
}

function customerResult(scan: ScanSummary): string {
  const cell = columns(() => 'Reliability', undefined).find((column) => column.key === 'review');
  if (cell == null) throw new Error('the customer-result column is gone');
  return renderToStaticMarkup(<MemoryRouter>{cell.cell(scan)}</MemoryRouter>);
}

describe('the customer-result boundary in raw-run history', () => {
  it('has no posture or raw-result column', () => {
    const keys = columns(() => 'Reliability', undefined).map((column) => column.key);

    expect(keys).not.toContain('overall');
    expect(keys).not.toContain('results');
  });

  it('sends an unfinished run back to its evidence record without rendering its provisional score', () => {
    const markup = customerResult(summary());

    expect(markup).toContain('Awaiting review');
    expect(markup).toContain('/history/scan-1');
    expect(markup).toContain('wa-row-inset');
    expect(markup).not.toContain('65.3');
  });

  it('links a completed run to its published report', () => {
    const markup = customerResult(summary({ resultId: 'result-1' }));

    expect(markup).toContain('Open report');
    expect(markup).toContain('/report/result-1');
    expect(markup).toContain('wa-row-inset');
    expect(markup).not.toContain('65.3');
  });
});
