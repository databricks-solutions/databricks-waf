// The welcome's claims, held against the things that make them true.
//
// A test that only asserted these sentences exist would be a test that the file was not deleted.
// What is worth checking is the pairing: each claim about the app's boundary is checked here against
// the mechanism that enforces it, so a change to the mechanism fails on the sentence too.
//
// The read-only claim is the one this exists for. "It changes nothing in your estate" is the sentence
// an operator reads before pointing this at production, and it is true because `check-read-only.mjs`
// refuses a collector that writes. If that check is ever removed or renamed, the promise stops being
// checked by anything — and the reader has no way to know, because the sentence still reads the same.
//
// The vocabulary is checked for reachability rather than for wording. A glossary term linking to a
// page that does not exist replaces the whole app with React Router's 404 boundary (see
// scripts/check-routes.mjs, which catches the same class of failure across every link in the client),
// and a term whose page is wrong is a definition that sends the reader to the wrong evidence.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRAMEWORK_URL, LIMITS, ONWARD, PROMISE, STANDING, WORDS } from './orientation-language';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', '..');
const ROUTER = join(HERE, '..', 'App.tsx');

describe('the promise', () => {
  it('says what is read, as whom, and what comes out', () => {
    const said = [PROMISE.lead, ...PROMISE.points].join(' ');

    expect(said).toContain('system tables');
    expect(said).toContain('scanning identity');
    expect(said).toContain('published report');
  });

  it('does not promise a remediation the app has no way to perform', () => {
    const said = [PROMISE.lead, ...PROMISE.points, ONWARD.detail].join(' ').toLowerCase();

    expect(said).not.toContain('fix your');
    expect(said).not.toContain('remediate');
    expect(said).not.toContain('automatically resolve');
  });
});

describe('the limits', () => {
  it('leads with the one an operator decides on', () => {
    expect(LIMITS.points[0]?.claim).toContain('does not change');
  });

  it('is a claim the build enforces, not a paragraph', () => {
    // The check that makes the first claim true. Named here so removing it fails a test that reads
    // like a promise to the customer rather than only a script somebody has to notice is missing.
    const guard = join(APP, 'scripts', 'check-read-only.mjs');
    expect(existsSync(guard)).toBe(true);

    // And it has to be one of the checks CI actually runs. A guard that exists and is never invoked
    // enforces nothing, which is the shape this would fail as.
    const verify = readFileSync(join(APP, 'scripts', 'verify.mjs'), 'utf8');
    expect(verify).toContain('check:read-only');
  });

  it('says an unreadable requirement is not measured rather than met', () => {
    const unseen = LIMITS.points.find((limit) => limit.claim.includes('does not see'));

    expect(unseen?.detail).toContain('not measured');
    expect(unseen?.detail).toMatch(/never comes back as a pass/i);
  });

  it('refuses the word certification about its own results', () => {
    const certify = LIMITS.points.find((limit) => limit.claim.includes('certify'));

    expect(certify?.detail).toContain('not an audit opinion');
    expect(certify?.detail).toContain('certification');
  });
});

describe('how to read a score', () => {
  it('names the three things that make two runs incomparable', () => {
    const said = STANDING.points.join(' ');

    expect(said).toContain('exact manifest');
    expect(said).toContain('coverage');
    expect(said).toContain('public methodology');
    expect(said).toContain('scoring basis');
  });
});

describe('the vocabulary', () => {
  it('defines every noun the app titles a page with', () => {
    const terms = WORDS.map((word) => word.term);

    for (const noun of ['Pillar', 'Requirement', 'Finding', 'Answer', 'Definition', 'Run', 'Decision']) {
      expect(terms).toContain(noun);
    }
  });

  it('introduces a word before the words that depend on it', () => {
    const at = (term: string): number => WORDS.findIndex((word) => word.term === term);

    expect(at('Requirement')).toBeLessThan(at('Finding'));
    expect(at('Definition')).toBeLessThan(at('Run'));
    expect(at('Finding')).toBeLessThan(at('Decision'));
  });

  it('sends every linked term to a route the router serves', () => {
    const router = readFileSync(ROUTER, 'utf8');

    for (const word of WORDS) {
      if (word.at == null) continue;
      expect(router, `${word.term} links to ${word.at}`).toContain(`path: '${word.at}'`);
    }
  });

  it('names no term twice', () => {
    expect(new Set(WORDS.map((word) => word.term)).size).toBe(WORDS.length);
  });
});

describe('the framework link', () => {
  it('points at the pages the catalogue was harvested from', () => {
    const harvest = readFileSync(join(APP, 'scripts', 'harvest-waf-docs.mjs'), 'utf8');

    // The same base URL, so the welcome cannot send a reader to a different edition of the framework
    // than the one this build scores against.
    expect(harvest).toContain(FRAMEWORK_URL);
  });
});
