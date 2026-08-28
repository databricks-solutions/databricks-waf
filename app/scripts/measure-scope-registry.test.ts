import { describe, expect, it } from 'vitest';

import { verdict } from './measure-scope-registry.mjs';

/**
 * How the registry's two refusals are told apart, and the one way the reading went wrong.
 *
 * The measurement itself is live and optional; this holds the part that decides what it reports. A detector
 * that reads "accepted" off a rejection unblocks work the platform will refuse, and it did exactly that once.
 */
describe('reading the scope registry', () => {
  it('reads a fall-through to the app lookup as accepted', () => {
    expect(
      verdict(
        404,
        '{"error_code":"NOT_FOUND","message":"App with name waf-registry-probe-absent-app does not exist or is deleted."}',
      ),
    ).toBe('accepted');
  });

  it('reads a named scope refusal as rejected', () => {
    expect(
      verdict(
        400,
        '{"error_code":"INVALID_PARAMETER_VALUE","message":"The specified scope sql.history is not a valid scope."}',
      ),
    ).toBe('rejected');
  });

  it('is not fooled by a probe app whose own name contains the word scope', () => {
    // The apparatus bug, kept as a test. The first run of this measurement invented the absent app
    // `waf-scope-probe-does-not-exist`, and its detector asked whether the response mentioned a scope. Every
    // response did, because every response quotes the app name back, so all twelve candidates read as
    // rejected — including two the registry accepts. The name in use has no such word, and the reading strips
    // it regardless, so the same mistake cannot come back by renaming.
    const message =
      '{"error_code":"NOT_FOUND","message":"App with name waf-scope-probe-does-not-exist does not exist or is deleted."}';
    expect(verdict(404, message, 'waf-scope-probe-does-not-exist')).toBe('accepted');
  });

  it('says so rather than guessing when the answer is neither', () => {
    expect(verdict(429, '{"error_code":"RESOURCE_EXHAUSTED","message":"Too many requests."}')).toBe(
      'unclear',
    );
    expect(verdict(500, 'gateway blew up')).toBe('unclear');
  });
});
