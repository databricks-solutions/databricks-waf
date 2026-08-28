import { describe, expect, it } from 'vitest';
import { withAssessment } from './assessment-id';

describe('withAssessment', () => {
  it('asks for nothing while definitions are still loading', () => {
    expect(withAssessment('/api/scans/latest', undefined)).toBeNull();
  });

  it('omits the parameter for the unscoped view', () => {
    expect(withAssessment('/api/scans/latest', null)).toBe('/api/scans/latest');
  });

  it('names the definition when one is selected', () => {
    expect(withAssessment('/api/scans/latest', 'def-1')).toBe('/api/scans/latest?definitionId=def-1');
  });

  it('appends to a path that already has a query', () => {
    expect(withAssessment('/api/notes/control/DG-1?observedIn=scan-1', 'def-1')).toBe(
      '/api/notes/control/DG-1?observedIn=scan-1&definitionId=def-1'
    );
  });
});
