import { describe, expect, it, vi } from 'vitest';
import { CollectionScheduler } from '../../scan/scheduler.js';
import type { CloudCredentials, CredentialProvider } from '../credentials.js';
import type { CollectorContext } from '../signal.js';
import { CloudCollector, VOLUME_SIGNAL } from './collector.js';

function credentials(cloud: CloudCredentials | null): CredentialProvider {
  return {
    mode: 'on-behalf-of-user',
    databricks: () => Promise.reject(new Error('not called')),
    cloud: () => Promise.resolve(cloud),
  };
}

function context(cloud: CloudCredentials | null, collected: CollectorContext['collected'] = new Map()): CollectorContext {
  return {
    credentials: credentials(cloud),
    scheduler: new CollectionScheduler({ limits: { cloud: { concurrency: 1, budget: 10 } } }),
    collected,
  };
}

const keys: CloudCredentials = {
  provider: 'aws',
  expiresAt: new Date('2026-08-19T12:00:00.000Z'),
  aws: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret', sessionToken: 'session' },
};

describe('the cloud collector', () => {
  it('reports the volume unmeasurable when no service credential is configured, and does not call the reader', async () => {
    const readVolume = vi.fn();
    const collector = new CloudCollector({ readVolume });
    const [reading] = await collector.collect([VOLUME_SIGNAL], context(null));
    expect(reading?.status).toBe('unmeasurable');
    expect(reading?.unmeasurableReason).toContain('No Unity Catalog service credential is configured');
    expect(readVolume).not.toHaveBeenCalled();
    expect(collector.spent().calls).toBe(0);
  });

  it('reports the volume when keys were vended and the reader answered', async () => {
    const collector = new CloudCollector({
      readVolume: (given) => {
        expect(given.provider).toBe('aws');
        return Promise.resolve({ provider: 'aws', billedBytes: 4096, locations: 2 });
      },
    });
    const [reading] = await collector.collect([VOLUME_SIGNAL], context(keys));
    expect(reading).toMatchObject({
      id: VOLUME_SIGNAL,
      status: 'observed',
      value: { provider: 'aws', billedBytes: 4096, locations: 2 },
    });
    expect(collector.spent().calls).toBe(1);
  });

  it('does not fail the scan when the reader throws — the bill is unmeasurable, not a finding', async () => {
    const collector = new CloudCollector({
      readVolume: () => Promise.reject(new Error('AccessDenied')),
    });
    const [reading] = await collector.collect([VOLUME_SIGNAL], context(keys));
    expect(reading?.status).toBe('unmeasurable');
    expect(reading?.unmeasurableReason).toContain('AccessDenied');
  });

  it('skips a volume already on the record, so a resume does not re-read the bill', async () => {
    const readVolume = vi.fn();
    const collector = new CloudCollector({ readVolume });
    const already = {
      id: VOLUME_SIGNAL,
      status: 'unmeasurable' as const,
      coverage: { mode: 'complete' as const },
      unmeasurableReason: 'earlier',
      collectedAt: new Date(),
      durationMs: 0,
    };
    const results = await collector.collect([VOLUME_SIGNAL], context(keys, new Map([[VOLUME_SIGNAL, already]])));
    expect(results).toEqual([]);
    expect(readVolume).not.toHaveBeenCalled();
  });
});
