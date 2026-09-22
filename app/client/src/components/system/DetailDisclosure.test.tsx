import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DetailDisclosure } from './DetailDisclosure';

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

describe('DetailDisclosure', () => {
  it('is a collapsed native disclosure labelled for technical detail', () => {
    const markup = html(
      <DetailDisclosure>
        <p>Raw evidence</p>
      </DetailDisclosure>
    );

    expect(markup).toContain('<details');
    expect(markup).not.toContain('open=');
    expect(markup).toContain('Show technical detail');
    expect(markup).toContain('Raw evidence');
  });

  it('appends a hint to the label', () => {
    const markup = html(
      <DetailDisclosure hint="3 tables">
        <p>x</p>
      </DetailDisclosure>
    );
    expect(markup).toContain('Show technical detail (3 tables)');
  });

  it('can be opened for a detail-first context', () => {
    const markup = html(
      <DetailDisclosure open>
        <p>x</p>
      </DetailDisclosure>
    );
    expect(markup).toContain('open=');
  });

  it('takes a custom label', () => {
    const markup = html(
      <DetailDisclosure label="Show the raw readings">
        <p>x</p>
      </DetailDisclosure>
    );
    expect(markup).toContain('Show the raw readings');
  });
});
