/**
 * What the vendoring check refuses, and what it lets past.
 *
 * The check exists because the last thing guarding this was a workflow step that failed on its first
 * line every run, so the tests that matter are the ones about it firing rather than about its prose.
 */
import { describe, expect, it } from 'vitest';

import {
  LOCK,
  problems,
  readers,
  readsVendoredSkills,
  VENDOR,
  type VendoringState as State,
} from './check-skill-vendoring.mjs';

/** The state the repository is in today, which has to be the passing one. */
function fallback(over: Partial<State> = {}): State {
  return { lock: false, ignored: true, script: null, scriptExists: false, readers: [], ...over };
}

const found = (state: State): readonly string[] => problems(state);

describe('the branch ADR 0002 actually took', () => {
  it('passes', () => {
    expect(found(fallback())).toEqual([]);
  });

  it('passes with a vendor:skills script that exists, because running one is not adopting it', () => {
    // The directory is still gitignored and nothing reads it. A developer populating it locally is
    // what ADR 0002 describes, and it is not the thing this check is watching for.
    expect(found(fallback({ script: 'scripts/vendor-skills.mjs', scriptExists: true }))).toEqual([]);
  });

  it('finds no reader in the repository as it stands', () => {
    // The real scan rather than a hand-supplied list. The first version of this file asserted the
    // case above with `readers: []` passed in, which asserted nothing about the scan that produces
    // it -- and the scan was wrong. A review found that; this is what would have.
    expect(readers()).toEqual([]);
  });
});

describe('adopting vendoring without bringing the gate back', () => {
  it('fails when the pin appears', () => {
    const [first] = found(fallback({ lock: true }));
    expect(first).toContain(LOCK);
    // The check has to say what to do, or it gets satisfied by deleting the check.
    expect(first).toContain('skills-drift.yml');
  });

  it('says the CLI compares against an installation, which is what 66 measured', () => {
    // The one fact that would otherwise be rediscovered by watching a repaired workflow open a false
    // issue: `update --check` answers `no skills installed` when nothing is installed, and the job's
    // grep reads that as drift.
    expect(found(fallback({ lock: true })).join(' ')).toMatch(/install.*before it compares/);
  });

  it('fails when something reads the gitignored directory', () => {
    const [first] = found(fallback({ readers: ['app/server/ai/ground.ts'] }));
    expect(first).toContain('app/server/ai/ground.ts');
    expect(first).toContain(VENDOR);
  });

  it('fails when the directory stops being ignored', () => {
    expect(found(fallback({ ignored: false })).join(' ')).toContain('.gitignore');
  });

  it('reports every problem at once rather than the first', () => {
    expect(found(fallback({ lock: true, ignored: false, readers: ['app/server/ai/ground.ts'] }))).toHaveLength(3);
  });
});

describe('an entry point to a branch nobody took', () => {
  it('fails when vendor:skills runs a file that is not there', () => {
    const [first] = found(fallback({ script: 'scripts/vendor-skills.mjs', scriptExists: false }));
    expect(first).toContain('MODULE_NOT_FOUND');
  });
});

describe('what counts as reading the vendored directory', () => {
  it('counts code', () => {
    expect(readsVendoredSkills('app/server/ai/ground.ts', "readFileSync('vendor/skills/x.md')")).toBe(true);
  });

  it('does not count prose, which is where the arrangement is discussed', () => {
    expect(readsVendoredSkills('docs/decisions/0002-vendoring-official-skills.md', 'app/vendor/skills/')).toBe(false);
  });

  it('does not count the workflow, which is the thing that comes back rather than a reader', () => {
    expect(readsVendoredSkills('.github/workflows/skills-drift.yml', 'app/vendor/skills')).toBe(false);
  });

  it('does not count itself', () => {
    expect(readsVendoredSkills('app/scripts/check-skill-vendoring.mjs', 'vendor/skills')).toBe(false);
  });

  it('does not count the script that populates the directory', () => {
    // ADR 0002's own `vendor:skills` entry point. It has to name the path it writes to, so a scan
    // that counts it fails the moment somebody restores the script the ADR describes -- and fails
    // with a message saying the app depends on a gitignored tree, which would be the opposite of
    // what happened. Writing the directory is not reading it.
    const populating = "const INTO = join(APP, 'vendor/skills');\nmkdirSync(INTO, { recursive: true });";
    expect(readsVendoredSkills('app/scripts/vendor-skills.mjs', populating)).toBe(false);
  });
});
