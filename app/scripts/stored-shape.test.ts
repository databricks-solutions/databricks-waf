// Whether the recorded stored shape is a description of the stored shape.
//
// The gate in `stored-shape.mts` is only worth having if its walk reaches the whole document, and its
// first version did not: properties of a mapped type have no declaration node, so `footprint.tasks` —
// `Record<Surface, SurfaceCounters>` — resolved to `any` for all six surfaces and the walk stopped there.
// The recording had 1747 paths, a stable digest, and no `terminal` anywhere in it. The instrument built to
// catch row 81 was blind to the field row 81 added, and nothing about the output said so.
//
// So these are assertions about the apparatus rather than about the app: they ask whether the recording
// describes what it claims to. `AGENTS.md` calls this checking that the apparatus matches what it says it
// describes, and `H1`'s first measurement is the reason it says so.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEC_VERSION } from '../server/scan/codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const recording = JSON.parse(readFileSync(join(HERE, 'recordings/stored-shape.json'), 'utf8')) as {
  readonly codecVersion: number;
  readonly digest: string;
  readonly pathCount: number;
  readonly paths: readonly string[];
};

describe('the recorded shape of a stored scan', () => {
  it('reaches the field row 81 added, on every surface that carries counters', () => {
    // The one assertion that would have failed on the blind version, and the reason it is first. Named
    // per surface because the blindness was per surface: `tasks` is a mapped type over six literals, and a
    // walk that resolves the map but not its value would pass a test that only asked for one.
    for (const surface of ['ai', 'cloud', 'describe', 'plans', 'rest', 'sql']) {
      const reached = recording.paths.filter((path) => path.startsWith(`footprint.tasks.${surface}.terminal.`));
      expect(reached.length, `terminal counts under ${surface}`).toBeGreaterThan(0);
    }
  });

  it('reaches the five counts every surface has carried since footprints were stored', () => {
    for (const count of ['ok', 'skipped', 'failed', 'retries', 'attempts']) {
      expect(recording.paths, count).toContain(`footprint.tasks.sql.${count}:number`);
    }
  });

  it('resolved every path to a type, because `any` is where a walk stopped rather than what a field holds', () => {
    // The tell that caught the mapped-type blindness. A stored document holds JSON; nothing in it is
    // legitimately `any`, so an `any` in this list is the walk giving up somewhere and saying nothing.
    expect(recording.paths.filter((path) => path.endsWith(':any'))).toEqual([]);
  });

  it('holds no method, because a stored document holds data and a method is a prototype walked by mistake', () => {
    /*
     * The second tell, and the one a review found rather than a test. `SignalId` is `${Surface}:${string}`,
     * a template literal type and not `String`, so the walk did not stop at it — it asked for the type's
     * properties, was handed `String`'s prototype, and recorded `signal|0.charAt` and 1,494 others like it.
     * The recording went from 1,812 paths to 317 when that was fixed: **82% of the digest was the standard
     * library**, and the stored field was described by its own prototype rather than as a string.
     *
     * A function type in a JSON document is the general form of that mistake, whatever type provoked it, so
     * this asks for the general form. It also stops the worse half: a `String` method added by a TypeScript
     * upgrade would have moved the digest and failed the gate for a reason with nothing to do with a stored
     * scan, and a rule that fires on unrelated changes is one people learn to ignore.
     */
    const methods = recording.paths.filter((path) => / => |^[^:]*:\{ \(/.test(path));
    expect(methods).toEqual([]);
  });

  it('reaches the parts of a scan the read path dereferences', () => {
    // Named rather than counted. Each of these is somewhere `decodeScan` or a presenter reads into, so a
    // walk that stopped short of one would leave a shape change there invisible.
    for (const path of [
      'id:string',
      'startedAt:Date',
      'finishedAt:Date',
      'state:"complete"|"partial"',
      'footprint.spend.elapsedMs:number',
      // Optional, and the `?` is part of the path on purpose: making a required field optional changes what
      // a stored document may omit, so it has to move the digest.
      'score.overall?:number',
      'stamp.actor:string',
    ]) {
      expect(recording.paths, path).toContain(path);
    }
    expect(recording.paths.some((path) => path.startsWith('findings[].evidence[].'))).toBe(true);
    expect(recording.paths.some((path) => path.startsWith('measurement[].'))).toBe(true);
  });

  it('leaves out what the encoder drops, so the digest is of what is stored', () => {
    // `encodeScan` drops raw signal values: a finding carries its own evidence, and the workspace settings
    // probe answers with a `Map`, which `JSON.stringify` renders as `{}` without complaint. Including them
    // would move the digest whenever a collector's payload type changed, for a field no stored document
    // has ever held.
    expect(recording.paths.filter((path) => path.startsWith('signals[].value'))).toEqual([]);
    expect(recording.paths.some((path) => path.startsWith('signals[].status'))).toBe(true);
  });

  it('is enough of the document to be the document', () => {
    /*
     * A floor rather than a count. A number here would be a chore to bump on every field and exactly as easy
     * to bump wrongly as to leave stale — but a walk that silently resolves nothing produces a short list and
     * a digest that never moves, which reads as a gate passing forever.
     *
     * 200, against 317 today. It was 500 for one commit, which was a floor read off a recording that was 82%
     * `String` prototype: high enough to pass on 1,812 corrupt paths and, once they were gone, high enough to
     * fail on the correct 317. A bound taken from an unverified measurement is calibrated to the fault, which
     * is the same lesson as the two above it and the third time this file has learned it.
     */
    expect(recording.paths.length).toBeGreaterThan(200);
    expect(recording.pathCount).toBe(recording.paths.length);
  });

  it('names the codec version the shape was recorded against', () => {
    // The whole mechanism. The digest means nothing without the version beside it: what the check compares
    // is whether the shape moved *while the version stood still*, which is what row 81 did.
    expect(recording.codecVersion).toBe(CODEC_VERSION);
    expect(recording.digest).toMatch(/^[0-9a-f]{16}$/);
  });
});
