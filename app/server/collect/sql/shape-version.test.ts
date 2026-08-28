import { describe, expect, it } from 'vitest';
import { FileQuerySource } from './queries.js';
import { SHAPE_STATEMENT, shapeFingerprintVersion } from './shape-version.js';

describe('the version a retained plan is filed under', () => {
  it('reads the same version from the same statement', () => {
    const statement = 'select substr(sha2(lower(t), 256), 1, 16) as shape from windows';

    expect(shapeFingerprintVersion(statement)).toBe(shapeFingerprintVersion(statement));
  });

  it('reads a different version where the normalisation changed', () => {
    // The case the field exists for. Every shape in the estate takes a new value here, and the plans
    // retained under the old one describe queries that no longer carry that identity.
    const before = shapeFingerprintVersion('select substr(sha2(lower(t), 256), 1, 16) as shape');
    const after = shapeFingerprintVersion('select substr(sha2(lower(trim(t)), 256), 1, 16) as shape');

    expect(after).not.toBe(before);
  });

  it('reads a different version where only the truncation changed', () => {
    // 16 hex characters and 32 are different identities over the same normalisation, and a version that
    // looked only at the regular expressions would call them the same.
    const short = shapeFingerprintVersion('select substr(sha2(lower(t), 256), 1, 16) as shape');
    const long = shapeFingerprintVersion('select substr(sha2(lower(t), 256), 1, 32) as shape');

    expect(long).not.toBe(short);
  });

  it('reads a different version where the change cannot affect a shape', () => {
    // Stated rather than left to be discovered. The digest covers the whole statement, so a comment or a
    // new column mints a version and discards a trend window that was still valid. The header says why
    // that is the trade taken: the alternative changes this statement's text, which is fingerprinted by
    // the runtime baseline, and re-establishing that needs a warehouse.
    const before = shapeFingerprintVersion('select substr(sha2(lower(t), 256), 1, 16) as shape');
    const after = shapeFingerprintVersion('-- a comment\nselect substr(sha2(lower(t), 256), 1, 16) as shape');

    expect(after).not.toBe(before);
  });

  it('refuses an empty statement rather than inventing a version', () => {
    // No fallback anywhere: a version that defaulted would be indistinguishable from a real one at the
    // point two of them are compared, which is the only point either is read.
    expect(() => shapeFingerprintVersion('   \n ')).toThrow(/cannot be filed without it/);
  });

  it('reads a version off the statement that ships', () => {
    const version = shapeFingerprintVersion(new FileQuerySource().text(SHAPE_STATEMENT));

    expect(version).toMatch(/^shape-[0-9a-f]{8}$/);
  });
});
