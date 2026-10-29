import { describe, expect, it } from 'vitest';
import {
  INTERIM_VERSION_1_DIGEST,
  INTERIM_VERSION_1_LABEL,
  isInterimVersionOne,
  methodologyVersionName,
} from './methodology-interim.js';

describe('the unreleased interim variant of Version 1', () => {
  it('is recognised by its digest on a Version 1 record', () => {
    expect(INTERIM_VERSION_1_DIGEST).toBe('sha256:3ffb685e36d092c91f52a93a172c1db7e32a2ec5f88f3efdab361390eb0dd71f');
    expect(isInterimVersionOne({ publicVersion: 1, manifestDigest: INTERIM_VERSION_1_DIGEST })).toBe(true);
  });

  it('is not recognised on another version, another digest or no record', () => {
    expect(isInterimVersionOne({ publicVersion: 2, manifestDigest: INTERIM_VERSION_1_DIGEST })).toBe(false);
    expect(isInterimVersionOne({ publicVersion: 1, manifestDigest: 'sha256:other' })).toBe(false);
    expect(isInterimVersionOne(undefined)).toBe(false);
  });

  it('names a version by number, and the interim variant by its label', () => {
    expect(INTERIM_VERSION_1_LABEL).toBe('unreleased interim variant of Version 1');
    expect(methodologyVersionName({ publicVersion: 2, manifestDigest: 'sha256:two' })).toBe('Version 2');
    expect(methodologyVersionName({ publicVersion: 1, manifestDigest: INTERIM_VERSION_1_DIGEST })).toBe(
      INTERIM_VERSION_1_LABEL
    );
  });
});
