-- Signal: sql:uc.platform_census
-- Rows: 1
-- Benchmark: census
--
-- The parts of the metastore that are not tables: what is shared and with whom, what
-- external systems are federated in, and which governance features are actually used.
--
-- This query exists because of a measurement rather than a design. Delta Sharing,
-- federated connections and recipient IP allowlists were all classified as unreachable
-- on the strength of the REST surface: `unity-catalog` and `sharing` are authorization
-- scopes Databricks Apps does not offer, so the Shares and Recipients APIs are closed to
-- every install of this app (ADR 0016). But `system.information_schema` exposes the same
-- configuration through a view, and reading it needs only the `sql` scope the app already
-- holds. Sixteen controls across interoperability, operational excellence and security
-- move from "answer this yourself" to measured because the second surface was checked
-- before the verdict was written down.
--
-- That paragraph used to say the view exposes this "to any principal with `USE` on the
-- metastore", which is wrong, and wrong in the direction that made four counts read zero
-- on an estate that had them. Measured on labs 2026-08-10, one privilege at a time, as
-- the metastore owner and as the scheduled principal: shares need `USE SHARE` on the
-- metastore, recipients `USE RECIPIENT`, providers `USE PROVIDER`, connections
-- `USE CONNECTION` — and the owner reads all four while holding none of them. The
-- visibility columns at the bottom of this statement are what a resolver reads before it
-- treats one of those zeroes as an estate rather than a permission. See
-- `docs/plan/e1-populations.md`, phase E1f.
--
-- Everything here is metastore-scoped. Shares, recipients, connections, credentials and
-- external locations are metastore objects with no catalog qualifier; volumes, routines,
-- masks and filters are catalog-scoped and so carry the Databricks-owned filter, for the
-- reason given in uc_asset_census.
--
-- Three relations are read once here and used twice, in the CTEs below, rather than by two
-- scalar subqueries each. Q1k's premise was that the subquery form "repeats scans", which
-- is not what the plan says: nothing in this statement is scanned at all. Every
-- `information_schema` view arrives as a local relation the metastore has already
-- evaluated, so there is no scan node to repeat. Merging them measured faster anyway —
-- 3,028 ms against 3,357 ms, medians of four alternating readings on labs 2026-08-11,
-- with the two ranges not overlapping — and the engine's own `execution_duration_ms` for
-- one reading of each did not show the gain, so where the 329 ms goes is not something
-- this measurement establishes. See docs/design/q1a-runtime-baseline.md.
--
-- Feeds: IU-01-02 (optimized connectors), IU-02-02 (secure sharing),
-- IU-04-01 (data products), OE-01-06 (catalog strategy), plus the Delta Sharing
-- recipient controls in the security pillar.
WITH
-- Outbound Delta Sharing recipients, both counts off one read.
--
-- Databricks-to-Databricks recipients authenticate through the sharing identity federation
-- rather than a bearer token, so a token allowlist does not apply to them. Counted apart so
-- the IP-restriction control judges only the recipients it governs.
--
-- `count(CASE WHEN ... THEN 1 END)` and not `count(*)` under a `WHERE`, because the
-- unfiltered count is taken in the same pass: count ignores nulls, so the CASE counts
-- exactly the rows the predicate held for. Checked against non-empty data rather than
-- assumed — five recipients spanning `TOKEN`, lower-case `token`, `DATABRICKS`, null and
-- the empty string return 2 either way. It has to be checked somewhere other than labs,
-- where all four sharing relations are empty and both forms return zero.
recipient_counts AS (
  SELECT
    count(*)                                                                       AS recipients,
    count(CASE WHEN upper(COALESCE(authentication_type, '')) = 'TOKEN' THEN 1 END)  AS token_recipients
  FROM system.information_schema.recipients
),
-- Volumes are the governed path for non-tabular files. Managed volumes sit in the
-- metastore's own storage; external ones point at a location the customer manages.
--
-- The Databricks-owned filter stays in the `WHERE`, because it governs both counts; only
-- `volume_type` moves into the CASE, because it separates them.
volume_counts AS (
  SELECT
    count(*)                                              AS volumes,
    count(CASE WHEN volume_type = 'MANAGED' THEN 1 END)    AS managed_volumes
  FROM system.information_schema.volumes
  WHERE {{customer_catalog volume_catalog}}
),
-- Lakehouse Federation. `connection_type` names the source system, which is what makes
-- the finding actionable: "two connections, both POSTGRESQL" beats "two connections".
connection_counts AS (
  SELECT
    count(*)                                                          AS connections,
    array_join(sort_array(collect_set(upper(connection_type))), ', ')  AS connection_types
  FROM system.information_schema.connections
)
SELECT
  -- Outbound Delta Sharing. A share with no recipient is a share nobody receives, so
  -- both halves are counted: the control is about sharing being set up, not declared.
  (SELECT count(*) FROM system.information_schema.shares)                                AS shares,
  r.recipients                                                                           AS recipients,
  r.token_recipients                                                                     AS token_recipients,
  (
    SELECT count(DISTINCT recipient_name)
    FROM system.information_schema.recipient_allowed_ip_ranges
  )                                                                                      AS recipients_with_ip_allowlist,
  -- Inbound: shares this metastore receives. Distinguished from outbound because
  -- receiving data governs nothing about how this estate shares its own.
  (SELECT count(*) FROM system.information_schema.providers)                              AS providers,
  c.connections                                                                          AS connections,
  c.connection_types                                                                     AS connection_types,
  -- Storage reached through Unity Catalog rather than around it.
  (SELECT count(*) FROM system.information_schema.external_locations)                     AS external_locations,
  (SELECT count(*) FROM system.information_schema.storage_credentials)                     AS storage_credentials,
  v.volumes                                                                              AS volumes,
  v.managed_volumes                                                                      AS managed_volumes,
  -- Registered functions: the reusable, governed alternative to the same logic pasted
  -- into every notebook that needs it.
  (
    SELECT count(*)
    FROM system.information_schema.routines
    WHERE {{customer_catalog routine_catalog}}
  )                                                                                      AS routines,
  -- Fine-grained access control actually in use, as opposed to available.
  (
    SELECT count(*)
    FROM system.information_schema.column_masks
    WHERE {{customer_catalog table_catalog}}
  )                                                                                      AS column_masks,
  (
    SELECT count(*)
    FROM system.information_schema.row_filters
    WHERE {{customer_catalog table_catalog}}
  )                                                                                      AS row_filters,
  -- Tags are how a data product is marked as one — certified, owned, classified. Counted
  -- as distinct tagged tables rather than tag rows, because ten tags on one table is not
  -- ten tables described.
  (
    SELECT count(DISTINCT concat_ws('.', catalog_name, schema_name, table_name))
    FROM system.information_schema.table_tags
    WHERE {{customer_catalog catalog_name}}
  )                                                                                      AS tagged_tables,
  (
    SELECT count(DISTINCT concat_ws('.', catalog_name, schema_name, table_name, column_name))
    FROM system.information_schema.column_tags
    WHERE {{customer_catalog catalog_name}}
  )                                                                                      AS tagged_columns,
  -- Whether the four sharing counts above mean what they say, for the identity that ran
  -- this. Both readings are available to any principal that can reach this view at all —
  -- measured as the scheduled principal holding nothing but BROWSE.
  --
  -- The owner is read separately from the grants rather than folded into them because the
  -- owner holds none of the four and sees all four, so a resolver testing only the grants
  -- would call an admin's correct zero unreadable.
  --
  -- Through a group as well as directly, because Databricks recommends nominating a group
  -- as the metastore admin rather than a user, so an owning group is the documented shape
  -- rather than the edge case. Verified on labs only for the direct form — this metastore
  -- is owned by a user — so the group half is the same function the grantee test uses and
  -- is untested against an owning group.
  (
    SELECT count(*)
    FROM system.information_schema.metastores
    WHERE metastore_owner = current_user() OR is_account_group_member(metastore_owner)
  ) > 0                                                                                  AS owns_metastore,
  -- `is_account_group_member` and not a membership join, because there is no
  -- `effective_metastore_privileges` view to expand a group grant. It is the right
  -- function rather than a workspace-group one: Unity Catalog refuses to grant to a
  -- workspace-local group at all, so every grantee here is an account principal. Verified
  -- on labs by granting `USE SHARE` to `account users` alone and reading it back as the
  -- service principal.
  --
  -- Naming the four is safe rather than merely narrow: there is no wildcard row that would
  -- fall outside this list. `GRANT ALL PRIVILEGES ON METASTORE` is refused on labs with
  -- `PRIVILEGE_NOT_APPLICABLE_TO_ENTITY` — "Privilege ALL PRIVILEGES is not applicable to
  -- this entity [...METASTORE/METASTORE_STANDARD]" — so no grantee can hold one.
  (
    SELECT array_join(sort_array(collect_set(privilege_type)), ',')
    FROM system.information_schema.metastore_privileges
    WHERE privilege_type IN ('USE_SHARE', 'USE_RECIPIENT', 'USE_PROVIDER', 'USE_CONNECTION')
      AND (grantee = current_user() OR is_account_group_member(grantee))
  )                                                                                      AS sharing_privileges
-- One row from each of the three, so the cross join is one row wide and one row long. An
-- aggregate with no `GROUP BY` returns its row even over an empty relation, which is what
-- keeps this a one-row statement on a metastore that shares nothing.
FROM recipient_counts AS r, volume_counts AS v, connection_counts AS c
