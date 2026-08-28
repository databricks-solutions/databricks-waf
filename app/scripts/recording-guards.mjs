// The guards that keep one estate's recording from being written under another estate's name.
//
// Written for `41b` inside `measure-job-audit-inputs.mjs` and lifted here by `41d`, which is the second
// script to record a reading per estate. They are one definition rather than two because what they protect
// is a filename, and two copies of a rule about filenames is how the copies drift apart.
//
// The failure they exist for is described in `docs/estates.md`: `DATABRICKS_HOST` in the environment beats
// `--profile`, and the profile supplies only the token, so `DATABRICKS_CONFIG_PROFILE=your-profile` beside a
// field-eng `DATABRICKS_HOST` is a valid run that writes field-eng's numbers under the labs name. Nothing
// else in a measurement script would notice: every probe succeeds, every number is plausible, and the file
// it lands in is the one a check reads.
//
// There are three, because they cover different moments. `refusalToMisname` is the only one that can fire
// on the *first* write, which is where the name is decided and there is nothing on disk to compare against.
// `refusalToOverwrite` covers every write afterwards, where the recording on disk says where it came from.
// `refusalToStray` covers the case neither of those reaches: a script whose recording filename is a
// constant, which is eleven of the twenty here and was found unguarded by `79`.
//
// **`refuseUnlessNamedForItsEstate` is what a script calls, and it is the only supported way to apply
// these.** The predicates are the rule; assembling them is not a thing a caller should be doing, for the
// reason in that function's own header. `recording-guards.test.ts` reads the sources and fails when a
// script that writes into `runtime-baseline/` does not call it, so a twenty-first cannot be missed the way
// the eleven were.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Why the filename may not be trusted to name the estate.
 *
 * Silence on either side reads as "cannot tell" and does not stop the run: an absent config entry is not
 * evidence of a mismatch, and inventing one would fail every CI run of the tests below.
 */
export function refusalToMisname(profile, host, configured) {
  if (configured == null || host === '') return null;
  if (configured === host) return null;
  return (
    `profile ${profile} names ${configured} but this run reads ${host}, so a recording written ` +
    `as ${profile}- would hold another estate's numbers. Clear DATABRICKS_HOST, or set ` +
    'DATABRICKS_CONFIG_PROFILE to the profile for the host you mean.'
  );
}

/**
 * Why a run may not write over what is already there.
 *
 * Only a host mismatch stops it. Re-taking a reading on the same estate is the point of these scripts, and a
 * recording of the same estate at a later date supersedes rather than conflicts. Silence on either side reads
 * as "cannot tell" for the same reason as above.
 *
 * **The permissive branch is load-bearing and it is wider than it was described as.** The comment here used
 * to say every recording in the tree states its host, so silence meant a file from elsewhere. `79` counted:
 * ten of them do not, including `labs.json`, which is the recording `check:sql-release` gates the build on.
 * Those ten are covered by `refusalToStray` below instead, which needs nothing from the file.
 */
export function refusalToOverwrite(path, existing, host) {
  if (existing == null) return null;
  const was = typeof existing.host === 'string' ? existing.host : '';
  if (was === '' || host === '' || was === host) return null;
  return (
    `${path} was taken from ${was} and this run is against ${host}. ` +
    'Set DATABRICKS_CONFIG_PROFILE to the estate the host belongs to; a recording is named for its estate.'
  );
}

/**
 * Why a run may not write to a recording named for an estate it is not on.
 *
 * The two above both compare hosts, and a host is only available where the caller builds its filename from
 * the profile. Eleven scripts do not: they write `labs-plan-joins.json`, `labs.json` and nine more with the
 * estate baked into a module constant. On those, a run under a correctly-configured second profile passes
 * both guards and lands field-eng's numbers in a file every reader believes is labs'.
 *
 * So this one compares the name against the profile and needs neither a host nor a file on disk. It is the
 * only guard that fires on the first write to a constant name, which is where those eleven live.
 *
 * A profile may contain a hyphen — `large-estate` does — so the name is matched as a prefix of the whole
 * profile rather than parsed at the first one, and `labs.json` is allowed as the bare form of `labs-`.
 */
export function refusalToStray(path, profile) {
  const name = basename(path);
  if (profile === '') return null;
  if (name.startsWith(`${profile}-`) || name === `${profile}.json`) return null;
  return (
    `${name} is named for another estate and this run is on profile ${profile}. A recording is named ` +
    'for the estate it was taken on, so writing it here would put one estate\'s numbers under another ' +
    "one's name. Set DATABRICKS_CONFIG_PROFILE to the estate this recording belongs to."
  );
}

/**
 * Every guard, applied, for a script that is about to write `path`.
 *
 * The predicates return a reason and leave the caller to act on it, which is the shape a unit test wants
 * and the shape the callers got wrong. `measure-discovery-rework.mjs` called two of them with the arguments
 * in the wrong order and discarded what they returned, so on the one script that spent three hours of a
 * shared estate neither could fire; ten more called none at all. Both found on 2026-08-16, both `79`.
 * Nothing caught either, because a guard whose contract is "check my return value" cannot tell whether
 * anybody did.
 *
 * So this is what a script calls. It reads the existing recording itself rather than being handed one,
 * because that argument was half of what went wrong, and it throws rather than returning, because a throw
 * is the one outcome a caller cannot discard by accident.
 *
 * Called **before the probes, not after**: a walk of a large shared estate that ends in a refusal to write
 * is minutes of somebody else's warehouse spent for nothing.
 *
 * It reads the profile's configured host itself for the same reason. Every argument a caller has to
 * assemble is an argument a caller can assemble wrongly, and this one was passed from two different
 * modules before `79`; taking it out also takes `measure-plan-reachability.mjs` out of an import cycle with
 * `plan-corpus.mjs`, which imports `skipReason` back from it.
 */
export function refuseUnlessNamedForItsEstate(path, profile, host) {
  const reason =
    refusalToStray(path, profile) ??
    refusalToMisname(profile, host, hostTheProfileNames(profile)) ??
    refusalToOverwrite(path, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null, host);
  if (reason != null) throw new Error(reason);
}

/**
 * The host a profile names in the CLI's config, or `null` where it does not say.
 *
 * This is the only way to tell whether `DATABRICKS_HOST` and `DATABRICKS_CONFIG_PROFILE` describe the same
 * workspace, and they can disagree without any error: the environment host wins and the profile supplies
 * only the token, so a leftover `DATABRICKS_HOST` sends a good token to the wrong place. The CLI reports
 * the profile valid — it reads the config file alone — and the call fails with `Invalid Token`, which
 * reads as an expired credential. `estates.md` records the hour that cost.
 *
 * A missing or unparseable config is not evidence of a mismatch, so it reads as "cannot tell". Inventing
 * one would fail every CI run, where there is no config file at all.
 */
export function hostTheProfileNames(profile) {
  try {
    const listed = JSON.parse(execFileSync('databricks', ['auth', 'profiles', '-o', 'json'], { encoding: 'utf8' }));
    const profiles = Array.isArray(listed) ? listed : (listed.profiles ?? []);
    const found = profiles.find((one) => one?.name === profile);
    const host = typeof found?.host === 'string' ? found.host.replace(/\/+$/, '') : '';
    return host === '' ? null : host;
  } catch {
    return null;
  }
}
