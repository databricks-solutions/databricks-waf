import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlainSummary } from './PlainSummary';

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

describe('PlainSummary', () => {
  it('leads with the plain status, then its meaning, then the next step', () => {
    const markup = html(
      <PlainSummary
        status="Most checks passed."
        meaning="A few need your confirmation."
        nextAction={<a href="/review">Open review</a>}
      />
    );

    expect(markup.indexOf('Most checks passed.')).toBeLessThan(markup.indexOf('A few need your confirmation.'));
    expect(markup.indexOf('A few need your confirmation.')).toBeLessThan(markup.indexOf('Open review'));
    expect(markup).toContain('wa-plain-summary');
  });

  it('defaults to a neutral tone that spends no verdict colour', () => {
    expect(html(<PlainSummary status="Nothing to report." />)).toContain('data-tone="neutral"');
  });

  it('carries a status tone without relying on colour alone to say it', () => {
    const markup = html(<PlainSummary status="Two checks failed." tone="danger" />);
    expect(markup).toContain('data-tone="danger"');
    // The status is a word a reader can read, not only an edge colour.
    expect(markup).toContain('Two checks failed.');
  });

  it('omits the action region when there is no next step', () => {
    expect(html(<PlainSummary status="All clear." />)).not.toContain('wa-plain-summary-action');
  });
});
