// The two canonicalisers have to produce the same bytes, and this is how we know they do.
//
// The admin evidence script computes a digest over the probe set in Python; the app recomputes it in
// TypeScript to decide whether the file it is importing is the file that was collected. Both claim
// to implement RFC 8785, and a claim like that is exactly the kind that holds until somebody tries
// it. If they disagree on one value, every evidence file containing that value reports as altered —
// which is the worst available failure, because it accuses the admin who ran the script of editing
// it.
//
// So the fixtures are chosen to be the places two languages disagree, not a happy path:
//
//   Numbers, which is the real risk. RFC 8785 serialises them as ECMAScript does, and Python does
//   not. Python prints 1e20 in exponent form where JavaScript prints twenty-one digits, switches to
//   exponent form four orders of magnitude earlier, and renders 100.0 with a fractional part. Each
//   of those is a value below.
//
//   Key order above the BMP, where sorting by UTF-16 code unit and sorting by code point differ. An
//   emoji in a cluster name reaches it, and both implementations sort by code unit deliberately.
//
//   Escaping, where the short forms and the \u forms have to be chosen identically.
//
// Run against the real script rather than a copy of its functions, so this cannot pass against a
// file nobody ships.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalise } from '../records/canonical.js';
import { COLLECTED } from './collected-fixture.js';
import { evidenceDirectory, SCRIPT_NAME } from './script.js';

const SCRIPT = join(evidenceDirectory(), SCRIPT_NAME);

/**
 * Values where the two languages' natural output differs, and a few that are simply data.
 *
 * Held as JSON text rather than as JavaScript values so both sides parse the same bytes: a literal
 * in this file would be a double already, and the point of some of these is what happens to an
 * integer on the way to becoming one.
 */
const FIXTURES: readonly string[] = [
  '0',
  '-0',
  '1',
  '100',
  '100.0',
  '1.5',
  '-3.25',
  '0.001',
  '1e-6',
  '1e-7',
  '1e20',
  '1e21',
  '5e-324',
  '1.7976931348623157e308',
  // Beyond 2^53, so both sides have to round it the same way. This is the case where agreeing means
  // both being lossy rather than both being exact.
  '1234567890123456789',
  '1700000000000',
  '"plain"',
  '"a \\"quoted\\" \\\\ backslash"',
  '"tab\\there, newline\\nthere"',
  '"control \\u0001 and \\u001f"',
  '"caf\\u00e9 \\ud83d\\ude00"',
  'null',
  'true',
  '[]',
  '{}',
  '[1,"two",null,true,[],{}]',
  '{"b":1,"a":2,"A":3,"\\u00e9":4,"\\ud83d\\ude00":5,"z":6}',
  // Nested, with keys assigned in an order no sort would produce by accident.
  '{"probes":[{"signals":["rest:workspace:token.list"],"status":"observed","value":{"token_infos":[{"expiry_time":null,"token_id":"b","creation_time":1700000000000}]}}],"tier":"workspace"}',
];

/** What the script's own canonicaliser makes of each fixture, in one Python invocation. */
function fromPython(fixtures: readonly string[]): string[] {
  const program = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("collector", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    // Registered before executing, because a dataclass declaration looks its own module up by name.
    'sys.modules["collector"] = module',
    'spec.loader.exec_module(module)',
    'for line in sys.stdin.read().splitlines():',
    '    sys.stdout.write(module.canonicalise(json.loads(line)) + "\\n")',
  ].join('\n');

  const output = execFileSync('python3', ['-c', program, SCRIPT], {
    input: fixtures.join('\n'),
    encoding: 'utf8',
  });
  return output.split('\n').slice(0, fixtures.length);
}

describe('the admin script canonicalises exactly as the app does', () => {
  const canonical = fromPython(FIXTURES);

  it.each(FIXTURES.map((fixture, at) => [fixture, at] as const))('agrees on %s', (fixture, at) => {
    expect(canonical[at]).toBe(canonicalise(JSON.parse(fixture)));
  });

  it('agrees on the digest of a whole probe set, which is what the envelope carries', () => {
    const probes = [
      { signals: ['rest:workspace:preview.workspace-conf'], status: 'observed', value: { maxTokenLifetimeDays: '90' } },
      { signals: ['rest:workspace:token.list'], status: 'denied', detail: 'http 403' },
      { signals: ['rest:account:accounts.log-delivery'], status: 'skipped', tier: 'account' },
    ];

    const program = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("collector", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'sys.modules["collector"] = module',
      'spec.loader.exec_module(module)',
      'sys.stdout.write(module.digest(json.loads(sys.stdin.read())))',
    ].join('\n');

    const theirs = execFileSync('python3', ['-c', program, SCRIPT], {
      input: JSON.stringify(probes),
      encoding: 'utf8',
    });

    const ours = `sha256:${createHash('sha256').update(canonicalBytes(probes)).digest('hex')}`;
    expect(theirs).toBe(ours);
  });

  // The fixtures above were chosen by reasoning about where Python and JavaScript disagree, which
  // means they cover the disagreements somebody thought of. This one was chosen by nobody: it is the
  // probe set from an actual two-tier run, and it agreed first time on 27,685 canonical bytes. Kept
  // because a synthetic suite that passes is evidence about the suite, and this is evidence about the
  // two implementations.
  it('agrees on a probe set collected from a live workspace and account', () => {
    const program = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("collector", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'sys.modules["collector"] = module',
      'spec.loader.exec_module(module)',
      'sys.stdout.write(module.digest(json.loads(sys.stdin.read())))',
    ].join('\n');

    const theirs = execFileSync('python3', ['-c', program, SCRIPT], {
      input: JSON.stringify(COLLECTED),
      encoding: 'utf8',
    });

    expect(theirs).toBe(`sha256:${createHash('sha256').update(canonicalBytes(COLLECTED)).digest('hex')}`);
  });
});
