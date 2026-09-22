import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageTransition } from './PageTransition';

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({
      matches: reduced,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('PageTransition', () => {
  it('fades its children in when motion is allowed', () => {
    const markup = html(
      <PageTransition>
        <p>Body</p>
      </PageTransition>
    );
    expect(markup).toContain('Body');
    expect(markup).toContain('wa-page-transition');
    expect(markup).toContain('wa-reveal');
  });

  it('renders the final state with no animation under reduced motion', () => {
    stubReducedMotion(true);
    const markup = html(
      <PageTransition>
        <p>Body</p>
      </PageTransition>
    );
    expect(markup).toContain('Body');
    expect(markup).toContain('wa-page-transition');
    expect(markup).not.toContain('wa-reveal');
  });
});
