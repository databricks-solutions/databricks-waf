import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_ACCEPTANCE_CASES,
  CUSTOMER_ACCEPTANCE_RENDER_COUNT,
  CUSTOMER_ACCEPTANCE_SURFACES,
  CUSTOMER_ACCEPTANCE_THEMES,
  CUSTOMER_ACCEPTANCE_WIDTHS,
} from './customer-acceptance';

describe('the local customer-system acceptance matrix', () => {
  it('covers every primary surface and every deterministic state fixture', () => {
    expect(CUSTOMER_ACCEPTANCE_SURFACES.map((one) => one.surface)).toEqual([
      'dashboard',
      'assess',
      'investigate',
      'improvement',
      'operate',
      'report',
    ]);
    expect(CUSTOMER_ACCEPTANCE_CASES).toHaveLength(31);
    expect(new Set(CUSTOMER_ACCEPTANCE_CASES.map((one) => one.id)).size).toBe(CUSTOMER_ACCEPTANCE_CASES.length);
  });

  it('renders every case in both themes at the supported desktop and laptop widths', () => {
    expect(CUSTOMER_ACCEPTANCE_WIDTHS.map((one) => one.width)).toEqual([1512, 1280]);
    expect(CUSTOMER_ACCEPTANCE_THEMES).toEqual(['light', 'dark']);
    expect(CUSTOMER_ACCEPTANCE_RENDER_COUNT).toBe(124);
  });

  it('uses development-only preview routes rather than customer or workspace writes', () => {
    for (const one of CUSTOMER_ACCEPTANCE_CASES) {
      expect(one.path).toBe(`/preview/${one.surface}/${one.state}`);
      expect(one.path).not.toMatch(/^\/(?:review|improvements)\/[^/]/);
    }
  });
});
