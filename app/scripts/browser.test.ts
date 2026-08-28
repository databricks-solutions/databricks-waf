import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./browser.mjs', import.meta.url), 'utf8');

describe('the release browser selection', () => {
  it('prefers installed stable Chrome before a cached test build', () => {
    expect(source.indexOf("const installed = [")).toBeGreaterThan(-1);
    expect(source.indexOf("const cache = join(homedir(), '.cache/puppeteer/chrome')")).toBeGreaterThan(-1);
    expect(source.indexOf("const installed = [")).toBeLessThan(
      source.indexOf("const cache = join(homedir(), '.cache/puppeteer/chrome')")
    );
  });
});
