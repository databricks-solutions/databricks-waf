// SCP-01-01: local credentials identified from the authentication path in the audit log.
//
// Password logins (`action_name = 'login'`) settle a failure. Their absence settles nothing —
// a local account that did not authenticate in the window looks exactly like no local account.
//
// Two sentences here are deliberately narrower than they read before. The count of the three
// named action names is not "authentication events": measured on labs, a third of the
// authentication traffic ran under names outside those three. So the counted events are
// described as the paths they came from, and the events outside them are reported by name
// without being classified — `otherAuthActions` says what the audit log emitted and nothing
// about what any of it means.

import type { ControlResolver } from '../resolver.js';
import type { AuthLoginPaths } from '../../collect/sql/shapes.js';
import { agreeing, evidenceFrom, fromSignal, unmeasured } from './helpers.js';

const AUTH = 'sql:security.auth_login_paths';

/** The action names outside the three, as a clause that reports them and concludes nothing. */
function otherPaths(paths: AuthLoginPaths): string {
  if (paths.otherAuthEvents === 0) return '';
  const { noun } = agreeing(paths.otherAuthEvents, 'event');
  const named =
    paths.otherAuthActions.length === 0 ? '' : ` (${paths.otherAuthActions.join(', ')})`;
  return `${noun} under other action names mentioning login or authentication${named}`;
}

/** Account-level events, which belong to no workspace and are counted rather than dropped. */
function accountPlane(paths: AuthLoginPaths): string {
  if (paths.accountPlaneEvents === 0) return '';
  const { noun } = agreeing(paths.accountPlaneEvents, 'event');
  return `${noun} recorded against the account rather than a workspace`;
}

const localCredentials = fromSignal<AuthLoginPaths>(AUTH, ['SCP-01-01'], (paths, context) => {
  const aside = [otherPaths(paths), accountPlane(paths)].filter((clause) => clause !== '');

  if (paths.passwordLogins > 0) {
    const when =
      paths.lastPasswordLogin == null
        ? ''
        : `, most recently ${paths.lastPasswordLogin.toISOString().slice(0, 10)}`;
    const logins = agreeing(paths.passwordLogins, 'username-and-password login');
    const actors = agreeing(paths.passwordActors, 'actor');
    return {
      outcome: 'fail' as const,
      evidence: [
        evidenceFrom(
          context,
          AUTH,
          `${logins.noun} from ${actors.noun} in the window` +
            when +
            `; ${paths.samlLogins.toLocaleString('en-US')} SAML and ` +
            `${paths.oidcLogins.toLocaleString('en-US')} OAuth` +
            (aside.length > 0 ? `; ${aside.join(', and ')}` : ''),
          'Accounts authenticate through the identity provider rather than with a local password'
        ),
      ],
      outcomeReason:
        'A username-and-password login is its own audit action, distinct from SAML and OAuth. Seeing one ' +
        'means a local credential was used; the account-plane configuration that would say whether such ' +
        'accounts are still provisioned is unreadable here.',
    };
  }

  if (paths.loginEvents === 0) {
    const nothing =
      paths.otherAuthEvents === 0
        ? 'No login, SAML or OAuth authentication events were recorded in the window'
        : `No login, SAML or OAuth authentication events were recorded in the window, though ` +
          `${otherPaths(paths)} ${
            paths.otherAuthEvents === 1 ? 'was' : 'were'
          }. This reading does not say which of those are people signing in, so it cannot tell ` +
          'whether one of them was a local credential';
    return unmeasured(
      `${nothing}, so whether local credentials exist could not be determined from the audit log. ` +
        'Absence of password logins would not prove they do not exist either — only that none ' +
        'authenticated that way while this window was retained.',
      'attestation'
    );
  }

  const sso = paths.samlLogins + paths.oidcLogins;
  const counted = agreeing(paths.loginEvents, 'login, SAML or OAuth event');
  return unmeasured(
    `No username-and-password logins were recorded among ${counted.noun} in the window` +
      (sso > 0
        ? ` (${paths.samlLogins.toLocaleString('en-US')} SAML, ${paths.oidcLogins.toLocaleString('en-US')} OAuth)`
        : '') +
      (aside.length > 0 ? `, alongside ${aside.join(', and ')}` : '') +
      '. That settles nothing about whether local accounts exist — only that none authenticated with a ' +
      'password while this window was retained. The account-plane provisioning path is unreadable here.',
    'attestation'
  );
});

export const AUTH_LOGIN_RESOLVERS: readonly ControlResolver[] = [localCredentials];
