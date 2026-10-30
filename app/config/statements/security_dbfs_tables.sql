-- Signal: sql:security.dbfs_tables
-- Rows: 1
-- Benchmark: census
--
-- Count of managed tables whose storage path is on DBFS root rather than in a governed
-- cloud location. A managed table created without a Unity Catalog external location, or
-- under an older metastore configuration that defaulted to workspace DBFS root, will
-- show a `storage_path` beginning with `dbfs:/` or `/dbfs/`.
--
-- ## What this can and cannot say
--
-- `system.information_schema.tables` is metastore-scoped, not workspace-scoped. It sees
-- every catalog assigned to the current metastore but cannot reach legacy `hive_metastore`
-- tables, which sit outside the Unity Catalog information schema. So this count covers only
-- Unity Catalog managed tables. A workspace still running primarily on Hive Metastore would
-- need a separate assessment that is outside the scope of this app.
--
-- A result of zero DBFS-root managed tables on a Unity Catalog metastore is a pass: it
-- confirms that the Unity Catalog storage configuration is correct. The finding is `pass`
-- rather than `partial` because the assertion is direct — every managed table in this
-- catalog's metastore that the system table can see has a governed cloud location.
--
-- ## Filters
--
-- Databricks-owned catalogs are excluded via the same predicate as the asset census:
-- catalogs owned by 'System user', the reserved names 'system' and 'samples', and any
-- catalog whose name begins '__databricks_internal'. The predicate is inlined here
-- because this statement is in awaiting-reading.json (labs baseline owed) and the
-- awaiting-reading gate cannot record a submission for a file that still contains a
-- fragment substitution — the SHA would be of a text nothing runs.
--
-- No `workspace_id` or `live_workspace_ids` parameters: `system.information_schema` is
-- metastore-scoped, not workspace-scoped, and has no workspace column to filter on.
--
-- Feeds: SCP-04-05.
SELECT
  COUNT(CASE WHEN table_type = 'MANAGED'
             AND (table_catalog NOT IN (SELECT catalog_name FROM system.information_schema.catalogs WHERE catalog_owner = 'System user')
                  AND lower(table_catalog) NOT IN ('system', 'samples')
                  AND NOT startswith(lower(table_catalog), '__databricks_internal'))
        THEN 1 END)                                                      AS total_managed_tables,
  COUNT(CASE WHEN table_type = 'MANAGED'
             AND (table_catalog NOT IN (SELECT catalog_name FROM system.information_schema.catalogs WHERE catalog_owner = 'System user')
                  AND lower(table_catalog) NOT IN ('system', 'samples')
                  AND NOT startswith(lower(table_catalog), '__databricks_internal'))
             AND (storage_path LIKE 'dbfs:%' OR storage_path LIKE '/dbfs/%')
        THEN 1 END)                                                      AS dbfs_root_tables
FROM system.information_schema.tables
WHERE table_schema <> 'information_schema'
