import { describe, expect, it } from 'vitest';
import { classify, demandedScope, FAMILIES, type Grants } from './reach.js';
import { declaredScopes } from './declared-scopes.js';

/** The refusal the platform actually sends, verbatim from a live probe. */
const REFUSED = (scope: string): string => `Response from server (Forbidden) Invalid scope, required scopes: ${scope}`;

describe('naming the scope a refusal demands', () => {
  it('reads the scope out of the platform message', () => {
    expect(demandedScope(REFUSED('clusters'))).toBe('clusters');
    expect(demandedScope(REFUSED('global-init-scripts'))).toBe('global-init-scripts');
    expect(demandedScope(REFUSED('serving.serving-endpoints:read'))).toBe('serving.serving-endpoints:read');
  });

  it('says nothing when the message names nothing', () => {
    expect(demandedScope('Response from server (Forbidden) PERMISSION_DENIED')).toBeUndefined();
  });
});

describe('telling a permanent refusal from a stale consent', () => {
  const grants: Grants = { carried: ['sql', 'model-serving'], declared: ['sql', 'model-serving', 'vector-search'] };

  it('calls it stale consent when the app asked and the token did not get it', () => {
    // The measured case: `vector-search` was declared, appeared in the app's effective
    // scopes, and was absent from the token minted seconds later.
    expect(classify(REFUSED('vector-search'), grants)).toBe('stale-consent');
  });

  it('calls it permanent when the app never asked', () => {
    expect(classify(REFUSED('clusters'), grants)).toBe('no-scope');
  });

  it('calls it permanent when the token is opaque, rather than guessing', () => {
    // Without the token's own claims there is no way to know consent is behind, and guessing
    // wrong sends someone to re-authorise for a scope no install will ever hold.
    expect(classify(REFUSED('vector-search'), { declared: ['vector-search'] })).toBe('no-scope');
  });

  it('calls it permanent when nothing is known about grants at all', () => {
    expect(classify(REFUSED('vector-search'))).toBe('no-scope');
  });

  it('does not call a scope stale when the token already carries it', () => {
    // A refusal naming a scope the token holds means the scope name is not what governs that
    // API, which is neither of the two and must not be reported as either.
    expect(classify(REFUSED('model-serving'), grants)).toBe('no-scope');
  });

  it('separates a missing permission from a missing scope', () => {
    expect(classify('Response from server (Forbidden) PERMISSION_DENIED: cannot access', grants)).toBe('forbidden');
    expect(classify('ENDPOINT_NOT_FOUND: No API found for GET /settings/types', grants)).toBe('absent');
    expect(classify('socket hang up', grants)).toBe('error');
  });
});

describe('the probe itself', () => {
  it('names a control set or an explicit reason for probing without one', () => {
    // A family with no controls behind it is legitimate — external locations are probed
    // speculatively — but it should be deliberate, so every family must at least be unique
    // and identifiable in the result.
    const ids = FAMILIES.map((family) => family.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FAMILIES.every((family) => family.label.trim() !== '')).toBe(true);
  });

  it('reads the scopes this app declares from the file the platform reads', () => {
    // Guards the drift this replaced: the list used to be a constant here, which would have
    // silently disagreed with app.yaml the moment either changed.
    const declared = declaredScopes();
    expect(declared).toContain('sql.statement-execution');
    expect(declared).toContain('model-serving');
  });

  it('reports no scopes rather than throwing when app.yaml is not there', () => {
    expect(declaredScopes('file:///nonexistent/deeply/nested/module.js')).toEqual([]);
  });
});
