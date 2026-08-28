import { describe, expect, it, vi } from 'vitest';
import {
  GROUP_ENV,
  NotPermittedError,
  UnconfiguredGroupError,
  configuredGroup,
  recordRefusal,
  requirePermission,
} from './group.js';

describe('the configured group', () => {
  it('is the name the install set', () => {
    expect(configuredGroup({ [GROUP_ENV]: 'waf-assessors' })).toBe('waf-assessors');
  });

  it('is trimmed, because a trailing space in a yaml value is not a different group', () => {
    expect(configuredGroup({ [GROUP_ENV]: '  admins \n' })).toBe('admins');
  });

  // The point of the whole file. An unset value has a convenient reading and a safe one, and
  // choosing the convenient one is the exposure A1a closes.
  it('refuses to be absent rather than defaulting to everybody', () => {
    expect(() => configuredGroup({})).toThrow(UnconfiguredGroupError);
    expect(() => configuredGroup({ [GROUP_ENV]: '' })).toThrow(UnconfiguredGroupError);
    expect(() => configuredGroup({ [GROUP_ENV]: '   ' })).toThrow(UnconfiguredGroupError);
  });

  it('says which file to edit, because the person reading it did not write this app', () => {
    let message = '';
    try {
      configuredGroup({});
    } catch (cause) {
      message = (cause as Error).message;
    }
    expect(message).toContain(GROUP_ENV);
    // Names the file the reader can actually change it in. `app.yaml` cannot hold this one: a value
    // there beats a target's override without saying so.
    expect(message).toContain('databricks.yml');
    expect(message).toContain('will not start');
  });
});

describe('permission to change an assessment', () => {
  it('is granted to a member', () => {
    expect(() => requirePermission('waf-assessors', { actor: 'ada@example.com', groups: ['users', 'waf-assessors'] }))
      .not.toThrow();
  });

  it('ignores case and surrounding space on both sides', () => {
    expect(() => requirePermission(' Admins ', { actor: 'ada@example.com', groups: ['ADMINS'] })).not.toThrow();
  });

  // The negative test the ledger row asks for.
  it('is refused to somebody in other groups', () => {
    const caller = { actor: 'grace@example.com', groups: ['users', 'analysts'] };
    expect(() => requirePermission('waf-assessors', caller)).toThrow(NotPermittedError);
    try {
      requirePermission('waf-assessors', caller);
    } catch (cause) {
      expect((cause as NotPermittedError).kind).toBe('not-a-member');
      expect((cause as Error).message).toContain('grace@example.com');
      expect((cause as Error).message).toContain('waf-assessors');
      // Says what is still available, so the refusal does not read as "the app is broken".
      expect((cause as Error).message).toContain('Reading the assessment');
    }
  });

  it('is refused to somebody in no groups at all', () => {
    expect(() => requirePermission('waf-assessors', { actor: 'nobody@example.com', groups: [] })).toThrow(
      NotPermittedError
    );
  });

  /*
   * The path worth arguing about.
   *
   * Membership arrives from one SCIM call, and an app that fell open when that call failed would be
   * an app whose authorization depends on an endpoint staying up. It is refused, and reported as a
   * fault rather than as a permission problem, because those two send an admin to opposite places.
   */
  it('is refused, as a fault, when membership could not be established', () => {
    try {
      requirePermission('waf-assessors', { actor: 'ada@example.com' });
      expect.unreachable('an unestablished membership must not be treated as a membership');
    } catch (cause) {
      expect((cause as NotPermittedError).kind).toBe('membership-unknown');
      expect((cause as Error).message).toContain('could not establish');
      expect((cause as Error).message).toContain('This is a fault rather than a permission problem');
    }
  });

  it('does not accept a group whose name merely contains the configured one', () => {
    expect(() => requirePermission('assessors', { actor: 'ada@example.com', groups: ['assessors-readonly'] })).toThrow(
      NotPermittedError
    );
  });
});

describe('a recorded refusal', () => {
  it('names the actor and the action it was refused, and not the paragraph they were shown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    recordRefusal('decide a finding', { actor: 'grace@example.com', groups: [] }, new NotPermittedError(
      'not-a-member',
      'a paragraph written for a person'
    ));

    expect(warn).toHaveBeenCalledOnce();
    const line = warn.mock.calls[0]?.[0] as string;
    expect(line).toContain('grace@example.com');
    expect(line).toContain('decide a finding');
    expect(line).toContain('not-a-member');
    expect(line).not.toContain('a paragraph written for a person');
    warn.mockRestore();
  });
});
