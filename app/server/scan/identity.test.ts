// What a run records about what produced it, and what those records mean for comparing two runs.
//
// The tests that matter here are the ones about *not knowing*. An axis this build read and could not
// establish, and an axis a run from last month never recorded, are different facts with different
// consequences, and the whole value of this record is that it does not conflate them.

import { describe, expect, it } from 'vitest';
import { observed, unmeasurable, type SignalId, type SignalResult } from '../collect/signal.js';
import {
  buildIdentity,
  definitionBarrier,
  exclusionKeys,
  identityBarriers,
  runIdentity,
  sourcesOf,
} from './identity.js';
import type { RunIdentity } from './identity.js';
import type { Provenance } from '../collect/provenance.js';

const IDENTITY: RunIdentity = {
  build: { id: '0.1.0+abcdef123456' },
  methodology: { id: 'sha256:aaa' },
  record: { id: 'codec-2' },
  sources: ['sql'],
};

function reading(id: string, provenance: Partial<Provenance> = {}): SignalResult {
  return {
    ...observed(id as SignalId, { value: 1 }, 1),
    provenance: {
      surface: 'sql',
      collector: 'sql',
      authority: 'on-behalf-of-user',
      actor: 'someone@example.com',
      ...provenance,
    },
  };
}

describe('what produced a run', () => {
  it('names this app’s version and the bundle that ran, so two builds are distinguishable', () => {
    const build = buildIdentity();

    // Either it found the shipped bundle, or it says why not. Never a version on its own, which
    // would report two runs as one build when one of them ran uncommitted work.
    if (build.id != null) expect(build.id).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    else expect(build.unknown).toContain('dist/server.js');
  });

  it('says why rather than guessing when there is no app root above it', () => {
    const build = buildIdentity('file:///nowhere/at/all/module.js');

    expect(build.id).toBeUndefined();
    expect(build.unknown).toBeTruthy();
  });

  it('derives the scoring method from the tables rather than a constant somebody maintains', () => {
    // The value is not asserted — asserting it would make this test the constant it exists to avoid.
    // What matters is that it is established and stable within a process.
    expect(runIdentity([]).methodology.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(runIdentity([]).methodology.id).toBe(runIdentity([]).methodology.id);
  });

  it('records the encoding the run is written down under', () => {
    expect(runIdentity([]).record.id).toMatch(/^codec-\d+$/);
  });
});

describe('which sources answered', () => {
  it('counts a surface that produced a reading', () => {
    expect(sourcesOf([reading('sql:a'), reading('rest:b', { surface: 'rest' })])).toEqual(['rest', 'sql']);
  });

  it('names each surface once, however many readings it produced', () => {
    expect(sourcesOf([reading('sql:a'), reading('sql:b')])).toEqual(['sql']);
  });

  /*
   * A refused probe still names the surface it would have read. Counting those would report every run
   * as having read everything, which is the opposite of what this field is for: a run with no
   * warehouse bound must not claim the warehouse answered.
   */
  it('does not count a surface that refused', () => {
    const refused: SignalResult = {
      ...unmeasurable('sql:a', 'no warehouse is bound'),
      provenance: { surface: 'sql', collector: 'sql', authority: 'on-behalf-of-user', actor: 'x' },
    };

    expect(sourcesOf([refused])).toEqual([]);
  });

  /*
   * An imported reading was not made by this app on any surface. Reporting it as `rest` — the surface
   * the administrator's script read — would say this app reached an endpoint it cannot reach at all.
   */
  it('reports an administrator’s reading as an import rather than as the surface they read', () => {
    expect(sourcesOf([reading('rest:a', { surface: 'rest', authority: 'admin-cli' })])).toEqual(['import']);
  });
});

describe('what two runs’ identities mean for comparing them', () => {
  it('permits a comparison between two runs of the same build with nothing to say', () => {
    expect(identityBarriers(IDENTITY, IDENTITY)).toEqual({ refusals: [], caveats: [] });
  });

  it('refuses a changed scoring method', () => {
    const { refusals } = identityBarriers(IDENTITY, { ...IDENTITY, methodology: { id: 'sha256:bbb' } });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('scoring method changed');
  });

  /*
   * The distinction this file exists for. An axis the app tried to establish and could not is a
   * refusal, because the alternative is presenting an equality nobody checked.
   */
  it('refuses an unestablished scoring method rather than assuming it matched', () => {
    const { refusals } = identityBarriers(IDENTITY, {
      ...IDENTITY,
      methodology: { unknown: 'the tables could not be read' },
    });

    expect(refusals[0]).toContain('does not record how findings were weighted');
  });

  /*
   * And the other side of it. A run from before the field existed is qualified, not refused: refusing
   * would empty every customer's history on the deploy that added the field.
   */
  it('qualifies rather than refuses when a run predates this record', () => {
    const { refusals, caveats } = identityBarriers(IDENTITY, undefined);

    expect(refusals).toEqual([]);
    expect(caveats[0]).toContain('recorded before this app noted what produced it');
  });

  it('qualifies a build change, naming both builds', () => {
    const { refusals, caveats } = identityBarriers(IDENTITY, { ...IDENTITY, build: { id: '0.2.0+abcdef123456' } });

    expect(refusals).toEqual([]);
    expect(caveats[0]).toContain('0.1.0+abcdef123456');
    expect(caveats[0]).toContain('0.2.0+abcdef123456');
  });

  it('qualifies an unidentifiable build', () => {
    const { caveats } = identityBarriers(IDENTITY, { ...IDENTITY, build: { unknown: 'no bundle was found' } });

    expect(caveats[0]).toContain('could not identify the build');
  });

  it('says which source answered in one run and not the other', () => {
    const { caveats } = identityBarriers({ ...IDENTITY, sources: ['sql', 'import'] }, IDENTITY);

    expect(caveats[0]).toContain('import answered in the later run and not the earlier');
  });

  it('reports every barrier rather than the first, so one fix is one round trip', () => {
    const { refusals, caveats } = identityBarriers(IDENTITY, {
      build: { id: '0.2.0+abcdef123456' },
      methodology: { id: 'sha256:bbb' },
      record: { id: 'codec-1' },
      sources: ['rest'],
    });

    expect(refusals).toHaveLength(1);
    expect(caveats).toHaveLength(2);
  });

  /*
   * The encoding is recorded so a decoded score says what it was decoded from, and it is deliberately
   * not compared: the decoder brings an older record up to date with its assumptions stated, so a
   * codec difference is already handled where it happens rather than being a barrier here.
   */
  it('says nothing about a differing encoding', () => {
    const { refusals, caveats } = identityBarriers(IDENTITY, { ...IDENTITY, record: { id: 'codec-1' } });

    expect(refusals).toEqual([]);
    expect(caveats).toEqual([]);
  });

  /*
   * A customer's applicability decisions change what the score is out of. Two scores over different
   * denominators are the same case as a changed scoring method — refused, not qualified.
   */
  it('refuses a comparison when a requirement was taken out of one score and not the other', () => {
    const { exclusions } = identityBarriers(
      { ...IDENTITY, exclusions: ['a', 'b'] },
      { ...IDENTITY, exclusions: ['a'] }
    );

    expect(exclusions).toContain('different denominators');
    expect(exclusions).toContain('1 taken out of the later run and not the earlier');
  });

  it('refuses when a decision was revoked between the runs, naming the drop', () => {
    const { exclusions } = identityBarriers({ ...IDENTITY, exclusions: [] }, { ...IDENTITY, exclusions: ['a'] });

    expect(exclusions).toContain('1 taken out of the earlier run and not the later');
  });

  /*
   * The exclusion refusal is reported on its own field rather than among the others, because
   * `carryForward` wants every barrier except this one. Keeping it out of `refusals` is what lets that
   * caller ask for the difference; a reader of this file should not conclude the axis stopped refusing.
   */
  it('keeps the exclusion refusal apart from the barriers every caller refuses on', () => {
    const barriers = identityBarriers({ ...IDENTITY, exclusions: ['a'] }, { ...IDENTITY, exclusions: [] });

    expect(barriers.refusals).toEqual([]);
    expect(barriers.exclusions).toBeDefined();
  });

  it('permits two runs that took the same set out, whatever order it is recorded in', () => {
    const { refusals } = identityBarriers(
      { ...IDENTITY, exclusions: ['a', 'b'] },
      { ...IDENTITY, exclusions: ['b', 'a'] }
    );

    expect(refusals).toEqual([]);
  });

  /*
   * The exception this axis documents: applicability postdates every run without the field, so an
   * absent set is an empty one, not an unknown one. A run that excluded nothing and a run from before
   * the feature existed are the same denominator, and comparing them says nothing.
   */
  it('reads an absent exclusion set as the empty one rather than qualifying it', () => {
    const { refusals, caveats } = identityBarriers({ ...IDENTITY, exclusions: [] }, IDENTITY);

    expect(refusals).toEqual([]);
    expect(caveats).toEqual([]);
  });

  it('refuses when one run excluded something and the other predates the field', () => {
    const { exclusions } = identityBarriers({ ...IDENTITY, exclusions: ['a'] }, IDENTITY);

    expect(exclusions).toContain('different denominators');
  });

  /*
   * The lever is a second thing that moves without the estate moving. Both levers take the requirement out
   * of the weighted average, so the ids alone compared equal — and the two do different things to the
   * range, which `apply.ts` documents and `apply.test.ts` holds. So a decision switched from one to the
   * other was drawn as a trend across two ranges that differ for a reason that is not the estate.
   */
  it('refuses when the same requirement was taken out by a different lever', () => {
    const { exclusions } = identityBarriers(
      { ...IDENTITY, exclusions: exclusionKeys([{ controlId: 'a', lever: 'disabled' }]) },
      { ...IDENTITY, exclusions: exclusionKeys([{ controlId: 'a', lever: 'not-applicable' }]) }
    );

    expect(exclusions).toContain('by different means');
    expect(exclusions).toContain('1 switched');
    // Not the denominator sentence: one requirement under two levers is one requirement out of both.
    expect(exclusions).not.toContain('different denominators');
  });

  it('permits two runs that took the same set out by the same levers', () => {
    const same = exclusionKeys([
      { controlId: 'b', lever: 'disabled' },
      { controlId: 'a', lever: 'not-applicable' },
    ]);
    const barriers = identityBarriers({ ...IDENTITY, exclusions: same }, { ...IDENTITY, exclusions: [...same] });

    expect(barriers.refusals).toEqual([]);
    expect(barriers.exclusions).toBeUndefined();
  });

  it('does not read a run recorded before the lever was kept as every decision having changed', () => {
    // The entry has no lever on it, and comparing it to one that has would otherwise refuse every
    // comparison across the upgrade — on an axis that refuses rather than qualifies.
    const { exclusions } = identityBarriers(
      { ...IDENTITY, exclusions: exclusionKeys([{ controlId: 'a', lever: 'disabled' }]) },
      { ...IDENTITY, exclusions: ['a'] }
    );

    expect(exclusions).toBeUndefined();
  });

  it('counts the switched requirements rather than the entries either side of the switch', () => {
    const { exclusions } = identityBarriers(
      {
        ...IDENTITY,
        exclusions: exclusionKeys([
          { controlId: 'a', lever: 'disabled' },
          { controlId: 'b', lever: 'disabled' },
          { controlId: 'c', lever: 'not-applicable' },
        ]),
      },
      {
        ...IDENTITY,
        exclusions: exclusionKeys([
          { controlId: 'a', lever: 'not-applicable' },
          { controlId: 'b', lever: 'not-applicable' },
          { controlId: 'c', lever: 'not-applicable' },
        ]),
      }
    );

    expect(exclusions).toContain('2 switched');
  });
});

describe('what two runs’ assessments mean for comparing them', () => {
  const definition = { id: 'def-1', version: 2, fingerprint: 'sha256:aa' };

  it('permits two runs of one version', () => {
    expect(definitionBarrier(definition, definition)).toBeUndefined();
  });

  it('permits two runs across a revision that did not change the question', () => {
    expect(definitionBarrier({ ...definition, version: 3 }, definition)).toBeUndefined();
  });

  it('refuses a revision that changed the question, naming both versions', () => {
    const barrier = definitionBarrier(
      { ...definition, version: 3, fingerprint: 'sha256:bb', name: 'Production readiness' },
      { ...definition, name: 'Production readiness' }
    );

    expect(barrier).toContain('between version 2 and version 3');
    expect(barrier).toContain('Production readiness');
    expect(barrier).not.toContain('def-1');
  });

  it('does not return an internal delivery name through a comparison barrier', () => {
    const barrier = definitionBarrier(
      { ...definition, version: 3, fingerprint: 'sha256:bb', name: '110c labs journey 2026-08-20' },
      { ...definition, name: '110c labs journey 2026-08-20' }
    );

    expect(barrier).toContain('The assessment changed what it measures');
    expect(barrier).not.toContain('110c');
    expect(barrier).not.toContain('labs journey');
  });

  it('refuses two different assessments', () => {
    const barrier = definitionBarrier(
      { ...definition, id: 'def-2', name: 'Analytics estate' },
      { ...definition, name: 'Production estate' }
    );

    expect(barrier).toContain('different assessments');
    expect(barrier).toContain('Analytics estate');
    expect(barrier).toContain('Production estate');
    expect(barrier).not.toContain('def-1');
    expect(barrier).not.toContain('def-2');
  });

  it('keeps a customer assessment name while omitting an internal peer name', () => {
    const barrier = definitionBarrier(
      { ...definition, id: 'def-2', name: 'PR #475 served proof' },
      { ...definition, name: 'Production estate' }
    );

    expect(barrier).toContain('one named “Production estate”');
    expect(barrier).not.toContain('PR #475');
  });

  it('refuses an assessment run against an ad-hoc one without exposing its technical key', () => {
    const barrier = definitionBarrier({ ...definition, name: 'Production readiness' }, undefined);

    expect(barrier).toContain('Production readiness');
    expect(barrier).not.toContain('def-1');
    expect(barrier).toContain('started directly');
  });

  it('permits two ad-hoc runs, since neither claims to answer to anything', () => {
    expect(definitionBarrier(undefined, undefined)).toBeUndefined();
  });
});
