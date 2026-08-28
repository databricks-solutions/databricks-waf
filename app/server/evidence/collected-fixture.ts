// One real envelope's probe set, with every estate identifier substituted.
//
// Collected by running `collect-evidence.py` against a live workspace and a live account — 29 probes,
// 28 observed, one denied, both tiers, nothing skipped — and then substituted: the account, metastore
// and storage-credential ids keep their UUID shape, the seven workspace ids and the job id keep their
// sixteen-digit magnitude, the host keeps its `dbc-` form, the email keeps its form, and the 83
// Databricks-provided `system.ai` models the real run returned are trimmed to three, since the
// remainder were the same shape repeated. What is left is the API's own output.
//
// It is here because the synthetic fixtures beside it were chosen by reasoning about where two
// languages disagree, and this was chosen by nothing at all — it is simply what the API returned. It
// carries things nobody would have thought to write down: a projected key with a colon in it
// (`members:count`), which sorts differently from the plain keys around it; ten nulls, every one of
// them a workspace setting that exists and has never been set; workspace ids of sixteen digits, which
// are inside the range a double represents exactly but only by seventeen percent; and the same kind of
// id in both integer and string form, because two endpoints disagree about which it is.
//
// A probe with no `value` at all is in here too — `hive-warehouse`, refused — because a denied probe
// has to canonicalise as readily as an observed one.
//
// Nothing in here is a credential. That is a property of the projection rather than of the redaction,
// and `no-leak.test.ts` is what holds it.

/** The probe set from a real two-tier run, as the envelope carries it. */
export const COLLECTED: readonly unknown[] = [
  {
    controls: [
      'SCP-01-04',
      'SCP-01-05',
      'SCP-02-04',
      'SCP-02-05',
      'SCP-02-06',
      'SCP-02-07',
      'SCP-02-08',
      'SCP-02-12',
      'SCP-03-10',
      'SCP-04-08',
      'SCP-04-09',
      'SCP-05-04',
      'SCP-05-05',
      'SCP-05-06',
      'SCP-05-07',
      'SCP-05-15',
    ],
    endpoint:
      'GET /api/2.0/workspace-conf?keys=enableIpAccessLists%2CenableVerboseAuditLogs%2CenableJobViewAcls%2CenforceClusterViewAcls%2CenforceWorkspaceViewAcls%2CenableProjectsAllowList%2CenableResultsDownloading%2CenableExportNotebook%2CenableNotebookTableClipboard%2CenableDbfsFileBrowser%2CenableFileStoreEndpoint%2CstoreInteractiveNotebookResultsInCustomerAccount%2CenableEnforceImdsV2%2CenableProjectTypeInWorkspace%2CmaxTokenLifetimeDays',
    fields: [
      'enableIpAccessLists',
      'enableVerboseAuditLogs',
      'enableJobViewAcls',
      'enforceClusterViewAcls',
      'enforceWorkspaceViewAcls',
      'enableProjectsAllowList',
      'enableResultsDownloading',
      'enableExportNotebook',
      'enableNotebookTableClipboard',
      'enableDbfsFileBrowser',
      'enableFileStoreEndpoint',
      'storeInteractiveNotebookResultsInCustomerAccount',
      'enableEnforceImdsV2',
      'enableProjectTypeInWorkspace',
      'maxTokenLifetimeDays',
    ],
    label: 'workspace-conf',
    shape: 'projected',
    signals: ['rest:workspace:preview.workspace-conf'],
    status: 'observed',
    tier: 'workspace',
    value: {
      enableDbfsFileBrowser: null,
      enableEnforceImdsV2: 'true',
      enableExportNotebook: null,
      enableFileStoreEndpoint: null,
      enableIpAccessLists: null,
      enableJobViewAcls: 'true',
      enableNotebookTableClipboard: null,
      enableProjectTypeInWorkspace: null,
      enableProjectsAllowList: null,
      enableResultsDownloading: null,
      enableVerboseAuditLogs: null,
      enforceClusterViewAcls: 'true',
      enforceWorkspaceViewAcls: 'true',
      maxTokenLifetimeDays: '730',
      storeInteractiveNotebookResultsInCustomerAccount: null,
    },
  },
  {
    controls: ['SCP-01-03', 'SCP-01-05', 'SCP-04-01'],
    endpoint: 'GET /api/2.0/token-management/tokens',
    fields: [
      'token_infos[].token_id',
      'token_infos[].created_by_username',
      'token_infos[].comment',
      'token_infos[].creation_time',
      'token_infos[].expiry_time',
    ],
    label: 'token-management',
    shape: 'projected',
    signals: ['rest:workspace:token.list'],
    status: 'observed',
    tier: 'workspace',
    value: {
      token_infos: [
        {
          comment: 'Example integration',
          created_by_username: 'admin@example.com',
          creation_time: 1780368425169,
          expiry_time: 1788144425169,
          token_id: '0000000000000000000000000000000000000000000000000000000000000001',
        },
        {
          comment: 'Example test token',
          created_by_username: 'admin@example.com',
          creation_time: 1780962288150,
          expiry_time: 1788738288150,
          token_id: '0000000000000000000000000000000000000000000000000000000000000002',
        },
        {
          comment: 'Example integration',
          created_by_username: 'admin@example.com',
          creation_time: 1783291368375,
          expiry_time: 1791067368375,
          token_id: '0000000000000000000000000000000000000000000000000000000000000003',
        },
      ],
    },
  },
  {
    controls: ['SCP-01-06'],
    endpoint: 'GET /api/2.0/permissions/authorization/tokens',
    fields: [
      'access_control_list[].user_name',
      'access_control_list[].group_name',
      'access_control_list[].service_principal_name',
      'access_control_list[].all_permissions[].permission_level',
    ],
    label: 'token-permissions',
    shape: 'projected',
    signals: ['rest:workspace:permissions.authorization.tokens'],
    status: 'observed',
    tier: 'workspace',
    value: {
      access_control_list: [
        {
          all_permissions: [
            {
              permission_level: 'CAN_MANAGE',
            },
          ],
          group_name: 'admins',
        },
      ],
    },
  },
  {
    controls: ['SCP-02-02', 'SCP-04-03'],
    endpoint: 'GET /api/2.0/clusters/list',
    fields: [
      'clusters[].cluster_id',
      'clusters[].cluster_name',
      'clusters[].state',
      'clusters[].cluster_source',
      'clusters[].spark_version',
      'clusters[].data_security_mode',
      'clusters[].autotermination_minutes',
      'clusters[].enable_local_disk_encryption',
      'clusters[].start_time',
      'clusters[].last_restarted_time',
      'clusters[].spark_env_vars:keys',
      'clusters[].init_scripts:count',
    ],
    label: 'clusters',
    shape: 'projected',
    signals: ['rest:workspace:clusters.list'],
    status: 'observed',
    tier: 'workspace',
    value: {},
  },
  {
    controls: ['SCP-05-01'],
    endpoint: 'GET /api/2.0/libraries/all-cluster-statuses',
    fields: [
      'statuses[].cluster_id',
      'statuses[].library_statuses[].status',
      'statuses[].library_statuses[].is_library_for_all_clusters',
      'statuses[].library_statuses[].library:keys',
    ],
    label: 'cluster-libraries',
    shape: 'projected',
    signals: ['rest:workspace:libraries.all-cluster-statuses'],
    status: 'observed',
    tier: 'workspace',
    value: {},
  },
  {
    controls: ['SCP-05-02'],
    endpoint: 'GET /api/2.0/global-init-scripts',
    fields: ['scripts[].script_id', 'scripts[].name', 'scripts[].enabled', 'scripts[].position'],
    label: 'global-init-scripts',
    shape: 'projected',
    signals: ['rest:workspace:global-init-scripts'],
    status: 'observed',
    tier: 'workspace',
    value: {},
  },
  {
    controls: ['SCP-02-01'],
    endpoint: 'GET /api/2.0/secrets/scopes/list',
    fields: ['scopes[].name', 'scopes[].backend_type'],
    label: 'secret-scopes',
    shape: 'projected',
    signals: ['rest:workspace:secrets.scopes.list'],
    status: 'observed',
    tier: 'workspace',
    value: {
      scopes: [
        {
          backend_type: 'DATABRICKS',
          name: 'control-tower',
        },
        {
          backend_type: 'DATABRICKS',
          name: 'waf-schedule',
        },
      ],
    },
  },
  {
    controls: ['SCP-03-05'],
    endpoint: 'GET /api/2.0/ip-access-lists',
    fields: [
      'ip_access_lists[].label',
      'ip_access_lists[].list_type',
      'ip_access_lists[].enabled',
      'ip_access_lists[].ip_addresses:count',
    ],
    label: 'ip-access-lists',
    shape: 'projected',
    signals: ['rest:workspace:ip-access-lists'],
    status: 'observed',
    tier: 'workspace',
    value: {},
  },
  {
    controls: ['SCP-05-03'],
    endpoint: 'GET /api/2.0/preview/scim/v2/Groups',
    fields: ['Resources[].id', 'Resources[].displayName', 'Resources[].members:count'],
    label: 'scim-groups',
    shape: 'projected',
    signals: ['rest:workspace:preview.scim.v2.Groups'],
    status: 'observed',
    tier: 'workspace',
    value: {
      Resources: [
        {
          displayName: 'users',
          id: '86434373858609',
          'members:count': 9,
        },
        {
          displayName: 'admins',
          id: '87490685820441',
          'members:count': 5,
        },
        {
          displayName: 'users-clone-2026-07-30-1915-UTC (created by Databricks)',
          id: '2124846692796859',
          'members:count': 6,
        },
      ],
    },
  },
  {
    controls: ['SCP-04-22'],
    endpoint: 'GET /api/2.1/jobs/list?limit=100&expand_tasks=false',
    fields: [
      'jobs[].job_id',
      'jobs[].settings.name',
      'jobs[].run_as_user_name',
      'jobs[].settings.run_as.user_name',
      'jobs[].settings.run_as.service_principal_name',
    ],
    label: 'jobs',
    shape: 'projected',
    signals: ['rest:workspace:jobs.list'],
    status: 'observed',
    tier: 'workspace',
    truncated: true,
    value: {
      jobs: [
        {
          job_id: 471148922192497,
          run_as_user_name: 'admin@example.com',
          settings: {
            name: 'Well-Architected assessment',
          },
        },
      ],
    },
  },
  {
    controls: ['SCP-04-05'],
    detail: 'Error: Public DBFS root is disabled. Access is denied on path: /user/hive/warehouse',
    endpoint: 'GET /api/2.0/dbfs/list?path=%2Fuser%2Fhive%2Fwarehouse',
    fields: ['files[].path', 'files[].is_dir', 'files[].file_size'],
    label: 'hive-warehouse',
    shape: 'projected',
    signals: ['rest:workspace:dbfs.list'],
    status: 'denied',
    tier: 'workspace',
  },
  {
    controls: ['SCP-04-15'],
    endpoint: 'GET /api/2.1/unity-catalog/metastores',
    fields: [
      'metastores[].metastore_id',
      'metastores[].name',
      'metastores[].owner',
      'metastores[].created_by',
      'metastores[].delta_sharing_scope',
    ],
    label: 'uc-metastores',
    shape: 'projected',
    signals: ['rest:workspace:unity-catalog.metastores'],
    status: 'observed',
    tier: 'workspace',
    value: {
      metastores: [
        {
          created_by: 'admin@example.com',
          delta_sharing_scope: 'INTERNAL',
          metastore_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          name: 'metastore_example_region',
          owner: 'admin@example.com',
        },
      ],
    },
  },
  {
    controls: ['SCP-04-11'],
    endpoint: 'GET /api/2.1/unity-catalog/metastore_summary',
    fields: [
      'metastore_id',
      'name',
      'delta_sharing_scope',
      'delta_sharing_recipient_token_lifetime_in_seconds',
      'privilege_model_version',
    ],
    label: 'uc-metastore-summary',
    shape: 'projected',
    signals: ['rest:workspace:unity-catalog.metastore_summary'],
    status: 'observed',
    tier: 'workspace',
    value: {
      delta_sharing_scope: 'INTERNAL',
      metastore_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'metastore_example_region',
      privilege_model_version: '1.0',
    },
  },
  {
    controls: ['SCP-05-08'],
    endpoint: 'GET /api/2.1/unity-catalog/storage-credentials',
    fields: [
      'storage_credentials[].id',
      'storage_credentials[].name',
      'storage_credentials[].read_only',
      'storage_credentials[].isolation_mode',
      'storage_credentials[].used_for_managed_storage',
    ],
    label: 'uc-storage-credentials',
    shape: 'projected',
    signals: ['rest:workspace:unity-catalog.storage-credentials'],
    status: 'observed',
    tier: 'workspace',
    value: {
      storage_credentials: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          isolation_mode: 'ISOLATION_MODE_OPEN',
          name: '__databricks_managed_storage_credential',
          read_only: false,
        },
      ],
    },
  },
  {
    controls: ['SCP-04-17'],
    endpoint: 'GET /api/2.1/unity-catalog/models',
    fields: ['registered_models[].full_name', 'registered_models[].metastore_id', 'registered_models[].browse_only'],
    label: 'uc-models',
    shape: 'projected',
    signals: ['rest:workspace:unity-catalog.models'],
    status: 'observed',
    tier: 'workspace',
    value: {
      registered_models: [
        {
          full_name: 'system.ai.databricks-gpt-5-6-sol',
          metastore_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
        {
          full_name: 'system.ai.databricks-gemini-3-1-flash-lite',
          metastore_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
        {
          full_name: 'system.ai.databricks-gemini-3-1-pro',
          metastore_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
      ],
    },
  },
  {
    controls: ['SCP-04-12', 'SCP-04-13'],
    endpoint: 'GET /api/2.1/unity-catalog/recipients',
    fields: [
      'recipients[].name',
      'recipients[].authentication_type',
      'recipients[].activated',
      'recipients[].expiration_time',
      'recipients[].ip_access_list.allowed_ip_addresses:count',
      'recipients[].tokens:count',
    ],
    label: 'uc-recipients',
    shape: 'projected',
    signals: ['rest:workspace:unity-catalog.recipients'],
    status: 'observed',
    tier: 'workspace',
    value: {},
  },
  {
    controls: ['SCP-05-12'],
    endpoint:
      'GET /api/2.1/unity-catalog/artifact-allowlists/LIBRARY_JAR GET /api/2.1/unity-catalog/artifact-allowlists/LIBRARY_MAVEN',
    fields: ['artifact_matchers[].artifact', 'artifact_matchers[].match_type', 'created_at'],
    label: 'uc-artifact-allowlists',
    shape: 'projected',
    signals: ['rest:workspace:unity-catalog.artifact-allowlists.{artifact_type}'],
    status: 'observed',
    tier: 'workspace',
    value: {
      LIBRARY_JAR: {},
      LIBRARY_MAVEN: {},
    },
  },
  {
    controls: ['SCP-04-20'],
    endpoint: 'GET /api/2.0/settings/types/automatic_cluster_update/names/default',
    fields: [],
    label: 'setting-automatic-cluster-update',
    shape: 'shallow',
    signals: ['rest:workspace:settings.types.automatic_cluster_update.names.default'],
    status: 'observed',
    tier: 'workspace',
    value: {
      automatic_cluster_update_workspace: {
        can_toggle: true,
        enabled: false,
        restart_even_if_no_updates_available: false,
      },
      setting_name: 'default',
    },
  },
  {
    controls: ['SCP-04-19'],
    endpoint: 'GET /api/2.0/settings/types/restrict_workspace_admins/names/default',
    fields: [],
    label: 'setting-restrict-workspace-admins',
    shape: 'shallow',
    signals: ['rest:workspace:settings.types.restrict_workspace_admins.names.default'],
    status: 'observed',
    tier: 'workspace',
    value: {
      restrict_workspace_admins: {
        disable_gov_tag_creation: false,
        status: 'ALLOW_ALL',
      },
      setting_name: 'default',
    },
  },
  {
    controls: ['SCP-02-10'],
    endpoint: 'GET /api/2.0/settings/types/disable_legacy_dbfs/names/default',
    fields: [],
    label: 'setting-disable-legacy-dbfs',
    shape: 'shallow',
    signals: ['rest:workspace:settings.types.disable_legacy_dbfs.names.default'],
    status: 'observed',
    tier: 'workspace',
    value: {
      disable_legacy_dbfs: {
        value: true,
      },
      setting_name: 'default',
    },
  },
  {
    controls: ['SCP-02-11'],
    endpoint: 'GET /api/2.0/settings/types/sql_results_download/names/default',
    fields: [],
    label: 'setting-sql-results-download',
    shape: 'shallow',
    signals: ['rest:workspace:settings.types.sql_results_download.names.default'],
    status: 'observed',
    tier: 'workspace',
    value: {
      boolean_val: {
        value: true,
      },
      setting_name: 'default',
    },
  },
  {
    controls: ['SCP-05-13'],
    endpoint: 'GET /api/2.0/settings/types/shield_csp_enablement_ws_db/names/default',
    fields: [],
    label: 'setting-compliance-security-profile',
    shape: 'shallow',
    signals: ['rest:workspace:settings.types.shield_csp_enablement_ws_db.names.default'],
    status: 'observed',
    tier: 'workspace',
    value: {
      compliance_security_profile_workspace: {
        is_enabled: false,
      },
      setting_name: 'default',
    },
  },
  {
    controls: ['SCP-05-14'],
    endpoint: 'GET /api/2.0/settings/types/shield_esm_enablement_ws_db/names/default',
    fields: [],
    label: 'setting-enhanced-security-monitoring',
    shape: 'shallow',
    signals: ['rest:workspace:settings.types.shield_esm_enablement_ws_db.names.default'],
    status: 'observed',
    tier: 'workspace',
    value: {
      enhanced_security_monitoring_workspace: {
        is_enabled: false,
      },
      setting_name: 'default',
    },
  },
  {
    controls: ['SCP-02-03', 'SCP-03-03', 'SCP-03-04', 'SCP-03-06'],
    endpoint: 'GET /api/2.0/accounts/00000000-1111-2222-3333-444444444444/workspaces',
    fields: [
      '[].workspace_id',
      '[].workspace_name',
      '[].deployment_name',
      '[].workspace_status',
      '[].network_id',
      '[].private_access_settings_id',
      '[].storage_customer_managed_key_id',
      '[].managed_services_customer_managed_key_id',
    ],
    label: 'account-workspaces',
    shape: 'projected',
    signals: ['rest:account:accounts.workspaces', 'rest:workspace:accounts.workspaces'],
    status: 'observed',
    tier: 'account',
    value: {
      items: [
        {
          deployment_name: 'dbc-00000000-0000',
          workspace_id: 7000000000000001,
          workspace_name: 'us-east-1-control-tower',
          workspace_status: 'RUNNING',
        },
        {
          deployment_name: 'dbc-00000000-0000',
          workspace_id: 7000000000000002,
          workspace_name: 'llm-workshop-test',
          workspace_status: 'RUNNING',
        },
        {
          deployment_name: 'dbc-00000000-0000',
          workspace_id: 7000000000000003,
          workspace_name: 'dogfood-01-02',
          workspace_status: 'RUNNING',
        },
        {
          deployment_name: 'dbc-00000000-0000',
          workspace_id: 7000000000000004,
          workspace_name: 'apj-control-tower',
          workspace_status: 'RUNNING',
        },
        {
          deployment_name: 'dbc-00000000-0000',
          workspace_id: 7000000000000005,
          workspace_name: 'dogfood-01-01',
          workspace_status: 'RUNNING',
        },
        {
          deployment_name: 'dbc-00000000-0000',
          workspace_id: 7000000000000006,
          workspace_name: 'dogfood-01-03',
          workspace_status: 'RUNNING',
        },
        {
          deployment_name: 'dbc-00000000-0000',
          workspace_id: 7000000000000007,
          workspace_name: 'child-01',
          workspace_status: 'RUNNING',
        },
      ],
    },
  },
  {
    controls: ['SCP-03-08', 'SCP-03-12'],
    endpoint: 'GET /api/2.0/accounts/00000000-1111-2222-3333-444444444444/ip-access-lists',
    fields: [
      'ip_access_lists[].label',
      'ip_access_lists[].list_type',
      'ip_access_lists[].enabled',
      'ip_access_lists[].ip_addresses:count',
    ],
    label: 'account-ip-access-lists',
    shape: 'projected',
    signals: ['rest:account:accounts.{account_id}.ip-access-lists'],
    status: 'observed',
    tier: 'account',
    value: {},
  },
  {
    controls: ['SCP-03-09', 'SCP-03-11'],
    endpoint: 'GET /api/2.0/accounts/00000000-1111-2222-3333-444444444444/network-policies',
    fields: [
      'items[].network_policy_id',
      'items[].egress.network_access.restriction_mode',
      'items[].egress.network_access.policy_enforcement.enforcement_mode',
    ],
    label: 'account-network-policies',
    shape: 'projected',
    signals: ['rest:account:accounts.network-policies'],
    status: 'observed',
    tier: 'account',
    value: {
      items: [
        {
          egress: {
            network_access: {
              policy_enforcement: {
                enforcement_mode: 'ENFORCED',
              },
              restriction_mode: 'FULL_ACCESS',
            },
          },
          network_policy_id: 'default-policy',
        },
      ],
    },
  },
  {
    controls: ['SCP-04-02'],
    endpoint: 'GET /api/2.0/accounts/00000000-1111-2222-3333-444444444444/log-delivery',
    fields: [
      'log_delivery_configurations[].config_id',
      'log_delivery_configurations[].config_name',
      'log_delivery_configurations[].log_type',
      'log_delivery_configurations[].output_format',
      'log_delivery_configurations[].status',
      'log_delivery_configurations[].workspace_ids_filter:count',
    ],
    label: 'account-log-delivery',
    shape: 'projected',
    signals: ['rest:account:accounts.log-delivery'],
    status: 'observed',
    tier: 'account',
    value: {},
  },
  {
    controls: ['SCP-04-21'],
    endpoint:
      'GET /api/2.0/accounts/00000000-1111-2222-3333-444444444444/settings/types/disable_legacy_features/names/default',
    fields: [],
    label: 'account-setting-disable-legacy-features',
    shape: 'shallow',
    signals: ['rest:account:accounts.settings.types.disable_legacy_features.names.default'],
    status: 'observed',
    tier: 'account',
    value: {
      disable_legacy_features: {
        value: false,
      },
      setting_name: 'default',
    },
  },
  {
    controls: ['SCP-05-11'],
    endpoint:
      'GET /api/2.0/accounts/00000000-1111-2222-3333-444444444444/settings/types/shield_csp_enablement_ac/names/default',
    fields: [],
    label: 'account-setting-compliance-security-profile',
    shape: 'shallow',
    signals: ['rest:account:accounts.settings.types.shield_csp_enablement_ac.names.default'],
    status: 'observed',
    tier: 'account',
    value: {
      csp_enablement_account: {
        is_enforced: false,
      },
      setting_name: 'default',
    },
  },
];
