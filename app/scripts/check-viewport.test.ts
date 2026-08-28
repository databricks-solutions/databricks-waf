import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./check-viewport.mjs', import.meta.url), 'utf8');

describe('the supported pilot viewport set', () => {
  it('release-gates desktop and laptop without promising tablet or mobile support', () => {
    expect(source).toContain("{ name: '1512x845', width: 1512, height: 845 }");
    expect(source).toContain("{ name: '1280x800', width: 1280, height: 800 }");
    expect(source).not.toContain("name: '1024x768'");
    expect(source).not.toContain("name: '390x844'");
  });
});
