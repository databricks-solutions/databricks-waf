import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  applyTheme,
  prefersDark,
  readPreference,
  resolve,
  storePreference,
  watchSystemTheme,
  type ThemePreference,
} from '@/lib/theme';

const OPTIONS: readonly { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

/**
 * Three explicit choices rather than a two-state switch, because a switch cannot express
 * "follow the workspace", which is the right default inside a host that has its own theme.
 */
export function ThemeToggle() {
  // Initialised from storage, not from a default, so the first render agrees with what the
  // boot script already painted. Defaulting to light here would flip the control's selected
  // state for a dark user until an effect corrected it.
  const [preference, setPreference] = useState<ThemePreference>(() =>
    typeof window === 'undefined' ? 'system' : readPreference(window.localStorage)
  );

  const choose = useCallback((next: ThemePreference) => {
    setPreference(next);
    storePreference(next);
    applyTheme(document.documentElement, resolve(next, prefersDark()));
  }, []);

  // Only reacts while following the system. Under an explicit choice the listener still fires
  // but re-resolves to the same answer, so the branch is left to resolve() rather than
  // conditionally subscribing.
  useEffect(
    () =>
      watchSystemTheme((dark) => {
        applyTheme(document.documentElement, resolve(preference, dark));
      }),
    [preference]
  );

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex items-center gap-0.5 rounded-sm border border-wa-border p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => choose(value)}
            className={`grid h-6 w-7 place-items-center rounded-xs ${
              selected ? 'bg-wa-selection text-wa-text' : 'text-wa-text-muted hover:text-wa-text'
            }`}
          >
            <Icon aria-hidden className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
