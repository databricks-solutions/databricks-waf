/**
 * Theme preference: light, dark, or follow the operating system.
 *
 * The storage key and the attribute writing are duplicated in the boot script in index.html,
 * which runs before first paint so an explicit choice does not flash the operating system's
 * theme first. `theme.test.ts` asserts the two agree, since a rename here that missed the
 * HTML would produce exactly the flash the boot script exists to prevent.
 */

export const THEME_KEY = 'wa-theme';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && PREFERENCES.includes(value as ThemePreference);
}

/** Resolves `system` against the operating system; light and dark pass through. */
export function resolve(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

export function readPreference(storage: Pick<Storage, 'getItem'>): ThemePreference {
  let stored: string | null = null;
  try {
    stored = storage.getItem(THEME_KEY);
  } catch {
    // Private-mode browsers throw on access rather than returning null. System is the answer.
    return 'system';
  }
  return isThemePreference(stored) ? stored : 'system';
}

/**
 * Exactly the three parts of an element this module writes to.
 *
 * Narrower than HTMLElement on purpose. It states the whole surface area of the side effect,
 * and it lets the behaviour be tested without a DOM — the alternative being a document stub
 * cast to HTMLElement, which asserts a lie to satisfy a signature that was never needed.
 */
export interface ThemeTarget {
  readonly dataset: Record<string, string | undefined>;
  readonly classList: { toggle: (token: string, force: boolean) => unknown };
  readonly style: { colorScheme: string };
}

/**
 * Writes the resolved theme onto the document root three ways because three consumers read it
 * differently: `data-theme` for wa-theme.css, the `dark`/`light` class for Tailwind's dark
 * variant and AppKit's own `.dark` selector, and color-scheme for native form controls and
 * scrollbars, which no stylesheet can reach.
 */
export function applyTheme(root: ThemeTarget, resolved: ResolvedTheme): void {
  root.dataset['theme'] = resolved;
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
  root.style.colorScheme = resolved;
}

export function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

export function storePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_KEY, preference);
  } catch {
    // A rejected write costs the choice on the next load, not this session's rendering.
  }
}

/**
 * Notifies when the operating system's theme changes. Only meaningful under the `system`
 * preference, but subscribing unconditionally keeps the caller free of that distinction.
 */
export function watchSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const query = window.matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent): void => {
    onChange(event.matches);
  };
  query.addEventListener('change', handler);
  return () => {
    query.removeEventListener('change', handler);
  };
}
