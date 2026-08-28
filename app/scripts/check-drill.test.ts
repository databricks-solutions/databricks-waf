import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./check-drill.mjs', import.meta.url), 'utf8');

describe('the investigation publication drill', () => {
  it('accepts either the review chooser or the exact sole review record', () => {
    expect(source).toContain("'^/review(?:/[0-9a-f-]+)?$'");
  });
});
