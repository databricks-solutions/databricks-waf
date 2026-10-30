// Who counts as an assessor when somebody is only reading.
//
// The same rule the gate applies to a change, asked of a request that may also arrive with no token
// or while the identity lookup is down. Both of those have to read as "not an assessor": the answer
// decides whether detail is shown, and nothing short of a proven direct membership may show it.

import { describe, expect, it } from 'vitest';

import type { CurrentUser, ScopeProbe } from '../collect/estate-scope.js';
import { assessorCheck } from './reader.js';

const GROUP = 'waf-assessors';

function request(headers: Record<string, string> = { 'x-forwarded-access-token': 'token' }) {
  return { headers };
}

function checking(answer: CurrentUser | Error) {
  const asked: ScopeProbe[] = [];
  const check = assessorCheck({
    host: 'https://example.cloud.databricks.com',
    assessorGroup: GROUP,
    probe: (probe) => {
      asked.push(probe);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  });
  return { check, asked };
}

describe('the assessor check', () => {
  it('admits a direct member of the group, however the group is cased', async () => {
    const { check } = checking({ userName: 'a@example.com', groups: ['users', 'WAF-Assessors'] });

    expect(await check(request())).toBe(true);
  });

  it('turns away a caller outside the group', async () => {
    const { check } = checking({ userName: 'a@example.com', groups: ['users'] });

    expect(await check(request())).toBe(false);
  });

  it('turns away a caller whose groups the workspace did not list', async () => {
    const { check } = checking({ userName: 'a@example.com' });

    expect(await check(request())).toBe(false);
  });

  it('turns away a request with no token, without asking the workspace anything', async () => {
    const { check, asked } = checking({ userName: 'a@example.com', groups: [GROUP] });

    expect(await check(request({}))).toBe(false);
    expect(asked).toEqual([]);
  });

  it('turns away a caller when the lookup fails outright', async () => {
    const { check } = checking(new Error('connect ECONNREFUSED'));

    expect(await check(request())).toBe(false);
  });

  it('turns away a caller whose forwarded identity is not the one the workspace verified', async () => {
    const { check } = checking({ userName: 'a@example.com', groups: [GROUP] });

    expect(await check(request({ 'x-forwarded-access-token': 'token', 'x-forwarded-email': 'someone-else@example.com' }))).toBe(
      false
    );
    expect(await check(request({ 'x-forwarded-access-token': 'token', 'x-forwarded-email': 'A@Example.com' }))).toBe(true);
  });

  it('asks the workspace with the forwarded token, once for a request however often it is asked', async () => {
    const { check, asked } = checking({ userName: 'a@example.com', groups: [GROUP] });
    const one = request();

    await Promise.all([check(one), check(one)]);
    await check(one);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.token).toBe('token');

    await check(request());
    expect(asked).toHaveLength(2);
  });
});
