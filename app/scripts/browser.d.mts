/**
 * Types for browser.mjs, which is JavaScript so it can run from the CLI unbuilt.
 *
 * The declaration covers only exports imported by TypeScript. The sweeps remain `.mjs`; add another
 * shape when a typed caller begins to depend on it rather than speculating about the whole driver.
 */

export interface BrowserPage {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  resize(width: number, height: number): Promise<void>;
  prefer(theme: string): Promise<void>;
  goto(url: string, options?: { ceiling?: number }): Promise<Verdict>;
  evaluate(source: string): Promise<unknown>;
  screenshot(): Promise<Buffer>;
  close(): void;
}

/** Starts one isolated headless Chrome page at the requested viewport. */
export function open(options?: { width?: number; height?: number }): Promise<BrowserPage>;

/** Throws when the shell has no `TOKEN`, with the recipe for getting one. */
export function requireIdentity(): void;

/** Throws when `origin` serves no scan, or serves nothing at all. */
export function requireScan(origin: string): Promise<void>;

/** The measured ceiling for routes that wait on the seven topology statements. */
export const INVESTIGATE_REST_CEILING_MS: number;

/** Returns the measured topology ceiling for a route that needs it. */
export function routeRestCeiling(path: string): number | undefined;

/** The network state held while one browser page is being measured. */
export interface NetworkState {
  readonly outstanding: Map<string, unknown>;
  lastAnswered: number;
}

/** Applies a Chrome network event, clearing the preceding document at a main-frame navigation. */
export function applyNetworkEvent(
  state: NetworkState,
  frame: { method?: string; params?: Record<string, unknown> },
  options?: { mainFrameId?: string; now?: number }
): void;

/** One reading of a page, as `quiesce` takes them while waiting for it to come to rest. */
export interface Reading {
  /** Milliseconds since the wait began. */
  readonly at: number;
  /** The customer document geometry and record counts, as one comparable string. */
  readonly shape: string;
  /** Requests the page has out and has not been answered. */
  readonly working: number;
  /** Milliseconds since the last response arrived, infinite before the first. */
  readonly sinceAnswer: number;
}

/** What a wait concluded, and how long it took to conclude it. */
export interface Verdict {
  readonly settled: boolean;
  readonly waited: number;
  readonly reason: string;
}

/**
 * Whether a page has come to rest, or null while the answer is "keep watching".
 *
 * Declared here because it is the part of `quiesce` a test holds — see browser-rest.test.ts.
 */
export function restVerdict(
  readings: readonly Reading[],
  options?: { agree?: number; afterAnswer?: number; ceiling?: number }
): Verdict | null;
