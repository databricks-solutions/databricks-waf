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
import { filterScans, scanFilterCounts, scanFilterFrom } from './schedule-language';
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

  it('labels a custom run as indicative and links to its exact evidence record', () => {
    const markup = customerResult(summary());

    expect(markup).toContain('Indicative only');
    expect(markup).toContain('/history/scan-1?definitionId=');
    expect(markup).toContain('wa-row-inset');
    expect(markup).not.toContain('65.3');
  });

  it('labels a saved assessment run as awaiting review', () => {
    const markup = customerResult(
      summary({
        stamp: {
          catalogueVersion: 'v1',
          catalogueFingerprint: 'scope-a',
          executionMode: 'on-behalf-of-user',
          actor: 'analyst@example.com',
          scope: { description: 'the account' },
          lookbackDays: 30,
          definition: { id: 'assessment-a', version: 1, fingerprint: 'scope-a' },
        },
      })
    );

    expect(markup).toContain('Awaiting review');
    expect(markup).toContain('/history/scan-1?definitionId=assessment-a');
    expect(markup).not.toContain('65.3');
  });

  it('links a completed run to its published report', () => {
    const markup = customerResult(
      summary({
        resultId: 'result-1',
        stamp: {
          catalogueVersion: 'v1',
          catalogueFingerprint: 'scope-a',
          executionMode: 'on-behalf-of-user',
          actor: 'analyst@example.com',
          scope: { description: 'the account' },
          lookbackDays: 30,
          definition: { id: 'assessment-a', version: 1, fingerprint: 'scope-a' },
        },
      })
    );

    expect(markup).toContain('Open report');
    expect(markup).toContain('/report/result-1?definitionId=assessment-a');
    expect(markup).toContain('wa-row-inset');
    expect(markup).not.toContain('65.3');
  });
});

// The scheduled service principal's runs are the system of record for the trend, so they are what the
// page shows first. A run somebody started by hand is one filter away rather than mixed in, where a
// spot-check by another identity would read as the estate moving.
describe('the scan filter on the history page', () => {
  const scheduled = summary({ id: 'nightly', trigger: 'scheduled' });
  const byHand = summary({ id: 'spot-check', trigger: 'interactive' });
  const unrecorded = summary({ id: 'older' });
  const all = [byHand, scheduled, unrecorded];

  it('defaults to the scheduled runs', () => {
    expect(scanFilterFrom(null)).toBe('scheduled');
    expect(scanFilterFrom('something-else')).toBe('scheduled');
    expect(filterScans(all, scanFilterFrom(null)).map((scan) => scan.id)).toEqual(['nightly']);
  });

  it('shows the runs started by hand one filter away', () => {
    expect(scanFilterFrom('interactive')).toBe('interactive');
    expect(filterScans(all, 'interactive').map((scan) => scan.id)).toEqual(['spot-check']);
  });

  it('shows every run, including those from before the trigger was recorded, under all', () => {
    expect(scanFilterFrom('all')).toBe('all');
    expect(filterScans(all, 'all').map((scan) => scan.id)).toEqual(['spot-check', 'nightly', 'older']);
  });

  it('does not count a run with no recorded trigger as either kind', () => {
    expect(filterScans([unrecorded], 'scheduled')).toEqual([]);
    expect(filterScans([unrecorded], 'interactive')).toEqual([]);
  });

  it('counts what each filter holds, so an empty default says what is behind it', () => {
    expect(scanFilterCounts(all)).toEqual({ scheduled: 1, interactive: 1, all: 3 });
  });
});
