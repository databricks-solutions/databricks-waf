import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountUp } from './CountUp';

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

describe('CountUp', () => {
  it('shows the final value with no count under reduced motion', () => {
    stubReducedMotion(true);
    const markup = html(<CountUp value={72} />);
    expect(markup).toContain('>72<');
    expect(markup).toContain('data-countup-value="72"');
  });

  it('always carries the destination value in the markup and labels it', () => {
    const markup = html(<CountUp value={94} from={0} />);
    expect(markup).toContain('data-countup-value="94"');
    expect(markup).toContain('aria-label="94"');
    expect(markup).toContain('wa-numeric');
  });

  it('formats the value when a formatter is given', () => {
    stubReducedMotion(true);
    const markup = html(<CountUp value={41.2} format={(n) => `${n.toFixed(1)}%`} />);
    expect(markup).toContain('41.2%');
  });
});
