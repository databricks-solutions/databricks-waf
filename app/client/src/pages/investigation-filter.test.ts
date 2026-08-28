import { describe, expect, it } from 'vitest';
import { updatedInvestigationParams } from './investigation-filter';

describe('investigation filter URLs', () => {
  it('keeps an explicit all-outcomes choice because an absent outcome defaults to unmet', () => {
    const next = updatedInvestigationParams(new URLSearchParams('pillar=reliability&outcome=unmet'), {
      outcome: 'all',
    });

    expect(next.get('outcome')).toBe('all');
    expect(next.get('pillar')).toBe('reliability');
  });

  it('clears the pillar and movement all-values while retaining all outcomes', () => {
    const next = updatedInvestigationParams(
      new URLSearchParams('pillar=reliability&outcome=fail&changed=new&control=REL-03-02'),
      { pillar: 'all', outcome: 'all', changed: 'all', control: 'REL-03-02' }
    );

    expect(next.toString()).toBe('outcome=all&control=REL-03-02');
  });
});
