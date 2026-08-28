import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { AuthLoginPaths } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const AUTH = 'sql:security.auth_login_paths' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function paths(over: Partial<AuthLoginPaths> = {}): AuthLoginPaths {
  return {
    loginEvents: 0,
    passwordLogins: 0,
    samlLogins: 0,
    oidcLogins: 0,
    otherAuthEvents: 0,
    otherAuthActions: [],
    accountPlaneEvents: 0,
    passwordActors: 0,
    ...over,
  };
}

function findingFor(value: AuthLoginPaths) {
  const spec = catalogue.controls.find((control) => control.id === 'SCP-01-01');
  if (spec == null) throw new Error('SCP-01-01 is not in the catalogue');
  const signals = new Map<SignalId, SignalResult>([[AUTH, observed(AUTH, value, 1, COMPLETE)]]);
  return resolveControl(spec, signals, registry.get('SCP-01-01'));
}

describe('SCP-01-01, authentication path', () => {
  it('fails when username-and-password logins appear in the window', () => {
    const finding = findingFor(
      paths({
        loginEvents: 148,
        passwordLogins: 4,
        samlLogins: 144,
        oidcLogins: 0,
        passwordActors: 2,
        lastPasswordLogin: new Date('2026-08-01T12:00:00Z'),
      })
    );
    expect(finding.outcome).toBe('fail');
    expect(finding.evidence.map((item) => item.observed).join(' ')).toMatch(/4 username-and-password/);
  });

  it('reports unmeasurable rather than a pass when no password logins appear', () => {
    // Absence of password logins does not prove local accounts are gone — only that none
    // authenticated that way while the window was retained.
    const finding = findingFor(paths({ loginEvents: 144, samlLogins: 144 }));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/settles nothing/);
  });

  it('reports unmeasurable when the window holds no authentication events at all', () => {
    const finding = findingFor(paths());
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/No login, SAML or OAuth/);
  });

  it('does not call the paths it counted "authentication events"', () => {
    // Measured on labs: a third of the authentication traffic ran under action names outside
    // the three this counts, so the count is of those three and the sentence has to say so.
    const finding = findingFor(
      paths({ loginEvents: 144, samlLogins: 144, otherAuthEvents: 198_520, otherAuthActions: ['tokenLogin'] })
    );
    expect(finding.outcomeReason).toMatch(/144 login, SAML or OAuth events/);
    expect(finding.outcomeReason).not.toMatch(/144 authentication events/);
  });

  it('names the other authentication actions it saw without saying what they were', () => {
    const finding = findingFor(
      paths({ loginEvents: 144, samlLogins: 144, otherAuthEvents: 2, otherAuthActions: ['jwtLogin', 'tokenLogin'] })
    );
    expect(finding.outcomeReason).toMatch(/2 events under other action names mentioning login or authentication \(jwtLogin, tokenLogin\)/);
  });

  it('does not report an estate with no named path as having no authentication at all', () => {
    // The failing case this row exists for: an estate whose sign-ins are all under some other
    // action name had every one of them invisible, and the sentence said none were recorded.
    const finding = findingFor(
      paths({ otherAuthEvents: 40_000, otherAuthActions: ['aadBrowserLogin'] })
    );
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/though 40,000 events under other action names/);
    expect(finding.outcomeReason).toMatch(/does not say which of those are people signing in/);
  });

  it('says when the events it read belong to the account rather than a workspace', () => {
    const finding = findingFor(paths({ loginEvents: 57, samlLogins: 57, accountPlaneEvents: 18 }));
    expect(finding.outcomeReason).toMatch(/18 events recorded against the account rather than a workspace/);
  });

  it('reads only the auth-login-paths signal', () => {
    const resolver = registry.get('SCP-01-01');
    expect(resolver?.requires).toEqual([AUTH]);
  });
});
