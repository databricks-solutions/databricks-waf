import { describe, expect, it } from 'vitest';
import { claimsOf, reportOn, scopesOf } from './token.js';

/** A JWT with the given claims and a signature that is never checked. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature-not-verified`;
}

describe('reading what a token permits', () => {
  it('names the scopes a space-separated token carries', () => {
    expect(scopesOf(jwt({ scope: 'sql catalog.tables:read files.files' }))).toEqual([
      'sql',
      'catalog.tables:read',
      'files.files',
    ]);
  });

  it('reads the scopes whether the claim is a string or a list', () => {
    expect(scopesOf(jwt({ scp: ['sql', 'iam.current-user:read'] }))).toEqual(['sql', 'iam.current-user:read']);
  });

  it('treats an opaque token as unreadable rather than as an error', () => {
    // The platform is entitled to issue a token that is not a JWT. A diagnostic that threw
    // here would turn "cannot tell" into "something is broken", which is a different and
    // wrong report.
    expect(scopesOf('dapi0123456789abcdef')).toBeUndefined();
    expect(claimsOf('dapi0123456789abcdef')).toBeUndefined();
    expect(reportOn('dapi0123456789abcdef')).toEqual({ readable: false });
  });

  it('survives a token whose body is not JSON', () => {
    expect(claimsOf('header.bm90LWpzb24.signature')).toBeUndefined();
  });

  it('distinguishes a token with no scope claim from one it could not read', () => {
    // Both report as unmeasured scopes, but only one is readable, and the difference decides
    // whether the answer is "the platform grants nothing" or "the app cannot tell".
    const report = reportOn(jwt({ sub: 'someone@example.com' }));
    expect(report.readable).toBe(true);
    expect(report.scopes).toBeUndefined();
  });

  it('reports remaining life so a stale token is not mistaken for an unscoped one', () => {
    const now = new Date('2026-08-01T00:00:00Z');
    const report = reportOn(jwt({ exp: now.getTime() / 1000 + 3600, scope: 'sql' }), now);
    expect(report.expiresIn).toBe(3600);
  });

  it('reports the audience, which is what says whether the account plane is in range', () => {
    expect(reportOn(jwt({ aud: 'dbc-example.cloud.databricks.com' })).audience).toBe(
      'dbc-example.cloud.databricks.com'
    );
  });
});
