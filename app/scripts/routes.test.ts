import { describe, expect, it } from 'vitest';
import {
  coverageProblems,
  declaredRoutes,
  developmentOnlyRoutes,
  productionRoutes,
  routeScreenshotName,
  routerSource,
  screenshotNameProblems,
} from './routes.mjs';

describe('the routes a served production drive is allowed to count', () => {
  it('excludes every route behind the development-only router guards', () => {
    const source = routerSource();
    const development = developmentOnlyRoutes(source).map(({ path }) => path);
    const production = productionRoutes(source).map(({ path }) => path);

    expect(development).toContain('/design-system');
    expect(development).toContain('/preview/acceptance');
    expect(development.some((path) => path.startsWith('/preview/'))).toBe(true);
    expect(production).toContain('/overview');
    expect(production).not.toContain('/prototype');
    expect(production).not.toContain('/design-system');
    expect(production).not.toContain('/preview/acceptance');
    expect(production.some((path) => path.startsWith('/preview/'))).toBe(false);
    expect(declaredRoutes(source).length).toBe(production.length + development.length);
  });

  it('lets a production check prove production coverage without claiming development previews', () => {
    const routes = productionRoutes(routerSource());
    expect(
      coverageProblems(['/overview'], {
        routes: routes.filter(({ path }) => path === '/overview'),
        what: 'tested',
      })
    ).toEqual([]);
  });

  it('gives every production route a distinct diagnostic screenshot', () => {
    const paths = productionRoutes(routerSource()).map(({ path }) => path);

    expect(routeScreenshotName('/')).toBe('landing');
    expect(routeScreenshotName('/overview')).toBe('overview');
    expect(screenshotNameProblems(paths)).toEqual([]);
    expect(screenshotNameProblems(['/', '/landing'])).toEqual(['/, /landing all write landing.png.']);
  });
});
