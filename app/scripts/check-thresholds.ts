#!/usr/bin/env -S npx tsx
// A declared threshold that no resolver reads is a sentence about a measurement that is not taken.
//
// Row 104: DG-01-02 and DG-01-03 still declared pass_share: 1 after E1b removed the measurement
// those numbers judged, and PE-03-15 declared max_days_since_analyze: 90 that no branch compared
// against. The criteria on the first two — "Effectively all tables are governed by Unity Catalog
// rather than a legacy metastore" — reached a reader, because criteria are in the control payload,
// and 100b authored a verify step from them that told the reader to look for a hive_metastore row
// that cannot exist.
//
// The walk is of the resolver source rather than of a running resolver, because a resolver that
// reads a threshold only on the happy path would look unread if invoked with empty evidence, and
// inventing a fixture that reaches every branch is how an apparatus starts describing itself.
// What this can see is a `threshold(context.spec, 'name')` or a `bandsOf(context.spec)` in the
// same `fromSignal`/`fromSignals` registration as the control id. That is every call in this
// tree today, and the apparatus assertions below refuse a walk that has stopped seeing them.
//
// A threshold that is read can still be dead. OE-03-01 declared `partial_share: 0.01` and its
// resolver compiled in `{ pass: 0, partial: 0.01 }` and returned `partial` on every branch, so the
// number was read and no value of it could move the outcome. A band is a pass line and a partial line,
// and it can only change an outcome if a share can land in each of the three places it creates: at or
// above the pass line, between the two, and below the partial line. `deadBands` judges the band a
// control is actually scored on — the catalogue's declaration over the resolver's compiled-in fallback —
// against that, so a declared number that cannot do anything is as much a finding as one nobody reads.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalogue } from '../server/catalogue/catalogue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVERS = join(HERE, '..', 'server', 'resolve', 'resolvers');

const ID = /'([A-Z]{2,4}-\d{2}-\d{2})'/g;
const THRESHOLD_NAME = /threshold\(\s*[\w.]+\s*,\s*'([a-z_]+)'/g;
// Only a call whose fallback is written as two numbers can be judged. One built from variables is
// skipped rather than guessed at, and the floor on `fallbacks.size` below catches a walk that stopped
// seeing the literal ones.
const BANDS_FALLBACK = /bandsOf\(\s*[\w.]+\s*,\s*\{\s*pass:\s*([\d.]+)\s*,\s*partial:\s*([\d.]+)\s*,?\s*\}/g;

/** A floor, not a count. A walk that silently resolves nothing produces a short list. */
export const MIN_THRESHOLD_CALLS = 10;

/** The same kind of floor for the bands the walk can judge. */
export const MIN_BANDED_CONTROLS = 10;

/** The pass and partial lines `bandsOf` falls back to when the catalogue declares none. */
export type Fallback = { readonly pass: number; readonly partial: number };

export type Reads = {
  readonly calls: number;
  readonly byControl: ReadonlyMap<string, ReadonlySet<string>>;
  /** The compiled-in bands of each `bandsOf` call, by the control its registration answers. */
  readonly fallbacks: ReadonlyMap<string, readonly Fallback[]>;
  readonly unattributed: readonly string[];
};

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('helpers.ts')) {
      found.push(path);
    }
  }
  return found;
}

export function readsOf(src: string): {
  readonly byControl: Map<string, Set<string>>;
  readonly fallbacks: Map<string, Fallback[]>;
  readonly unattributed: string[];
} {
  const byControl = new Map<string, Set<string>>();
  const fallbacks = new Map<string, Fallback[]>();
  const unattributed: string[] = [];
  for (const chunk of src.split(/(?=\bfromSignals?\b)/)) {
    const ids = [...chunk.matchAll(ID)].map((match) => match[1]);
    const names = [...chunk.matchAll(THRESHOLD_NAME)].map((match) => match[1]);
    const bands = /\bbandsOf\(/.test(chunk);
    const compiled = [...chunk.matchAll(BANDS_FALLBACK)].map((match) => ({
      pass: Number(match[1]),
      partial: Number(match[2]),
    }));
    if (ids.length === 0) {
      for (const name of names) unattributed.push(name);
      continue;
    }
    for (const id of ids) {
      const held = byControl.get(id) ?? new Set<string>();
      for (const name of names) held.add(name);
      if (bands) {
        held.add('pass_share');
        held.add('partial_share');
      }
      byControl.set(id, held);
      if (compiled.length > 0) fallbacks.set(id, [...(fallbacks.get(id) ?? []), ...compiled]);
    }
  }
  return { byControl, fallbacks, unattributed };
}

export function walkResolvers(dir = RESOLVERS): Reads {
  const byControl = new Map<string, Set<string>>();
  const fallbacks = new Map<string, Fallback[]>();
  const unattributed: string[] = [];
  let calls = 0;
  for (const path of sources(dir)) {
    const src = readFileSync(path, 'utf8');
    calls += [...src.matchAll(/\bthreshold\(/g)].length;
    const walked = readsOf(src);
    unattributed.push(...walked.unattributed);
    for (const [id, names] of walked.byControl) {
      const held = byControl.get(id) ?? new Set<string>();
      for (const name of names) held.add(name);
      byControl.set(id, held);
    }
    for (const [id, found] of walked.fallbacks) fallbacks.set(id, [...(fallbacks.get(id) ?? []), ...found]);
  }
  return { calls, byControl, fallbacks, unattributed };
}

export function unreadThresholds(
  catalogue = loadCatalogue(),
  walked = walkResolvers()
): readonly { readonly id: string; readonly names: readonly string[] }[] {
  const unread: { readonly id: string; readonly names: readonly string[] }[] = [];
  for (const control of catalogue.controls) {
    const declared = Object.keys(control.thresholds ?? {});
    if (declared.length === 0) continue;
    const got = walked.byControl.get(control.id) ?? new Set<string>();
    const names = declared.filter((name) => !got.has(name));
    if (names.length > 0) unread.push({ id: control.id, names });
  }
  return unread;
}

/**
 * Why a pass line and a partial line cannot give a share three different outcomes, or undefined when
 * they can.
 *
 * Shares are fractions of a population, so they live in [0, 1]. `bandOutcome` passes at or above the
 * pass line, is partial at or above the partial line, and fails below it. Each way the three places
 * can collapse is a band that cannot change an outcome:
 *
 * - a pass line of 0 or less passes every share, so the other two outcomes are unreachable;
 * - a pass line above 1 passes none, which is `fail` and `partial` only;
 * - a partial line at or above the pass line leaves nothing between them, so no share is partial;
 * - a partial line of 0 or less fails nothing, because no share is below it.
 */
export function deadBand(pass: number, partial: number): string | undefined {
  if (!Number.isFinite(pass) || !Number.isFinite(partial)) return 'a line is not a number';
  if (pass <= 0) return `a pass line of ${String(pass)} passes every share, so nothing can be partial or fail`;
  if (pass > 1) return `a pass line of ${String(pass)} is above every share, so nothing can pass`;
  if (partial >= pass) {
    return `a partial line of ${String(partial)} is not below the pass line of ${String(pass)}, so nothing can be partial`;
  }
  if (partial <= 0) return `a partial line of ${String(partial)} is below no share, so nothing can fail`;
  return undefined;
}

export interface DeadBand {
  readonly id: string;
  readonly pass: number;
  readonly partial: number;
  readonly why: string;
}

/**
 * The bands a control is scored on that cannot change its outcome.
 *
 * The band is the catalogue's declaration where there is one, over the fallback the resolver compiles
 * in where there is not, which is the order `bandsOf` reads them in. A declaration that is fine on its
 * own can still empty the band it is read over — `partial_share: 0.95` against a compiled-in pass line
 * of 0.9 — and a compiled-in fallback can be dead before any declaration touches it.
 */
type Declaring = { readonly controls: readonly { readonly id: string; readonly thresholds?: Record<string, unknown> }[] };

export function deadBands(
  catalogue: Declaring = loadCatalogue(),
  walked: Pick<Reads, 'fallbacks'> = walkResolvers()
): readonly DeadBand[] {
  const dead: DeadBand[] = [];
  for (const control of catalogue.controls) {
    for (const fallback of walked.fallbacks.get(control.id) ?? []) {
      const declared = control.thresholds ?? {};
      const pass = typeof declared.pass_share === 'number' ? declared.pass_share : fallback.pass;
      const partial = typeof declared.partial_share === 'number' ? declared.partial_share : fallback.partial;
      const why = deadBand(pass, partial);
      if (why != null) dead.push({ id: control.id, pass, partial, why });
    }
  }
  return dead;
}

function main(): void {
  const walked = walkResolvers();
  const problems: string[] = [];

  if (walked.calls < MIN_THRESHOLD_CALLS) {
    problems.push(
      `The walk found ${walked.calls} threshold() calls in the resolver files, below a floor of ${MIN_THRESHOLD_CALLS}. ` +
        'A walk that sees nothing produces an empty unread list and a gate that passes forever.'
    );
  }
  if (walked.unattributed.length > 0) {
    problems.push(
      `threshold() is called with '${walked.unattributed.join("', '")}' outside any fromSignal registration, ` +
        'so those reads cannot be attributed to a control.'
    );
  }

  const unread = unreadThresholds(loadCatalogue(), walked);
  for (const { id, names } of unread) {
    problems.push(
      `${id} declares ${names.join(', ')} and its resolver never reads ${names.length === 1 ? 'it' : 'them'}. ` +
        'A threshold nobody reads is a sentence about a measurement that is not taken — row 104, ' +
        'and the criteria on DG-01-02 that told a reader the app compared the estate to a legacy metastore.'
    );
  }

  if (walked.fallbacks.size < MIN_BANDED_CONTROLS) {
    problems.push(
      `The walk found the compiled-in bands of ${walked.fallbacks.size} controls, below a floor of ` +
        `${MIN_BANDED_CONTROLS}. A walk that cannot see bandsOf() fallbacks judges nothing and passes forever.`
    );
  }
  for (const { id, pass, partial, why } of deadBands(loadCatalogue(), walked)) {
    problems.push(
      `${id} is scored on a band of pass ${String(pass)} and partial ${String(partial)}, and ${why}. A band ` +
        'that cannot change the outcome is a declared number that does nothing, which is what OE-03-01 ' +
        'carried while its resolver returned partial on every branch.'
    );
  }

  if (problems.length > 0) {
    console.error('\nA declared threshold is not doing what it declares:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    process.exit(1);
  }

  const declared = loadCatalogue().controls.filter((control) => Object.keys(control.thresholds ?? {}).length > 0);
  console.log(
    `Every one of the ${declared.length} controls that declare a threshold has a resolver that reads it ` +
      `(${walked.calls} threshold() calls attributed), and every band of the ${walked.fallbacks.size} ` +
      'controls whose bands the walk can judge can change an outcome.'
  );
}

const invoked = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) main();
