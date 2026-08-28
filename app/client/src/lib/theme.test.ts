import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyTheme, isThemePreference, readPreference, resolve, THEME_KEY } from './theme';

// applyTheme takes the three-property surface it writes to rather than an HTMLElement, so this
// is a real argument and not a cast.
function stubRoot() {
  const classes = new Set<string>();
  return {
    dataset: {} as Record<string, string | undefined>,
    classList: {
      toggle(name: string, on: boolean) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      has: (name: string) => classes.has(name),
    },
    style: { colorScheme: '' },
  };
}

function apply(resolved: 'light' | 'dark') {
  const root = stubRoot();
  applyTheme(root, resolved);
  return root;
}

const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');

describe('resolve', () => {
  it('follows the operating system under the system preference', () => {
    expect(resolve('system', true)).toBe('dark');
    expect(resolve('system', false)).toBe('light');
  });

  it('ignores the operating system under an explicit preference', () => {
    expect(resolve('dark', false)).toBe('dark');
    expect(resolve('light', true)).toBe('light');
  });
});

describe('readPreference', () => {
  it('reads a stored preference', () => {
    expect(readPreference({ getItem: () => 'dark' })).toBe('dark');
  });

  it('falls back to system when nothing is stored', () => {
    expect(readPreference({ getItem: () => null })).toBe('system');
  });

  it('falls back to system rather than trusting an unrecognised value', () => {
    expect(readPreference({ getItem: () => 'solarized' })).toBe('system');
  });

  it('survives storage that throws instead of answering', () => {
    expect(
      readPreference({
        getItem: () => {
          throw new Error('access denied');
        },
      })
    ).toBe('system');
  });
});

describe('applyTheme', () => {
  it('writes all three signals for dark, since three consumers read it differently', () => {
    const root = apply('dark');
    expect(root.dataset['theme']).toBe('dark');
    expect(root.classList.has('dark')).toBe(true);
    expect(root.classList.has('light')).toBe(false);
    expect(root.style.colorScheme).toBe('dark');
  });

  it('removes the dark class when switching to light, not merely adding light', () => {
    const root = stubRoot();
    applyTheme(root, 'dark');
    applyTheme(root, 'light');
    expect(root.classList.has('dark')).toBe(false);
    expect(root.classList.has('light')).toBe(true);
    expect(root.style.colorScheme).toBe('light');
  });
});

describe('isThemePreference', () => {
  it('accepts the three preferences and nothing else', () => {
    expect(['light', 'dark', 'system'].every(isThemePreference)).toBe(true);
    expect(isThemePreference('auto')).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});

// The boot script in index.html duplicates this module's logic to run before first paint.
// Duplication is the point, so these assert the copy has not drifted; a mismatch would
// reintroduce exactly the flash the boot script exists to prevent, silently.
describe('the pre-paint boot script', () => {
  it('reads the same storage key this module writes', () => {
    expect(indexHtml).toContain(`'${THEME_KEY}'`);
  });

  it('sets all three signals applyTheme sets', () => {
    expect(indexHtml).toContain('root.dataset.theme = resolved');
    expect(indexHtml).toContain("classList.toggle('dark'");
    expect(indexHtml).toContain("classList.toggle('light'");
    expect(indexHtml).toContain('root.style.colorScheme = resolved');
  });

  it('resolves system mode against the same media query', () => {
    expect(indexHtml).toContain('(prefers-color-scheme: dark)');
  });

  it('is synchronous, since a deferred or module script runs after the first paint', () => {
    expect(indexHtml).toMatch(/<script>\s*\(function \(\) \{/u);
    expect(indexHtml).not.toMatch(/<script (?:defer|async|type="module")[^>]*>\s*\(function/u);
  });
});
