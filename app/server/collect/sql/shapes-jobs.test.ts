// The job row keeps the two identity columns apart: `run_as` is an ID and says nothing about the kind
// of identity, while `run_as_name` carries the email, application ID or group name that does.

import { describe, expect, it } from 'vitest';
import type { Row } from './rows.js';
import { parse } from './shapes.js';

function row(overrides: Row = {}): Row {
  return { workspace_id: '1', job_id: 'j-1', name: 'nightly-load', ...overrides };
}

describe('the job row parser', () => {
  it('reads the run-as ID and the run-as name as separate fields', () => {
    const [parsed] = parse.jobs([row({ run_as: '8800112233', run_as_name: 'alice@example.com' })]);

    expect(parsed?.runAs).toBe('8800112233');
    expect(parsed?.runAsName).toBe('alice@example.com');
  });

  it('leaves the run-as name absent when the column is null or missing', () => {
    const [withNull, withoutColumn] = parse.jobs([row({ run_as: '8800112233', run_as_name: null }), row()]);

    expect(withNull).not.toHaveProperty('runAsName');
    expect(withoutColumn).not.toHaveProperty('runAsName');
  });
});
