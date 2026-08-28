// Whether the welcome is interposed, and what happens when the browser will not remember.
//
// The denied-storage case is the whole reason this has a test. The app is embedded, storage can be
// refused outright, and the naive reading of a refused read is "not oriented" — which redirects to the
// welcome, records nothing, and redirects again on the next navigation. That is not a degraded
// welcome, it is an app the reader cannot get past, and it would only appear in an embedding nobody
// developing it uses.
//
// The two functions rather than the hook, on the same grounds as api/hooks.test.ts: the decision is
// what is worth asserting, and asserting it through a renderer would mean a DOM library in the
// dependency tree to prove that `useState` returns what it was initialised with.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOriented, writeOriented } from './oriented';

const KEY = 'wa-oriented';

/** A working store, since the node environment these tests run in has none. */
function stubStorage(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => held.set(key, value),
  });
  return held;
}

/** One that refuses, which is what an embedding context with storage access denied looks like. */
function stubDeniedStorage() {
  const denied = () => {
    throw new Error('The embedding context denied storage.');
  };
  vi.stubGlobal('localStorage', { getItem: denied, setItem: denied });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readOriented', () => {
  it('interposes the welcome on a browser that has not seen it', () => {
    stubStorage();

    expect(readOriented()).toBe(false);
  });

  it('does not interpose it again once it has been read', () => {
    stubStorage({ [KEY]: 'true' });

    expect(readOriented()).toBe(true);
  });

  it('counts a browser that refuses to remember as oriented, rather than looping', () => {
    stubDeniedStorage();

    expect(readOriented()).toBe(true);
  });

  it('treats any other stored value as unseen, rather than as truthy', () => {
    // A stale key from an earlier shape of this preference must not silently mean "read it".
    stubStorage({ [KEY]: 'yes' });

    expect(readOriented()).toBe(false);
  });
});

describe('writeOriented', () => {
  it('remembers it for the next visit', () => {
    const held = stubStorage();

    writeOriented();

    expect(held.get(KEY)).toBe('true');
    expect(readOriented()).toBe(true);
  });

  it('does not throw where the write is refused', () => {
    stubDeniedStorage();

    expect(() => {
      writeOriented();
    }).not.toThrow();
  });
});
