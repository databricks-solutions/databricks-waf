-- Signal: sql:serving.model_entities
-- Rows: at most :serving_entity_limit
-- Benchmark: coverage
--
-- What the estate's managed model serving endpoints serve, and which of them carry traffic.
--
-- Two requirements read this. `PE-02-02` asks whether production models are served by managed serving
-- infrastructure; `OE-02-08` asks whether they are referenced through a registry with a version rather
-- than by path. Both are recorded fields on `system.serving.served_entities`, which is why `37g` turned
-- them from questions into readings.
--
-- ## The one thing this cannot see, and both readings are shaped by it
--
-- **This table records managed serving and nothing else.** A model served from a team's own Flask app on
-- a classic cluster, or from a container outside Databricks entirely, leaves no row here — and that is
-- precisely the arrangement `PE-02-02` exists to ask about. So the presence of managed endpoints under
-- traffic is direct evidence the managed path is in use, and their absence is *not* evidence of a
-- hand-built one: it is equally an estate that serves no models at all. The resolver reports the second
-- case as unmeasured, which is
-- [ADR 0074](../../../docs/decisions/0074-an-emptiness-the-scan-cannot-establish-is-unmeasured-rather-than-not-applicable.md)
-- applied to a table whose population is defined by the very choice being assessed.
--
-- ## Latest configuration per served entity, not every version of it
--
-- `served_entities` is a change log: one row per served entity per `endpoint_config_version`, so an
-- endpoint reconfigured forty times carries forty rows. Measured on `large-estate` on 2026-08-16, 50,158
-- rows across 13,873 endpoint ids — a count of *configurations*, which is why a naive `count(*)` here
-- reports an estate an order of magnitude larger than it is. The window function takes the most recent
-- row per `served_entity_id`, and `endpoint_delete_time IS NULL` keeps deleted endpoints out.
--
-- ## Traffic is joined and not required
--
-- `endpoint_usage` is the proof that an endpoint carries load rather than merely existing, and an entity
-- with no requests in the window is kept with a zero rather than dropped. A serving endpoint that exists
-- and is idle is a different finding from one that does not exist, and dropping it here would make the
-- two indistinguishable downstream. Measured on field-eng over thirty days: 775,193 requests across 161
-- served entities of the 3,965 live ones, so most of the population is idle and the join has to survive
-- that.
--
-- ## What the estate looked like where this was built
--
-- `large-estate`, 2026-08-16, live entities by type: 3,145 `CUSTOM_MODEL`, 554 `FOUNDATION_MODEL`, 240
-- `EXTERNAL_MODEL`, 26 `FEATURE_SPEC`. Every custom model carried an `entity_version`; of their
-- `entity_name`s, 3,011 were three-part Unity Catalog names and 134 were bare single names, which is the
-- workspace model registry rather than a path. Not one looked like a filesystem path — see the note on
-- `OE-02-08` in `model-lifecycle.ts` for what that does to the reading.
--
-- Bounded at `:serving_entity_limit`, ordered by requests so the entities carrying the estate's load come
-- back first. The estate-wide counts are computed before the cap and cross-joined onto every row, so a
-- reader gets a share of the whole population rather than a share of what fitted.
--
-- @param serving_entity_limit  the row ceiling
-- @param lookback_days         the traffic window, capped at 30 in the WHERE clause
-- @param workspace_id          one workspace, or '' for every one the identity can see
-- @param live_workspace_ids    the live workspaces, comma-joined, or '' for no filter
--
-- Feeds: PE-02-02, OE-02-08.
WITH live AS (
  SELECT
    workspace_id,
    served_entity_id,
    endpoint_id,
    endpoint_name,
    served_entity_name,
    entity_type,
    entity_name,
    entity_version,
    task,
    created_by,
    change_time
  FROM (
    SELECT
      *,
      row_number() OVER (PARTITION BY served_entity_id ORDER BY change_time DESC) AS rank
    FROM system.serving.served_entities
    WHERE endpoint_delete_time IS NULL
      AND (:workspace_id = '' OR workspace_id = :workspace_id)
      AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  )
  WHERE rank = 1
),
traffic AS (
  SELECT
    served_entity_id,
    count(*)                                                   AS requests,
    count(DISTINCT date(request_time))                         AS days_with_traffic,
    -- Errors as the platform recorded them, so a reader can tell an endpoint under load from one under
    -- load and failing. Anything at or above 400 — the split between client and server fault is not this
    -- signal's question, and reporting one without the other would make an estate look half as broken.
    count_if(status_code >= 400)                               AS failed_requests,
    count_if(status_code IS NULL)                              AS requests_without_status,
    max(request_time)                                          AS last_request
  FROM system.serving.endpoint_usage
  WHERE request_time >= current_timestamp() - make_dt_interval(least(:lookback_days, 30))
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY served_entity_id
),
/*
 * The whole population, before the cap, as one row cross-joined onto every result row.
 *
 * Counted here rather than derived from the returned rows for the reason every capped statement in this
 * repository states: a share computed over what fitted under the limit is a share of the limit.
 */
coverage AS (
  SELECT
    count(*)                                                          AS live_entities,
    count(DISTINCT endpoint_id)                                       AS live_endpoints,
    count_if(entity_type = 'CUSTOM_MODEL')                            AS custom_models,
    count_if(entity_type = 'FOUNDATION_MODEL')                        AS foundation_models,
    count_if(entity_type = 'EXTERNAL_MODEL')                          AS external_models,
    count_if(entity_type = 'FEATURE_SPEC')                            AS feature_specs,
    -- The `OE-02-08` numerator, and the one field on this table that answers it directly. A served
    -- entity carrying an `entity_version` was resolved through a registry that versions it; one without
    -- was not. Restricted to custom models, because a foundation or external model has no registry entry
    -- to reference and counting it either way would answer a question nobody asked.
    count_if(entity_type = 'CUSTOM_MODEL' AND entity_version IS NOT NULL AND trim(entity_version) <> '') AS custom_models_with_a_version,
    count_if(entity_type = 'CUSTOM_MODEL' AND entity_name RLIKE '^[^. ]+[.][^. ]+[.][^. ]+$')            AS custom_models_named_in_uc
  FROM live
)
SELECT
  l.workspace_id,
  l.served_entity_id,
  l.endpoint_id,
  l.endpoint_name,
  l.served_entity_name,
  l.entity_type,
  l.entity_name,
  l.entity_version,
  l.task,
  l.created_by,
  l.change_time,
  coalesce(t.requests, 0)                 AS requests,
  coalesce(t.days_with_traffic, 0)        AS days_with_traffic,
  coalesce(t.failed_requests, 0)          AS failed_requests,
  coalesce(t.requests_without_status, 0)  AS requests_without_status,
  t.last_request,
  c.live_entities,
  c.live_endpoints,
  c.custom_models,
  c.foundation_models,
  c.external_models,
  c.feature_specs,
  c.custom_models_with_a_version,
  c.custom_models_named_in_uc
FROM live l
LEFT JOIN traffic t ON t.served_entity_id = l.served_entity_id
CROSS JOIN coverage c
ORDER BY coalesce(t.requests, 0) DESC, l.endpoint_name, l.served_entity_name
LIMIT :serving_entity_limit
