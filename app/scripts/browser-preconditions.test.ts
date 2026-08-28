/**
 * What a browser sweep refuses to run without.
 *
 * `requireScan` has had one of these since the family that found sweeps passing on empty pages.
 * `requireIdentity` is the same failure one step further out and it is the reason this file exists:
 * `63` ran all three sweeps against a live route with no token in the shell, and all three passed,
 * because the route rendered a 215-character card saying it could not read anything — which fits every
 * window, skips no heading level and has contrast to spare.
 *
 * The comment above `forwardIdentity` had said exactly that would happen. It had said so for months.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { INVESTIGATE_REST_CEILING_MS, requireIdentity, routeRestCeiling } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.TOKEN;

afterEach(() => {
  if (TOKEN == null) delete process.env.TOKEN;
  else process.env.TOKEN = TOKEN;
});

describe('requireIdentity', () => {
  it('refuses a shell with no token', () => {
    delete process.env.TOKEN;
    expect(() => {
      requireIdentity();
    }).toThrow(/no TOKEN/);
  });

  it('refuses a shell whose token is empty, which is what an unset profile leaves behind', () => {
    // `TOKEN=$(databricks auth token -p labs | jq -r .access_token)` sets an empty string when the
    // profile's refresh token has expired, and the export succeeds. That shell looks configured.
    process.env.TOKEN = '';
    expect(() => {
      requireIdentity();
    }).toThrow(/no TOKEN/);
  });

  it('says what the token is for, and that a scan is not the missing part', () => {
    delete process.env.TOKEN;
    let message = '';
    try {
      requireIdentity();
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }

    // The recipe, because a refusal that does not say how to satisfy it gets satisfied by deleting the
    // refusal. And the distinction, because the obvious reading of "the page rendered nothing" is that
    // the install needs a scan, and running one does not fix this.
    expect(message).toContain('databricks auth token');
    expect(message).toContain('databricks current-user me');
    expect(message).toMatch(/scan is not the missing part/);
  });

  it('passes a shell that has one', () => {
    process.env.TOKEN = 'dapi-not-a-real-token';
    expect(() => {
      requireIdentity();
    }).not.toThrow();
  });
});

describe('the sweeps that open every declared route', () => {
  // Named rather than discovered, because the property is about these two: they walk the router's own
  // list, so they reach the live routes whether or not anybody remembered those exist. A sweep with a
  // hand-written list of links -- check:drill -- is not in scope and does not carry the guard.
  const walkers = ['check-a11y.mjs', 'check-viewport.mjs'];

  for (const sweep of walkers) {
    it(`${sweep} refuses before it starts Chrome`, () => {
      const source = readFileSync(join(HERE, sweep), 'utf8');
      expect(source).toContain('requireIdentity()');

      // Before `open`, or the check spends a browser launch and a page load finding out.
      expect(source.indexOf('requireIdentity()')).toBeLessThan(source.indexOf('await open('));
    });
  }
});

describe('the measured topology-read ceiling', () => {
  it('covers both customer routes that wait on the seven topology statements', () => {
    expect(routeRestCeiling('/investigate')).toBe(INVESTIGATE_REST_CEILING_MS);
    expect(routeRestCeiling('/topology')).toBe(INVESTIGATE_REST_CEILING_MS);
    expect(routeRestCeiling('/overview')).toBeUndefined();
  });
});
