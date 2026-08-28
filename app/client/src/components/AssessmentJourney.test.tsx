import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssessmentJourney } from './AssessmentJourney';
import { assessmentStageState, type AssessmentStage } from './assessment-journey';

describe('the four-stage assessment journey', () => {
  it('makes review current only after prepare and collect are complete', () => {
    expect(assessmentStageState('prepare', 'review')).toBe('complete');
    expect(assessmentStageState('collect', 'review')).toBe('complete');
    expect(assessmentStageState('review', 'review')).toBe('current');
    expect(assessmentStageState('publish', 'review')).toBe('upcoming');
  });

  it('marks every stage complete only after the result exists', () => {
    expect(
      ['prepare', 'collect', 'review', 'publish'].map((stage) =>
        assessmentStageState(stage as AssessmentStage, 'publish', true)
      )
    ).toEqual(['complete', 'complete', 'complete', 'complete']);
  });

  it('exposes the current stage and all four labels without relying on colour', () => {
    const markup = renderToStaticMarkup(<AssessmentJourney current="review" detail="3 of 7 pillars have a record." />);
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain('Prepare');
    expect(markup).toContain('Collect');
    expect(markup).toContain('Review');
    expect(markup).toContain('Publish');
    expect(markup).toContain('3 of 7 pillars have a record.');
  });
});
