import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { refusalToMisname, refusalToOverwrite, refusalToStray } from './recording-guards.mjs';
import type { JobAuditInputs } from './measure-job-audit-inputs.d.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(BASELINES, name), 'utf8')) as T;
}

const fieldEng = read<JobAuditInputs>('large-estate-job-audit-inputs.json');

describe('a recording may not be overwritten by one taken somewhere else', () => {
  // `41b`'s first deliverable, and the reason it was first: the script wrote to a fixed labs path, so pointing
  // it at a second estate would have replaced the recording every assertion in its test file reads, and the two
  // estates' numbers would have been indistinguishable afterwards with one of them gone.
  it('stops a run whose host is not the host the recording on disk came from', () => {
    const refusal = refusalToOverwrite(
      '/tmp/labs-thing.json',
      { ...fieldEng, host: 'https://a.example' },
      'https://b.example'
    );
    expect(refusal).toMatch(/was taken from https:\/\/a\.example/);
    expect(refusal).toMatch(/DATABRICKS_CONFIG_PROFILE/);
  });

  it('names the file it is refusing to write, since that is the thing being protected', () => {
    // The path is a parameter rather than a module constant because two scripts now share these guards, and a
    // refusal naming the other script's recording would send the reader to a file that is not at risk.
    expect(
      refusalToOverwrite('/tmp/labs-table-layout-inputs.json', { host: 'https://a.example' }, 'https://b.example')
    ).toMatch(/^\/tmp\/labs-table-layout-inputs\.json was taken from/);
  });

  it('allows a re-run on the same estate, which is what the scripts are for', () => {
    expect(
      refusalToOverwrite('/tmp/r.json', { ...fieldEng, host: 'https://a.example' }, 'https://a.example')
    ).toBeNull();
    expect(refusalToOverwrite('/tmp/r.json', null, 'https://a.example')).toBeNull();
  });

  it('does not refuse where either side is silent, because that is not a mismatch', () => {
    // A recording from before this field existed says nothing about its host; refusing on that would be a claim
    // the file cannot support. The name carries the estate in the meantime.
    expect(refusalToOverwrite('/tmp/r.json', { ...fieldEng, host: '' }, 'https://a.example')).toBeNull();
    expect(refusalToOverwrite('/tmp/r.json', { ...fieldEng, host: 'https://a.example' }, '')).toBeNull();
  });

  // The hole the overwrite guard cannot close, because the first write is where the name is decided and there is
  // nothing on disk to compare against.
  it('refuses a run whose profile names a different host than the one being read', () => {
    const refusal = refusalToMisname('named-profile', 'https://field.example', 'https://labs.example');
    expect(refusal).toMatch(
      /^profile named-profile names https:\/\/labs\.example but this run reads https:\/\/field\.example/
    );
    expect(refusal).toMatch(/DATABRICKS_HOST/);
  });

  it('allows the run where they agree, and cannot tell where the config is silent', () => {
    expect(refusalToMisname('labs', 'https://labs.example', 'https://labs.example')).toBeNull();
    // An absent config entry is not evidence of a mismatch, and treating it as one would fail every run on a
    // machine without this profile — including CI.
    expect(refusalToMisname('labs', 'https://labs.example', null)).toBeNull();
    expect(refusalToMisname('labs', '', 'https://labs.example')).toBeNull();
  });

  // The hole the other two cannot close, and the one `79` found eleven scripts sitting in: a filename that is
  // a module constant rather than built from the profile. Both host comparisons pass on a correctly
  // configured second profile, and the numbers land under the first estate's name anyway.
  it('refuses a run whose profile is not the estate the filename names', () => {
    const refusal = refusalToStray('/x/runtime-baseline/labs-plan-joins.json', 'large-estate');
    expect(refusal).toMatch(/^labs-plan-joins\.json is named for another estate/);
    expect(refusal).toMatch(/DATABRICKS_CONFIG_PROFILE/);
  });

  it('allows the name the profile builds, in both spellings the tree uses', () => {
    expect(refusalToStray('/x/labs-plan-joins.json', 'labs')).toBeNull();
    // `labs.json` is the SQL baseline and predates the prefix convention. It is the recording
    // `check:sql-release` gates the build on, so it is the one that most needs to be writable on labs.
    expect(refusalToStray('/x/labs.json', 'labs')).toBeNull();
    // A profile may contain a hyphen, so the name is matched against the whole profile rather than parsed
    // at the first one — otherwise every `large-estate-` recording refuses its own estate.
    expect(refusalToStray('/x/large-estate-job-audit-inputs.json', 'large-estate')).toBeNull();
  });

  it('cannot tell where there is no profile, which is not a mismatch', () => {
    expect(refusalToStray('/x/labs.json', '')).toBeNull();
  });
});

describe('every script that writes a recording applies the guards', () => {
  // This is the test the eleven needed and did not have. Both halves of `79` were invisible to a unit test of
  // the predicates, because both were about whether a script *called* them: one passed the arguments in the
  // wrong order and threw the result away, ten never imported them. A guard whose contract is "check my
  // return value" cannot tell whether anybody did, so what is checked here is the source rather than the
  // behaviour — the one thing that scales to a twentieth script nobody remembers to wire up.
  const HERE_SCRIPTS = dirname(fileURLToPath(import.meta.url));

  const scripts = readdirSync(HERE_SCRIPTS)
    .filter((name) => /^measure-.*\.m[jt]s$/.test(name))
    .map((name) => ({ name, source: readFileSync(join(HERE_SCRIPTS, name), 'utf8') }))
    // Writing into `runtime-baseline/` is what makes a script one of these. A script that only reads a
    // recording — to compare against, or to decide whether to run — is not naming an estate and is not at
    // risk, so matching on the write keeps the list to the scripts the rule is about.
    .filter(({ source }) => /runtime-baseline/.test(source) && /writeFileSync\(/.test(source));

  it('finds the recording scripts, so an empty list cannot pass this file', () => {
    // Without this the two assertions below are vacuously true the moment the filter stops matching, which is
    // the failure mode of every census test written against a directory.
    expect(scripts.length).toBeGreaterThanOrEqual(19);
  });

  for (const { name, source } of scripts) {
    it(`${name} calls refuseUnlessNamedForItsEstate`, () => {
      expect(source).toContain('refuseUnlessNamedForItsEstate(');
    });

    it(`${name} does not assemble the predicates itself`, () => {
      // The predicates are the rule and applying them is not a caller's job — that is exactly what the one
      // mis-call did. A script reaching for them directly is how the next one drifts.
      expect(source).not.toMatch(/\brefusalTo(Misname|Overwrite|Stray)\s*\(/);
    });
  }
});

describe('every recording states the estate it came from', () => {
  // The guards above are worth nothing if the field they compare is absent, so this holds the recordings
  // themselves rather than the functions: both scripts, both estates.
  const recordings: readonly {
    readonly file: string;
    readonly profile: string;
    readonly host: string;
    readonly warehouse: string;
  }[] = [
    { file: 'labs-job-audit-inputs.json', profile: 'labs', host: 'dbc-example', warehouse: '0123456789abcdef' },
    {
      file: 'large-estate-job-audit-inputs.json',
      profile: 'large-estate',
      host: 'example.cloud.databricks.com',
      warehouse: '0011223344556677',
    },
    { file: 'labs-table-layout-inputs.json', profile: 'labs', host: 'dbc-example', warehouse: '0123456789abcdef' },
    // `36t`'s throttle reading, and the estate is load-bearing on this one in a way it is not on the
    // others: what it records is a workspace's refusal boundary, and the same script run against a
    // busier workspace would find a different one. A recording that did not name where it came from
    // would read as a claim about the Statement Execution API.
    {
      file: 'labs-throttle-response.json',
      profile: 'labs',
      host: 'dbc-example',
      // A different warehouse from the two above, and deliberately the one the app itself scans through.
      // What this recording measures is the Statement Execution API's admission of a `wait_timeout: 0s`
      // submission, which never reaches the warehouse's execution — but the id is still the apparatus,
      // and a reader comparing this against a later reading needs to know the submissions went to the
      // same place.
      warehouse: '0123456789abcdef',
    },
    {
      file: 'large-estate-table-layout-inputs.json',
      profile: 'large-estate',
      host: 'example.cloud.databricks.com',
      warehouse: '0011223344556677',
    },
  ];

  for (const { file, profile, host, warehouse } of recordings) {
    it(`${file} names its estate, host and warehouse`, () => {
      const recording = read<{ profile: string; host: string; warehouse: string }>(file);
      expect(recording.profile).toBe(profile);
      expect(recording.host).toContain(host);
      // The exact id, not its shape. The write-ups name this warehouse, and on a shared estate a recording
      // re-taken through a different one is a different apparatus — which a pattern match would let through
      // silently, and which is the whole reason these three fields are in the file.
      expect(recording.warehouse).toBe(warehouse);
    });
  }
});
