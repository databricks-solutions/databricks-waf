// Which scopes this app asks for, read from the file the platform reads.
//
// Needed because two refusals are byte-identical and mean opposite things. "Invalid scope,
// required scopes: clusters" is permanent when the app never asked for `clusters`, and
// temporary when it did and this user's consent predates the request. Separating them needs
// the declared list at runtime.
//
// Read from `app.yaml` rather than restated in TypeScript. A constant here would be a third
// copy alongside `app.yaml` and `databricks.yml`, and `check:resources` holds those two together
// precisely because copies drift. Reading the shipped file means there is nothing to hold.
//
// Not read from the app object over the API either, which would be authoritative about what
// was requested: that is a control-plane round trip to learn something already on disk, on
// the path of a diagnostic whose whole point is to be cheap.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

/**
 * `app.yaml` as deployed, found by walking up from this module.
 *
 * Walking rather than a fixed relative path because the compiled layout and the source layout
 * differ in depth, and a path correct in one is silently wrong in the other — silently,
 * because a missing file here degrades to an empty list, which is the safe direction and also
 * the invisible one.
 */
function appYaml(from: string): string | undefined {
  let directory = dirname(fileURLToPath(from));

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      return readFileSync(join(directory, 'app.yaml'), 'utf8');
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
  return undefined;
}

/**
 * The scopes `app.yaml` declares, or an empty list if it cannot be read.
 *
 * Empty is the honest answer for "cannot tell", and it is also the one that makes every scope
 * refusal report as permanent. That is the right way round: telling someone their consent is
 * stale, when the truth is that the file could not be read, sends them to re-authorise for a
 * scope the app never wanted.
 */
export function declaredScopes(from: string = import.meta.url): readonly string[] {
  const text = appYaml(from);
  if (text == null) return [];

  try {
    const parsed = load(text);
    if (typeof parsed !== 'object' || parsed === null) return [];

    const scopes = (parsed as Record<string, unknown>)['user_api_scopes'];
    if (!Array.isArray(scopes)) return [];

    return scopes.filter((scope): scope is string => typeof scope === 'string');
  } catch {
    return [];
  }
}
