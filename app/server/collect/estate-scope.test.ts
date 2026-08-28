// What a scope may and may not mean.
//
// The scope is on the stamp and the stamp is what two runs are compared by, so the failures here are not
// crashes: a selection that canonicalises differently on two runs makes one estate compare as two, and a
// selection that quietly drops an id narrows the assessment while leaving the record of what was asked
// for unchanged.

import { describe, expect, it } from 'vitest';
import { accountScope, EstateScopeError, probeCurrentUser, selectedScope } from './estate-scope.js';

describe('narrowing a scope to what an assessment names', () => {
  it('keeps the host workspace, which the region partition needs', () => {
    expect(selectedScope(accountScope('host-1'), ['w2']).hostWorkspaceId).toBe('host-1');
  });

  it('canonicalises the ids, so one estate cannot compare as two', () => {
    expect(selectedScope(accountScope(), [' w2', 'w1', 'w2 ']).selected).toEqual(['w1', 'w2']);
  });

  /*
   * Refused rather than dropped. Dropping turns a scope of three into a run of two while the definition
   * still says three, which is the failure the whole selection mechanism exists to close.
   */
  it('refuses a blank id rather than narrowing silently', () => {
    expect(() => selectedScope(accountScope(), ['w1', ' '])).toThrow(EstateScopeError);
  });

  it('refuses a selection of nothing, which would assess nothing while claiming a scope', () => {
    expect(() => selectedScope(accountScope(), [])).toThrow(EstateScopeError);
  });

  it('says how many workspaces it covers, since the description is shown verbatim', () => {
    expect(selectedScope(accountScope(), ['w1']).description).toContain('1 workspace this assessment names');
    expect(selectedScope(accountScope(), ['w1', 'w2']).description).toContain('2 workspaces this assessment names');
  });

  /*
   * Not `narrowedTo`. That forces every signal to workspace reach and disables slicing, both right for one
   * workspace and wrong for a set: six of forty is an account-reach read of six that still wants slicing.
   */
  it('does not bind the single-workspace narrowing', () => {
    expect(selectedScope(accountScope('host-1'), ['w1']).narrowedTo).toBeUndefined();
  });
});

describe('what the identity probe keeps from a SCIM record', () => {
  const answering =
    (body: unknown, orgId = 'w1'): typeof globalThis.fetch =>
    () =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { 'x-databricks-org-id': orgId } })
      );

  const probe = (fetch: typeof globalThis.fetch) =>
    probeCurrentUser({ host: 'https://example.cloud.databricks.com', token: 't', fetch });

  it('keeps the name a service principal calls itself, which is the only readable form of its id', () => {
    // The whole reason this field exists. A service principal's userName is its application id, so a
    // history page shows a UUID where a person's row shows an email. SCIM answers the name the person
    // who created it chose, and asking `Me` needs no privilege the identity does not already have.
    return expect(
      probe(answering({ userName: '5af463d1-8cb9-4417-b2a5-725cea64cce5', displayName: 'waf-schedule-probe' }))
    ).resolves.toMatchObject({ userName: '5af463d1-8cb9-4417-b2a5-725cea64cce5', displayName: 'waf-schedule-probe' });
  });

  it('drops a name that only repeats the username, rather than recording it twice', async () => {
    // SCIM echoes a person's email into displayName. Keeping it would put the same string in the
    // record under two names and leave a reader wondering which was authoritative.
    const user = await probe(answering({ userName: 'admin@example.com', displayName: 'admin@example.com' }));
    expect(user.displayName).toBeUndefined();
    expect(user.userName).toBe('admin@example.com');
  });

  it('records nothing rather than an empty name when SCIM has none', async () => {
    expect((await probe(answering({ userName: 'admin@example.com', displayName: '   ' }))).displayName).toBeUndefined();
    expect((await probe(answering({ userName: 'admin@example.com' }))).displayName).toBeUndefined();
  });

  it('says nothing at all when the probe is refused, so attribution falls back rather than failing', async () => {
    const refused: typeof globalThis.fetch = () => Promise.resolve(new Response('no', { status: 403 }));
    expect(await probe(refused)).toEqual({});
  });
});
