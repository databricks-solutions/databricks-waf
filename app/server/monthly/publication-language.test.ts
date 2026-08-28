import { describe, expect, it } from 'vitest';
import { noSelectedRun, selectedRun, selectedRunReference } from './publication-language.js';

describe('month publication run language', () => {
  it('names a selected run without saying an open month has closed', () => {
    expect(selectedRun('August 2026', '17 Aug 2026, 08:22 UTC', false)).toBe(
      'August 2026 currently uses the run finished 17 Aug 2026, 08:22 UTC in this preview'
    );
    expect(selectedRunReference('17 Aug 2026, 08:22 UTC', false)).toBe(
      'the run finished 17 Aug 2026, 08:22 UTC selected by this preview'
    );
    expect(noSelectedRun('August 2026', false)).toContain('no readable run in the month yet');
  });

  it('keeps the closing-run language once the month has actually closed', () => {
    expect(selectedRun('July 2026', '31 Jul 2026, 23:50 UTC', true)).toBe(
      'July 2026 closed on the run finished 31 Jul 2026, 23:50 UTC'
    );
    expect(selectedRunReference('31 Jul 2026, 23:50 UTC', true)).toBe(
      'the closing run finished 31 Jul 2026, 23:50 UTC'
    );
    expect(noSelectedRun('July 2026', true)).toContain('no readable closing run');
  });
});
