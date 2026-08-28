/*
 * Refuses SQL that reads a change-log or timeline table without ever getting down to one thing.
 *
 * The rule is `server/collect/sql/grain.ts`; this is what points it at everything in the tree. Both
 * sources, and that is the whole reason this is a script rather than another vitest beside `history.ts`:
 * the same tables are read by the app's own statements and by the authored guidance, and the app's are
 * the more serious of the two. A wrong guidance step misleads one person doing remediation. A wrong
 * statement misleads the score, which is what the product is for.
 *
 * Static. It never opens a warehouse, which is the point: the statement this check found passed
 * `npm run guidance:sql` and every other gate in the tree, because it parses and it returns rows. The
 * rows were wrong by a factor of eleven, and no amount of running it would have said so — the only way
 * to see it is to know the table's grain and read the query against it, which is what this does.
 *
 *   npm run check:grain
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { GRAINED, grainFaults, type GrainFault } from '../server/collect/sql/grain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const STATEMENTS = join(APP, 'config', 'statements');
const GUIDANCE = join(APP, 'config', 'guidance');

/** One piece of SQL, and enough to tell a reader which one it is. */
interface Subject {
  readonly where: string;
  readonly sql: string;
  /** Lines to add to a fault's line number, for SQL embedded in a larger file. */
  readonly offset: number;
}

const problems: string[] = [];
const subjects = [...statements(), ...guidance()];

if (subjects.length === 0) {
  problems.push('No SQL was found in either config/statements or config/guidance, so this checked nothing.');
}

for (const subject of subjects) {
  for (const fault of grainFaults(subject.sql)) problems.push(explain(subject, fault));
}

process.stdout.write('Grain\n\n');
process.stdout.write(
  `  ${String(subjects.length)} pieces of SQL read for ${String(Object.keys(GRAINED).length)} tables that keep\n` +
    '  more than one row per thing.\n'
);

if (problems.length > 0) {
  process.stderr.write(`\n${String(problems.length)} problem${problems.length === 1 ? '' : 's'}:\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write(
    '\n  A read is accepted when the query around it ranks by the entity and keeps one row, uses\n' +
      '  MAX_BY, counts distinct on it, or groups by it. If a statement genuinely wants change grain,\n' +
      '  that is a reviewable claim rather than a flag to add: say so in the header and make the\n' +
      '  aggregate name what it is counting.\n'
  );
  process.exit(1);
}

process.stdout.write('\n  Every read of one of them gets down to one thing.\n');

/** Every statement file, as SQL. */
function statements(): readonly Subject[] {
  return readdirSync(STATEMENTS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      where: `config/statements/${name}`,
      sql: readFileSync(join(STATEMENTS, name), 'utf8'),
      offset: 0,
    }));
}

/**
 * Every `how: sql` verify step in the authored guidance.
 *
 * The line number is recovered by searching the file for the step's own text rather than tracked
 * through the parse, because `js-yaml` does not carry positions and a fault reported at "line 1 of
 * reliability.yaml" sends a reader to the top of a two-thousand-line file. Searching can be wrong if
 * two entries hold identical SQL, and the cost of that is a line number pointing at the first of two
 * places both of which need the same fix.
 */
function guidance(): readonly Subject[] {
  const found: Subject[] = [];

  for (const name of readdirSync(GUIDANCE).filter((one) => one.endsWith('.yaml')).sort()) {
    const raw = readFileSync(join(GUIDANCE, name), 'utf8');
    const doc = yaml.load(raw) as { entries?: Record<string, { verify?: { how?: string; where?: string }[] }> };

    for (const [control, entry] of Object.entries(doc?.entries ?? {})) {
      for (const step of entry?.verify ?? []) {
        if (step?.how !== 'sql' || typeof step.where !== 'string') continue;
        found.push({
          where: `config/guidance/${name} ${control}`,
          sql: step.where,
          offset: lineOf(raw, step.where) - 1,
        });
      }
    }
  }

  return found;
}

/** The 1-based line a block of embedded text starts on, or 1 when it cannot be found. */
function lineOf(file: string, block: string): number {
  const first = block.split('\n').find((line) => line.trim() !== '');
  if (first == null) return 1;
  const at = file.indexOf(first.trim());
  return at === -1 ? 1 : file.slice(0, at).split('\n').length;
}

/** One fault, as a sentence naming where it is and what to do about it. */
function explain(subject: Subject, fault: GrainFault): string {
  const entity = fault.entity[0] ?? 'the entity';
  const counts = fault.grain === 'change' ? 'configuration versions' : 'rows of a timeline';
  return (
    `${subject.where}:${String(fault.line + subject.offset)} reads ${fault.table} without getting down to one ` +
    `${entity}.\n` +
    `      That table keeps ${fault.grain === 'change' ? 'a row per change' : fault.grain === 'period' ? 'a row per period' : 'a row per snapshot'}, ` +
    `so this counts ${counts}. Rank by ${entity} and keep the first row, count distinct ${entity}, or group by it.`
  );
}
