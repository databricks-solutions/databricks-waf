import { describe, expect, it } from 'vitest';
import { readablePillarId } from './pillar-label';

describe('readablePillarId', () => {
  it('reads a hyphenated identifier as a sentence', () => {
    expect(readablePillarId('security-compliance-and-privacy')).toBe('Security compliance and privacy');
  });

  it('leaves a single word capitalised', () => {
    expect(readablePillarId('reliability')).toBe('Reliability');
  });

  it('says so rather than rendering nothing when the identifier is empty', () => {
    expect(readablePillarId('')).toBe('Unknown pillar');
    expect(readablePillarId('   ')).toBe('Unknown pillar');
  });

  it('never returns a slug, so a title can never render as one', () => {
    expect(readablePillarId('data_and_ai-governance')).not.toContain('-');
    expect(readablePillarId('data_and_ai-governance')).not.toContain('_');
  });
});
