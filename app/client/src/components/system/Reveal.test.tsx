import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Reveal } from './Reveal';

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

describe('Reveal', () => {
  it('renders its children with the reveal animation when motion is allowed', () => {
    const markup = html(
      <Reveal>
        <span>Ready</span>
      </Reveal>
    );
    expect(markup).toContain('Ready');
    expect(markup).toContain('wa-reveal');
  });

  it('passes an explicit delay to the animation', () => {
    const markup = html(
      <Reveal delay={120}>
        <span>Ready</span>
      </Reveal>
    );
    expect(markup).toContain('--wa-reveal-delay:120ms');
  });

  it('renders the final state with no animation attributes under reduced motion', () => {
    stubReducedMotion(true);
    const markup = html(
      <Reveal delay={120}>
        <span>Ready</span>
      </Reveal>
    );
    expect(markup).toContain('Ready');
    expect(markup).not.toContain('wa-reveal');
    expect(markup).not.toContain('--wa-reveal-delay');
  });
});
