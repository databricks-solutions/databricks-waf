-- Signal: sql:topology.resource_names
-- Rows: at most 4,000
-- Benchmark: inventory
--
-- One optional display name for each non-table node that survived the 2,000-edge response cap.
-- Identity remains the kind-qualified platform id. Each system table is slowly changing, so its
-- latest definition is chosen before names are combined. A deleted object's latest row is retained:
-- deletion does not erase the last exact name the platform recorded.
--
-- Job ids are workspace-local. When an account-wide response contains the same kind/id with different
-- latest names, HAVING refuses the ambiguous name and the client falls back to the resource kind.
-- Tables are absent because their topology id is already the exact qualified table name.
WITH requested AS (
  SELECT 'job' AS kind, explode(filter(split(:job_ids, ','), value -> value <> '')) AS technical_id
  UNION ALL
  SELECT 'cluster', explode(filter(split(:cluster_ids, ','), value -> value <> ''))
  UNION ALL
  SELECT 'warehouse', explode(filter(split(:warehouse_ids, ','), value -> value <> ''))
  UNION ALL
  SELECT 'pipeline', explode(filter(split(:pipeline_ids, ','), value -> value <> ''))
),
latest_jobs AS (
  SELECT 'job' AS kind, CAST(job_id AS STRING) AS technical_id, name
  FROM system.lakeflow.jobs
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    AND CAST(job_id AS STRING) IN (SELECT technical_id FROM requested WHERE kind = 'job')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
),
latest_clusters AS (
  SELECT 'cluster' AS kind, CAST(cluster_id AS STRING) AS technical_id, cluster_name AS name
  FROM system.compute.clusters
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    AND CAST(cluster_id AS STRING) IN (SELECT technical_id FROM requested WHERE kind = 'cluster')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) = 1
),
latest_warehouses AS (
  SELECT 'warehouse' AS kind, CAST(warehouse_id AS STRING) AS technical_id, warehouse_name AS name
  FROM system.compute.warehouses
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    AND CAST(warehouse_id AS STRING) IN (SELECT technical_id FROM requested WHERE kind = 'warehouse')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, warehouse_id ORDER BY change_time DESC) = 1
),
latest_pipelines AS (
  SELECT 'pipeline' AS kind, CAST(pipeline_id AS STRING) AS technical_id, name
  FROM system.lakeflow.pipelines
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    AND CAST(pipeline_id AS STRING) IN (SELECT technical_id FROM requested WHERE kind = 'pipeline')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, pipeline_id ORDER BY change_time DESC) = 1
),
candidates AS (
  SELECT * FROM latest_jobs
  UNION ALL
  SELECT * FROM latest_clusters
  UNION ALL
  SELECT * FROM latest_warehouses
  UNION ALL
  SELECT * FROM latest_pipelines
)
SELECT kind, technical_id, max(name) AS name
FROM candidates
WHERE name IS NOT NULL AND trim(name) <> ''
GROUP BY kind, technical_id
HAVING count(DISTINCT name) = 1
ORDER BY kind, technical_id
