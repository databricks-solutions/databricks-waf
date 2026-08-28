-- Probe: covered query time that no returned shape describes (Q1d, population b).
--
-- workload_query_shapes.sql computes its coverage figures over every covered statement, and then drops
-- the shapes whose recorded text spans several statement types — the guard its header calls the most
-- important line in the file. So covered time included work that reached no returned row, and the
-- coverage percentage claimed a list the reader could not find.
--
-- The statement now returns that gap as `ambiguous_ms` and `ambiguous_runs`. This measures the same gap
-- independently of it, on the same window and the same exclusions, so the returned pair can be checked
-- against something that is not the statement being checked. 1.0% of query time is the figure quoted in
-- the statement's header from the estate it was calibrated on; this is what it is here.
--
-- The self-exclusion and the covered types are repeated rather than shared, which is the same trade every
-- probe in this directory makes: a probe that imported the statement's own definitions would agree with
-- it by construction and measure nothing.
--
-- ## Two exclusions this was short of, both of which read as zero on labs
--
-- Repeating a population by hand is how a probe stays independent and also how it stops describing the
-- thing it names. This omitted the empty-text guard, so redacted statements — which the statement drops
-- before grouping, and which all normalise to one shape — sat in the denominator and would have been
-- reported as one large ambiguous group. And it counted `kinds` over the current window while the
-- statement counts them over both halves, so a shape heterogeneous only in the prior fortnight was
-- ambiguous to the statement and homogeneous here. Labs has no redacted statement and no ambiguous shape
-- at all, so the two agreed anyway, which is the more dangerous way for an apparatus to be wrong.
WITH windows AS (
  SELECT
    workspace_id,
    statement_type,
    total_duration_ms,
    -- The statement's own halves. `kinds` is over both, because a shape is one shape or it is not, and
    -- the time and run figures are over the current one, because that is what a coverage figure is of.
    CASE
      WHEN start_time >= current_timestamp() - make_dt_interval(least(:lookback_days, 15)) THEN 1
      ELSE 0
    END AS is_now,
    CASE
      WHEN execution_status = 'FINISHED' AND coalesce(from_result_cache, false) = false THEN 1
      ELSE 0
    END AS is_measurable,
    CASE
      WHEN try_element_at(query_tags, 'databricks_waf') = 'assessment'
        OR startswith(trim(statement_text), '-- databricks-waf: assessment')
        OR contains(statement_text, '-- Signal: sql:')
        OR contains(statement_text, '-- Rows: ')
      THEN 1
      ELSE 0
    END AS is_self,
    substr(
      sha2(
        regexp_replace(
          regexp_replace(regexp_replace(lower(trim(statement_text)), '[0-9]+', 'N'), concat(chr(39), '[^', chr(39), ']*', chr(39)), 'S'),
          '[ \t\n\r]+',
          ' '
        ),
        256
      ),
      1, 16
    ) AS shape
  FROM system.query.history
  -- Twice the current window, which is what the statement groups over. `is_now` above takes the half the
  -- coverage figures are of back out again.
  WHERE start_time >= current_timestamp() - make_dt_interval(2 * least(:lookback_days, 15))
    AND execution_status IN ('FINISHED', 'FAILED', 'CANCELED')
    -- The statement's redaction guard, repeated. Without it every statement whose text is empty under
    -- customer-managed keys collects into one shape, which this would then report as ambiguous.
    AND statement_text IS NOT NULL
    AND trim(statement_text) <> ''
    -- The statement's own `is_covered` list, repeated. Narrower or wider and this measures a different
    -- population from the one the returned figures are about.
    AND statement_type IN (
      'SELECT', 'INSERT', 'MERGE', 'UPDATE', 'DELETE', 'COPY', 'REPLACE', 'CREATE'
    )
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
covered AS (
  SELECT * FROM windows WHERE is_self = 0
),
per_shape AS (
  SELECT
    workspace_id,
    shape,
    count(DISTINCT statement_type)                    AS kinds,
    sum(is_now)                                       AS runs,
    sum(is_now * is_measurable * total_duration_ms)   AS ms
  FROM covered
  GROUP BY workspace_id, shape
  -- The statement returns only shapes that ran in the current window, and its coverage figures are over
  -- that half. A shape that ran only in the prior one is in neither.
  HAVING sum(is_now) > 0
)
SELECT
  count(*)                                                  AS shapes,
  count(CASE WHEN kinds > 1 THEN 1 END)                     AS ambiguous_shapes,
  coalesce(sum(ms), 0)                                      AS covered_ms,
  coalesce(sum(CASE WHEN kinds > 1 THEN ms END), 0)         AS ambiguous_ms,
  coalesce(sum(runs), 0)                                    AS covered_runs,
  coalesce(sum(CASE WHEN kinds > 1 THEN runs END), 0)       AS ambiguous_runs,
  round(100.0 * coalesce(sum(CASE WHEN kinds > 1 THEN ms END), 0) / nullif(sum(ms), 0), 2) AS ambiguous_percent
FROM per_shape
