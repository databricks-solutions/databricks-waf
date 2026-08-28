// Whether this reader has met the app before.
//
// In the browser, deliberately, and not in the database beside the definitions.
//
// The alternative was a per-user row on the server, which would survive a new laptop. It was rejected
// on what it would be: a durable record of what a named person has and has not read, kept forever,
// read by nothing except a redirect. That is a claim about somebody rather than about the estate, and
// this app already asks its operators to trust it with a service principal against production — the
// less it remembers about them the easier that is to grant. The cost of getting it wrong the other
// way is one dismissal on a new browser.
//
// Which also decides the failure mode. Storage can be denied outright by the embedding context, and
// a reader whose browser refuses it must not be shown the welcome on every navigation for the rest of
// the session — so a denied read counts as oriented and the in-memory state carries the session. The
// welcome is worth interposing once; it is not worth a loop.

import { useCallback, useState } from 'react';

const ORIENTED_KEY = 'wa-oriented';

/**
 * Whether this browser has seen the welcome.
 *
 * Read once, at mount, by the hook below. A value written by another tab is not worth a storage
 * listener: the welcome is interposed on arrival, and arriving is a mount.
 *
 * Exported so it can be tested without a DOM renderer, which is how the rest of the client's hook
 * logic is held — see api/hooks.test.ts.
 */
export function readOriented(): boolean {
  try {
    return localStorage.getItem(ORIENTED_KEY) === 'true';
  } catch {
    // Denied, so nothing can be remembered — and a welcome that cannot be dismissed is worse than a
    // welcome nobody saw.
    return true;
  }
}

/** Records it. Returns whether the record will survive the tab, which the caller does not need. */
export function writeOriented(): void {
  try {
    localStorage.setItem(ORIENTED_KEY, 'true');
  } catch {
    /* Denied. The session still knows, and that is enough to not show it again. */
  }
}

export interface Oriented {
  /** True when the welcome has been read or waved off, and the app should open on the assessment. */
  readonly oriented: boolean;
  /** Records it. Idempotent, and safe to call from a handler that also navigates. */
  readonly remember: () => void;
}

export function useOriented(): Oriented {
  const [oriented, setOriented] = useState(readOriented);

  const remember = useCallback(() => {
    // State first, so the redirect stops even where the write throws.
    setOriented(true);
    writeOriented();
  }, []);

  return { oriented, remember };
}
