-- Signal: sql:workload.query_shapes
-- Rows: at most :shape_limit
-- Benchmark: workload
--
-- No `-- Slice:` header, and that is a decision rather than an omission. The four sliced statements are
-- the ones that return a row per job or per cluster and so grow without bound; this one is capped at
-- `:shape_limit` and fits an inline result at any estate. Slicing it would also be *wrong* in two ways
-- the slice checker cannot see: `LIMIT` applies per slice, so the concatenation would be the top forty
-- shapes of each workspace rather than of the estate, and the coverage figures are cross-joined from a
-- single row, so slices would each carry their own denominator and the "same on every row" property the
-- analyzer relies on would quietly stop holding.
--
-- The costliest query shapes in the window, with the signals that separate one cause of slowness
-- from another. Feeds the workload advisor, which is analysis rather than assessment: nothing here
-- can change a score or a finding.
--
-- `docs/design/h6-calibration.md` records what every threshold and guard below was measured
-- against, on two real estates, before any of this was written. Three of the decisions here exist
-- because measuring changed them, and each is noted at the line it affects.
--
-- ## Grouping, and why a fingerprint is computed rather than read
--
-- `system.query.history` has no query hash. Forty-four columns and none of them identifies a
-- statement shape, so the shape is computed from `statement_text`: lowercased, runs of digits
-- replaced with `N`, single-quoted literals replaced with `S`, whitespace collapsed, hashed. On a
-- large estate that collapses 802,617 statements into 43,044 shapes — 18.6 to one — which is what
-- makes a top twelve a meaningful answer rather than an arbitrary slice of a very long list.
--
-- Computed in SQL rather than in the app on purpose. The alternative moves the better part of a
-- million rows across the wire to answer a question that ends in twelve of them, and inline results
-- are capped at 25 MiB by the Statement Execution API and *fail* past it rather than truncating.
--
-- ## A shape whose statements are of several kinds is not a shape
--
-- `HAVING kinds = 1`, and it is the most important line in this file.
--
-- Some submission paths record the calling expression instead of the SQL it built. On the estate
-- this was measured against, 1,389,247 statements over thirty days arrive with a `statement_text`
-- of `spark.sql(stmt)` — fifteen characters — spanning eleven different `statement_type` values:
-- SET, ALTER, REPLACE, OTHER, CREATE, SELECT, MERGE, INSERT, GRANT, DROP and DELETE. They all
-- normalise to one string, so they all hash to one shape.
--
-- Left in, that shape ranked *second* by total time. It is the worst kind of wrong output: it cites
-- a real and enormous quantity of time, carries a statement type picked arbitrarily by `max()` from
-- eleven candidates, describes nothing that exists anywhere, and there is nothing about the row a
-- reviewer could look at and see was wrong.
--
-- Excluding empty text does not catch it — the text is present, non-empty and identical a million
-- times over. So the guard is general instead: if the recorded text does not even determine whether
-- a statement reads or writes, it did not identify the statement, and grouping on it is unsound. A
-- denylist naming `spark.sql(stmt)` would be narrower and would need editing every time a
-- submission path changed; this needs editing never. It costs half a percent of shapes and 1.0% of
-- query time, and `kinds` is returned so the analyzer can say what it dropped rather than hiding it.
--
-- ## The window is bounded at thirty days, here rather than in the caller
--
-- `least(:lookback_days, 15)` is the current window and twice that is what gets read, so a caller
-- asking for ninety days reads thirty. The ceiling is in the statement because a cap held by
-- whatever binds the parameter is one a later caller can forget, and this is the one place in the
-- plan where a customer with more history would otherwise be punished for having it. Measured: 26.3
-- seconds at thirty days against 40.9 at sixty, and the scan is linear in the window.
--
-- The consequence to design the surface around is that the prior window comes out of the same
-- thirty days. The comparison is at most fifteen days against fifteen, fourteen against fourteen by
-- default, and a quarter-over-quarter trend is not available at this bound.
--
-- ## What each returned signal separates
--
-- Every shape in a top ten is slow. These are what make the advice different:
--
--   spilled_bytes         memory pressure. 16.7 TB on one shape, which is not a tuning problem.
--   pruned_percent        file layout. 0.5% means the scan reads the table every run. NULL, not
--                         zero, where no files were read at all — metadata and memory-served
--                         statements are 3,621 of one workspace's 5,885, and dividing without the
--                         `nullif` reports perfect pruning on a query that read nothing.
--   parallelism           task time over execution time. Below 1 the work was serial and no amount
--                         of compute helps; 50.2 on one shape and 0.45 on another, both "slow".
--   compilation_percent   89.4% on a shape of 291,362 runs. The planner is being asked to plan the
--                         same statement over and over because the literals change, and the answer
--                         is parameterisation rather than tuning. Not in either upstream design
--                         document, and the largest finding in the top ten that neither predicts.
--   queue_seconds         waiting for capacity. NULL on non-warehouse compute rather than zero, so
--                         `coalesce` before summing or a pipeline reads as never having queued.
--   runs_before           absent as 0, which the analyzer reads as a new shape rather than as one
--                         that got infinitely worse.
--   cache_hits            served from the result cache. Counted, excluded from every timing.
--   failures              terminal and not FINISHED. A finding, and not a performance one.
--
-- ## REFRESH is excluded, and how much that leaves out is returned rather than hidden
--
-- A materialised view is a managed service. There is no knob a reader could turn in response to a
-- finding about one, and advice nobody can act on is worse than silence — so `REFRESH` is not in the
-- statement types this reads. That agrees with the advisor document's filter at line 444 for a better
-- reason than the one it gives.
--
-- What it costs is large enough that the surface has to say so, which is why `covered_ms` and
-- `excluded_ms` come back as their own row rather than being left as an assumption. Measured over
-- seven days on a real estate: `REFRESH` is 62.9% of query time and **99.6% of all spill** — 23.86 TB
-- of 23.96. So the advisor covers roughly a third of query time there, and a page headed "the estate's
-- costliest queries" that had quietly dropped the majority of them is exactly the kind of incomplete
-- answer this app exists not to give.
--
-- It also reorders what the top of the ranking is made of. With `REFRESH` gone there is zero spill in
-- the entire top twelve and no pruning finding either; what is left is failures, compilation share and
-- serial execution. Keep the volume rules, but do not expect them to be what a reader sees.
--
-- ## This app's own queries are excluded, and how much they were is returned
--
-- The scan reads `system.query.history`, and the scan is in it. On the first real run against a labs
-- workspace, eight of the top twelve shapes were this app's own signals and two rules fired on them: the
-- page told the reader to go and optimise the tool they were reading. That workspace's query time was
-- 51.8% ours over twenty days, which is not an artefact of a small estate — it is what an assessment
-- that reads twenty system-table aggregates on a schedule costs, in proportion to whatever else the
-- workspace does.
--
-- Excluded by any of four marks: a `query_tags` entry and a leading comment, both applied at submit time,
-- and the `-- Signal:` and `-- Rows:` header conventions every statement file carries.
-- `server/collect/sql/self.ts` holds all four and says what each is for; the short version is that the tag
-- is the platform's mechanism, the comment covers a workspace without the tags preview, and the two
-- conventions are what work backwards over history written before the other two shipped.
--
-- The retroactive pair took two attempts, and what failed is worth keeping. Matching the signal header as a
-- prefix left three of the top twelve ours — the executions in question opened with the bounds header, and
-- the signal header was the line beneath it. So both are matched anywhere in the text, and the bounds
-- header is in the list because it is the one convention every statement file has carried for longer than
-- the advisor has existed.
--
-- Counted separately rather than merged into `excluded_ms`, because the two are different claims. Time
-- excluded for being a `REFRESH` or a `GRANT` is the estate's own work this advisor cannot help with;
-- time excluded for being ours is the cost of running the assessment, and a reader is entitled to see
-- that figure — it is the one number on this page that is the tool's fault.
--
-- ## Covered is not the same as described, and the difference is returned
--
-- `covered_ms` is computed over `windows`, before the homogeneity guard below drops the shapes whose
-- recorded text spans several statement types. So covered time included work no returned row describes,
-- and the coverage percentage was a claim about the analysis that the analysis did not meet. On the
-- estate the guard was measured against, the gap is 1.0% of query time.
--
-- `ambiguous_ms` and `ambiguous_runs` are that gap, returned as a subset of covered rather than folded
-- into it, so the surface can report both what this could advise on and what it ended up describing.
--
-- ## The text is returned, because a reader cannot act on a hash
--
-- `statement_text` for the shape's representative execution, and this was the last thing the draft was
-- missing. Returning only the fingerprint made this `METRICS_ONLY` by omission — the strictest of the
-- three storage modes the advisor document specifies at line 1398, arrived at by accident — and also
-- useless, because `118d86d07db5ece6` is not something anybody can go and change.
--
-- Not redacted, and that is a decision rather than an oversight. This app runs inside the customer's
-- own environment, against their own workspace, and shows them their own queries; redacting text back
-- from somebody who can already read `system.query.history` is theatre that costs the surface its
-- point. The redaction list in that document stays relevant for the day any of those three stops being
-- true — an export leaving the environment, a hosted variant, or text handed to a model.
--
-- ## The representative is one execution, chosen by the document's own rule
--
-- A shape is a group and a plan is per statement, so anything that wants a plan later needs one
-- execution nominated now. Line 610: highest duration, then most recent, among the measurable
-- statements of the current window. `statement_id` comes back with it so row 33b has something to
-- fetch, and the choice is made here rather than in the app because the alternative is returning every
-- execution to pick one from.
--
-- Its `warehouse_id` and `compute_type` come with it, because most executions are not fetchable and
-- which ones is knowable in advance. `system.query.history` is a metastore-level table carrying every
-- workspace that shares it, while `GET /sql/history/queries/{id}` answers for one workspace — so a
-- statement from a sibling workspace 404s exactly as one on non-warehouse compute does. Measured over
-- fifteen days on labs: 96.79% on a warehouse this workspace can see, 3.10% on one of four it cannot,
-- 0.11% on something that is not a warehouse. Both misses are predictable from these two columns, and
-- `server/collect/sql/plans/retrievable.ts` is where they are read. See `docs/plan/h6-workload-advisor.md`.
--
-- ## Counted and measured are different, and conflating them flatters a shape
--
-- Every timing figure is over the statements that finished and were not served from the result
-- cache; the run counts are over every terminal statement. Two rules need the difference. A cached
-- statement's timings describe a lookup rather than an execution, so including them makes a shape
-- look fast in proportion to how often it was cached, and the advisor document excludes them from
-- discovery at line 443 for that reason. Failures used to be excluded by a `WHERE
-- execution_status = 'FINISHED'`, which made every failing statement in the estate invisible instead
-- of separate — line 545 asks for a failure signal "separately displayed rather than hidden in
-- performance score", and a shape failing half its runs is worth saying so.
--
-- Feeds: the workload advisor. Cites no requirement and scores nothing.
WITH windows AS (
  SELECT
    workspace_id,
    statement_id,
    statement_text,
    statement_type,
    start_time,
    total_duration_ms,
    execution_duration_ms,
    compilation_duration_ms,
    total_task_duration_ms,
    waiting_at_capacity_duration_ms,
    read_bytes,
    written_bytes,
    spilled_local_bytes,
    shuffle_read_bytes,
    pruned_files,
    read_files,
    from_result_cache,
    execution_status,
    compute.warehouse_id                    AS warehouse_id,
    -- Read for the representative rather than for the aggregate: with `warehouse_id` it decides
    -- whether a plan for that one execution is retrievable at all. See the representative CTE.
    compute.type                            AS compute_type,
    query_source.job_info.job_id            AS job_id,
    query_source.pipeline_info.pipeline_id  AS pipeline_id,
    -- Which half of the window a statement is in. An integer rather than a label so every
    -- aggregate below can multiply by it, which keeps the two windows in one pass over the data.
    CASE
      WHEN start_time >= current_timestamp() - make_dt_interval(least(:lookback_days, 15)) THEN 1
      ELSE 0
    END                                     AS is_now,
    /*
     * Which statements the performance figures are allowed to come from, as a multiplier for the
     * same reason `is_now` is one.
     *
     * Finished, and not served from the result cache. Both halves are `include_plans`-adjacent
     * decisions from `databricks-query-optimization-advisor.md`: cache hits are excluded from
     * discovery at line 443 because a cached statement's timings describe a lookup rather than an
     * execution, and ranking a shape on them credits it with work it did not do. They are still
     * counted below — `CACHE_HIT` is one of the thirteen rules and needs the count — but they are
     * not what the shape is ranked or advised on.
     */
    CASE
      WHEN execution_status = 'FINISHED' AND coalesce(from_result_cache, false) = false THEN 1
      ELSE 0
    END                                     AS is_measurable,
    /*
     * Whether this is work a reader could do something about, as a flag rather than a `WHERE`.
     *
     * `REFRESH` is the exclusion that matters and the header says what it costs. A flag because the
     * cost has to be *reported*: filtering here would leave the surface asserting a coverage figure it
     * had no way to compute, and the whole argument for excluding a managed service is undermined by a
     * page that does not admit how much it left out.
     *
     * A positive list rather than `<> 'REFRESH'` on purpose. `system.query.history` records eleven
     * statement types and most of the rest — `SET`, `GRANT`, `USE`, `SHOW` — are metadata operations
     * that would rank nowhere and inflate the shape count on the way there. The list is the advisor
     * document's own at line 444, plus the two DDL forms that do real work.
     */
    CASE
      WHEN statement_type IN (
        'SELECT', 'INSERT', 'MERGE', 'UPDATE', 'DELETE', 'COPY', 'REPLACE', 'CREATE'
      ) THEN 1
      ELSE 0
    END                                     AS is_covered,
    /*
     * Whether this app submitted the statement, as a flag for the same reason `is_covered` is one: the
     * cost of the assessment has to be reported rather than quietly dropped. See the header.
     *
     * Any of four marks counts. `query_tags` is the platform's own and the one that survives text
     * truncation; the comment covers a workspace without the tags preview and any history written before
     * the tag shipped. `try_element_at` rather than `[]` so a workspace whose column is absent or whose map
     * is empty reads as not-ours instead of failing the statement.
     */
    CASE
      WHEN try_element_at(query_tags, 'databricks_waf') = 'assessment'
        OR startswith(trim(statement_text), '-- databricks-waf: assessment')
        /*
         * The two retroactive marks, matched anywhere in the text rather than at the start.
         *
         * Neither of the marks above is retroactive, so without these the advisor spends its first
         * fortnight after an upgrade ranking the assessment that ran before they existed — which is not a
         * hypothetical: it is what the run after they shipped showed, and then what the run after *that*
         * one showed, for two reasons this pair fixes. A `startswith` on the signal header misses an
         * execution whose text opens with the bounds header instead, and the signal header reached some
         * files later than others — so the bounds declaration, which every statement file has carried for
         * longer, is the mark that reaches furthest back. `server/collect/sql/self.ts` holds both strings.
         */
        OR contains(statement_text, '-- Signal: sql:')
        OR contains(statement_text, '-- Rows: ')
      THEN 1
      ELSE 0
    END                                     AS is_self
  FROM system.query.history
  -- Twice the current window, so the trend has an equal prior one, and never past thirty days.
  WHERE start_time >= current_timestamp() - make_dt_interval(2 * least(:lookback_days, 15))
    /*
     * Terminal statements only, and NOT finished ones only.
     *
     * An earlier draft filtered to FINISHED here, which made every failing and cancelled statement
     * in the estate invisible rather than separate. The advisor document is explicit at line 545
     * that a failure signal is "separately displayed rather than hidden in performance score", and
     * a shape that fails half its runs is a finding — just not a performance one. So failures are
     * read and counted, and `is_measurable` above keeps them out of every timing figure.
     */
    AND execution_status IN ('FINISHED', 'FAILED', 'CANCELED')
    -- Redaction empties the text under customer-managed keys, and an empty string normalises to an
    -- empty string: without this every redacted statement in the estate collects into one shape.
    AND statement_text IS NOT NULL
    AND trim(statement_text) <> ''
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
/*
 * How much of the estate's query time this statement is describing.
 *
 * One row, cross-joined onto every result row below, because there is nowhere else to put it: the
 * signal is a list of shapes and a reader needs the denominator beside them. Over the *current* window
 * only — `is_now` — since a coverage figure spanning the comparison window would describe a period
 * twice as long as the one the page is about.
 *
 * Computed before the type filter is applied, which is the whole reason `is_covered` is a flag rather
 * than a `WHERE` clause up there.
 */
coverage AS (
  SELECT
    -- Covered is the estate's own work, of a type this can advise on. The two exclusions below are
    -- subtracted from the same denominator, so `covered + excluded + self` is the window's query time.
    sum(is_now * is_measurable * is_covered * (1 - is_self) * total_duration_ms)       AS covered_ms,
    sum(is_now * is_measurable * (1 - is_covered) * (1 - is_self) * total_duration_ms) AS excluded_ms,
    sum(is_now * is_measurable * is_self * total_duration_ms)                          AS self_ms,
    sum(is_now * is_covered * (1 - is_self))                                          AS covered_runs,
    sum(is_now * (1 - is_covered) * (1 - is_self))                                    AS excluded_runs,
    sum(is_now * is_self)                                                             AS self_runs
  FROM windows
),
shaped AS (
  SELECT
    *,
    -- Truncated to 16 hex characters — 64 bits, which at tens of thousands of shapes makes a
    -- collision vanishingly unlikely while keeping the value short enough to show a reader.
    substr(
      sha2(
        -- Six passes, in this order, and the order is the whole design. Each is measured against a corpus
        -- written to exercise it, in `scripts/measure-shape-fingerprint.mjs`, and the recording says which
        -- pairs it gets right and which it does not. Changing anything here without re-running that is how
        -- this expression came to swallow whole statements for months without anybody knowing.
        trim(regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                -- Literals second, and never across a newline. A literal's quotes are consumed with it, so
                -- `'2026-01-01'` and `'x'` both become S rather than leaving a bare quote behind. `''`
                -- inside one is consumed too, so `'it''s'` is one S and not two. The newline bound is what
                -- stops an apostrophe in a comment — `-- don't` — from pairing with a quote further down and
                -- replacing every statement in between with a single S.
                regexp_replace(
                  -- Digits first: an epoch millisecond in a generated table name is one shape run many
                  -- times, not many shapes run once. Measured on labs, every shape this merges is that.
                  regexp_replace(lower(trim(statement_text)), '[0-9]+', 'N'),
                  concat(chr(39), '([^', chr(39), chr(10), ']|', chr(39), chr(39), ')*', chr(39)),
                  'S'
                ),
                -- Comments and identifier quotes carry nothing that distinguishes one statement from
                -- another, and both are removed rather than replaced. After the literal pass, so a `--`
                -- inside a string is already an S and cannot be mistaken for a comment. The lower-case
                -- anchor is why: without it, `` `a--b` `` and `` `a--c` `` become one shape, which is the
                -- same defect as the swallow above. The cost is that a comment hugging an identifier —
                -- `from t--why` — is left in the text. A split is worth accepting to avoid a false merge.
                concat('(?s)(?<![a-z0-9_])--[^', chr(10), ']*|/\\*.*?\\*/|', chr(96)),
                ''
              ),
              -- `date 'x'` and `'x'` are one shape with a cast written differently. After literals, so
              -- there is an S to fold into.
              '\\b(date|timestamp|interval)\\s+S',
              'S'
            ),
            -- An IN list's length is not part of a shape: `in (S, S)` and `in (S, S, S)` are one query
            -- written twice. Measured as the largest defect on labs after the swallow.
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
    )                                                                        AS shape
  FROM windows
  -- Here rather than in `windows`, so `coverage` above can see what was left out.
  WHERE is_covered = 1
    AND is_self = 0
),
/*
 * The one execution that stands for the shape, and the text that comes with it.
 *
 * Line 610 of the advisor document: highest duration, then most recent. Its first key is the composite
 * score, which cannot be applied here — the coefficients are versioned configuration and live in the
 * analyzer — so this takes the second and third. That is a knowing departure and a small one: within
 * one shape the executions differ in duration and little else, where the composite exists to compare
 * shapes against each other.
 *
 * A measurable statement of the current window where there is one. A shape's representative should not
 * be a cache hit, whose plan describes a lookup, nor a failure, whose timings describe how far it got.
 *
 * ## Where every run failed, a failed run is the representative
 *
 * `is_measurable = 1` used to be a `WHERE` clause, and a shape whose every current-window execution
 * failed or was served from cache matched none of it. The join below is a `LEFT JOIN`, so those shapes
 * came back with a null `statement_id`, a null `statement_text` and a null `representative_at` — and
 * they are precisely the shapes the failure list is *made of*. The one page that exists to show a
 * reader what is failing showed them a row with no query on it.
 *
 * So it is a sort key rather than a filter: measurable first, then the document's own two keys. A shape
 * with one finished run and nine hundred failures still represents itself with the finished one, and a
 * shape with nothing but failures represents itself with its longest failure rather than with nothing.
 * `representative_measured` says which happened, and `representative_status` says what the chosen run
 * did — a surface may say "this text is from a run that failed" only from those two, because
 * `is_measurable` is false for a cache hit as well and the two are not the same sentence.
 *
 * ## Where it ran comes with it, and is not the aggregate above
 *
 * `warehouse_id` and `compute_type` are this one execution's, where `warehouses` in `per_shape` counts
 * the distinct ones across the group. A plan is fetched per statement, so the aggregate cannot answer
 * whether *this* statement's plan is reachable: a shape that ran on four warehouses, one of them in
 * another workspace, would be indistinguishable from one that ran on four this workspace owns.
 */
representative AS (
  SELECT
    workspace_id,
    shape,
    statement_id,
    statement_text,
    start_time,
    is_measurable,
    execution_status,
    warehouse_id,
    compute_type
  FROM (
    SELECT
      workspace_id,
      shape,
      statement_id,
      statement_text,
      start_time,
      is_measurable,
      execution_status,
      warehouse_id,
      compute_type,
      ROW_NUMBER() OVER (
        PARTITION BY workspace_id, shape
        ORDER BY is_measurable DESC, total_duration_ms DESC, start_time DESC
      ) AS pick
    FROM shaped
    WHERE is_now = 1
  )
  WHERE pick = 1
),
per_shape AS (
  SELECT
    workspace_id,
    shape,
    -- The homogeneity guard's evidence. Returned rather than only filtered on, so the analyzer can
    -- report how much of the estate it declined to describe.
    count(DISTINCT statement_type)                                           AS kinds,
    max(statement_type)                                                      AS statement_type,
    /*
     * Two counts per window, and the difference between them is the point.
     *
     * `runs_*` is every terminal statement of this shape, which is what frequency means and what the
     * cache and failure rates are a proportion of. `measured_*` is the subset the timings below are
     * allowed to come from. A shape that ran ten thousand times and was served from cache nine
     * thousand of them is a different thing from one that executed ten thousand times, and only the
     * second is a performance problem.
     */
    sum(is_now)                                                              AS runs_now,
    sum(1 - is_now)                                                          AS runs_before,
    sum(is_now * is_measurable)                                              AS measured_now,
    sum((1 - is_now) * is_measurable)                                        AS measured_before,
    -- Every figure from here down is multiplied by `is_measurable`, so a cached or failed statement
    -- contributes to the counts above and to nothing else.
    sum(is_now * is_measurable * total_duration_ms)                          AS ms_now,
    sum((1 - is_now) * is_measurable * total_duration_ms)                    AS ms_before,
    sum(is_now * is_measurable * spilled_local_bytes)                        AS spilled_bytes,
    sum(is_now * is_measurable * shuffle_read_bytes)                         AS shuffle_bytes,
    sum(is_now * is_measurable * read_bytes)                                 AS read_bytes,
    sum(is_now * is_measurable * written_bytes)                              AS written_bytes,
    sum(is_now * is_measurable * pruned_files)                               AS pruned_files,
    sum(is_now * is_measurable * read_files)                                 AS read_files,
    sum(is_now * is_measurable * total_task_duration_ms)                     AS task_ms,
    sum(is_now * is_measurable * execution_duration_ms)                      AS execution_ms,
    sum(is_now * is_measurable * compilation_duration_ms)                    AS compilation_ms,
    -- Null on non-warehouse compute, and a sum of nulls is null, so a pipeline would report no
    -- queue at all rather than none observed.
    sum(is_now * is_measurable * coalesce(waiting_at_capacity_duration_ms, 0)) AS queue_ms,
    -- The evidence for two of the thirteen rules, and both are counts of what was excluded above.
    -- `CACHE_HIT` is informational; a failure rate is a finding but not a performance one.
    sum(is_now * CASE WHEN coalesce(from_result_cache, false) THEN 1 ELSE 0 END) AS cache_hits,
    sum(is_now * CASE WHEN execution_status <> 'FINISHED' THEN 1 ELSE 0 END)  AS failures,
    count(DISTINCT warehouse_id)                                             AS warehouses,
    count(DISTINCT job_id)                                                   AS jobs,
    count(DISTINCT pipeline_id)                                              AS pipelines,
    max(CASE WHEN is_now = 1 AND is_measurable = 1 THEN total_duration_ms END) AS worst_ms,
    percentile_approx(
      CASE WHEN is_now = 1 AND is_measurable = 1 THEN total_duration_ms END,
      0.5
    )                                                                        AS median_ms
  FROM shaped
  -- Named rather than positional: H1c executes this one workspace at a time and that is only exact
  -- if every grouping key includes workspace_id, which is what slices.ts refuses a positional key
  -- for.
  GROUP BY workspace_id, shape
),
/*
 * The covered work the shapes list does not describe, because its shapes were not shapes.
 *
 * `covered_ms` is computed before `HAVING kinds = 1` drops the ambiguous shapes, so it counts time that
 * reaches no returned row. On the estate the guard was measured against that is 1.0% of query time: 1.0%
 * the coverage figure claimed to describe and did not.
 *
 * Returned as its own pair rather than subtracted from `covered_ms`, because the two are different
 * claims and a reader is owed both — covered is the work of a kind this can advise on, ambiguous is the
 * part of it whose recorded text did not identify a statement. `ambiguous_ms` is a subset of
 * `covered_ms` and `ambiguous_runs` of `covered_runs`, counted off the same rows on the same basis:
 * `ms_now` is measurable-only and so is `covered_ms`, `runs_now` is every run and so is `covered_runs`.
 * The analyzer subtracts; see `coverageOf` in `server/advise/workload.ts`.
 *
 * One row, like `coverage`, and cross-joined the same way. The `runs_now > 0` filter matches the one in
 * the final `WHERE` so that both sides count the same population.
 */
ambiguity AS (
  SELECT
    coalesce(sum(CASE WHEN kinds > 1 THEN ms_now END), 0)   AS ambiguous_ms,
    coalesce(sum(CASE WHEN kinds > 1 THEN runs_now END), 0) AS ambiguous_runs,
    count(CASE WHEN kinds > 1 THEN 1 END)                   AS ambiguous_shapes
  FROM per_shape
  WHERE runs_now > 0
)
SELECT
  s.workspace_id,
  s.shape,
  statement_type,
  kinds,
  runs_now,
  runs_before,
  measured_now,
  measured_before,
  ms_now,
  ms_before,
  -- Over the measured runs, not over every run. Dividing by `runs_now` would report a shape as fast
  -- in proportion to how often it was served from cache.
  round(ms_now / nullif(measured_now, 0))                                    AS mean_ms_now,
  round(ms_before / nullif(measured_before, 0))                              AS mean_ms_before,
  median_ms,
  worst_ms,
  spilled_bytes,
  shuffle_bytes,
  read_bytes,
  written_bytes,
  -- Null where nothing was read from files, which is a different statement from pruning nothing.
  round(100.0 * pruned_files / nullif(pruned_files + read_files, 0), 1)      AS pruned_percent,
  -- The counts as well as the ratio, because one rule is about file *size* rather than pruning: a scan
  -- reading a great many files for very few bytes is a compaction problem, and `read_bytes / read_files`
  -- is the only place that shows.
  read_files,
  pruned_files,
  round(task_ms / nullif(execution_ms, 0), 2)                                AS parallelism,
  round(100.0 * compilation_ms / nullif(ms_now, 0), 1)                       AS compilation_percent,
  queue_ms,
  cache_hits,
  failures,
  warehouses,
  jobs,
  pipelines,
  r.statement_id,
  -- Truncated, because a page shows the head of a query and a `MERGE` generated by a framework can run
  -- to tens of kilobytes. Four thousand characters is past anything a reader reads and small enough
  -- that twelve of them are not what decides whether this statement fits an inline result.
  substr(r.statement_text, 1, 4000)                                          AS statement_text,
  r.start_time                                                               AS representative_at,
  -- Whether the text above came from a run whose timings mean anything, and what that run did. Both are
  -- needed to say which: a run that is not measurable either failed or was served from the cache.
  coalesce(r.is_measurable, 0) = 1                                           AS representative_measured,
  r.execution_status                                                         AS representative_status,
  -- Where the representative ran, which is what says whether its plan can be fetched at all. Null on
  -- non-warehouse compute, and that null is the answer rather than a gap — see the representative CTE.
  r.warehouse_id                                                             AS representative_warehouse_id,
  r.compute_type                                                             AS representative_compute_type,
  -- The same figures on every row, which is the cost of having nowhere else to put them. See the
  -- `coverage` CTE: a list of the costliest shapes is not readable without the denominator.
  c.covered_ms,
  c.excluded_ms,
  c.self_ms,
  c.covered_runs,
  c.excluded_runs,
  c.self_runs,
  -- The part of `covered_*` that no returned row describes, because its shape spanned several statement
  -- types. A subset of covered rather than a fourth category. See the `ambiguity` CTE.
  a.ambiguous_ms,
  a.ambiguous_runs,
  a.ambiguous_shapes
FROM per_shape s
LEFT JOIN representative r
  ON r.workspace_id = s.workspace_id
  AND r.shape = s.shape
CROSS JOIN coverage c
CROSS JOIN ambiguity a
WHERE runs_now > 0
  -- See the header. A shape spanning several statement types was never one shape.
  AND kinds = 1
/*
 * By total measured time, because impact is total rather than mean: a shape at two seconds and
 * 291,362 runs outranks one at seven hours and thirty, and a reader can act on both.
 *
 * Two things this ordering is knowingly not. It is not the composite score the advisor document
 * specifies at line 594 — seven weighted features, each capped at its 99th percentile — because that
 * needs coefficients held in versioned configuration rather than in a statement, so it belongs to the
 * analyzer. And it ranks a shape that only ever fails last, at `ms_now` of zero, so a failure-rate
 * finding needs its own ordering over these same rows rather than this one. Both are row 33.
 */
ORDER BY ms_now DESC, shape
LIMIT :shape_limit
