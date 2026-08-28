import { describe, expect, it } from 'vitest';
import { requirementHref, requirementIn } from './requirement-link';

describe('carrying a requirement into the action lifecycle', () => {
  it('round trips the stable control id without carrying customer-facing prose', () => {
    const href = requirementHref('/improvements', 'REL-03-02');

    expect(requirementIn(new URLSearchParams(href.split('?')[1]))).toEqual({ controlId: 'REL-03-02' });
    expect(href).toBe('/improvements?control=REL-03-02');
  });

  it('preserves an existing query string when the plan link already carries state', () => {
    expect(requirementHref('/improvements/plan-1?action=a-1', 'CO-03-01')).toBe(
      '/improvements/plan-1?action=a-1&control=CO-03-01'
    );
  });

  it.each(['', 'row-122', 'REL-3-2', 'REL-03-02&title=edited'])('refuses a non-catalogue-shaped id: %s', (id) => {
    expect(requirementIn(new URLSearchParams({ control: id }))).toBeUndefined();
  });
});
