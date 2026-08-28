// What the served-app stamp may say, and what it may not.
//
// Two of these are about a check that fails for a reason nobody can fix, which is the failure mode that
// makes a check ignorable — ADR 0027. The rest are about the stamp claiming more than the recording under
// it holds.

import { describe, expect, it } from 'vitest';
import { ago, recordDriven, stamp } from './served.mjs';

const served = {
  asked: '2026-08-18T00:32:59.634Z',
  estate: 'labs',
  app: 'databricks-waf-assessment',
  origin: 'https://databricks-waf-assessment-747.aws.databricksapps.com',
  deploymentId: '01f19a118e4016a4952bb1318e33f39a',
  deployedAt: '2026-08-17T07:59:21Z',
  deploymentState: 'SUCCEEDED',
  appState: 'RUNNING',
  source: 'databricks apps get databricks-waf-assessment --profile your-profile',
};

const driven = {
  at: '2026-08-18T00:32:59.636Z',
  estate: 'labs',
  origin: served.origin,
  deploymentId: served.deploymentId,
  drove: 31,
  declared: 34,
  failures: 0,
};

describe('the stamp in docs/estates.md', () => {
  it('states no age, so it does not drift from its recording overnight', () => {
    // The first version said "deployed 2026-08-17 (16 hours ago)" and "7 commits are dated after that
    // deploy". Both are true when generated and false the next morning, so `check:served` would have
    // failed every day on a document nobody had touched — and a check whose fix is "regenerate it
    // without reading it" stops being read. The ages belong in the check's output, which is where they
    // are, and the dates belong here.
    const said = stamp({ served, driven });
    expect(said).not.toMatch(/hours ago|days ago|within the hour/);
    expect(said).not.toMatch(/\bcommits\b/);
    expect(said).toContain('deployed 2026-08-17');
    expect(said).toContain('**Driven:** 2026-08-18');
  });

  it('says a drive was of the deployment last read, not of the one serving now', () => {
    // The platform was asked when it was asked. A present-tense claim about what is serving is a claim
    // about a system this file has not spoken to since, and AGENTS.md is explicit that prose may report
    // what was read and may not conclude what the platform is doing.
    const said = stamp({ served, driven });
    expect(said).toContain('That drive was of the deployment this file last read as active.');
    expect(said).not.toMatch(/serving now|is currently/);
  });

  it('says so when the app was redeployed after the drive, and names both', () => {
    const after = { ...served, deploymentId: 'ffffffffffff0000000000000000ffff' };
    const said = stamp({ served: after, driven });
    expect(said).toContain('The active deployment had changed');
    expect(said).toContain(driven.deploymentId.slice(0, 12));
    expect(said).toContain('ffffffffffff');
  });

  it('reports a drive that found failures as failures, so an old bad run cannot read as verification', () => {
    expect(stamp({ served, driven: { ...driven, failures: 3 } })).toContain('3 of them not rendering');
    expect(stamp({ served, driven })).toContain('none of those 31 failing to render');
  });

  it('claims nothing about the routes the drive did not open', () => {
    // "31 of 34 declared routes, all of them rendering" was the first wording, and `failures` counts only
    // the routes the drive opened: three of the thirty-four are never driven on this estate, so "all of
    // them" was a verdict on an app five sixths of which had been measured. The tell is a definite article
    // over a number no single field carries.
    const said = stamp({ served, driven });
    expect(said).not.toMatch(/all of them/);
    expect(said).toContain('The other 3 were not driven');
  });

  it('says nothing about undriven routes when there are none', () => {
    const every = { ...driven, drove: 34, declared: 34 };
    expect(stamp({ served, driven: every })).not.toMatch(/were not driven/);
  });

  it('says nothing has driven it when nothing has', () => {
    const said = stamp({ served });
    expect(said).toContain('**Driven:** never.');
  });

  it('says nothing has served it when there is no recording of one', () => {
    expect(stamp({})).toContain('Nothing has recorded the app being served.');
  });
});

describe('what may be recorded as a drive', () => {
  it('refuses a dev server, whatever data it is pointed at', () => {
    // The whole value of the stamp. Browser work ran for five days against a local server pointed at
    // labs, which reads in a write-up exactly like a drive of the deployed app; the served app is a
    // different bundle, process and binding, and both defects that the next real deploy found lived in
    // that difference. This throws before it asks the platform anything, so the refusal needs no network.
    for (const origin of ['http://localhost:8000', 'http://127.0.0.1:8000/', 'https://localhost:8443']) {
      expect(() => recordDriven({ origin, profile: 'labs', drove: 31, declared: 34, failures: 0, unreached: [] }))
        .toThrow(/dev server, not a served app/);
    }
  });
});

describe('how long ago the check says it was', () => {
  it('counts in hours below two days, because "0 days ago" beside an earlier date reads as a mistake', () => {
    expect(ago('2026-08-17T07:59:21Z', '2026-08-18T00:32:59Z')).toBe('16 hours ago');
    expect(ago('2026-08-18T00:00:00Z', '2026-08-18T00:29:00Z')).toBe('within the hour');
    expect(ago('2026-08-16T00:00:00Z', '2026-08-18T00:00:00Z')).toBe('2 days ago');
    expect(ago('2026-08-01T00:00:00Z', '2026-08-18T00:00:00Z')).toBe('17 days ago');
  });
});
