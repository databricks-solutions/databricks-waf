/*
 * Every URL this repository's configuration cites, and what cites it.
 *
 * Separate from `check-guidance-links.mjs` because that script fetches on import: it is a command,
 * not a library, and a test that imported it would go to the network to assert which files it reads.
 * The collection is the part worth testing — row 67 exists because a citation source nobody was
 * reading looked exactly like one that was.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const GUIDANCE_DIR = 'config/guidance';
export const RULES_FILE = 'config/analyze/serverless-rules.yaml';

/**
 * Every URL the guidance entries cite, against the entry citing it.
 *
 * @param {string} dir
 * @returns {{ url: string, where: string, absolute?: boolean }[]}
 */
export function guidanceCitations(dir = GUIDANCE_DIR) {
  const found = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml'))) {
    const entries = parse(readFileSync(join(dir, file), 'utf8'))?.entries ?? {};
    for (const [control, entry] of Object.entries(entries)) {
      for (const reference of entry?.references ?? []) {
        const url = typeof reference === 'string' ? reference : reference?.url;
        if (typeof url === 'string' && url.startsWith('http')) found.push({ url, where: `${file} ${control}` });
      }
    }
  }
  return found;
}

/**
 * Every URL the serverless ruleset cites, against the rule or assumption citing it.
 *
 * Both lists, because both are shown. An assumption's citation sits under a cost estimate and a
 * rule's under the sentence saying the job cannot move, and the reader is not told which kind of
 * claim they are reading — so a check that took only the rules would leave the assumptions unwatched
 * while reporting that the file was covered.
 *
 * @param {string} file
 * @returns {{ url: string, where: string, absolute: boolean }[]}
 */
export function rulesetCitations(file = RULES_FILE) {
  const parsed = parse(readFileSync(file, 'utf8')) ?? {};
  const name = file.split('/').at(-1);
  const found = [];
  for (const [list, kind] of [
    [parsed.assumptions, 'assumption'],
    [parsed.rules, 'rule'],
  ]) {
    for (const one of list ?? []) {
      if (typeof one?.doc_url === 'string' && one.doc_url.startsWith('http')) {
        found.push({
          url: one.doc_url,
          where: `${name} ${kind} ${String(one.id ?? '?')}`,
          /*
           * A blocker says the work cannot move. That is the wording a lifted limitation makes wrong
           * while the URL keeps resolving, so it is the one a reader has to re-read rather than
           * re-point. Taken from `kind` rather than a new field: the distinction is already in the
           * data, and a second way of saying it would be a second thing to keep true.
           */
          absolute: one.kind === 'blocker',
        });
      }
    }
  }
  return found;
}
