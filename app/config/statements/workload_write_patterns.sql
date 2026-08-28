-- Signal: sql:workload.write_patterns
-- Rows: at most :shape_limit
-- Benchmark: workload
--
-- No `-- Slice:` header, for the reason `workload_query_shapes.sql` gives at the same place: this is
-- capped at `:shape_limit`, and slicing it would take the top shapes of each workspace rather than of
-- the estate while giving each slice its own coverage denominator.
--
-- The write shapes the estate ran, so the advisor can say which of them rewrite a table over and over
-- and which of them dribble a table in a few megabytes at a time. Analysis rather than assessment:
-- nothing here can change a score or a finding.
--
-- ## Why writes are a statement of their own rather than a column on the query shapes
--
-- The two ask different questions of the same table and rank on different quantities.
-- `workload_query_shapes.sql` ranks by time, because a slow statement is what it is about, and its top
-- twelve on a real estate is `SELECT`s. A write pattern is not a slow-query finding: a rewrite of a
-- table is *fast* and still wrong, and what makes it a finding is how much it wrote and how often,
-- neither of which moves it up a ranking by duration. Reading it off the same rows would mean either a
-- second ranking inside one signal or a top twelve that has to be long enough to contain the writes by
-- accident.
--
-- ## The premise, and where it was measured
--
-- Read on `large-estate` on 2026-08-12 over three days, recorded in
-- `docs/plan/h6-workload-advisor.md` under `33g`: 7,545 `REPLACE`, 1,706 `INSERT`, 606 `UPDATE`, 460
-- `MERGE`, 154 `DELETE` and 1 `COPY`, with `written_bytes` populated on all but two of the 10,472 — 617
-- GB written by the rewrites against 3.9 GB by the merges.
--
-- **The labs half of that premise was wrong, and this statement is what caught it.** `33g` recorded
-- that labs ran no write statements at all and carried `written_bytes` null throughout. Read on labs on
-- 2026-08-16 over thirty days, by this statement and by hand beside it: 178 write statements — 81
-- `REPLACE`, 74 `INSERT`, 17 `MERGE`, 3 `UPDATE`, 3 `DELETE` — every one of the 178 carrying a written
-- figure, 517 MB between them, collecting into 35 shapes. So the null claim was false in both halves.
-- What is true is that labs is small: its largest rewrite shape ran 17 times on one day and its middle
-- run wrote 4.9 MB, which is three orders of magnitude under the rewrite threshold. Neither rule fires
-- there, and that is a fact about the size of the estate rather than a threshold read off it.
--
-- Two things follow, and both are built rather than assumed. `written_bytes` was populated on every one
-- of the 10,650 write statements read across both estates, so a null is a fact about a statement and not
-- about the platform — which is why `runs_stating_bytes` comes back beside every byte figure rather than
-- the app dividing by `runs` and reporting a rewrite that wrote nothing. And labs still cannot set these
-- thresholds: an estate whose largest rewrite is 5 MB has no upper tail to read one off, so the numbers
-- are the field-eng ones and what labs establishes is that they do not misfire on a small estate.
--
-- ## The two things this may not say
--
-- Whether a rewrite could have been a `MERGE`, and whether an ingest could have been Auto Loader, are
-- properties of the pipeline that produced the statement. This reads `system.query.history`, which
-- holds what ran and not what could have run instead, and neither question is answerable from it. So
-- the rules over these rows report a pattern — a table rewritten repeatedly, a load arriving in small
-- pieces — and the remedy is offered as the thing to look at rather than asserted as the fix. The
-- analyzer carries the same caveat in each rule's own words; see `config/analyze/write-rules.yaml`.
--
-- ## A shape whose statements are of several kinds is not a shape
--
-- `HAVING kinds = 1`, and the reasoning is `workload_query_shapes.sql`'s in full: some submission paths
-- record the calling expression instead of the SQL, so 1,389,247 statements across eleven statement
-- types normalise to one fingerprint, and that shape ranked second by total time before the guard
-- existed. It matters more here than there, because this signal *is* about what kind of write a
-- statement was: a shape that cannot say whether it inserted or replaced is one both rules would read
-- wrongly, and one of them would read it as a rewrite.
--
-- ## The fingerprint is the shipped one
--
-- The same six passes in the same order as `workload_query_shapes.sql`, and
-- `scripts/measure-shape-fingerprint.test.ts` asserts that both statements contain it, because a second
-- copy of an expression measured against a corpus is a thing this repository has already been bitten by.
-- Changing it here without changing it there would split one shape into two populations that look
-- comparable and are not.
--
-- ## The window
--
-- One window rather than the shapes statement's two. Nothing here is a trend: a rewrite that ran forty
-- times last fortnight and forty times this one is the same finding, and the prior window exists in that
-- statement to classify a shape as getting worse. Bounded in the `WHERE` clause at thirty days for the
-- reason that file gives — a cap held by whatever binds the parameter is one a later caller can forget.
--
-- ## This app's own statements are excluded, and its writes are not the estate's
--
-- The same four marks `server/collect/sql/self.ts` holds. The assessment writes nothing to a customer
-- table, so unlike the shapes statement there is no self share worth reporting back: what our exclusion
-- removes here is nothing, and a figure that is always zero on every estate is one a reader learns to
-- ignore. What is returned instead is `write_statements`, the estate's own writes in the window, so the
-- returned shapes have a denominator.
--
-- Feeds: the workload advisor's write patterns. Cites no requirement and scores nothing.
WITH windows AS (
  SELECT
    workspace_id,
    statement_id,
    statement_text,
    statement_type,
    start_time,
    total_duration_ms,
    written_bytes,
    read_bytes,
    produced_rows,
    execution_status,
    /*
     * Whether the platform stated a written figure for this execution, as a flag.
     *
     * A null and a zero are different statements and the difference decides a rule. A `DELETE` that
     * removed nothing wrote zero bytes; a statement whose figure the platform did not record wrote an
     * unknown number of them, and summing both as zero makes an unreadable estate look like an idle
     * one. Every byte aggregate below is paired with a count of the runs that stated a figure.
     */
    CASE WHEN written_bytes IS NULL THEN 0 ELSE 1 END AS states_bytes,
    /*
     * Whether this statement wrote, which is the population this signal is about.
     *
     * The six the premise measured, and `CREATE` is deliberately not among them. A create-table-as-select
     * is a rewrite the first time and a table that exists thereafter, so counting it would put every
     * table the estate has ever built into a rule about tables it rebuilds; `REPLACE` is the type the
     * platform records for the rebuild, which is the thing this is looking for.
     */
    CASE
      WHEN statement_type IN ('INSERT', 'MERGE', 'UPDATE', 'DELETE', 'COPY', 'REPLACE') THEN 1
      ELSE 0
    END AS is_write,
    CASE
      WHEN execution_status = 'FINISHED' THEN 1
      ELSE 0
    END AS is_finished,
    -- The four marks, matched exactly as `workload_query_shapes.sql` matches them. `try_element_at`
    -- rather than `[]` so a workspace whose column is absent reads as not-ours instead of failing.
    CASE
      WHEN try_element_at(query_tags, 'databricks_waf') = 'assessment'
        OR startswith(trim(statement_text), '-- databricks-waf: assessment')
        OR contains(statement_text, '-- Signal: sql:')
        OR contains(statement_text, '-- Rows: ')
      THEN 1
      ELSE 0
    END AS is_self
  FROM system.query.history
  WHERE start_time >= current_timestamp() - make_dt_interval(least(:lookback_days, 30))
    AND execution_status IN ('FINISHED', 'FAILED', 'CANCELED')
    -- Redaction empties the text under customer-managed keys, and an empty string normalises to an
    -- empty string: without this every redacted write in the estate collects into one shape.
    AND statement_text IS NOT NULL
    AND trim(statement_text) <> ''
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
/*
 * What the returned shapes are a part of, as one row cross-joined onto every result row.
 *
 * Over the whole window and before the homogeneity guard, so a surface can say both how much of the
 * estate's writing this describes and how much it had to drop for being unidentifiable. Both halves are
 * counts of statements rather than of bytes: a shape's share of bytes is a figure a reader can compute
 * from the rows, and a share of an estate's writing weighted by bytes would be dominated by one nightly
 * rebuild on every estate that has one.
 */
coverage AS (
  SELECT
    sum(is_write * (1 - is_self))                              AS write_statements,
    sum(is_write * (1 - is_self) * states_bytes)               AS writes_stating_bytes,
    sum(is_write * (1 - is_self) * written_bytes)              AS written_bytes,
    sum((1 - is_write) * (1 - is_self))                        AS other_statements
  FROM windows
),
shaped AS (
  SELECT
    *,
    -- The shipped fingerprint, six passes in the shipped order. `workload_query_shapes.sql` documents
    -- what each pass is for and `measure-shape-fingerprint.test.ts` holds the two copies together.
    substr(
      sha2(
        trim(regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(lower(trim(statement_text)), '[0-9]+', 'N'),
                  concat(chr(39), '([^', chr(39), chr(10), ']|', chr(39), chr(39), ')*', chr(39)),
                  'S'
                ),
                concat('(?s)(?<![a-z0-9_])--[^', chr(10), ']*|/\\*.*?\\*/|', chr(96)),
                ''
              ),
              '\\b(date|timestamp|interval)\\s+S',
              'S'
            ),
            '\\(\\s*(S|N)(\\s*,\\s*(S|N))+\\s*\\)',
            '(S)'
          ),
          '[ \t\n\r]+',
          ' '
        ))
        ,
        256
      ),
      1, 16
    ) AS shape
  FROM windows
  WHERE is_write = 1
    AND is_self = 0
),
grouped AS (
  SELECT
    shape,
    max(workspace_id)                                              AS workspace_id,
    max(statement_type)                                            AS statement_type,
    count(DISTINCT statement_type)                                 AS kinds,
    count(*)                                                       AS runs,
    sum(is_finished)                                               AS finished_runs,
    count(DISTINCT date(start_time))                               AS days_run,
    sum(states_bytes)                                              AS runs_stating_bytes,
    sum(written_bytes)                                             AS written_bytes,
    max(written_bytes)                                             AS largest_write_bytes,
    -- The middle write rather than the mean, because one backfill inside a fortnight of hourly loads
    -- moves a mean by two orders of magnitude and is exactly the shape both rules must not fire on.
    percentile(written_bytes, 0.5)                                 AS median_write_bytes,
    sum(read_bytes)                                                AS read_bytes,
    sum(produced_rows)                                             AS produced_rows,
    sum(total_duration_ms)                                         AS total_ms,
    min(start_time)                                                AS first_seen,
    max(start_time)                                                AS last_seen
  FROM shaped
  GROUP BY shape
  -- See the header. A shape whose recorded text does not determine whether it inserted or replaced did
  -- not identify the statement, and both rules below read the statement type.
  HAVING count(DISTINCT statement_type) = 1
),
/*
 * The one execution that stands for the shape, and the text that comes with it.
 *
 * `workload_query_shapes.sql`'s rule minus the parts that do not apply: there are no plans to fetch
 * here, so no warehouse or compute type is carried, and a cache hit cannot be a write. What is left is
 * the largest write, then the most recent — largest rather than slowest, because the reader opening
 * this row wants to see the statement that moved the data.
 */
representative AS (
  SELECT
    shape,
    statement_id,
    statement_text,
    start_time AS representative_at
  FROM (
    SELECT
      shape,
      statement_id,
      statement_text,
      start_time,
      row_number() OVER (
        PARTITION BY shape
        ORDER BY coalesce(written_bytes, -1) DESC, start_time DESC
      ) AS rank
    FROM shaped
  )
  WHERE rank = 1
)
SELECT
  g.workspace_id,
  g.shape,
  g.statement_type,
  g.runs,
  g.finished_runs,
  g.days_run,
  g.runs_stating_bytes,
  g.written_bytes,
  g.largest_write_bytes,
  g.median_write_bytes,
  g.read_bytes,
  g.produced_rows,
  g.total_ms,
  g.first_seen,
  g.last_seen,
  r.statement_id,
  r.statement_text,
  r.representative_at,
  c.write_statements,
  c.writes_stating_bytes,
  c.written_bytes AS estate_written_bytes,
  c.other_statements
FROM grouped g
LEFT JOIN representative r ON r.shape = g.shape
CROSS JOIN coverage c
-- By what they wrote and not by what they cost. A rewrite is fast and still the finding; ranking these
-- by duration would put the estate's slowest `MERGE` above the table it rebuilds every hour.
ORDER BY coalesce(g.written_bytes, 0) DESC, g.runs DESC, g.shape
LIMIT :shape_limit
