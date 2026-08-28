import { describe, expect, it } from 'vitest';
import { foundationHref, foundationIn, foundationPhrase } from './foundation-link';

describe('carrying a foundation shortfall into the action lifecycle', () => {
  it('round trips a known reading and preselects requirements that a later run can check', () => {
    const href = foundationHref('/improvements', 'table-metadata');
    const handoff = foundationIn(new URLSearchParams(href.split('?')[1]));

    expect(handoff).toEqual({
      id: 'table-metadata',
      label: 'Table metadata',
      controlIds: ['DG-01-03', 'DG-01-05'],
    });
    expect(foundationPhrase(handoff as NonNullable<typeof handoff>)).toBe('the table metadata foundation reading');
  });

  it('does not invent a handoff for an edited or stale id', () => {
    expect(foundationIn(new URLSearchParams({ foundation: 'overall-readiness' }))).toBeUndefined();
  });
});
