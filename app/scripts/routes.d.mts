export interface DeclaredRoute {
  readonly path: string;
  readonly component: string;
}

export const ROUTER: string;

export function routerSource(): string;
export function declaredRoutes(source: string): DeclaredRoute[];
export function developmentOnlyRoutes(source: string): DeclaredRoute[];
export function productionRoutes(source: string): DeclaredRoute[];
export function isParameterised(path: string): boolean;
export function routeScreenshotName(path: string): string;
export function screenshotNameProblems(paths: readonly string[]): string[];
export function routePattern(path: string): RegExp;
export function coverageProblems(
  swept: Iterable<string | { readonly path: string }>,
  options?: {
    readonly exempt?: Map<string, string>;
    readonly what?: string;
    readonly routes?: readonly DeclaredRoute[];
  }
): string[];
