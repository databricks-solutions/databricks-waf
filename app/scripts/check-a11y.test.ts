import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./check-a11y.mjs', import.meta.url), 'utf8');

describe('the supported accessibility viewport set', () => {
  it('checks the pilot desktop and laptop windows without promising tablet support', () => {
    expect(source).toContain("{ name: '1512x845', width: 1512, height: 845 }");
    expect(source).toContain("{ name: '1280x800', width: 1280, height: 800 }");
    expect(source).not.toContain("name: '860x800'");
  });
});
