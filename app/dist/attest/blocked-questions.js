//#region server/attest/blocked-questions.ts
/** How long an answer about a setting stands. Short, because a setting changes in one click. */
const QUARTERLY = 90;
/**
* For state that changes without anyone touching it.
*
* Cluster uptime, secret age, token expiry: nobody edits these, they drift. An answer about drift is
* only worth the interval it was taken over.
*/
const MONTHLY = 30;
/**
* For what was decided when the workspace was built.
*
* Customer-managed keys, a customer-managed VPC, front-end Private Link, secure cluster
* connectivity: each is chosen at workspace creation and several cannot be changed afterwards
* without rebuilding. Asking quarterly would train the reader to click through it.
*/
const ANNUAL = 365;
const BLOCKED_QUESTIONS = {
	"SCP-01-03": {
		question: "Are there personal access tokens in this workspace with no expiry?",
		evidence: "Settings → Advanced → Access tokens lists every token with its expiry. Report whether any shows no expiration.",
		cadenceDays: QUARTERLY
	},
	"SCP-01-04": {
		question: "Is a maximum lifetime set for newly created tokens, rather than left unlimited?",
		evidence: "Settings → Advanced → Personal access tokens, the maximum lifetime field. Report the value set.",
		cadenceDays: QUARTERLY
	},
	"SCP-01-05": {
		question: "Are there tokens still valid for longer than the maximum you now allow for new ones?",
		evidence: "A cap applies to tokens created after it was set, so tokens issued earlier can outlive it. Compare the token list against the current maximum.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-01": {
		question: "Do you know which tokens expire in the next 90 days, and is someone responsible for rotating them?",
		evidence: "The token list with expiry dates, and who owns rotation. A token expiring unnoticed takes a production integration with it.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-04": {
		question: "Is downloading query and notebook results disabled for this workspace?",
		evidence: "Settings → Security → Notebook result download. Report whether it is off.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-05": {
		question: "Is notebook export disabled, so notebooks and their outputs cannot be taken off the platform?",
		evidence: "Settings → Security → Notebook export. Report the setting as it currently stands.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-06": {
		question: "Is copying table results to the clipboard from notebooks disabled?",
		evidence: "Settings → Security → Notebook table clipboard features.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-07": {
		question: "Are interactive notebook results stored only in your own cloud account, rather than in the control plane?",
		evidence: "Settings → Security → Store interactive notebook results in customer account. This is off by default, so a workspace nobody has changed will answer not met.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-08": {
		question: "Is the FileStore endpoint — which serves files over HTTPS to anyone with the link — disabled?",
		evidence: "Settings → Security, the FileStore or DBFS file serving setting.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-12": {
		question: "Is the DBFS file browser disabled, so DBFS is not a route around catalogue permissions?",
		evidence: "Settings → Advanced → DBFS File Browser.",
		cadenceDays: QUARTERLY
	},
	"SCP-03-10": {
		question: "Are IP access lists enforced for this workspace, rather than configured but not switched on?",
		evidence: "Settings → Security → IP access lists. A list that exists with enforcement disabled restricts nothing; report which state you are in.",
		cadenceDays: QUARTERLY
	},
	"SCP-03-07": {
		question: "Are the model serving endpoints named in this finding reachable only over Private Link or from an allowed IP range, rather than from the public internet?",
		evidence: "For each endpoint, Serving → the endpoint → Networking. Report which are private and name any that accept public traffic; the account console shows whether Private Link is in place for the workspace.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-08": {
		question: "Is Instance Metadata Service v2 enforced on compute, so instance credentials cannot be read by a simple request?",
		evidence: "The workspace setting for IMDSv2 enforcement. Answer not-applicable outside AWS.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-09": {
		question: "Are verbose audit logs enabled, so notebook and query actions appear in the audit trail?",
		evidence: "Settings → Advanced → Verbose Audit Logs. Without it the audit log records access to the workspace but not what was run in it.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-04": {
		question: "Are job permissions granted deliberately, rather than jobs being visible to everyone by inheritance?",
		evidence: "The permissions on a sample of production jobs, and whether any grant view or manage to all users.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-05": {
		question: "Are cluster permissions granted to specific groups rather than to all users?",
		evidence: "The permissions on your production clusters, particularly any grant to the all-users group.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-06": {
		question: "Are workspace object permissions — folders, notebooks, dashboards — set deliberately rather than left open?",
		evidence: "The permissions on the top-level folders in the workspace, and who can read them.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-07": {
		question: "Is Git integration enabled and in use, so notebooks in this workspace have a source of truth outside it?",
		evidence: "Whether Git folders are enabled and whether production notebooks are backed by a repository.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-15": {
		question: "Is there an allowlist of Git repositories, so code can only be pulled in from repositories you control?",
		evidence: "Settings → Advanced, the Git URL allowlist. An empty allowlist permits any repository.",
		cadenceDays: QUARTERLY
	},
	"SCP-01-06": {
		question: "Is creating personal access tokens restricted to admins, rather than allowed to all workspace users?",
		evidence: "Settings → Advanced → Access tokens → Permissions. Report whether the \"All workspace users\" group can use tokens. A PAT inherits everything its creator can do and outlives their session.",
		cadenceDays: QUARTERLY
	},
	"SCP-01-07": {
		question: "Have all account service principal client secrets been created or rotated recently?",
		evidence: "Account console → Service principals, each principal's secrets and their creation dates. A secret with no rotation date is the oldest one you have.",
		cadenceDays: MONTHLY
	},
	"SCP-02-01": {
		question: "Are credentials held in secret scopes rather than written into notebooks and job definitions?",
		evidence: "The secret scopes that exist and roughly what is in them. An estate with no scopes at all is either not using external systems or holding their credentials somewhere worse.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-03": {
		question: "Are customer-managed keys configured for both managed services and workspace storage?",
		evidence: "Account console → the workspace's configuration, the two key fields. Both, not either: managed services covers notebooks and secrets, workspace storage covers the DBFS root and job results.",
		cadenceDays: ANNUAL
	},
	"SCP-02-02": {
		question: "Is local disk encryption enabled on the clusters that handle sensitive data?",
		evidence: "The cluster specification, `enable_local_disk_encryption`. It is off unless set, and it covers the scratch space that shuffle and spill land in — which holds the same data the table does.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-03": {
		question: "Are any clusters running for weeks without a restart?",
		evidence: "Compute, the start time of each running cluster. A cluster that never restarts never picks up a runtime security patch, and image updates are applied at start.",
		cadenceDays: MONTHLY
	},
	"SCP-05-01": {
		question: "Are there libraries installed for all clusters, and is each one still needed?",
		evidence: "Compute → the workspace library list, anything marked as installed on all clusters. Each of those is code running everywhere, with no cluster owner having chosen it.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-02": {
		question: "Are the global init scripts in this workspace ones you can account for?",
		evidence: "Settings → Compute → Global init scripts. Each runs as root on every cluster in the workspace before it becomes usable, so an unaccounted-for one is the most privileged code you have.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-12": {
		question: "Is there an artifact allowlist restricting which JARs and Maven coordinates can be installed?",
		evidence: "Catalog → the metastore's allowlist for LIBRARY_JAR and LIBRARY_MAVEN. An empty allowlist on a shared-access cluster permits any artifact.",
		cadenceDays: QUARTERLY
	},
	"SCP-03-03": {
		question: "Does workspace access go over front-end private connectivity rather than the public internet?",
		evidence: "Account console → the workspace's private access settings. This is decided at creation and needs a rebuild to add, so answer not met rather than in progress if it was not.",
		cadenceDays: ANNUAL
	},
	"SCP-03-04": {
		question: "Does this workspace run in a VPC or VNet you own, rather than one Databricks created?",
		evidence: "Account console → the workspace's network configuration. Without it you cannot apply your own egress controls, and on AWS and GCP it cannot be changed after creation.",
		cadenceDays: ANNUAL
	},
	"SCP-03-05": {
		question: "Are IP access lists configured for this workspace and switched on?",
		evidence: "Settings → Security → IP access lists. Both halves: a list that exists with enforcement off restricts nothing, and is the more common of the two states.",
		cadenceDays: QUARTERLY
	},
	"SCP-03-06": {
		question: "Is secure cluster connectivity in effect, so cluster nodes have no public IP addresses?",
		evidence: "Account console → the workspace configuration, secure cluster connectivity — called NoPublicIp on Azure. Default for new workspaces, so an older workspace is the one worth checking.",
		cadenceDays: ANNUAL
	},
	"SCP-03-08": {
		question: "Are IP access lists configured for the account console itself?",
		evidence: "Account console → Settings → IP access lists. Separate from the workspace lists and often missed: the console is where workspaces, keys and network policies are administered.",
		cadenceDays: QUARTERLY
	},
	"SCP-03-09": {
		question: "Does every workspace have a network policy assigned, in restricted mode, and enforced rather than in dry run?",
		evidence: "Account console → Settings → Network policies, and which workspaces each is assigned to. All three parts, because a policy in dry-run mode logs what it would have blocked and blocks nothing.",
		cadenceDays: QUARTERLY
	},
	"SCP-03-11": {
		question: "Is public access to the workspace restricted by a network policy, rather than open with a policy present?",
		evidence: "The network policy's ingress configuration and its public access restriction mode. Report the mode as it stands, not whether a policy exists.",
		cadenceDays: QUARTERLY
	},
	"SCP-03-12": {
		question: "Does the account console IP access list have at least one enabled allow entry?",
		evidence: "Account console → Settings → IP access lists. With only block entries, or with everything disabled, the console is reachable from any address — including where a leaked credential is being used from.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-02": {
		question: "Is audit log delivery configured at the account and currently enabled?",
		evidence: "Account console → Settings → Log delivery, the configuration with type AUDIT_LOGS. This is the copy of the audit trail that survives outside Databricks, which is the one an investigation needs.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-10": {
		question: "Are legacy DBFS root access and DBFS mounts disabled for this workspace?",
		evidence: "Settings → Advanced, the legacy DBFS setting. A mount is a credential shared with everyone who can read it.",
		cadenceDays: QUARTERLY
	},
	"SCP-02-11": {
		question: "Is downloading results from SQL warehouse queries disabled?",
		evidence: "Settings → Security, the SQL results download setting. Separate from the notebook download setting, and a workspace often has one off and the other on.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-19": {
		question: "Are workspace admins restricted, so they cannot change job owners or use another user's tokens?",
		evidence: "Settings → Security → Restrict workspace admins. Unrestricted is the default, which lets a workspace admin run a job as somebody else.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-20": {
		question: "Is automatic cluster update enabled, so compute images get security patches without anyone scheduling it?",
		evidence: "Settings → Compute → Automatic cluster update. Report the setting, and note the maintenance window if one is set.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-21": {
		question: "Is the account set to disable legacy features for newly created workspaces?",
		evidence: "Account console → Settings → the legacy features setting. It governs workspaces created from now on, so answering met says nothing about the workspaces you already have.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-11": {
		question: "Is the compliance security profile enabled by default for new workspaces at the account?",
		evidence: "Account console → Settings → the compliance security profile default. Answer not-applicable if you have no regulatory regime that requires it.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-13": {
		question: "Is the compliance security profile enabled on this workspace?",
		evidence: "Settings → Security → Compliance security profile. It cannot be turned off once on, and it constrains which runtimes and instance types the workspace may use.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-14": {
		question: "Is enhanced security monitoring enabled on this workspace?",
		evidence: "Settings → Security → Enhanced security monitoring. It adds file integrity monitoring and antivirus to the compute images, and reports to the audit log.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-11": {
		question: "Is the Delta Sharing recipient token lifetime for the metastore capped at a short period?",
		evidence: "Catalog → the metastore's Delta Sharing settings, the recipient token lifetime. Relevant only where sharing is open to external recipients; answer not-applicable if the scope is internal only.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-12": {
		question: "Does every token-based Delta Sharing recipient have an IP access list?",
		evidence: "Catalog → Delta Sharing → Recipients, filtered to token authentication. A bearer token with no address restriction works from anywhere it is copied to.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-13": {
		question: "Do all Delta Sharing recipient tokens have an expiry set?",
		evidence: "Catalog → Delta Sharing → Recipients, each token's expiration. A recipient token with no expiry is a permanent external grant on the data in the share.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-15": {
		question: "Is the metastore admin a group, rather than the individual who created it?",
		evidence: "Catalog → the metastore's owner. If it is still the creator, or a personal account, then metastore administration leaves with that person and nobody else can grant it back.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-17": {
		question: "Are machine learning models registered in Unity Catalog rather than in the workspace model registry?",
		evidence: "Catalog → Models, against what the ML teams are actually deploying from. Models in the workspace registry have no catalogue permissions, no lineage and no audit trail.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-08": {
		question: "Are storage credentials used only through external locations, rather than granted to users directly?",
		evidence: "Catalog → External data → Storage credentials, and who holds READ FILES or WRITE FILES on each. A direct grant bypasses the path restrictions the external location exists to impose.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-09": {
		question: "Is the ability to create Delta Sharing shares and recipients limited to a small, named group?",
		evidence: "Catalog → the metastore's permissions, CREATE SHARE and CREATE RECIPIENT. Together these two allow data to be sent outside the account without any other approval.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-22": {
		question: "Do production jobs run as a service principal rather than as a named person?",
		evidence: "Workflows, the \"run as\" identity on your production jobs. A job running as a person fails when they change team, and grants the job everything that person can reach.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-23": {
		question: "Is CAN MANAGE on production jobs held only by admins and the job owner?",
		evidence: "The permissions on a sample of production jobs. CAN MANAGE allows editing the task, so it is the authority to change what runs, not just to run it.",
		cadenceDays: QUARTERLY
	},
	"SCP-05-03": {
		question: "Is the workspace admin group small enough that you can name everyone in it?",
		evidence: "Settings → Identity and access → Groups → admins, and its membership. Report the count and whether each member still needs it.",
		cadenceDays: QUARTERLY
	},
	"SCP-04-05": {
		question: "Is data still being written to the DBFS root under /user/hive/warehouse?",
		evidence: "The DBFS root, /user/hive/warehouse. Tables there have no catalogue permissions and sit in a bucket every workspace user can read, which is what Unity Catalog managed storage replaces.",
		cadenceDays: QUARTERLY
	}
};
//#endregion
export { BLOCKED_QUESTIONS };
