// Publishing the admin evidence script, and the checksum that makes the download checkable.
//
// Fifty-three security requirements name a control-plane endpoint no app install can reach (ADR
// 0016), and the answer to most of them is a script an admin runs under their own authority. That
// script lives in `config/evidence` and ships with the app for one reason worth being explicit
// about: the fields it collects are the fields this build's resolvers consume, so a copy from a
// different version answers a different set of questions. Serving it from the app rather than
// linking to a repository is how the two stay in step.
//
// The checksum is the other half. An admin who is about to run a script against production with
// account-admin authority should be able to establish that the file in front of them is the file
// the vendor published, and that whoever sent it did not edit it in the middle. So the digest is
// published beside the download, and the script writes its own digest into every file it produces
// — the app compares the two on import, and says so when they differ.
//
// What this is not is a security control. Anybody who can run the script can write whatever JSON
// they like, and no checksum changes that; the import in H4's second half treats an evidence file
// as an attested claim by the person who ran it, not as an observation. What the checksum catches
// is the ordinary failure: a stale copy from six months ago, or a well-meaning edit to a
// projection, arriving as though it were current.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceScriptPayload } from '../../shared/api/contract.js';
import { shippedConfigDirectory } from '../shipped-config.js';

/** The file, as it ships. One file so an admin can read all of it before running it. */
export const SCRIPT_NAME = 'collect-evidence.py';

/**
 * The script and everything the app can say about it without running it.
 *
 * `source` is the file verbatim: this is what a download serves, and what the digest is over.
 */
export interface EvidenceScript {
  readonly name: typeof SCRIPT_NAME;
  readonly source: string;
  /** `sha256:<hex>` over the file's bytes, in the same spelling the script reports for itself. */
  readonly digest: string;
  readonly bytes: number;
  /** The envelope contract the script writes, so the importer can refuse a schema it predates. */
  readonly schema: string;
  /** The script's own version, which is what an evidence file records having been produced by. */
  readonly version: string;
  readonly modifiedAt: Date;
}

/**
 * Where the script lives, found the same way the catalogue is.
 *
 * Searched upwards rather than computed from a depth, because this module runs from
 * `server/evidence/` under tsx and from `dist/evidence/` in the bundle. Getting that wrong is a
 * fault that only shows up in a deployed workspace, and it has happened here once already.
 */
export function evidenceDirectory(moduleUrl = import.meta.url): string {
  return shippedConfigDirectory('evidence', moduleUrl);
}

/**
 * The two declarations the app has to agree with the script about.
 *
 * Read out of the source rather than duplicated in TypeScript, because a copy would be a second
 * place for the truth to live and the first place for it to go stale. Anchored to a line start so a
 * mention in the docstring cannot be mistaken for the declaration — the repository's
 * `check:evidence-script` fails if either stops matching, so this cannot quietly start guessing.
 */
const SCHEMA = /^SCHEMA = "([^"]+)"$/m;
const VERSION = /^SCRIPT_VERSION = "([^"]+)"$/m;

export function loadEvidenceScript(directory: string = evidenceDirectory()): EvidenceScript {
  const path = join(directory, SCRIPT_NAME);
  // Bytes, not the decoded string, so the digest is over what a download receives. The two agree
  // for ASCII and would not for the em dashes in the docstring.
  const bytes = readFileSync(path);
  const source = bytes.toString('utf8');

  const schema = SCHEMA.exec(source)?.[1];
  const version = VERSION.exec(source)?.[1];
  if (schema == null || version == null) {
    // Loud rather than defaulted. A script whose schema the app cannot read is one whose files the
    // app cannot safely import, and guessing a version would make a stale file look current.
    throw new Error(
      `${path} does not declare both SCHEMA and SCRIPT_VERSION at the top level. The app reads them from ` +
        'the script so there is one source of truth, and it will not guess at either.'
    );
  }

  return {
    name: SCRIPT_NAME,
    source,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: bytes.byteLength,
    schema,
    version,
    modifiedAt: statSync(path).mtime,
  };
}

export function evidenceScriptPayload(script: EvidenceScript, href: string): EvidenceScriptPayload<Date> {
  const expected = script.digest.replace(/^sha256:/, '');
  return {
    name: script.name,
    digest: script.digest,
    bytes: script.bytes,
    schema: script.schema,
    version: script.version,
    modifiedAt: script.modifiedAt,
    href,
    verify: [`shasum -a 256 ${script.name}`, `sha256sum ${script.name}`, `expected: ${expected}`],
  };
}
