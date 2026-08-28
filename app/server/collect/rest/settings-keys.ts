// The workspace settings each security control reads, and what an unset one means.
//
// Fifteen controls come out of one call, which is why this table exists: the endpoint
// takes a list of keys and answers them together, so the alternative is fifteen calls
// asking one question each.
//
// The hard part is not the call, it is the third answer. `workspace-conf` returns a
// value, or `null` for a key the workspace has never set — and `null` is neither
// enabled nor disabled, it is "whatever the platform does by default". Reading it as
// disabled is the same fabrication as reading an empty storage snapshot as an estate of
// zero bytes, and it is the error SAT makes: a workspace that has never touched a
// setting is reported as failing it.
//
// So each key declares what an absent value means, and why. Three answers are possible
// and all three are used:
//
//   enforcement  — an unset enforcement flag is not enforcing. Nothing enforces itself
//                  silently, so absence is a real finding.
//   permissive   — the documented default is the permissive one, so absence is the
//                  permissive setting and a real finding.
//   unknown      — the default depends on cloud, tier or workspace age, and is not
//                  knowable from here. Absence is reported as unmeasured, with that
//                  reason, rather than guessed in either direction.

/** What a `null` from `workspace-conf` means for a given key. */
export type WhenAbsent = 'enforcement' | 'permissive' | 'unknown';

export interface SettingKey {
  /** The `workspace-conf` key, spelled as the API spells it. */
  readonly key: string;
  readonly controlId: string;
  /** How the setting reads in a sentence, for evidence a workspace admin recognises. */
  readonly label: string;
  /** The value that satisfies the control. */
  readonly secure: 'true' | 'false';
  readonly whenAbsent: WhenAbsent;
  /** Why absence means what it means, quoted in the finding when it decides the outcome. */
  readonly absentReason: string;
}

/**
 * Boolean settings, keyed by control.
 *
 * `maxTokenLifetimeDays` is deliberately not here: it is a number compared against a
 * threshold rather than a flag, so it is resolved separately.
 */
export const SETTING_KEYS: readonly SettingKey[] = [
  {
    key: 'enableIpAccessLists',
    controlId: 'SCP-03-10',
    label: 'IP access list enforcement',
    secure: 'true',
    whenAbsent: 'enforcement',
    absentReason:
      'IP access list enforcement is off until it is switched on, so a workspace that has never set it is ' +
      'not enforcing its lists. Any entries configured are inert.',
  },
  {
    key: 'enableVerboseAuditLogs',
    controlId: 'SCP-04-09',
    label: 'Verbose audit logging',
    secure: 'true',
    whenAbsent: 'enforcement',
    absentReason: 'Verbose audit logging is off unless enabled, so an unset value means the extra events are not being recorded.',
  },
  {
    key: 'enableJobViewAcls',
    controlId: 'SCP-05-04',
    label: 'Job view ACL enforcement',
    secure: 'true',
    whenAbsent: 'enforcement',
    absentReason: 'View ACL enforcement applies only once enabled, so an unset value means jobs are visible beyond their permissions.',
  },
  {
    key: 'enforceClusterViewAcls',
    controlId: 'SCP-05-05',
    label: 'Cluster view ACL enforcement',
    secure: 'true',
    whenAbsent: 'enforcement',
    absentReason: 'View ACL enforcement applies only once enabled, so an unset value means clusters are visible beyond their permissions.',
  },
  {
    key: 'enforceWorkspaceViewAcls',
    controlId: 'SCP-05-06',
    label: 'Workspace object view ACL enforcement',
    secure: 'true',
    whenAbsent: 'enforcement',
    absentReason:
      'View ACL enforcement applies only once enabled, so an unset value means notebooks and folders are ' +
      'visible beyond their permissions.',
  },
  {
    key: 'enableProjectsAllowList',
    controlId: 'SCP-05-15',
    label: 'Git repository allowlist',
    secure: 'true',
    whenAbsent: 'enforcement',
    absentReason: 'An allowlist restricts nothing until it is enabled, so an unset value means any external repository may be connected.',
  },
  {
    key: 'enableResultsDownloading',
    controlId: 'SCP-02-04',
    label: 'Downloading notebook results',
    secure: 'false',
    whenAbsent: 'permissive',
    absentReason: 'Result downloading is available by default, so an unset value means it is available.',
  },
  {
    key: 'enableExportNotebook',
    controlId: 'SCP-02-05',
    label: 'Exporting notebooks',
    secure: 'false',
    whenAbsent: 'permissive',
    absentReason: 'Notebook export is available by default, so an unset value means it is available.',
  },
  {
    key: 'enableNotebookTableClipboard',
    controlId: 'SCP-02-06',
    label: 'Copying table results to the clipboard',
    secure: 'false',
    whenAbsent: 'permissive',
    absentReason: 'Clipboard copy of tabular results is available by default, so an unset value means it is available.',
  },
  {
    key: 'enableDbfsFileBrowser',
    controlId: 'SCP-02-12',
    label: 'The DBFS file browser',
    secure: 'false',
    whenAbsent: 'permissive',
    absentReason: 'The DBFS browser is available by default, so an unset value means users can browse shared storage paths through the UI.',
  },
  {
    key: 'enableFileStoreEndpoint',
    controlId: 'SCP-02-08',
    label: 'The FileStore HTTPS endpoint',
    secure: 'false',
    whenAbsent: 'unknown',
    absentReason:
      'Whether the FileStore endpoint is served by default varies with workspace age, and the setting is ' +
      'absent both on workspaces that never enabled it and on workspaces where it was never offered.',
  },
  {
    key: 'storeInteractiveNotebookResultsInCustomerAccount',
    controlId: 'SCP-02-07',
    label: 'Storing interactive notebook results in your own account',
    secure: 'true',
    whenAbsent: 'unknown',
    absentReason:
      'The default depends on how the workspace was created and whether customer-managed keys are in use, ' +
      'so an absent value does not say where results are being stored.',
  },
  {
    key: 'enableEnforceImdsV2',
    controlId: 'SCP-04-08',
    label: 'AWS Instance Metadata Service v2 enforcement',
    secure: 'true',
    whenAbsent: 'unknown',
    absentReason:
      'Newer AWS workspaces enforce IMDSv2 without the setting being present, so an absent value does not ' +
      'distinguish an unenforced workspace from one where enforcement is the platform default.',
  },
  {
    key: 'enableProjectTypeInWorkspace',
    controlId: 'SCP-05-07',
    label: 'Git folder support in the workspace',
    secure: 'true',
    whenAbsent: 'unknown',
    absentReason:
      'Git folder support is present by default on current workspaces and the setting is absent on those, ' +
      'so an absent value is not evidence that it is unavailable.',
  },
];

/** The token lifetime ceiling, which is a number rather than a flag. */
export const MAX_TOKEN_LIFETIME_KEY = 'maxTokenLifetimeDays';

/** Every key the one call has to ask for. */
export const REQUESTED_KEYS: readonly string[] = [...SETTING_KEYS.map((setting) => setting.key), MAX_TOKEN_LIFETIME_KEY];
