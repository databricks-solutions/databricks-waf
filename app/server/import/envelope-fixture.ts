// A document that passes every rule in `envelope.ts`, for a test to break one thing about.
//
// Its own module rather than a helper inside `envelope.test.ts`, because three suites want it and
// importing it from a test file makes that file's own suite run again inside each importer. Which is
// harmless and misleading: a failure in the schema tests would then be reported under the route tests
// as well, and a reader chasing it starts in the wrong file.
//
// Deliberately untyped — `Record<string, unknown>` rather than `Envelope`. Every consumer's job is to
// produce a document the parser refuses, and a builder returning the parsed type could not express one.

import { SCHEMA } from './envelope.js';

/**
 * The builders take `undefined` to mean "remove this field", which is what a document missing a field
 * actually looks like. Left in place it would be a key holding undefined — a thing JSON cannot express,
 * so a test asserting on it would be testing a document no upload can produce.
 */
function without(held: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(held).filter(([, value]) => value !== undefined));
}

/** One probe that satisfies every rule. */
export function probe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return without({
    signals: ['rest:workspace:preview.workspace-conf'],
    tier: 'workspace',
    label: 'workspace-conf',
    endpoint: 'GET /api/2.0/workspace-conf?keys=enableIpAccessLists',
    controls: ['SCP-01-04'],
    fields: ['enableIpAccessLists'],
    shape: 'projected',
    status: 'observed',
    value: { enableIpAccessLists: 'true' },
    ...overrides,
  });
}

export function identity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return without({
    username: 'admin@example.com',
    host: 'https://dbc-00000000-0000.cloud.databricks.com',
    account_id: '00000000-1111-2222-3333-444444444444',
    workspace_id: '7000000000000001',
    auth_type: 'databricks-cli',
    profile: 'labs',
    read: 'json',
    ...overrides,
  });
}

/** A whole envelope that passes. Its `digest` is a placeholder; `trust.ts` recomputes it. */
export function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return without({
    schema: SCHEMA,
    generated_at: '2026-08-03T10:41:52Z',
    script: { name: 'collect-evidence.py', version: '1', digest: `sha256:${'a'.repeat(64)}` },
    cli: { version: 'Databricks CLI v1.1.0' },
    tiers: {
      workspace: { ran: true, identity: identity() },
      account: { ran: false, reason: 'The account tier was not run.' },
    },
    probes: [probe()],
    deferred: [{ signal: 'rest:workspace:permissions.jobs.{job_id}', reason: 'One call per job.' }],
    digest: `sha256:${'b'.repeat(64)}`,
    ...overrides,
  });
}
