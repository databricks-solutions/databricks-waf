// The inbox is a composition of existing authorities. These tests hold the links between them:
// every open review remains addressable, and every specialist route enters the one owned-work path.

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { OperateComposition, OwnedWork, ReviewInbox } from './OperatePage';
import type { AssessmentReview, ScanSummary } from '../api/types';
import { operatePreviewFixture } from '../system/recurring-preview-fixtures';

function review(id: string, runId: string): AssessmentReview {
  return {
    id,
    runId,
    openedBy: 'schedule-principal',
    openedAt: '2026-08-18T08:00:00.000Z',
    pillars: [],
    answers: [],
    durable: true,
  };
}

function scan(id: string): ScanSummary {
  return {
    id,
    startedAt: '2026-08-18T07:55:00.000Z',
    finishedAt: '2026-08-18T08:00:00.000Z',
    state: 'complete',
    actor: 'schedule-principal',
    executionMode: 'on-behalf-of-user',
    trigger: 'scheduled',
    catalogueVersion: '16',
    measuredPillars: [],
    freshPillars: [],
    counts: { pass: 0, fail: 0, partial: 0, unmeasurable: 0, notApplicable: 0 },
    pillarScores: {},
  };
}

describe('the operating inbox composition', () => {
  it('keeps multiple scheduled reviews individually resumable with timing and work remaining', () => {
    const reviews = [review('review-1', 'scan-1'), review('review-2', 'scan-2')];
    const scans = new Map(reviews.map((one) => [one.runId, scan(one.runId)]));
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ReviewInbox reviews={reviews} scans={scans} pillarCount={7} now={new Date('2026-08-20T10:00:00.000Z')} />
      </MemoryRouter>
    );

    expect(markup).toContain('/review/review-1');
    expect(markup).toContain('/review/review-2');
    expect(markup.match(/Scheduled review/g)).toHaveLength(2);
    expect(markup.match(/7 pillars left/g)).toHaveLength(2);
    expect(markup).toContain('took 5m 0s');
  });

  it('routes every named specialist surface into the existing improvement lifecycle', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OwnedWork plans={[]} loading={false} />
      </MemoryRouter>
    );

    for (const path of ['/workloads', '/warehouses', '/serverless', '/foundation', '/improvements']) {
      expect(markup).toContain(`href="${path}"`);
    }
    expect(markup).toContain('Creating a plan does not change the Dashboard');
  });

  it('puts the next operating action before publication, schedule and history context', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OperateComposition {...operatePreviewFixture('attention')} />
      </MemoryRouter>
    );

    expect(markup).toContain('<h2 class="wa-type-page">What needs attention now</h2>');
    expect(markup).not.toContain('<h2 class="wa-type-page">Operate</h2>');
    expect(markup).toContain('Resume review');
    expect(markup.indexOf('Finish the open assessment review')).toBeLessThan(markup.indexOf('Latest report'));
    expect(markup.indexOf('Needs attention')).toBeLessThan(markup.indexOf('Cycle history'));
    expect(markup).toContain('Production recovery ownership');
    expect(markup).toContain('Restrict public network access');
  });

  it('keeps a partial scheduled run in both the lead action and the attention inbox', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OperateComposition {...operatePreviewFixture('recovery')} />
      </MemoryRouter>
    );

    expect(markup).toContain('Inspect the latest partial scheduled run');
    expect(markup).toContain('Partial scheduled run');
    expect(markup).not.toContain('Nothing in Next actions');
    expect(markup.match(/href="\/history\/preview-scheduled-partial"/g)).toHaveLength(3);
  });

  it('keeps backend diagnostics behind disclosure in the error state', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OperateComposition {...operatePreviewFixture('clean')} error="No record with id opaque-id." />
      </MemoryRouter>
    );

    expect(markup).toContain('One or more records did not load');
    expect(markup).toContain('<details class="wa-technical-disclosure">');
    expect(markup).toContain('No record with id opaque-id.');
  });
});
