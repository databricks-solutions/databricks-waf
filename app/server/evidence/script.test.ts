import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_NAME,
  evidenceDirectory,
  evidenceScriptPayload,
  loadEvidenceScript,
} from './script.js';

const SCRIPT = join(evidenceDirectory(), SCRIPT_NAME);

describe('the published evidence script', () => {
  const script = loadEvidenceScript();

  it('is the file that ships, not a copy of it', () => {
    expect(script.name).toBe('collect-evidence.py');
    expect(script.source.startsWith('#!/usr/bin/env python3')).toBe(true);
    expect(script.bytes).toBeGreaterThan(1_000);
  });

  it('publishes a digest an admin can reproduce with a shell command', () => {
    // Computed the way the admin will compute it, by shelling out, rather than by hashing the same
    // bytes twice in the same process. The point of publishing a checksum is that a person with the
    // file and a terminal reaches the same answer, and only one of those two ways proves it.
    const [reported] = execFileSync('shasum', ['-a', '256', SCRIPT], { encoding: 'utf8' }).trim().split(/\s+/);
    expect(script.digest).toBe(`sha256:${reported}`);
  });

  it('reads its schema and version out of the script rather than holding its own copy', () => {
    expect(script.schema).toMatch(/^waf-admin-evidence\/\d+$/);
    expect(script.version).toMatch(/^\d+$/);
  });

  it('reports the same digest the script reports for itself', () => {
    // The comparison the importer makes. If these two ever disagree, every collected file arrives
    // looking like it came from an edited script.
    const manifest = JSON.parse(execFileSync('python3', [SCRIPT, '--manifest'], { encoding: 'utf8' })) as {
      digest: string;
      schema: string;
      version: string;
    };

    expect(manifest.digest).toBe(script.digest);
    expect(manifest.schema).toBe(script.schema);
    expect(manifest.version).toBe(script.version);
  });

  it('refuses a script that does not declare what it writes', () => {
    // A missing schema is not a field to default. An evidence file whose contract the app has to
    // guess at is one it cannot safely import, and a version guessed as current would make a file
    // collected six months ago look like today's.
    const directory = mkdtempSync(join(tmpdir(), 'waf-evidence-'));
    writeFileSync(join(directory, SCRIPT_NAME), '#!/usr/bin/env python3\nprint("nothing declared")\n');

    expect(() => loadEvidenceScript(directory)).toThrow(/SCHEMA and SCRIPT_VERSION/);
  });
});

describe('what the app says about the script', () => {
  const payload = evidenceScriptPayload(loadEvidenceScript(), '/api/evidence/collect-evidence.py');

  it('carries no source, since the download carries that', () => {
    expect(payload).not.toHaveProperty('source');
    expect(payload.href).toBe('/api/evidence/collect-evidence.py');
  });

  it('gives the verification as commands rather than as a description', () => {
    // Both tools, because the check only happens if it is easy and an admin on macOS and one on
    // Linux do not reach for the same one.
    expect(payload.verify.some((line) => line.startsWith('shasum '))).toBe(true);
    expect(payload.verify.some((line) => line.startsWith('sha256sum '))).toBe(true);

    const expected = payload.verify.find((line) => line.startsWith('expected: '));
    expect(expected).toBe(`expected: ${payload.digest.replace('sha256:', '')}`);
  });
});
