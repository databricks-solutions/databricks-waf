-- Signal: sql:workload.warehouse_pressure
-- Rows: at most :warehouse_limit
-- Benchmark: workload
--
-- What each SQL warehouse was actually asked to do, over the seven days a sizing decision is made from.
-- Feeds the warehouse half of the workload advisor. Like the query shapes beside it, this scores nothing
-- and cites no requirement: it is advice about a configuration, not a measurement against a standard.
--
-- ## Why seven days, and why the day counts rather than the totals decide anything
--
-- A warehouse is resized on a pattern, not on an afternoon. One busy Tuesday is not a reason to add a
-- cluster, and a quiet week in August is not a reason to shrink a warehouse that carries month-end. So
-- every pressure figure here comes back twice: as a total over the window, and as the number of distinct
-- days on which it was present at all. The rules upstream require both, which is the "sustained" in
-- sustained pressure — `days_queued` of 1 out of 7 is a bad day, and `days_queued` of 5 is a size.
--
-- The day counts use the lowest bar there is — any queueing at all that day, any spill at all that day —
-- deliberately. A tunable threshold inside a `count(CASE WHEN ...)` would be a threshold nobody can see
-- from the ruleset, and every number a rule turns on is meant to be readable in
-- `config/analyze/sizing-rules.yaml` (ADR 0002). What is in SQL here is only the objective part: whether
-- the thing happened that day.
--
-- Seven days rather than the advisory's own window, capped here rather than by the caller for the same
-- reason `workload_query_shapes.sql` caps at fifteen: a ceiling held by whatever binds the parameter is
-- one a later caller can forget. A longer window would also make the day counts unreadable — "queued on
-- 9 days" means one thing out of 14 and another out of 30, and the rules would have to carry the
-- denominator to say which.
--
-- The window starts at a date boundary rather than seven times twenty-four hours ago, and that is the
-- point of it. A rolling 168-hour window that begins mid-afternoon spans eight calendar dates, so
-- `date(start_time)` produced eight buckets and a continuously-used warehouse reported "8 days" on a page
-- headed "the last 7 days" — permanently, and next to thresholds phrased as four days out of seven. Today
-- is a partial day, which is what a daily window means; a count that cannot exceed its own denominator is
-- worth more than a whole final day.
--
-- ## Uptime is derived from the event stream, and the last interval runs to now
--
-- `system.compute.warehouse_events` records a row when a warehouse starts, stops, or changes how many
-- clusters it is running, and `cluster_count` on each is the state from that moment until the next event.
-- So uptime is a sum over the gaps, and `cluster_ms` weights each gap by the clusters running in it —
-- which is what a bill is proportional to and therefore what utilisation has to be measured against.
--
-- The last interval of the window has no next event and is closed at `current_timestamp()`, so a
-- warehouse that is up right now has its current session counted to this instant.
--
-- The first interval is the one this used to get wrong. Only events inside the window were read, so a
-- warehouse that started eight days ago and has not stopped since reported uptime from its first event
-- *inside* the window — and a warehouse with no in-window event at all reported no uptime, which is the
-- opposite of what a continuously-running warehouse costs. `carried` reads the last event before the
-- boundary and, where it left the warehouse running, seeds an interval at the window's first instant. So
-- the window opens in the state the warehouse was already in, and `carried_in` says on which rows it did.
--
-- The seed reads back as far as the table goes, and the bound it used to have is worth recording because
-- it was wrong in the way this file's header warns about. It looked back thirty days, justified by a cost
-- nobody had measured and a claim — "far past any auto-stop setting" — that is false for exactly the
-- warehouse this seed exists for. A warehouse with auto-stop disabled emits nothing while it runs, so its
-- last event is as old as its current session; `compute_warehouse_inventory.sql` reads that setting and
-- the page beside this one prints "never stops" for it. The bound therefore excluded the one population
-- it was written to catch.
--
-- Measured on labs, where the whole table is 9,605 events over 65 warehouses. The cost the bound was
-- there to avoid is not one two runs each could separate: 4.4 s and 4.3 s bounded against 4.5 s and
-- 4.2 s unbounded. What it changed was the population, and by how much depends on the scope the caller
-- asks for. Over the account, 52 of the 58 warehouses with an event before the boundary had it more than
-- thirty days back, so the bound discarded the last known state of nine in ten of them; all 52 were
-- stopped, which is why the reading did not move and is not a reason the bound was safe. Scoped to the
-- live workspaces, which is how the collector runs this, none was beyond the floor and the oldest was
-- 26 days back — four days of margin on a bound that had been described as far past anything.
--
-- The event table is a state-change log, one row per start, stop or resize, and is orders of magnitude
-- smaller than the query history this same statement reads seven days of.
--
-- `days_seen` still counts days with an event, and so is 0 on a warehouse that was up all week and did
-- nothing worth recording. That is deliberate — the churn rule divides `starts` by it and wants days the
-- warehouse was observed doing something — but it means `days_seen` is no longer the tell for a session
-- that began before the window. `carried_in` is.
--
-- ## Utilisation here is statement execution per cluster-millisecond, and it is not CPU
--
-- `execution_percent` is the sum of `execution_duration_ms` over the window's statements divided by
-- cluster-milliseconds of uptime. Read it as: for every minute of warehouse the account paid for, how
-- many minutes of statement execution came out. It can exceed 100 for a genuinely concurrent warehouse,
-- because several statements execute at once and their durations sum past the wall clock, and that is
-- information rather than a bug — a warehouse over 100 is one where concurrency is doing what it is for.
--
-- What it is not is a CPU figure. Nothing in these two tables measures how busy a cluster's cores were,
-- so a low share here means the warehouse spent its paid time not executing statements. That is an
-- auto-stop question far more often than a size one, which is why the two rules reading it are separate
-- and why neither of them says "downsize" from this number alone.
--
-- ## The assessment's own statements are excluded here, at the source
--
-- The same decision as the query-shape statement beside it, and it took two goes to get here. Our
-- statements were once counted as load — the warehouse did run them and the account was billed for
-- them — with `self_ms` returned so the rules could decline to advise on a warehouse whose work was
-- mostly ours. That produced a warehouse reported to the customer as "measuring ourselves": a row in
-- their list of warehouses, occupying the space where advice goes, saying nothing they can act on.
--
-- Every figure below is now the estate's own work. `is_self` is a `WHERE` clause rather than a
-- measure, so our statements never reach a percentile, a day count, a user count or a spill total, and
-- there is no share left to suppress anything with. A number a reader has to discount is worse than a
-- number that is already about them.
--
-- Recognition is by mark and deliberately not by identity, which is the same choice ADR 0070 made and
-- the one worth restating here because identity is the intuitive lever. An interactive scan runs
-- on-behalf-of the signed-in user, so `executed_by` on our statements is a person whose other queries
-- are the estate's real work — filtering on them would drop the customer's own queries and still miss a
-- scheduled run, which authenticates as something else again. `server/collect/sql/self.ts` holds the
-- strings.
--
-- ## Uptime is left whole, because our share of it is not worth modelling
--
-- The one figure the exclusion above cannot clean. `up_ms` and `cluster_ms` come from the event stream,
-- which records that a warehouse was running and not who asked it to, so time we kept a warehouse warm
-- stays in the utilisation denominator after our statements have left the numerator.
--
-- Deliberately not corrected for. An assessment is twenty small system-table aggregates on a weekly
-- schedule, which is a negligible share of any estate large enough to have a sizing question — and a
-- discount for it would be an approximation the reader cannot check, applied to a figure that was
-- already right. Where the assessment genuinely is a warehouse's workload, the answer is a deployment
-- one rather than an arithmetic one: point the app at a dedicated 2X-Small of its own and the question
-- stops arising. `assessment-only` is what names that warehouse.
--
-- What this costs is a quiet estate: a nearly-idle workspace where we woke a warehouse repeatedly can
-- report low utilisation partly of our making. That is a development workspace rather than a customer's,
-- and it is preferred to a correction on every real one.
--
-- ## Every warehouse the window saw, whether or not it ran anything
--
-- A `FULL OUTER JOIN`, because the two halves disagree about which warehouses exist and both answers
-- matter. A warehouse with events and no statements was paid for and did nothing; one with statements
-- and no events never started or stopped inside the window, which is either a warehouse that is always
-- up or one whose session began before it. `days_used` of 0 is the first case and is a state the surface
-- names rather than a finding: an idle warehouse is already assessed by the auto-stop control, and two
-- surfaces telling a reader the same thing in different words is how an advisor loses its authority.
--
-- Definitions — name, size, cluster range, auto-stop, serverless or classic — are deliberately not read
-- here. `compute_warehouse_inventory` already returns them, and it carries a fix this statement would
-- otherwise have to repeat: the latest row for a warehouse is the row recording its deletion, and
-- ranking without accounting for that reported 5,101 live warehouses where 24 existed. The advisory run
-- asks for both signals and the analyzer joins them.
--
-- Feeds: the workload advisor's warehouse sizing. Scores nothing.
WITH history AS (
  SELECT
    workspace_id,
    compute.warehouse_id                                    AS warehouse_id,
    date(start_time)                                        AS day,
    total_duration_ms,
    execution_duration_ms,
    -- Null on compute that cannot queue, and a sum of nulls is null, so a warehouse would report no
    -- queueing at all rather than none observed.
    coalesce(waiting_at_capacity_duration_ms, 0)            AS queue_ms,
    coalesce(spilled_local_bytes, 0)                        AS spilled_bytes,
    executed_by,
    -- Finished, and not served from the result cache. A cache hit's duration describes a lookup, and
    -- crediting a warehouse's utilisation with it would make a heavily cached warehouse look busy.
    CASE
      WHEN execution_status = 'FINISHED' AND coalesce(from_result_cache, false) = false THEN 1
      ELSE 0
    END                                                     AS is_measurable,
    -- Ours, by the same four marks the query-shape statement uses. Filtered out below rather than
    -- measured — see the header. `server/collect/sql/self.ts` holds the strings.
    CASE
      WHEN try_element_at(query_tags, 'databricks_waf') = 'assessment'
        OR startswith(trim(statement_text), '-- databricks-waf: assessment')
        OR contains(statement_text, '-- Signal: sql:')
        OR contains(statement_text, '-- Rows: ')
      THEN 1
      ELSE 0
    END                                                     AS is_self
  FROM system.query.history
  -- Seven calendar days, today included, capped here rather than by the caller. See the header.
  WHERE start_time >= date_sub(current_date(), least(:lookback_days, 7) - 1)
    -- Warehouse statements only. Serverless notebook and job compute is in this table too and has no
    -- size to advise on.
    AND compute.warehouse_id IS NOT NULL
    AND execution_status IN ('FINISHED', 'FAILED', 'CANCELED')
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
/*
 * The estate's own work, which is everything the figures below are about.
 *
 * The exclusion is here rather than in each aggregate so that there is one of it. Every CTE downstream
 * reads this and none of them has to remember: a percentile, a distinct-user count and a day count each
 * need our statements gone for a different reason, and three separate `is_self = 0` predicates would be
 * three places for the next aggregate to be added without one.
 */
statements AS (
  SELECT * FROM history WHERE is_self = 0
),
/*
 * Whether the assessment ran here at all, which is the only thing about ourselves anything reads.
 *
 * A count rather than a duration, because no figure is corrected for our share and none should be. Its
 * one job is to separate a warehouse nothing ran on from one only this assessment ran on: those two rows
 * want opposite advice, and telling a customer the warehouse their assessment runs on is unused invites
 * them to delete it.
 */
self_load AS (
  SELECT
    workspace_id,
    warehouse_id,
    count(*)                                                AS self_runs
  FROM history
  WHERE is_self = 1
  GROUP BY workspace_id, warehouse_id
),
/*
 * Per warehouse per day, which exists only so the day counts below can be counted.
 *
 * The alternative is `count(DISTINCT CASE WHEN queue_ms > 0 THEN date(start_time) END)` against the
 * statements directly, which is the same answer and reads as an accident.
 */
per_day AS (
  SELECT
    workspace_id,
    warehouse_id,
    day,
    count(*)                                                AS runs,
    sum(is_measurable)                                      AS measured,
    sum(is_measurable * queue_ms)                           AS queue_ms,
    -- The two durations are coalesced inside the sum rather than after it. A row can carry a null
    -- duration, `is_measurable * null` is null, and a sum of nothing but nulls is null rather than zero —
    -- so a warehouse whose only statements were untimed reported a busy time of zero and a utilisation of
    -- unknown, which are two different claims from one measurement. Observed on labs.
    sum(is_measurable * coalesce(execution_duration_ms, 0)) AS busy_ms,
    sum(is_measurable * coalesce(total_duration_ms, 0))     AS total_ms,
    sum(is_measurable * spilled_bytes)                      AS spilled_bytes,
    count(DISTINCT executed_by)                             AS users
  FROM statements
  GROUP BY workspace_id, warehouse_id, day
),
per_warehouse AS (
  SELECT
    workspace_id,
    warehouse_id,
    sum(runs)                                               AS runs,
    sum(measured)                                           AS measured,
    sum(queue_ms)                                           AS queue_ms,
    sum(busy_ms)                                            AS busy_ms,
    sum(total_ms)                                           AS total_ms,
    sum(spilled_bytes)                                      AS spilled_bytes,
    -- The busiest day's user count rather than the window's distinct users: concurrency is what a
    -- cluster range answers to, and a warehouse ten people use on different days is not contended.
    max(users)                                              AS peak_users,
    count(*)                                                AS days_used,
    count(CASE WHEN queue_ms > 0 THEN 1 END)                AS days_queued,
    count(CASE WHEN spilled_bytes > 0 THEN 1 END)           AS days_spilled
  FROM per_day
  GROUP BY workspace_id, warehouse_id
),
/*
 * The p95 statement, over the whole window rather than per day.
 *
 * Separate from `per_warehouse` because a percentile of per-day percentiles is not a percentile. It is
 * here rather than beside the sums because one of the two size rules turns on it: a warehouse whose
 * slowest statements are fast has headroom, and a mean would hide the tail that decides that.
 */
latency AS (
  SELECT
    workspace_id,
    warehouse_id,
    percentile_approx(CASE WHEN is_measurable = 1 THEN total_duration_ms END, 0.95) AS p95_ms,
    max(CASE WHEN is_measurable = 1 THEN total_duration_ms END)                     AS worst_ms,
    max(CASE WHEN is_measurable = 1 THEN queue_ms END)                              AS worst_queue_ms
  FROM statements
  GROUP BY workspace_id, warehouse_id
),
events AS (
  SELECT
    workspace_id,
    warehouse_id,
    event_type,
    cluster_count,
    event_time
  FROM system.compute.warehouse_events
  -- The same boundary as the statements above, so `days_seen` and `days_used` are counted out of the same
  -- seven and a reader comparing them is comparing like with like.
  WHERE event_time >= date_sub(current_date(), least(:lookback_days, 7) - 1)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
/*
 * The state each warehouse was already in when the window opened.
 *
 * The last event before the boundary, and only where it left clusters running: a warehouse whose last
 * event stopped it needs no seed, because the timeline below starts it again the moment it next starts.
 * Ranked before the running filter is applied, so a warehouse that stopped and is therefore absent from
 * this CTE is absent because its *latest* event stopped it, rather than because an older running event
 * was passed over for it. `advisor-populations.test.ts` fails the build on the other order — not
 * `history.ts`, which guards `delete_time` and `change_time` and cannot see this column.
 *
 * `cluster_count ASC` breaks a tie on `event_time`, which the STOPPING and STOPPED of one shutdown can
 * share to the second. The tie has to be broken somewhere and this breaks it towards not seeding, so a
 * warehouse is read as up at the boundary only where nothing at that instant says otherwise.
 *
 * No lower bound, for the reason in the header: the bound that was here excluded the warehouses whose
 * last event is oldest, which are the ones that have been running longest.
 */
carried AS (
  SELECT workspace_id, warehouse_id, cluster_count
  FROM (
    SELECT
      workspace_id,
      warehouse_id,
      cluster_count,
      ROW_NUMBER() OVER (
        PARTITION BY workspace_id, warehouse_id ORDER BY event_time DESC, cluster_count ASC
      )                                                     AS recency
    FROM system.compute.warehouse_events
    WHERE event_time < date_sub(current_date(), least(:lookback_days, 7) - 1)
      AND (:workspace_id = '' OR workspace_id = :workspace_id)
      AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  )
  WHERE recency = 1 AND cluster_count > 0
),
/*
 * Every state change the window contains, with the carried state seeded at its first instant.
 *
 * `seeded` breaks the tie when a warehouse has a real event exactly at the boundary: the seed sorts
 * first, so the interval between the two is zero milliseconds long and the real event governs from
 * there. Without the tie-break the ordering is arbitrary and the seed could swallow the first real
 * interval of the window.
 */
timeline AS (
  SELECT workspace_id, warehouse_id, cluster_count, event_time AS at, 0 AS seeded
  FROM events
  UNION ALL
  SELECT
    workspace_id,
    warehouse_id,
    cluster_count,
    cast(date_sub(current_date(), least(:lookback_days, 7) - 1) AS TIMESTAMP) AS at,
    1                                                       AS seeded
  FROM carried
),
intervals AS (
  SELECT
    workspace_id,
    warehouse_id,
    cluster_count,
    at,
    seeded,
    lead(at) OVER (
      PARTITION BY workspace_id, warehouse_id ORDER BY at, seeded DESC
    )                                                       AS next_at
  FROM timeline
),
uptime AS (
  SELECT
    workspace_id,
    warehouse_id,
    -- Wall-clock time with at least one cluster running, and the same weighted by the clusters running.
    -- The second is what the account paid for and so what utilisation is measured against. The upper
    -- clamp is `current_timestamp()` twice over: an open last interval runs to now, and a closed one
    -- cannot end after it.
    sum(
      CASE
        WHEN cluster_count > 0
        THEN timestampdiff(
          MILLISECOND, at, least(coalesce(next_at, current_timestamp()), current_timestamp())
        )
        ELSE 0
      END
    )                                                       AS up_ms,
    sum(
      CASE
        WHEN cluster_count > 0
        THEN cluster_count * timestampdiff(
          MILLISECOND, at, least(coalesce(next_at, current_timestamp()), current_timestamp())
        )
        ELSE 0
      END
    )                                                       AS cluster_ms,
    max(cluster_count)                                      AS peak_clusters,
    -- Whether any of this warehouse's uptime came from a session that began before the window.
    max(seeded)                                             AS carried_in
  FROM intervals
  GROUP BY workspace_id, warehouse_id
),
/*
 * What the window's own events say, which is a different population from the intervals above.
 *
 * A warehouse seeded up and never touched again has uptime and no events, so these two counts are 0 for
 * it. Kept apart from `uptime` for exactly that reason: `starts` is a count of startings and `days_seen`
 * is a count of days one happened, and neither is a claim about how long the warehouse ran.
 */
seen AS (
  SELECT
    workspace_id,
    warehouse_id,
    count(CASE WHEN event_type = 'STARTING' THEN 1 END)     AS starts,
    count(DISTINCT date(event_time))                        AS days_seen
  FROM events
  GROUP BY workspace_id, warehouse_id
)
SELECT
  coalesce(w.workspace_id, u.workspace_id)                  AS workspace_id,
  coalesce(w.warehouse_id, u.warehouse_id)                  AS warehouse_id,
  coalesce(runs, 0)                                         AS runs,
  coalesce(measured, 0)                                     AS measured,
  coalesce(total_ms, 0)                                     AS total_ms,
  coalesce(busy_ms, 0)                                      AS busy_ms,
  coalesce(queue_ms, 0)                                     AS queue_ms,
  coalesce(spilled_bytes, 0)                                AS spilled_bytes,
  coalesce(peak_users, 0)                                   AS peak_users,
  coalesce(days_used, 0)                                    AS days_used,
  coalesce(days_queued, 0)                                  AS days_queued,
  coalesce(days_spilled, 0)                                 AS days_spilled,
  -- Null rather than zero on a warehouse that ran nothing measurable: it has no slowest statement, and
  -- a p95 of zero would read as a warehouse answering instantly.
  l.p95_ms,
  l.worst_ms,
  l.worst_queue_ms,
  coalesce(up_ms, 0)                                        AS up_ms,
  coalesce(cluster_ms, 0)                                   AS cluster_ms,
  coalesce(e.starts, 0)                                     AS starts,
  coalesce(peak_clusters, 0)                                AS peak_clusters,
  coalesce(e.days_seen, 0)                                  AS days_seen,
  -- Whether the window opened with this warehouse already running. Where it is true, `up_ms` includes
  -- time from a session that began before the window and `days_seen` may be 0 on a warehouse that was up
  -- throughout. See the header.
  coalesce(u.carried_in, 0) = 1                             AS carried_in,
  -- The estate's statement execution per cluster-millisecond of uptime, as a percentage. Over 100 is a
  -- concurrent warehouse rather than an error. Null where there was no uptime to divide by, and only
  -- there — the numerators are coalesced because the outer join below makes them null on a warehouse that
  -- ran nothing, and "up all week, executed nothing" is 0% rather than unknown.
  --
  -- The numerator excludes our statements and the denominator cannot, since uptime carries no mark. Not
  -- corrected for: our footprint is negligible on any estate with a sizing question, and the header says
  -- what that costs on one without.
  round(100.0 * coalesce(busy_ms, 0) / nullif(cluster_ms, 0), 1)  AS execution_percent,
  round(100.0 * coalesce(queue_ms, 0) / nullif(total_ms, 0), 1)   AS queue_percent,
  -- Whether the assessment ran on it, so a warehouse with none of the estate's work on it can be told
  -- apart from one with no work at all. Not a share and not a suppression: nothing above reads it, and no
  -- rule turns on it. The two rows want opposite advice — see `self_load`.
  coalesce(s.self_runs, 0) > 0                              AS ran_assessment,
  -- How many warehouses the window saw, repeated on every row, so a surface reporting the busiest
  -- :warehouse_limit of them can say what it is a subset of. `count(*) OVER ()` is over the joined set
  -- before the limit applies, which is the population this statement declined to return in full.
  count(*) OVER ()                                          AS warehouse_population
FROM per_warehouse w
FULL OUTER JOIN uptime u
  ON u.workspace_id = w.workspace_id
  AND u.warehouse_id = w.warehouse_id
LEFT JOIN latency l
  ON l.workspace_id = w.workspace_id
  AND l.warehouse_id = w.warehouse_id
-- Against the coalesced pair rather than `w`, because a warehouse the assessment was the only thing to
-- run on has no `per_warehouse` row at all — which is exactly the row this join exists to label.
LEFT JOIN self_load s
  ON s.workspace_id = coalesce(w.workspace_id, u.workspace_id)
  AND s.warehouse_id = coalesce(w.warehouse_id, u.warehouse_id)
-- Also against the coalesced pair, and for the mirror of that reason: a warehouse seeded up with no
-- in-window event has no `seen` row, and a warehouse that ran statements without starting or stopping
-- has no `uptime` row.
LEFT JOIN seen e
  ON e.workspace_id = coalesce(w.workspace_id, u.workspace_id)
  AND e.warehouse_id = coalesce(w.warehouse_id, u.warehouse_id)
/*
 * Busiest first, so the warehouses a cap would drop are the ones nothing was asked of.
 *
 * `NULLS LAST` because the outer join produces a null total for a warehouse that ran nothing, and the
 * default ordering in Spark puts nulls first on a descending sort — which would fill the returned rows
 * with idle warehouses and drop the busy ones on any estate past the cap.
 */
ORDER BY total_ms DESC NULLS LAST, warehouse_id
LIMIT :warehouse_limit
