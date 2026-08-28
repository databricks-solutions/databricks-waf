import type { ScanStamp } from './api/types';

export type MethodologyStamp = Pick<ScanStamp, 'publicMethodology' | 'catalogueVersion'>;

/** Public identity in a compact customer-facing form. */
export function methodologyLabel(stamp: MethodologyStamp): string {
  const methodology = stamp.publicMethodology;
  if (methodology == null) return 'Pre-release development';
  return `Methodology Version ${String(methodology.publicVersion)}${methodology.state === 'candidate' ? ' candidate' : ''}`;
}

/** Public identity followed by explicitly technical provenance. */
export function methodologyProvenance(stamp: MethodologyStamp): string {
  return `${methodologyLabel(stamp)} · catalogue revision ${stamp.catalogueVersion}`;
}
