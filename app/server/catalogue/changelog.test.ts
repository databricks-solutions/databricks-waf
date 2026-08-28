import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadChangelog, NO_CHANGELOG, spanBetween, type CatalogueChange } from './changelog.js';

function version(one: Partial<CatalogueChange> & { version: string }): CatalogueChange {
  return {
    fingerprint: `sha256:${one.version}`,
    recordedAt: '2026-01-01T00:00:00.000Z',
    scoredUnits: 184,
    describes: true,
    added: [],
    removed: [],
    renamed: [],
    changed: [],
    ...one,
  };
}

function changelog(...entries: CatalogueChange[]) {
  return { entries };
}

describe('what separates two catalogue versions', () => {
  it('has nothing to say about two runs scored against the same version', () => {
    const span = spanBetween(changelog(version({ version: '2' })), '2', '2');

    expect(span.describable).toBe(true);
    expect(span.added).toEqual([]);
    expect(span.versions).toEqual([]);
  });

  it('names what one version added and removed', () => {
    const span = spanBetween(
      changelog(version({ version: '2', added: ['gov-9'], removed: ['cost-3'] })),
      '1',
      '2',
    );

    expect(span.describable).toBe(true);
    expect(span.added).toEqual(['gov-9']);
    expect(span.removed).toEqual(['cost-3']);
    expect(span.versions).toEqual(['2']);
  });

  it('follows a requirement renumbered twice to the id the later run used', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', renamed: [{ from: 'a', to: 'b' }] }),
        version({ version: '3', renamed: [{ from: 'b', to: 'c' }] }),
      ),
      '1',
      '3',
    );

    expect(span.renamed.get('a')).toBe('c');
    expect(span.renamed.has('b')).toBe(false);
  });

  it('reports an id dropped and later reused as both an arrival and a departure', () => {
    const span = spanBetween(
      changelog(version({ version: '2', removed: ['rel-4'] }), version({ version: '3', added: ['rel-4'] })),
      '1',
      '3',
    );

    // Nothing in the record says the requirement holding rel-4 at the end is the one that held it at
    // the start. Cancelling the pair would admit it to the like-for-like core and report the
    // difference between two unrelated requirements as the estate moving.
    expect(span.added).toEqual(['rel-4']);
    expect(span.removed).toEqual(['rel-4']);
  });

  it('reports a requirement that arrived and left within the span as neither', () => {
    const span = spanBetween(
      changelog(version({ version: '2', added: ['rel-4'] }), version({ version: '3', removed: ['rel-4'] })),
      '1',
      '3',
    );

    // Absent from both endpoints, so no run either side holds a finding for it.
    expect(span.added).toEqual([]);
    expect(span.removed).toEqual([]);
  });

  it('reports a requirement renumbered and then dropped under the id the earlier run used', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', renamed: [{ from: 'rel-4', to: 'rel-9' }] }),
        version({ version: '3', removed: ['rel-9'] }),
      ),
      '1',
      '3',
    );

    // A rename pointing at an id the later catalogue does not have matches nothing in either run.
    expect(span.renamed.size).toBe(0);
    expect(span.removed).toEqual(['rel-4']);
    expect(span.added).toEqual([]);
  });

  it('reports a requirement renumbered back to where it started as unmoved', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', renamed: [{ from: 'rel-4', to: 'rel-9' }] }),
        version({ version: '3', renamed: [{ from: 'rel-9', to: 'rel-4' }] }),
      ),
      '1',
      '3',
    );

    expect(span.renamed.size).toBe(0);
  });

  it('unions the fields a requirement moved on across every version crossed', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', changed: [{ id: 'sec-1', fields: ['severity'] }] }),
        version({ version: '3', changed: [{ id: 'sec-1', fields: ['thresholds', 'severity'] }] }),
      ),
      '1',
      '3',
    );

    expect(span.changed).toEqual([{ id: 'sec-1', fields: ['severity', 'thresholds'] }]);
  });

  // Everything the span reports is keyed on the ids the later run used, because that is what its
  // findings carry. A requirement that moved and was then renumbered is the case where the two can
  // come apart, and coming apart is not visible downstream: it looks like a requirement that did not
  // move, which is how a change of question ends up attributed to the customer's estate.
  it('reports a requirement changed then renumbered under the id the later run used', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', changed: [{ id: 'a', fields: ['severity'] }] }),
        version({ version: '3', renamed: [{ from: 'a', to: 'a2' }] }),
      ),
      '1',
      '3',
    );

    expect(span.changed).toEqual([{ id: 'a2', fields: ['severity'] }]);
  });

  it('merges what a requirement changed either side of being renumbered', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', changed: [{ id: 'a', fields: ['severity'] }] }),
        version({
          version: '3',
          renamed: [{ from: 'a', to: 'a2' }],
          changed: [{ id: 'a2', fields: ['thresholds'] }],
        }),
      ),
      '1',
      '3',
    );

    expect(span.changed).toEqual([{ id: 'a2', fields: ['severity', 'thresholds'] }]);
  });

  it('reports a requirement added then renumbered under the id the later run used', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', added: ['a'] }),
        version({ version: '3', renamed: [{ from: 'a', to: 'a2' }] }),
      ),
      '1',
      '3',
    );

    expect(span.added).toEqual(['a2']);
    expect(span.removed).toEqual([]);
  });

  /*
   * Positional ids get reused, so every one of these applies three or more events across three
   * versions with one id passing between two unrelated requirements. They are here as a family
   * rather than as four cases because the family is the point: each one was reachable while the
   * composition was keyed on ids, each read as a plausible answer, and each blamed the customer's
   * estate for a renumbering. The lineage indirection is what makes them impossible, and a test
   * that only exercised one of them would let a future refactor reintroduce the other three.
   */
  it('keeps a rename when the id it started from is later filled and dropped again', () => {
    // The one that cost a real regression: a requirement renumbered a→b, then an unrelated
    // requirement lands on the freed `a` and is itself dropped. Keyed on ids, the second removal
    // resolved through the rename and deleted it, leaving an empty span — so a genuine estate
    // regression on the renumbered requirement was reported to the customer as a release note.
    const span = spanBetween(
      changelog(
        version({ version: '2', renamed: [{ from: 'a', to: 'b' }] }),
        version({ version: '3', added: ['a'] }),
        version({ version: '4', removed: ['a'] }),
      ),
      '1',
      '4',
    );

    expect([...span.renamed]).toEqual([['a', 'b']]);
    // The requirement that arrived on `a` and left again is absent from both endpoints, so it is
    // neither an addition nor a departure.
    expect(span.added).toEqual([]);
    expect(span.removed).toEqual([]);
  });

  it('reports both departures when one id is vacated, refilled by a rename, and vacated again', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', removed: ['a'] }),
        version({ version: '3', renamed: [{ from: 'b', to: 'a' }] }),
        version({ version: '4', removed: ['a'] }),
      ),
      '1',
      '4',
    );

    // Two requirements left. Keyed on ids, the second removal overwrote the first's record and the
    // earlier run's findings for `a` were carried into the like-for-like core.
    expect(span.removed).toEqual(['a', 'b']);
    expect([...span.renamed]).toEqual([]);
  });

  it('keeps a departure when a later rename lands on the id it vacated', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', removed: ['b'] }),
        version({ version: '3', added: ['a'] }),
        version({ version: '4', renamed: [{ from: 'a', to: 'b' }] }),
      ),
      '1',
      '4',
    );

    // `b` left and something new arrived on its number. Keyed on ids, the rename overwrote the
    // departure and reported a phantom `a → b` for a requirement the earlier run never had.
    expect(span.removed).toEqual(['b']);
    expect(span.added).toEqual(['b']);
    expect([...span.renamed]).toEqual([]);
  });

  it('reports a departure under the id the earlier run used, not one a later rename produced', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', removed: ['a'] }),
        version({ version: '3', added: ['a'] }),
        version({ version: '4', renamed: [{ from: 'a', to: 'z' }] }),
      ),
      '1',
      '4',
    );

    // `removed` is consumed as earlier-run ids by both attribution and the change list, so a later
    // id in it drops the wrong finding — and leaves the departed requirement's finding to collide
    // with the arriving one.
    expect(span.removed).toEqual(['a']);
    expect(span.added).toEqual(['z']);
    expect([...span.renamed]).toEqual([]);
  });

  it('does not describe a requirement as rescoped when it left before the later run', () => {
    // `changed` is read as "asks something different than it did", so a requirement absent from one
    // endpoint was not asking anything there. Reported, it puts a "reweighted or rescoped" caveat
    // and a `redefined` note on a row that reads `pass → absent`.
    const span = spanBetween(
      changelog(
        version({ version: '2', changed: [{ id: 'a', fields: ['severity'] }] }),
        version({ version: '3', removed: ['a'] }),
      ),
      '1',
      '3',
    );

    expect(span.removed).toEqual(['a']);
    expect(span.changed).toEqual([]);
  });

  it('does not describe a requirement as rescoped when it arrived after the earlier run', () => {
    const span = spanBetween(
      changelog(
        version({ version: '2', added: ['n'] }),
        version({ version: '3', changed: [{ id: 'n', fields: ['weight'] }] }),
      ),
      '1',
      '3',
    );

    expect(span.added).toEqual(['n']);
    expect(span.changed).toEqual([]);
  });

  it('refuses when a version in between was never recorded', () => {
    const span = spanBetween(changelog(version({ version: '3' })), '1', '3');

    expect(span.describable).toBe(false);
    expect(span.why).toContain('version 2');
  });

  it('refuses when a version crossed does not describe what it changed', () => {
    const span = spanBetween(changelog(version({ version: '2', describes: false })), '1', '2');

    expect(span.describable).toBe(false);
    expect(span.why).toContain('before this app wrote down');
  });

  it('refuses to describe a rollback rather than inverting the record', () => {
    const span = spanBetween(changelog(version({ version: '2' })), '2', '1');

    expect(span.describable).toBe(false);
    expect(span.why).toContain('older than');
  });

  it('refuses when either run does not say which catalogue it was scored against', () => {
    const span = spanBetween(changelog(version({ version: '2' })), 'unknown', '2');

    expect(span.describable).toBe(false);
    expect(span.why).toContain('does not record which catalogue version');
  });

  it('refuses everything when no history was recorded at all', () => {
    expect(spanBetween(NO_CHANGELOG, '1', '2').describable).toBe(false);
  });
});

describe('reading the recorded history off disk', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function directoryWith(contents?: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'waf-changelog-'));
    directories.push(directory);
    if (contents != null) writeFileSync(join(directory, 'changelog.json'), contents);
    return directory;
  }

  it('reads entries oldest first, whatever order the file holds them in', () => {
    const directory = directoryWith(
      JSON.stringify([
        { version: '2', fingerprint: 'sha256:b', describes: true, added: ['x'] },
        { version: '1', fingerprint: 'sha256:a', describes: true },
      ]),
    );

    expect(loadChangelog(directory).entries.map((one) => one.version)).toEqual(['1', '2']);
  });

  it('treats an absent file as no history rather than an error', () => {
    expect(loadChangelog(directoryWith())).toBe(NO_CHANGELOG);
  });

  it('treats an unreadable file as no history, so a bad write cannot stop the app booting', () => {
    expect(loadChangelog(directoryWith('{ not json'))).toBe(NO_CHANGELOG);
  });

  it('drops malformed renames rather than inventing an id for them', () => {
    const directory = directoryWith(
      JSON.stringify([
        { version: '1', describes: true, renamed: [{ from: 'a' }, { from: 'b', to: 'c' }] },
      ]),
    );

    expect(loadChangelog(directory).entries[0]?.renamed).toEqual([{ from: 'b', to: 'c' }]);
  });
});
