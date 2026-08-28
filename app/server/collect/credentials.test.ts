// The two pieces of request and environment handling that a live scan proved fragile.
//
// Both of these were found the same way: the app deployed, started, answered, and then
// reported that all seventy-eight controls were unmeasurable. Neither failure looked
// like a bug from the outside — the app said the workspace could not be assessed, and
// it said it politely. That is the failure mode these tests exist to prevent.

import { describe, expect, it } from 'vitest';
import {
  MissingUserTokenError,
  actorFromHeaders,
  fromRequest,
  modeFor,
  vendServiceCredential,
  workspaceHost,
} from './credentials.js';
import { ranAsServicePrincipal } from '../../client/src/pages/run-language.js';

describe('the workspace host', () => {
  it('accepts the bare hostname the Apps runtime supplies', () => {
    // The form that broke a live scan: fetch rejects it with "Failed to parse URL".
    expect(workspaceHost({ DATABRICKS_HOST: 'dbc-example.cloud.databricks.com' })).toBe(
      'https://dbc-example.cloud.databricks.com'
    );
  });

  it('leaves an absolute URL alone apart from a trailing slash', () => {
    expect(workspaceHost({ DATABRICKS_HOST: 'https://example.cloud.databricks.com/' })).toBe(
      'https://example.cloud.databricks.com'
    );
  });

  it('falls back to the workspace url variable', () => {
    expect(workspaceHost({ DATABRICKS_WORKSPACE_URL: 'example.azuredatabricks.net' })).toBe(
      'https://example.azuredatabricks.net'
    );
  });

  it('is empty when neither is set, rather than a URL that half works', () => {
    expect(workspaceHost({})).toBe('');
  });
});

describe('who the forwarded token belongs to', () => {
  it('reads the email the proxy sets', () => {
    expect(actorFromHeaders({ headers: { 'x-forwarded-email': 'someone@example.com' } })).toBe('someone@example.com');
  });

  it('falls back to the preferred username when there is no email', () => {
    expect(actorFromHeaders({ headers: { 'x-forwarded-preferred-username': 'someone' } })).toBe('someone');
  });

  it('ignores a header that is present but blank', () => {
    expect(actorFromHeaders({ headers: { 'x-forwarded-email': '  ' } })).toBeUndefined();
  });

  it('is undefined when the proxy said nothing, so the caller can probe instead', () => {
    expect(actorFromHeaders({ headers: {} })).toBeUndefined();
  });
});

/**
 * The two forms of actor the store holds, measured on labs 2026-08-10 across all twenty scans.
 *
 * Named here rather than written into each case so that the day a third form arrives — a username
 * with no email, an application id in some other notation — it is added once and every assertion
 * below covers it.
 */
const PERSON = 'operator@example.com';
const PRINCIPAL = '5af463d1-8cb9-4417-b2a5-725cea64cce5';

describe('which identity a run was made by', () => {
  it('reads a service principal from its application id and a person from their email', () => {
    expect(modeFor(PRINCIPAL)).toBe('service-principal');
    expect(modeFor(PERSON)).toBe('on-behalf-of-user');
  });

  it('does not take a username for a principal, nor an id with anything around it', () => {
    // The discriminator is the whole actor, not a UUID somewhere in it: a username is forwarded
    // where an identity has no email, and calling one of those a service principal would stamp a
    // person's run as unattended.
    expect(modeFor('workspace-operator')).toBe('on-behalf-of-user');
    expect(modeFor(`sp-${PRINCIPAL}@example.com`)).toBe('on-behalf-of-user');
    expect(modeFor('')).toBe('on-behalf-of-user');
    // Whitespace either side is the proxy's, not the identity's; `actorFromHeaders` trims and this
    // agrees with it rather than reading a padded id as a person.
    expect(modeFor(` ${PRINCIPAL} `)).toBe('service-principal');
  });

  it('answers what the interface answers, so a stamp and a sentence cannot disagree', () => {
    // Two copies of one rule, in two build trees that share types and no code. The client's exists
    // because the mode it was reading was always `on-behalf-of-user`; this one exists so that stops
    // being true. If they ever part, a run stamped `service-principal` here could still be described
    // as a person's over there.
    for (const actor of [PERSON, PRINCIPAL, 'workspace-operator', '', PRINCIPAL.toUpperCase(), ` ${PRINCIPAL} `]) {
      expect(modeFor(actor) === 'service-principal', `actor ${actor}`).toBe(ranAsServicePrincipal({ actor }));
    }
  });
});

describe('credentials from a request', () => {
  it('carry the forwarded token and the actor', async () => {
    const provider = fromRequest(
      { headers: { 'x-forwarded-access-token': 'tok' } },
      'https://example.cloud.databricks.com',
      'someone@example.com'
    );
    const databricks = await provider.databricks();

    expect(databricks.mode).toBe('on-behalf-of-user');
    expect(databricks.actor).toBe('someone@example.com');
    expect(await databricks.token()).toBe('tok');
  });

  it('stamp a scheduled run as the principal that made it, on the provider and on the credentials', async () => {
    // Eight scheduled runs on labs recorded `on-behalf-of-user` with no person in them, because this
    // was a literal. `comparable()` refuses across a change of execution mode and could not fire.
    const provider = fromRequest(
      { headers: { 'x-forwarded-access-token': 'tok' } },
      'https://h',
      PRINCIPAL,
      'waf-schedule-probe'
    );

    expect(provider.mode).toBe('service-principal');
    expect((await provider.databricks()).mode).toBe('service-principal');
    expect((await provider.databricks()).actorName).toBe('waf-schedule-probe');
  });

  it('refuse to fall back to the app identity when no token was forwarded', () => {
    // The important one. Falling back would produce a scan of an estate the signed-in
    // user cannot see, and it would look exactly like a successful scan.
    expect(() => fromRequest({ headers: {} }, 'https://example.cloud.databricks.com', 'someone')).toThrow(
      MissingUserTokenError
    );
  });

  it('report no cloud credentials when no service credential is named', async () => {
    const provider = fromRequest({ headers: { 'x-forwarded-access-token': 'tok' } }, 'https://h', 'someone');
    expect(await provider.cloud()).toBeNull();
  });
});

describe('vending a service credential', () => {
  it('returns null when the workspace refuses, so a missing grant is not a bill', async () => {
    const keys = await vendServiceCredential('https://h', 'tok', 'prod-reader', () =>
      Promise.resolve(new Response('denied', { status: 403 }))
    );
    expect(keys).toBeNull();
  });

  it('returns the AWS keys the workspace vended', async () => {
    const keys = await vendServiceCredential('https://h', 'tok', 'prod-reader', () =>
      Promise.resolve(
        Response.json({
          aws_temp_credentials: {
            access_key_id: 'AKIATEST',
            secret_access_key: 'secret',
            session_token: 'session',
          },
          expiration_time: '2026-08-19T12:00:00.000Z',
        })
      )
    );
    expect(keys).toEqual({
      provider: 'aws',
      expiresAt: new Date('2026-08-19T12:00:00.000Z'),
      aws: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret', sessionToken: 'session' },
    });
  });
});
