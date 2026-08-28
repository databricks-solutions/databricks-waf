// The first collector on the `cloud` surface: the object-storage bill.
//
// Phase 7a (tier three). `CO-03-05` already reports active bytes from the Delta log
// sample, and its own criteria say the cloud-side bill is larger than that number.
// This is the reading that closes the gap — Storage Lens or CloudWatch, mapped to
// the estate's external locations — and it is off unless the install named a Unity
// Catalog service credential. Absence is not a fail: twelve controls that need
// cloud APIs degrade to unmeasurable rather than inventing a bill.
//
// Labs has no service credential (measured 2026-08-19: one Databricks-managed
// storage credential, purpose STORAGE, and nothing with purpose SERVICE), so the
// path this collector takes there is the unmeasurable one. The Storage Lens path
// is reached only when `credentials.cloud()` returns keys, which is a configuration
// this app does not require.

import type { Surface } from '../../scan/surfaces.js';
import type { Collector, CollectorContext, CollectorSpend, SignalId, SignalResult } from '../signal.js';
import { COMPLETE, observed, unmeasurable } from '../signal.js';
import type { CloudCredentials } from '../credentials.js';

export const VOLUME_SIGNAL = 'cloud:storage.volume' as const;

export const CLOUD_SIGNALS: readonly SignalId[] = [VOLUME_SIGNAL];

export interface CloudVolume {
  readonly provider: CloudCredentials['provider'];
  /** Bytes the cloud billed for the mapped locations. Not Delta active bytes. */
  readonly billedBytes: number;
  readonly locations: number;
}

export type VolumeReader = (credentials: CloudCredentials) => Promise<CloudVolume>;

export interface CloudCollectorOptions {
  /**
   * How the bill is read once keys have been vended. Injected so a test can cover
   * the observed path without calling AWS, and so a later Storage Lens implementation
   * replaces this without touching the disable path.
   */
  readonly readVolume?: VolumeReader;
}

export class CloudCollector implements Collector {
  readonly surface: Surface = 'cloud';
  readonly name = 'object-storage';
  readonly signals: readonly SignalId[] = CLOUD_SIGNALS;

  private calls = 0;

  constructor(private readonly options: CloudCollectorOptions = {}) {}

  spent(): CollectorSpend {
    return { surface: this.surface, name: this.name, calls: this.calls };
  }

  async collect(ids: readonly SignalId[], context: CollectorContext): Promise<SignalResult[]> {
    const results: SignalResult[] = [];
    for (const id of ids) {
      if (id !== VOLUME_SIGNAL) {
        results.push(unmeasurable(id, `No cloud collector is implemented for ${id}.`));
        continue;
      }
      if (context.collected.has(id)) continue;
      const result = await this.volume(context);
      results.push(result);
      await context.settled?.(result);
    }
    return results;
  }

  private async volume(context: CollectorContext): Promise<SignalResult> {
    const credentials = await context.credentials.cloud();
    if (credentials == null) {
      return unmeasurable(
        VOLUME_SIGNAL,
        'No Unity Catalog service credential is configured, so the cloud-side bill is not read. ' +
          'The Delta-log sample still reports active bytes.'
      );
    }
    const read = this.options.readVolume;
    if (read == null) {
      return unmeasurable(
        VOLUME_SIGNAL,
        'A service credential is configured but this build has no Storage Lens or CloudWatch reader yet, ' +
          'so the cloud-side bill is not read.'
      );
    }
    this.calls += 1;
    const started = Date.now();
    try {
      const volume = await read(credentials);
      return observed(VOLUME_SIGNAL, volume, Date.now() - started, COMPLETE);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'the cloud reader failed';
      return unmeasurable(VOLUME_SIGNAL, `The cloud-side bill could not be read: ${reason}.`);
    }
  }
}
