// What the projection lets out, asserted by planting secrets and looking for them.
//
// CI already checks that the deny-listed fields are *declared* as `:keys` or `:count` — that
// `spark_env_vars:keys` is what the probe table says. That is a check on the declaration. This is a
// check on the behaviour: the script's own projection function, run over response bodies carrying
// credentials in the places credentials really turn up, with the assertion that the output does not
// contain them.
//
// The distinction is not academic. A declaration is right or wrong once, at review time; the code
// that honours it is what runs against a customer's estate. And the two can drift apart silently in
// either direction — a `:keys` suffix that the projection stopped recognising would emit the whole
// object and every existing check would still pass.
//
// The planted values are sentinels rather than credential-shaped strings. The first draft used the
// shapes scanners look for — a `dapi` token, an AWS key pair, a Postgres URL — and the repository's
// own pre-commit scanner blocked the commit, correctly: a file asserting that credentials do not leak
// is a poor place to commit five strings indistinguishable from live ones. Nothing is lost, because
// what the assertion needs is a value it can search the output for. Naming each sentinel after where
// it was planted buys something the realistic version did not have — a failure says which field leaked.
//
// One honest gap, stated because the alternative is implying otherwise: the live run that these
// bodies are modelled on had no clusters at all — both test workspaces are serverless — so the
// cluster paths here are driven by hand-written bodies in the API's shape rather than by a real
// response. The field names and nesting come from the real `clusters/list` contract; the secrets are
// invented.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceDirectory, SCRIPT_NAME } from './script.js';

const SCRIPT = join(evidenceDirectory(), SCRIPT_NAME);

/**
 * Sentinels that must not survive a projection, whatever field they arrive in.
 *
 * Each names the field it stands in for, so a failure reads as the leak it is rather than as a
 * mismatch between two opaque strings.
 */
const SECRETS: readonly string[] = [
  'SENTINEL-cluster-env-var-value-must-not-leak',
  'SENTINEL-cloud-key-material-must-not-leak',
  'SENTINEL-undeclared-field-value-must-not-leak',
  'SENTINEL-url-embedded-credential-must-not-leak',
  'SENTINEL-init-script-query-string-must-not-leak',
];

/**
 * What the script keeps from `body` for the probe labelled `label`.
 *
 * Runs the script's own `project` against its own declared fields, so this cannot pass against a
 * projection nobody ships or a field list nobody declared.
 */
function kept(label: string, body: unknown): string {
  const program = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("collector", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'sys.modules["collector"] = module',
    'spec.loader.exec_module(module)',
    'label, body = json.loads(sys.stdin.read())',
    'probe = next(one for one in module.PROBES if one.label == label)',
    'shaped = module.shallow(body) if probe.shape == "shallow" else module.project(body, probe.fields)',
    'sys.stdout.write(json.dumps(shaped, sort_keys=True))',
  ].join('\n');

  return execFileSync('python3', ['-c', program, SCRIPT], {
    input: JSON.stringify([label, body]),
    encoding: 'utf8',
  });
}

/** The projection's output as a shape a test can read a count off. */
function shaped(output: string): Record<string, readonly Record<string, unknown>[]> {
  return JSON.parse(output) as Record<string, readonly Record<string, unknown>[]>;
}

function assertNothingLeaked(output: string): void {
  for (const secret of SECRETS) {
    expect(output).not.toContain(secret);
  }
}

describe('the projection cannot carry a credential out of a response', () => {
  it('keeps the names of cluster environment variables and none of their values', () => {
    const output = kept('clusters', {
      clusters: [
        {
          cluster_id: '0801-123456-abcdef',
          cluster_name: 'shared-etl',
          spark_version: '15.4.x-scala2.12',
          data_security_mode: 'USER_ISOLATION',
          spark_env_vars: { DB_TOKEN: SECRETS[0], AWS_SECRET_ACCESS_KEY: SECRETS[1] },
          // Not declared by the probe at all, so it should not appear even as a key name.
          spark_conf: { 'spark.hadoop.fs.s3a.secret.key': SECRETS[2] },
        },
      ],
    });

    assertNothingLeaked(output);
    // The names are the point: a requirement about credentials on clusters is answered by knowing
    // that a variable called DB_TOKEN exists, and answering it does not need its value.
    expect(output).toContain('DB_TOKEN');
    expect(output).toContain('AWS_SECRET_ACCESS_KEY');
    // An undeclared field is discarded whole, so its keys go with its values.
    expect(output).not.toContain('spark_conf');
    expect(output).not.toContain('s3a.secret.key');
  });

  it('counts init scripts rather than naming where they come from', () => {
    const output = kept('clusters', {
      clusters: [
        {
          cluster_id: '0801-123456-abcdef',
          init_scripts: [{ s3: { destination: `s3://bucket/bootstrap.sh?token=${SECRETS[4]}` } }, { volumes: {} }],
        },
      ],
    });

    assertNothingLeaked(output);
    expect(output).not.toContain('bootstrap.sh');
    expect(shaped(output).clusters[0]['init_scripts:count']).toBe(2);
  });

  it('keeps a library kind without the repository URL that can carry credentials in it', () => {
    const output = kept('cluster-libraries', {
      statuses: [
        {
          cluster_id: '0801-123456-abcdef',
          library_statuses: [
            { status: 'INSTALLED', library: { pypi: { package: 'requests', repo: `https://user:${SECRETS[3]}@pypi.internal/simple` } } },
          ],
        },
      ],
    });

    assertNothingLeaked(output);
    expect(output).not.toContain('pypi.internal');
  });

  it('counts group members rather than listing who they are', () => {
    const output = kept('scim-groups', {
      Resources: [
        {
          id: '86434373858609',
          displayName: 'admins',
          members: [
            { display: 'Ada Lovelace', value: '1', userName: 'ada@example.com' },
            { display: 'Alan Turing', value: '2', userName: 'alan@example.com' },
          ],
        },
      ],
    });

    // Not a credential but personal data, and the requirement needs the size of the admin group
    // rather than its roll. Same mechanism, different reason.
    expect(output).not.toContain('ada@example.com');
    expect(output).not.toContain('Ada Lovelace');
    expect(shaped(output).Resources[0]['members:count']).toBe(2);
  });

  it('keeps a secret scope\u2019s name and backend, never anything inside it', () => {
    // The endpoint that would return what is inside a scope is not called at all — CI asserts the
    // script does not name it. This is the neighbouring guarantee: what the scope list itself returns
    // is projected down to the two fields the requirement needs.
    const output = kept('secret-scopes', {
      scopes: [{ name: 'prod-keys', backend_type: 'DATABRICKS', keyvault_metadata: { resource_id: SECRETS[3] } }],
    });

    assertNothingLeaked(output);
    expect(output).toContain('prod-keys');
    expect(output).not.toContain('keyvault_metadata');
  });

  it('drops an undeclared field even when the response grows one', () => {
    // The case that matters for next year: the API adds a field, nobody notices, and the projection
    // is what stands between that field and a file an admin emails out.
    const output = kept('uc-storage-credentials', {
      storage_credentials: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          name: 'managed',
          aws_iam_role: { external_id: SECRETS[2], unrolled_credential: SECRETS[0] },
          azure_service_principal: { client_secret: SECRETS[1] },
        },
      ],
    });

    assertNothingLeaked(output);
    expect(output).not.toContain('client_secret');
  });

  it('truncates a single field long enough to be a payload rather than a value', () => {
    // `shallow` is the mode used for the typed settings endpoints, where the fields are not declared
    // one by one. It keeps scalars, so the cap is what stops one scalar being a megabyte.
    const output = kept('setting-compliance-security-profile', {
      compliance_security_profile_workspace: { is_enabled: true, compliance_standards: 'x'.repeat(50_000) },
      etag: 'abc',
    });

    expect(output.length).toBeLessThan(2_000);
    // The etag is excluded by name: it is a concurrency token for writing the setting back, and this
    // script never writes anything.
    expect(output).not.toContain('etag');
  });
});
