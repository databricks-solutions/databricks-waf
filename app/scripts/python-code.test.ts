// Whether the checks on the admin evidence script can fail.
//
// `check-evidence-script.mjs` asserts, among other things, that the script never names `secrets/get`
// and never names a mutating verb. Both are `includes` against `codeOf(...)`, so the whole force of
// those checks rests on this function keeping the string literals and dropping only the prose. Get it
// wrong in one direction and the checks fail on their own documentation; wrong in the other and they
// pass on a script that reads secrets.
//
// It was wrong in the second direction for a while, and nothing noticed, because a check that has
// stopped being able to fail looks exactly like a check that is passing. So these are mostly
// assertions that something is *seen* — the direction with no symptom.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOf } from './python-code.mjs';

/** Tokenise `text` as a Python file. */
function read(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'python-code-')), 'sample.py');
  writeFileSync(file, text);
  return codeOf(file);
}

describe('prose is dropped, so a check cannot fail on its own documentation', () => {
  it('drops a module docstring', () => {
    expect(read('"""This module never calls secrets/get."""\nX = 1\n')).not.toContain('secrets/get');
  });

  it('drops a module docstring under a shebang', () => {
    // The shape the evidence script actually has. A comment does not complete a statement, so it
    // cannot be what makes the following string look like data.
    const body = read('#!/usr/bin/env python3\n"""Never POST, never secrets/get."""\nX = 1\n');
    expect(body).not.toContain('secrets/get');
    expect(body).not.toContain('POST');
  });

  it('drops a function and a class docstring', () => {
    const body = read(
      ['class Thing:', '    """Not a DELETE."""', '', '    def act(self):', '        """No secrets/get here."""', '        return 1'].join('\n')
    );
    expect(body).not.toContain('DELETE');
    expect(body).not.toContain('secrets/get');
    expect(body).toContain('act');
  });

  it('drops a comment, including one inside a collection', () => {
    expect(read('PATHS = (\n    # not secrets/get\n    "/api/2.0/clusters/list",\n)\n')).not.toContain('secrets/get');
  });
});

describe('code is kept, so a check can still fail', () => {
  it('keeps a string on its own line inside a tuple', () => {
    // The regression. Every endpoint path and field name in the probe table is written like this.
    expect(read('PATHS = (\n    "/api/2.0/secrets/get",\n    "/api/2.0/clusters/list",\n)\n')).toContain('secrets/get');
  });

  it('keeps strings nested two collections deep', () => {
    const body = read('PROBES = [\n    {\n        "fields": (\n            "spark_env_vars",\n        ),\n    },\n]\n');
    expect(body).toContain('spark_env_vars');
  });

  it('keeps a string that follows a completed statement inside brackets', () => {
    expect(read('CALL = dict(\n    verb="post",\n    path="/api/2.0/dbfs/read",\n)\n')).toContain('dbfs/read');
  });

  it('keeps a bare string expression that is not a docstring', () => {
    // Not prose by intent, but it stands where a statement stands, so it reads as prose and is
    // dropped. Worth pinning: it is the one case where the rule gives up something, and giving up a
    // string that no probe table would ever contain is the safe direction.
    expect(read('X = 1\n\n"secrets/get"\n')).not.toContain('secrets/get');
  });

  it('keeps an assigned string that merely mentions a forbidden name', () => {
    expect(read('WHY = "we do not call secrets/get"\n')).toContain('secrets/get');
  });

  it('is not fooled by a hash inside a string', () => {
    expect(read('PATH = "/api/2.0/x#secrets/get"\n')).toContain('secrets/get');
  });

  it('is not fooled by a forbidden name inside a triple-quoted assignment', () => {
    expect(read('HELP = """\nsecrets/get\n"""\n')).toContain('secrets/get');
  });
});
