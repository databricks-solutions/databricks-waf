// The specialist pages read the selected assessment's advisory. This wire contract keeps the run
// that fills them in the same record set; otherwise the warehouse work succeeds and the pages keep
// saying that no analysis has run.

import { describe, expect, it } from 'vitest';
import { advisoryBody } from './hooks';

describe('the body an advisory run is started with', () => {
  it('names the selected assessment in the field the server resolves', () => {
    expect(advisoryBody('def-1')).toEqual({ definitionId: 'def-1' });
    expect(Object.keys(advisoryBody('def-1'))).toEqual(['definitionId']);
  });

  it('keeps the deliberate no-assessment choice unscoped', () => {
    expect(advisoryBody(null)).toEqual({});
  });

  it('does not invent an assessment while definitions are loading', () => {
    expect(advisoryBody(undefined)).toEqual({});
  });
});
