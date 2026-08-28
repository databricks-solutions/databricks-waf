// Rendered rather than reasoned about.
//
// The bar's whole job is proportion, and proportion lives in inline styles that typecheck
// perfectly while being wrong. These assertions are on the HTML the component actually
// produces, using the server renderer so no browser environment is needed.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoreBar } from './ScoreBar';

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

describe('the score bar', () => {
  it('fills to the floor that holds regardless, not to the score', () => {
    // Live reliability: scored 0 from 1 of 16 requirements, so the range is 0 to 92.3.
    // A bar filled to the score would show a full-width empty track and imply the whole
    // pillar had been measured and failed.
    const markup = html(<ScoreBar score={0} range={{ low: 0, high: 92.3 }} label="Reliability" />);

    expect(markup).toContain('width:0%');
    expect(markup).toContain('width:92.3%');
  });

  it('starts the unknown band where the certain part ends', () => {
    const markup = html(<ScoreBar score={100} range={{ low: 20.3, high: 100 }} label="Performance efficiency" />);

    expect(markup).toContain('width:20.3%');
    expect(markup).toContain('left:20.3%');
    // 100 - 20.3, so the band reaches the end of the track and no further.
    expect(markup).toContain('width:79.7%');
  });

  it('says what it means to a screen reader, which sees no stripes at all', () => {
    const markup = html(<ScoreBar score={50} range={{ low: 0.1, high: 99.9 }} label="Security" />);

    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain('Security');
    expect(markup).toContain('between 0.1 and 99.9');
  });

  it('draws no hatching when there is nothing unknown to show', () => {
    const markup = html(<ScoreBar score={76.1} range={{ low: 76.1, high: 76.1 }} label="Governance" />);

    expect(markup).toContain('width:76.1%');
    expect(markup).not.toContain('repeating-linear-gradient');
    // And says nothing about a range it does not have.
    expect(markup).not.toContain('between');
  });

  it('falls back to the score when no range was supplied at all', () => {
    const markup = html(<ScoreBar score={40} label="Cost" />);

    expect(markup).toContain('width:40%');
    expect(markup).not.toContain('repeating-linear-gradient');
  });

  it('never draws past the end of the track, whatever it is handed', () => {
    // A high below its own low would otherwise produce a negative width, which renders as
    // no band at all and silently hides the uncertainty it exists to show.
    const markup = html(<ScoreBar score={50} range={{ low: 60, high: 40 }} label="Odd" />);

    expect(markup).not.toContain('width:-');
  });
});
