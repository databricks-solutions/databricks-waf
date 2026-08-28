import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { queryDirectory } from './queries.js';
import { mark, SELF_BOUNDS, SELF_HEADER, SELF_MARKER, SELF_TAG_KEY, SELF_TAG_VALUE, SELF_TAGS } from './self.js';

describe('marking this app’s own statements', () => {
  it('prepends the marker as its own line', () => {
    expect(mark('SELECT 1')).toBe('-- databricks-waf: assessment\nSELECT 1');
  });

  it('marks once, however many times it is asked', () => {
    // The executor is the only caller today. Idempotence is here so a second marking site later cannot
    // produce a statement whose text differs from the one the shapes statement matches on.
    expect(mark(mark('SELECT 1'))).toBe(mark('SELECT 1'));
  });

  it('sends tags as an array of key and value, not as a map', () => {
    // A map is accepted by the Statement Execution API with a 200 and recorded in `system.query.history`
    // as `{"tags_invalid": null}`, so the request succeeds and the tag does not exist. Nothing short of
    // reading the column back on a real workspace catches it, which is how the shape below was arrived at.
    expect(SELF_TAGS).toEqual([{ key: SELF_TAG_KEY, value: SELF_TAG_VALUE }]);
  });
});

/*
 * The statement is the other half of this and it cannot import from here — it is SQL — so all four marks
 * appear as literals in both places. That is a drift risk with a silent failure mode: change one here and
 * the advisor starts ranking a slice of its own queries again, with nothing failing to say so.
 */
describe('the shapes statement excludes what the executor marks', () => {
  it('matches on the same tag and the same three comments', async () => {
    const sql = await readFile(join(queryDirectory(), 'workload_query_shapes.sql'), 'utf8');

    expect(sql).toContain(`try_element_at(query_tags, '${SELF_TAG_KEY}') = '${SELF_TAG_VALUE}'`);
    expect(sql).toContain(`startswith(trim(statement_text), '${SELF_MARKER.trimEnd()}')`);
    expect(sql).toContain(`contains(statement_text, '${SELF_HEADER}')`);
    expect(sql).toContain(`contains(statement_text, '${SELF_BOUNDS}')`);
  });

  /*
   * The two retroactive marks are matched anywhere in the text, and that is not a detail.
   *
   * The first version of this matched the signal header as a prefix, and the run after it shipped still had
   * three of the top twelve ours: those executions opened with the bounds header and carried the signal
   * header on the line beneath it. A prefix match is defeated by anything written above the mark, and what
   * a reader sees is three rows telling them to optimise the assessment.
   */
  it('matches the retroactive marks anywhere in the text, not only at the start', async () => {
    const sql = await readFile(join(queryDirectory(), 'workload_query_shapes.sql'), 'utf8');

    expect(sql).not.toContain(`startswith(trim(statement_text), '${SELF_HEADER}')`);
    expect(sql).not.toContain(`startswith(trim(statement_text), '${SELF_BOUNDS}')`);
  });

  /*
   * Both retroactive marks are conventions rather than code, so they have to be on every statement.
   *
   * They were documentation until the exclusion started reading them, and one of the twenty files lacked a
   * signal header — that file duly appeared as a query shape of its own in the run after the first fix,
   * while the other nineteen were excluded. A twenty-first statement written without one would do the same,
   * and the symptom is one row on a page rather than anything that looks like a failure.
   */
  it('is carried by every statement file, since the exclusion now depends on it', async () => {
    const directory = queryDirectory();
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql'));

    expect(files.length).toBeGreaterThan(15);
    for (const name of files) {
      const text = await readFile(join(directory, name), 'utf8');
      expect(text.startsWith(SELF_HEADER), name).toBe(true);
      // The bounds declaration is what reaches furthest back, so a file without one is invisible to the
      // retroactive marks for as long as its signal header is younger than the window.
      expect(text.includes(SELF_BOUNDS), name).toBe(true);
    }
  });

  it('keeps the excluded time rather than dropping it from the denominator', async () => {
    // The exclusion is only honest if the page can say how much it excluded. A statement that filtered our
    // queries out in `windows` would leave the coverage figure describing a window it had already trimmed,
    // and the reader would be told the advisor covered 94% of an estate it had seen half of.
    const sql = await readFile(join(queryDirectory(), 'workload_query_shapes.sql'), 'utf8');

    expect(sql).toContain('AS self_ms');
    expect(sql).toContain('AS self_runs');
  });
});
