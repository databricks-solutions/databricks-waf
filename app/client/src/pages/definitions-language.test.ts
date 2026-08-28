import { describe, expect, it } from 'vitest';
import type { DefinitionVersion } from '../api/types';
import { describeChange, describeOwners, describeScope } from './definitions-language';

function version(overrides: Partial<DefinitionVersion> = {}): DefinitionVersion {
  return {
    version: 1,
    fingerprint: 'sha256:aaa',
    createdAt: '2026-08-01T00:00:00.000Z',
    createdBy: 'alice@example.com',
    measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
    attribution: { name: 'Q3 review', owners: [] },
    ...overrides,
  };
}

describe('describeChange', () => {
  it('distinguishes a renamed assessment from a re-aimed one', () => {
    const renamed = describeChange(
      version({ version: 2, attribution: { name: 'Q3 platform review', owners: [] } }),
      version()
    );
    const reaimed = describeChange(version({ version: 2, fingerprint: 'sha256:bbb' }), version());

    // The whole reason the fingerprint is stored: a reader looking at a score that moved has to be
    // able to tell which of these happened, and the two sentences must not be substitutable.
    expect(renamed).not.toBe(reaimed);
    expect(renamed).toContain('compare');
    expect(reaimed).toContain('not of the same question');
  });

  it('says a first version is a first version rather than describing a change to nothing', () => {
    expect(describeChange(version(), undefined)).toBe('The first version.');
  });
});

describe('describeScope', () => {
  it('describes an account reach by what decides it, not by a count it cannot know', () => {
    const said = describeScope(version());
    expect(said).toContain('scanning identity');
    expect(said).not.toMatch(/\d+ workspace/);
  });

  it('counts chosen workspaces, and agrees with itself about the singular', () => {
    expect(describeScope(version({ measurement: { scope: { kind: 'selected', workspaceIds: ['1'] }, lookbackDays: 1 } }))).toBe(
      '1 chosen workspace, over the last 1 day, covering every pillar.'
    );
    expect(
      describeScope(version({ measurement: { scope: { kind: 'selected', workspaceIds: ['1', '2'] }, lookbackDays: 30 } }))
    ).toBe('2 chosen workspaces, over the last 30 days, covering every pillar.');
  });

  it('names how many pillars when the definition narrows them', () => {
    expect(
      describeScope(version({ measurement: { scope: { kind: 'account' }, lookbackDays: 30, pillars: ['cost-optimization'] } }))
    ).toContain('covering 1 pillar.');
  });
});

describe('describeOwners', () => {
  it('says nobody owns it rather than leaving the line blank', () => {
    // An empty line reads as "not shown yet". An unowned assessment is a real state and the reason
    // the field is optional, so it has to be legible as one.
    expect(describeOwners([])).toContain('Nobody');
  });

  it('lists the owners it has', () => {
    expect(describeOwners(['alice@example.com', 'bob@example.com'])).toBe(
      'Owned by alice@example.com, bob@example.com.'
    );
  });
});
