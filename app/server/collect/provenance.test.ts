// Attribution, tested where it can be got wrong.
//
// Two behaviours carry the weight. A place is named only when one was supplied, because the field's
// only value is that it can be checked and a plausible default cannot. And a collector that read
// under an authority the scan is not running as keeps its own attribution, because that collector —
// the cloud one, reading object storage with a Unity Catalog service credential — is the reason this
// is per-reading rather than per-scan in the first place.

import { describe, expect, it } from 'vitest';
import { attributed, locate, type Provenance } from './provenance.js';
import { COMPLETE, observed, type SignalId } from './signal.js';

const SCAN: Provenance = {
  surface: 'sql',
  collector: 'system-tables',
  authority: 'on-behalf-of-user',
  actor: 'someone@example.com',
};

describe('where a surface reads from', () => {
  it('names the warehouse for both surfaces that run statements on one', () => {
    expect(locate('sql', { warehouse: 'abc123' })).toBe('warehouse abc123');
    expect(locate('describe', { warehouse: 'abc123' })).toBe('warehouse abc123');
  });

  it('names the workspace for the surface that calls it', () => {
    expect(locate('rest', { host: 'https://example.cloud.databricks.com' })).toBe(
      'https://example.cloud.databricks.com'
    );
  });

  it('says nothing rather than guessing, where nothing was supplied', () => {
    // A build with no warehouse bound, and the cloud surface, whose bucket only its own collector
    // knows. Both have to come back absent: a reader told a number came from somewhere it did not
    // will check the wrong thing and conclude the app is wrong about more than the place.
    expect(locate('sql', {})).toBeUndefined();
    expect(locate('cloud', { warehouse: 'abc123', host: 'https://example.cloud.databricks.com' })).toBeUndefined();
  });
});

describe('attributing a reading', () => {
  const id = 'sql:uc.census' as SignalId;

  it('stamps one that carries nothing', () => {
    expect(attributed(observed(id, {}, 1, COMPLETE), SCAN).provenance).toEqual(SCAN);
  });

  it('leaves one that recorded its own, which is how a second authority survives', () => {
    const vended: Provenance = {
      surface: 'cloud',
      collector: 'storage-volume',
      authority: 'service-credential',
      actor: 'prod-storage-reader',
      from: 's3://acme-lakehouse',
    };
    const result = { ...observed(id, {}, 1, COMPLETE), provenance: vended };

    expect(attributed(result, SCAN).provenance).toEqual(vended);
  });
});
