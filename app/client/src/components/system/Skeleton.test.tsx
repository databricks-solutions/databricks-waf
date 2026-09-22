import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Skeleton } from './Skeleton';

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

describe('Skeleton', () => {
  it('reserves its space and hides from assistive technology by default', () => {
    const markup = html(<Skeleton width={120} height={16} />);
    expect(markup).toContain('wa-skeleton');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('width:120px');
    expect(markup).toContain('height:16px');
  });

  it('shows the loading sheen when motion is allowed', () => {
    expect(html(<Skeleton width={80} height={12} />)).toContain('wa-skeleton-sheen');
  });

  it('drops the sheen under reduced motion', () => {
    stubReducedMotion(true);
    const markup = html(<Skeleton width={80} height={12} />);
    expect(markup).toContain('wa-skeleton');
    expect(markup).not.toContain('wa-skeleton-sheen');
  });

  it('announces itself as a status when given a label', () => {
    const markup = html(<Skeleton width={80} height={12} label="Loading scans" />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Loading scans"');
    expect(markup).not.toContain('aria-hidden');
  });
});
