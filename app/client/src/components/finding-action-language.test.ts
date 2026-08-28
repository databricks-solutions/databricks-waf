import { describe, expect, it } from 'vitest';
import { findingActionReason } from './finding-action-language';

describe('the finding action reason', () => {
  it('keeps one evidence-bounded sentence in the decision surface', () => {
    expect(
      findingActionReason(
        'Every table examined keeps seven days of history. The complete qualification belongs with the evidence.',
        'A catalogue rationale that should not replace the observed result.'
      )
    ).toBe('Every table examined keeps seven days of history.');
  });

  it('does not split a Delta property name', () => {
    expect(
      findingActionReason(
        'delta.logRetentionDuration is longer than the files can support. Review the implementation detail.',
        undefined
      )
    ).toBe('delta.logRetentionDuration is longer than the files can support.');
  });

  it('falls back to the requirement rationale and then the honest default', () => {
    expect(findingActionReason(undefined, 'This requirement has no observed outcome reason yet. More detail.')).toBe(
      'This requirement has no observed outcome reason yet.'
    );
    expect(findingActionReason(undefined, undefined)).toBe('The published report does not meet this requirement.');
  });
});
