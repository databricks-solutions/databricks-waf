// Writes the generated tables in docs/design/q1a-runtime-baseline.md from the recordings they quote, and
// fails when the two disagree.
//
// The per-statement table was transcribed by hand and drifted: it published twenty-two statements when the
// file held thirty-one, six columns for a statement that returns fourteen, and 6.8s for one that measures
// over twenty. Every number in it is in labs.json already, so the document quoting it does not need a
// second copy maintained by hand — it needs generating, and a check that fails while it is stale.
//
// `36j`'s two tables are here for the same reason and before drifting rather than after: both are read
// straight out of labs-shapes.json, and the prose around them names the same figures a second time, which
// is the transcription this script exists to stop.
//
// Run `node scripts/publish-baseline-table.mjs` to rewrite them, or with `--check` to compare only, which
// is what `npm run verify` does.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const BASELINE = join(APP, 'server', 'collect', 'sql', 'runtime-baseline', 'labs.json');
const SHAPES = join(APP, 'server', 'collect', 'sql', 'runtime-baseline', 'labs-shapes.json');
const DOC = join(APP, '..', 'docs', 'design', 'q1a-runtime-baseline.md');

const START = '<!-- generated: per-statement budgets. Run `node app/scripts/publish-baseline-table.mjs`. -->';
const END = '<!-- end generated -->';
const SHAPES_START = '<!-- generated: shape fingerprint modes. Run `node app/scripts/publish-baseline-table.mjs`. -->';
const SHAPES_END = '<!-- end generated: shape fingerprint modes -->';

/**
 * What each variant in measure-shape-fingerprint.mjs fixes, in the words the plan uses for the mode.
 *
 * Here rather than in the recording because it is editorial: the recording holds the counts, and a name a
 * reader recognises is the one thing about this table that is not measured.
 */
const MODES = {
  standalone_digits: 'digits inside identifiers',
};

const number = (value) => (value == null ? 'null' : value.toLocaleString('en-US'));

function table(baseline) {
  const lines = [
    START,
    '',
    `Measured on \`${baseline.profile}\`, run finished ${baseline.runFinishedAt}. Each reading carries its own`,
    'date and warehouse in `labs.json`; the dates differ across a run because the run takes minutes.',
    '',
    'Duration is the median of the readings in the next column, which is what the release gate holds a',
    'class ceiling against. Spread is the widest reading over the narrowest.',
    '',
    'The two byte columns answer different questions and were confused for one for long enough to leave a',
    'budget nobody held. **Serialized** is the size of the answer. **Scanned** is the data read to compute',
    'it, from `system.query.history`, and it is the number every scan-count measurement in Q1e was taken',
    'with. A statement can serialize a few hundred bytes and scan a hundred megabytes to get them.',
    '',
    '| Statement | Rows | Columns | Duration | Readings | Spread | Serialized | Scanned | Shuffle read | Spilled | Sliced |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [name, record] of Object.entries(baseline.statements)) {
    // The four statements declaring a slice column were measured with every live workspace bound at
    // once, which is not how the collector executes them. The column says so on every row rather than
    // in a footnote, because the duration beside it is the one the release gate publishes as a budget.
    const sliced =
      record.sliceColumn == null ? '—' : `no, whole-estate form (slices by \`${record.sliceColumn}\`)`;
    const durations = record.durations;
    lines.push(
      `| \`${name}\` | ${number(record.rows)} | ${number(record.columnCount)} | ` +
        `${number(durations?.median ?? record.durationMs)} ms | ` +
        `${durations == null ? 'one, unsampled' : durations.readings.map(number).join(', ')} | ` +
        `${durations == null ? '—' : `×${String(durations.spreadRatio)}`} | ` +
        `${number(record.serializedBytes)} B | ` +
        `${number(record.scannedBytes)} | ` +
        `${number(record.shuffleReadBytes)} | ${number(record.spilledLocalBytes)} | ${sliced} |`
    );
  }
  lines.push('', END);
  return lines.join('\n');
}

/**
 * The two tables `36j` reports: shapes per fixed mode, and the corpus the count came from.
 *
 * The `reading` column is derived rather than written, because which direction a count moves in is the
 * whole finding and a hand-written gloss is the part that would go stale silently. A variant with more
 * shapes than shipped keeps apart statements the shipped rule merges; with fewer, it joins ones the shipped
 * rule splits. Which of those is the defect is not something the count knows — see the prose.
 */
function shapesTable(shapes) {
  const shipped = shapes.shapes.shipped;
  const clients = shapes.clients;
  const totalShapes = clients.reduce((sum, client) => sum + client.shapes, 0);
  const probes = clients
    .filter((client) => client.app === 'Databricks CLI' || client.app === 'node')
    .reduce((sum, client) => sum + client.shapes, 0);

  const lines = [
    SHAPES_START,
    '',
    `Recorded on \`${shapes.profile}\` at ${shapes.recordedAt}, over ${number(shapes.lookbackDays)} days:`,
    `${number(shapes.statements)} statements and ${number(shipped)} shapes under the shipped fingerprint.`,
    '',
    `\`36s\` merged ${number(shapes.shapes.before36s - shipped)} shapes: ${number(shapes.shapes.before36s)} before it,`,
    `${number(shipped)} after, both counted in this window rather than one of them in an earlier one.`,
    '',
    'The one mode `36s` left alone, still measured because leaving it alone rests on that measurement:',
    '',
    '| Mode the variant fixes | Statements with one | Shapes | vs shipped | Reading |',
    '| --- | --- | --- | --- | --- |',
  ];
  // Descending by effect, so the mode the finding is about is the first row rather than a row.
  const ordered = Object.entries(MODES).sort(
    ([left], [right]) => Math.abs(shapes.shapes[right] - shipped) - Math.abs(shapes.shapes[left] - shipped)
  );
  for (const [key, label] of ordered) {
    const count = shapes.shapes[key];
    const delta = count - shipped;
    const exercised = shapes.exercised[key];
    // A variant that changes nothing and a variant with nothing to change read identically in the shape
    // column and mean opposite things, so the reading is written from both columns and never from one.
    const reading =
      delta > 0
        ? `shipped merges ${number(delta)} the variant keeps apart`
        : delta < 0
          ? `shipped splits ${number(-delta)} the variant joins`
          : exercised === 0
            ? '**not exercised**: no statement here has one'
            : 'exercised, and changes nothing';
    lines.push(
      `| ${label} | ${number(exercised)} | ${number(count)} | ${delta > 0 ? `+${number(delta)}` : number(delta)} | ${reading} |`
    );
  }

  lines.push(
    '',
    'And the corpus those counts came from, which is what bounds them:',
    '',
    '| Client | Statements | Shapes |',
    '| --- | --- | --- |'
  );
  for (const client of clients) {
    lines.push(`| \`${client.app}\` | ${number(client.statements)} | ${number(client.shapes)} |`);
  }
  lines.push(
    '',
    `\`Databricks CLI\` and \`node\` are ${number(probes)} of the ${number(totalShapes)} shapes across clients —`,
    `${Math.round((100 * probes) / totalShapes)}% — and are largely the ad-hoc SQL written while measuring this`,
    'and the rows before it. None of it carries a mark `is_self` looks for.',
    ''
  );

  const relations = shapes.fixtures.relations;
  const held = relations.filter((relation) => relation.held).length;
  lines.push(
    `Then the corpus written by hand (\`36r\`), which does not depend on labs running anything: ${number(relations.length)}`,
    `pairs, ${number(held)} of which the shipped fingerprint gets right. "Want" is the intended behaviour, and a`,
    'gap is what the rework has to close.',
    '',
    '| Mode | Want | Is | |',
    '| --- | --- | --- | --- |'
  );
  // Gaps first: the list is read to find out what is left to do, not to admire what holds.
  for (const relation of [...relations].sort((left, right) => Number(left.held) - Number(right.held))) {
    lines.push(`| ${relation.mode} | ${relation.want} | ${relation.is} | ${relation.held ? 'holds' : '**gap**'} |`);
  }
  lines.push('', SHAPES_END);
  return lines.join('\n');
}

function replaced(doc, generated, start, end, what) {
  const from = doc.indexOf(start);
  const to = doc.indexOf(end);
  if (from === -1 || to === -1) {
    throw new Error(`${DOC} has no generated block for ${what}. Add the markers around it:\n${start}\n${end}`);
  }
  return `${doc.slice(0, from)}${generated}${doc.slice(to + end.length)}`;
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const shapes = JSON.parse(readFileSync(SHAPES, 'utf8'));
const doc = readFileSync(DOC, 'utf8');
const updated = replaced(
  replaced(doc, table(baseline), START, END, 'the per-statement table'),
  shapesTable(shapes),
  SHAPES_START,
  SHAPES_END,
  "36j's shape tables"
);

if (process.argv.includes('--check')) {
  if (updated !== doc) {
    console.error('A published table has drifted from the recording it quotes.');
    console.error('Run `node app/scripts/publish-baseline-table.mjs` and commit the result.');
    process.exit(1);
  }
  console.log('The published tables match the recordings they quote.');
} else {
  writeFileSync(DOC, updated);
  console.log(`wrote the generated tables into ${DOC}`);
}
