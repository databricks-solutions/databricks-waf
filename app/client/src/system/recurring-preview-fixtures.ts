/** Invented, read-only states for the Assess and Operate local acceptance routes. */

import type { AcceptedRisk, AssessmentReview, ImprovementPlan, ScanSummary } from '@/api/types';
import type { OperateCompositionProps } from '@/pages/OperatePage';
import type { OperatePreviewState } from '../../../shared/customer-acceptance';

export {
  ASSESS_PREVIEW_STATES,
  type AssessPreviewState,
  OPERATE_PREVIEW_STATES,
  type OperatePreviewState,
} from '../../../shared/customer-acceptance';

const NOW = new Date('2026-08-22T02:30:00.000Z');

const REVIEW: AssessmentReview = {
  id: 'preview-review-attention',
  runId: 'preview-scheduled-complete',
  openedBy: 'architecture.owner@example.com',
  openedAt: '2026-08-21T23:05:00.000Z',
  pillars: [],
  answers: [],
  durable: true,
};

const COMPLETE_SCHEDULED: ScanSummary = {
  id: 'preview-scheduled-complete',
  startedAt: '2026-08-21T23:00:00.000Z',
  finishedAt: '2026-08-21T23:05:00.000Z',
  state: 'complete',
  actor: 'waf-assessment-sp',
  actorName: 'WAF assessment schedule',
  executionMode: 'service-principal',
  trigger: 'scheduled',
  catalogueVersion: 'waf-v1',
  measuredPillars: ['reliability'],
  freshPillars: ['reliability'],
  counts: { pass: 14, fail: 2, partial: 1, unmeasurable: 3, notApplicable: 1 },
  pillarScores: { reliability: 72 },
};

const PARTIAL_SCHEDULED: ScanSummary = {
  ...COMPLETE_SCHEDULED,
  id: 'preview-scheduled-partial',
  startedAt: '2026-08-22T01:00:00.000Z',
  finishedAt: '2026-08-22T01:04:00.000Z',
  state: 'partial',
  measuredPillars: ['reliability'],
  freshPillars: [],
  counts: { pass: 4, fail: 1, partial: 0, unmeasurable: 16, notApplicable: 0 },
};

const PLAN: ImprovementPlan = {
  id: 'preview-plan-reliability',
  title: 'Production recovery ownership',
  outcome: 'Recovery procedures have a named owner and current exercise evidence.',
  owners: ['platform.operations@example.com'],
  raisedFrom: 'preview-result-current',
  createdBy: 'architecture.owner@example.com',
  createdAt: '2026-08-18T02:05:00.000Z',
  progress: {
    planId: 'preview-plan-reliability',
    states: {
      draft: 0,
      planned: 0,
      'in-progress': 1,
      blocked: 0,
      'ready-for-validation': 1,
      verified: 0,
      cancelled: 0,
    },
    contradicted: ['preview-action-recovery-test'],
    overdue: ['preview-action-owner'],
    blocked: [],
    settled: false,
    nextDue: '2026-08-20T23:59:59.999Z',
  },
};

const RISK: AcceptedRisk = {
  id: 'preview-risk-public-network',
  controlId: 'SEC-02-04',
  reason: 'A supplier migration requires a temporary public endpoint.',
  compensatingControl: 'Daily network policy review and restricted source addresses.',
  residual: 'high',
  owner: 'security.owner@example.com',
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-08-21T23:59:59.999Z',
  recordedBy: 'security.owner@example.com',
  recordedAt: '2026-08-01T00:00:00.000Z',
  standing: 'expired',
  effective: false,
  title: 'Restrict public network access',
  pillarId: 'security-compliance-and-privacy',
  severity: 'high',
};

const CURRENT_RESULT = {
  id: 'preview-result-current',
  finalisedBy: 'reviewer@example.com',
  finalisedAt: '2026-08-18T02:10:00.000Z',
} as const;

export function operatePreviewFixture(state: OperatePreviewState): OperateCompositionProps {
  const base: OperateCompositionProps = {
    reviews: [],
    scans: [COMPLETE_SCHEDULED],
    plans: [],
    risks: [],
    pillarCount: 7,
    now: NOW,
    result: CURRENT_RESULT,
  };
  if (state === 'loading') return { ...base, scans: [], loading: true };
  if (state === 'attention') return { ...base, reviews: [REVIEW], plans: [PLAN], risks: [RISK] };
  if (state === 'partial') {
    return {
      ...base,
      scans: [],
      result: undefined,
      eligibilityReason: 'The current identity cannot read assessment reviews for this definition.',
    };
  }
  if (state === 'recovery') return { ...base, scans: [PARTIAL_SCHEDULED] };
  return base;
}

export function publishedReviewPreview(): AssessmentReview {
  const pillars = [
    'cost-optimization',
    'data-and-ai-governance',
    'interoperability-and-usability',
    'operational-excellence',
    'performance-efficiency',
    'reliability',
    'security-compliance-and-privacy',
  ].map((pillarId, index) => ({
    id: `preview-pillar-${String(index + 1)}`,
    reviewId: 'preview-review-published',
    runId: 'preview-run-published',
    pillarId,
    kind: 'confirmed' as const,
    attestationIds: [],
    by: 'reviewer@example.com',
    at: '2026-08-22T02:15:00.000Z',
  }));
  return {
    id: 'preview-review-published',
    runId: 'preview-run-published',
    openedBy: 'reviewer@example.com',
    openedAt: '2026-08-22T02:00:00.000Z',
    pillars,
    answers: [],
    durable: true,
    result: {
      id: 'preview-result-published',
      reviewId: 'preview-review-published',
      runId: 'preview-run-published',
      finalisedBy: 'reviewer@example.com',
      finalisedAt: '2026-08-22T02:15:00.000Z',
      pillars,
      attestationIds: [],
    },
  };
}
