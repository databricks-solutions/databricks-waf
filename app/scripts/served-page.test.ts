import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RENDERED_SURFACE_SELECTOR } from './served-page.mjs';

describe('what the served route drive recognises as application content', () => {
  it('recognises only the customer design-system surface', () => {
    expect(RENDERED_SURFACE_SELECTOR).toBe('.wa-customer-surface');
  });

  it('is the readiness contract used by the local browser drive', () => {
    const browser = readFileSync(new URL('./browser.mjs', import.meta.url), 'utf8');

    expect(browser).toContain("import { RENDERED_SURFACE_SELECTOR } from './served-page.mjs'");
    expect(browser).toContain("RENDERED_SURFACE_SELECTOR + ', .wa-empty'");
  });
});
