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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalogue } from '../server/catalogue/catalogue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVERS = join(HERE, '..', 'server', 'resolve', 'resolvers');

const ID = /'([A-Z]{2,4}-\d{2}-\d{2})'/g;
const THRESHOLD_NAME = /threshold\(\s*[\w.]+\s*,\s*'([a-z_]+)'/g;

/** A floor, not a count. A walk that silently resolves nothing produces a short list. */
export const MIN_THRESHOLD_CALLS = 10;

export type Reads = {
  readonly calls: number;
  readonly byControl: ReadonlyMap<string, ReadonlySet<string>>;
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

export function readsOf(src: string): { readonly byControl: Map<string, Set<string>>; readonly unattributed: string[] } {
  const byControl = new Map<string, Set<string>>();
  const unattributed: string[] = [];
  for (const chunk of src.split(/(?=\bfromSignals?\b)/)) {
    const ids = [...chunk.matchAll(ID)].map((match) => match[1]);
    const names = [...chunk.matchAll(THRESHOLD_NAME)].map((match) => match[1]);
    const bands = /\bbandsOf\(/.test(chunk);
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
    }
  }
  return { byControl, unattributed };
}

export function walkResolvers(dir = RESOLVERS): Reads {
  const byControl = new Map<string, Set<string>>();
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
  }
  return { calls, byControl, unattributed };
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

  if (problems.length > 0) {
    console.error('\nA declared threshold is not being read:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    process.exit(1);
  }

  const declared = loadCatalogue().controls.filter((control) => Object.keys(control.thresholds ?? {}).length > 0);
  console.log(
    `Every one of the ${declared.length} controls that declare a threshold has a resolver that reads it ` +
      `(${walked.calls} threshold() calls attributed).`
  );
}

const invoked = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) main();
