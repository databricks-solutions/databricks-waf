import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_PREVIEW_STATES,
  PREVIEW_CONTROLS,
  dashboardPreviewFixture,
  improvementPreviewAction,
  investigationPreviewFixture,
  reportPreviewFixture,
} from './customer-preview-fixtures';
import {
  ASSESS_PREVIEW_STATES,
  OPERATE_PREVIEW_STATES,
  operatePreviewFixture,
  publishedReviewPreview,
} from './recurring-preview-fixtures';

describe('the customer-system acceptance fixtures', () => {
  it.each(CUSTOMER_PREVIEW_STATES)('keeps the %s report census consistent with its score', (state) => {
    const fixture = reportPreviewFixture(state);
    const counted = Object.values(fixture.scan.score.counts).reduce((total, count) => total + count, 0);

    expect(fixture.rows).toHaveLength(fixture.scan.findings.length);
    expect(counted).toBe(fixture.scan.score.totalControls);
    expect(fixture.pillarRows).toHaveLength(fixture.scan.score.pillars.length);
    for (const entry of fixture.ranked) {
      expect(fixture.rows.some((row) => row.controlId === entry.finding.controlId)).toBe(true);
    }
  });

  it('carries an exact labs workspace destination for the complete Dashboard action', () => {
    const fixture = dashboardPreviewFixture('complete');
    const first = fixture.queue[0];

    expect(first).toBeDefined();
    expect(fixture.firstControl?.id).toBe(first?.finding.controlId);
    expect(fixture.firstControl?.remediation?.deepLink).toBe(
      'https://dbc-example.cloud.databricks.com/jobs/482901347110/tasks?o=7000000000000023'
    );
  });

  it('separates sparse, clean and changed acceptance states without fabricated work', () => {
    const sparse = dashboardPreviewFixture('sparse');
    const empty = dashboardPreviewFixture('empty');
    const changed = dashboardPreviewFixture('changed');

    expect(sparse.scan.score.counts.unmeasurable).toBeGreaterThan(100);
    expect(sparse.gaps.every((gap) => gap.action != null)).toBe(true);
    expect(sparse.gaps.filter((gap) => gap.counted).reduce((sum, gap) => sum + gap.blocked, 0)).toBe(
      sparse.scan.score.counts.unmeasurable
    );
    expect(sparse.gaps.filter((gap) => !gap.counted).map((gap) => gap.id)).toEqual([
      'not-applicable',
      'silent-signals',
    ]);
    expect(empty.queue).toEqual([]);
    expect(empty.gaps).toEqual([]);
    expect(empty.scan.score.counts.unmeasurable).toBe(0);
    expect(changed.changes?.lines).toHaveLength(3);
    expect(PREVIEW_CONTROLS[changed.queue[0]?.finding.controlId ?? '']).toBeDefined();
  });

  it('keeps investigation and improvement states exact and non-persistent', () => {
    const many = investigationPreviewFixture('complete');
    const one = investigationPreviewFixture('sparse');
    const clean = investigationPreviewFixture('empty');
    const refused = investigationPreviewFixture('changed');

    expect(many.finding?.evidence[0]?.at?.items).toHaveLength(3);
    expect(many.topology?.edges).toHaveLength(1);
    expect(one.finding?.evidence[0]?.at?.items).toHaveLength(1);
    expect(one.finding?.evidence[0]?.at?.items[0]?.url).toContain('o=7000000000000026');
    expect(one.workspaceDirectory?.workspaces[0]?.status).toBe('BANNED');
    expect(one.topology).toBeUndefined();
    expect(clean.finding).toBeUndefined();
    expect(refused.topologyError).toContain('could not be read');
    expect(improvementPreviewAction('changed')?.agreement).toBe('contradicted');
    expect(improvementPreviewAction('empty')).toBeUndefined();
  });

  it('covers every recurring-cycle state without turning a clean cycle into work', () => {
    expect(ASSESS_PREVIEW_STATES).toEqual(['loading', 'review', 'partial', 'published', 'empty', 'error']);
    expect(OPERATE_PREVIEW_STATES).toEqual(['loading', 'attention', 'clean', 'partial', 'recovery']);

    const attention = operatePreviewFixture('attention');
    const clean = operatePreviewFixture('clean');
    const recovery = operatePreviewFixture('recovery');

    expect(attention.reviews).toHaveLength(1);
    expect(attention.plans[0]?.progress.contradicted).toHaveLength(1);
    expect(attention.risks[0]?.standing).toBe('expired');
    expect(clean.reviews).toEqual([]);
    expect(clean.plans).toEqual([]);
    expect(clean.risks).toEqual([]);
    expect(recovery.scans[0]?.state).toBe('partial');
    expect(publishedReviewPreview().result?.pillars).toHaveLength(7);
  });
});
