import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Finding, RemedyKind } from '../api/types';
import { MeasurementRemedyAction } from './MeasurementRemedyAction';

function render(kind?: RemedyKind, because?: string): string {
  const finding: Finding = {
    controlId: 'SEC-01-01',
    pillarId: 'security-compliance-and-privacy',
    principleId: 'SEC-01',
    title: 'Protect administrative access',
    outcome: 'unmeasurable',
    severity: 'high',
    coverage: { mode: 'sampled', examined: 0, population: 0 },
    outcomeReason: 'The required source could not be read.',
    evidence: [],
    ...(kind != null
      ? {
          remedy: {
            kind,
            says: 'Take the recorded measurement remedy.',
            ...(because != null ? { because } : {}),
            signals: kind === 'grant' ? (['workspace_current_user'] as const) : [],
          },
        }
      : {}),
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <MeasurementRemedyAction finding={finding} />
    </MemoryRouter>
  );
}

describe('MeasurementRemedyAction', () => {
  it('opens Answers on the exact requirement when a person must answer it', () => {
    const markup = render('attest');
    expect(markup).toContain('Answer this requirement');
    expect(markup).toContain('href="/answers?control=SEC-01-01"');
    expect(markup).not.toContain('/improvements');
  });

  it('names grant and sign-in work without inventing a generic remediation destination', () => {
    for (const kind of ['grant', 're-authorise'] as const) {
      const markup = render(kind);
      expect(markup).toContain('No safe exact link is recorded.');
      expect(markup).not.toContain('/improvements');
    }
    expect(render('grant')).toContain('Grant the scanning identity the required access');
    expect(render('re-authorise')).toContain('Sign in to this app again');
  });

  it('keeps retry and application defects attached to the workflow that owns them', () => {
    expect(render('retry')).toContain('href="/overview"');
    expect(render('report')).toContain('href="/diagnostics"');
  });

  it('does not invent compliance remediation when no measurement remedy was recorded', () => {
    const markup = render();
    expect(markup).toContain('Review why this requirement could not be measured');
    expect(markup).toContain('No safe action is recorded.');
    expect(markup).not.toContain('data-customer-action="recommendation"');
    expect(markup).not.toContain('/improvements');
  });

  it('verifies restored measurement rather than the requirement compliance criterion', () => {
    const markup = render('grant');
    expect(markup).toContain('reads the previously unavailable source and records an outcome');
    expect(markup).not.toContain('80%');
  });

  it('keeps platform evidence and source signals in tertiary disclosure', () => {
    const markup = render('grant', 'PERMISSION_DENIED: cannot read system.compute.warehouses');
    expect(markup).toContain('Technical measurement evidence');
    expect(markup).toContain('PERMISSION_DENIED: cannot read system.compute.warehouses');
    expect(markup).toContain('Source signal IDs');
    expect(markup).toContain('workspace_current_user');
  });
});
