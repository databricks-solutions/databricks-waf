import { describe, expect, it } from 'vitest';
import { internalDeliveryLabels } from './customer-language.mjs';

describe('served customer language', () => {
  it.each(['Run 110c labs journey 2026-08-20', 'Evidence for row 122', 'PR #464 visual proof', 'Phase H1b'])(
    'finds internal delivery vocabulary in %s',
    (text) => expect(internalDeliveryLabels(text)).not.toEqual([])
  );

  it.each([
    'Platform architecture review',
    'Q3 platform review',
    'Performance efficiency · PE-03-11',
    'Reviewed 2026-08-21',
    'Result 696743ff-0808-4c6f-b13c-ab3f0a56d6a8',
  ])('leaves customer content and product provenance alone in %s', (text) => {
    expect(internalDeliveryLabels(text)).toEqual([]);
  });
});
