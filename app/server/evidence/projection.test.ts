// What the projection records, held against what the response actually said.
//
// The leak test next door asserts what must never come out. This asserts the other half: that what
// does come out means what a consumer will read it as. The two are separate files because they fail
// for different reasons and a reader chasing one should not have to read the other.
//
// The case that motivated it is `workspace-conf`, which answers with one entry per key it
// recognises. So there are three states per key and only two of them are values: answered with
// something, answered as null, or not answered at all. The first draft wrote null for the last two,
// which reads as "the setting exists and has never been set" — a finding — when the truth was "this
// workspace tier does not have this setting" — unmeasured. On the labs workspace that was twelve of
// fifteen keys, so the difference is not a corner case.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceDirectory, SCRIPT_NAME } from './script.js';

const SCRIPT = join(evidenceDirectory(), SCRIPT_NAME);

/**
 * The script's own `project`, run over a body and a field list.
 *
 * Calls into the file the app publishes rather than reimplementing the rules, because a second
 * implementation of a projection would agree with the first exactly until the day it mattered.
 */
function project(body: unknown, fields: readonly string[]): Record<string, unknown> {
  const program = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("collector", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'sys.modules["collector"] = module',
    'spec.loader.exec_module(module)',
    'body, fields = json.loads(sys.stdin.read())',
    'sys.stdout.write(json.dumps(module.project(body, fields)))',
  ].join('\n');

  const output = execFileSync('python3', ['-c', program, SCRIPT], {
    input: JSON.stringify([body, fields]),
    encoding: 'utf8',
  });
  return JSON.parse(output) as Record<string, unknown>;
}

describe('a declared field the response did not carry', () => {
  it('is absent from the projection, where a field answered as null is null', () => {
    const kept = project(
      { enableIpAccessLists: 'true', enableVerboseAuditLogs: null },
      ['enableIpAccessLists', 'enableVerboseAuditLogs', 'enableJobViewAcls']
    );

    expect(kept).toStrictEqual({ enableIpAccessLists: 'true', enableVerboseAuditLogs: null });
    // The assertion the whole change is for: `in` distinguishes these two, and `?? null` does not.
    expect('enableVerboseAuditLogs' in kept).toBe(true);
    expect('enableJobViewAcls' in kept).toBe(false);
  });

  it('lets a consumer recover what was asked for and not answered, from fields minus keys', () => {
    // How the import is meant to reconstruct `WorkspaceSettings.unanswered`. Asserted here so that
    // the reconstruction is a property of the envelope rather than a convention two files share.
    const fields = ['a', 'b', 'c'];
    const kept = project({ a: 'true', b: null }, fields);

    expect(fields.filter((field) => !(field in kept))).toStrictEqual(['c']);
  });

  it('is absent rather than null for the shape-only forms', () => {
    const withNothing = project({ cluster_id: '1' }, ['cluster_id', 'spark_env_vars:keys', 'init_scripts:count']);
    expect(withNothing).toStrictEqual({ cluster_id: '1' });

    // Answered as null is a different fact again: the cluster has the field and it is empty.
    const withNulls = project(
      { cluster_id: '1', spark_env_vars: null, init_scripts: null },
      ['cluster_id', 'spark_env_vars:keys', 'init_scripts:count']
    );
    expect(withNulls).toStrictEqual({ cluster_id: '1', 'spark_env_vars:keys': null, 'init_scripts:count': null });
  });

  it('keeps a null object as null rather than as an object with nothing in it', () => {
    expect(project({ aws_attributes: null }, ['aws_attributes.instance_profile_arn'])).toStrictEqual({
      aws_attributes: null,
    });
    expect(project({ aws_attributes: {} }, ['aws_attributes.instance_profile_arn'])).toStrictEqual({
      aws_attributes: {},
    });
  });

  it('omits per element, so one row missing a field does not speak for the others', () => {
    const kept = project(
      { clusters: [{ cluster_id: '1', data_security_mode: 'USER_ISOLATION' }, { cluster_id: '2' }] },
      ['clusters[].cluster_id', 'clusters[].data_security_mode']
    );

    expect(kept).toStrictEqual({
      clusters: [{ cluster_id: '1', data_security_mode: 'USER_ISOLATION' }, { cluster_id: '2' }],
    });
  });
});
