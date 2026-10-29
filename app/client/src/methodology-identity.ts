import type { ScanStamp } from './api/types';
import { INTERIM_VERSION_1_LABEL, isInterimVersionOne } from '../../shared/api/methodology-interim';

export type MethodologyStamp = Pick<ScanStamp, 'publicMethodology' | 'catalogueVersion'>;

/** Public identity in a compact customer-facing form. */
export function methodologyLabel(stamp: MethodologyStamp): string {
  const methodology = stamp.publicMethodology;
  if (methodology == null) return 'Pre-release development';
  // Named on the stored stamp's own digest and never by rewriting it: the stamp still says what it
  // recorded, and this says what that digest is.
  if (isInterimVersionOne(methodology)) {
    return `Methodology Version 1 (${INTERIM_VERSION_1_LABEL})`;
  }
  return `Methodology Version ${String(methodology.publicVersion)}${methodology.state === 'candidate' ? ' candidate' : ''}`;
}

/** Public identity followed by explicitly technical provenance. */
export function methodologyProvenance(stamp: MethodologyStamp): string {
  return `${methodologyLabel(stamp)} · catalogue revision ${stamp.catalogueVersion}`;
}
