import { ResolverRegistry } from "../resolver.js";
import { AUTH_LOGIN_RESOLVERS } from "./auth-login.js";
import { CLUSTER_SIZING_RESOLVERS } from "./cluster-sizing.js";
import { COMPUTE_HARDENING_RESOLVERS } from "./compute-hardening.js";
import { CONSTRAINT_RESOLVERS } from "./constraints.js";
import { COST_RESOLVERS } from "./cost.js";
import { ENDPOINT_RESOLVERS } from "./endpoints.js";
import { GOVERNANCE_RESOLVERS } from "./governance.js";
import { INTEROPERABILITY_RESOLVERS } from "./interoperability.js";
import { JOB_TRIGGERS_RESOLVERS } from "./job-triggers.js";
import { LAYOUT_RESOLVERS } from "./layout.js";
import { METASTORE_RESOLVERS } from "./metastore.js";
import { MODEL_LIFECYCLE_RESOLVERS } from "./model-lifecycle.js";
import { OPERATIONAL_EXCELLENCE_RESOLVERS } from "./operational-excellence.js";
import { PLATFORM_RESOLVERS } from "./platform.js";
import { QUALITY_MONITORING_RESOLVERS } from "./quality-monitoring.js";
import { RETENTION_RESOLVERS } from "./retention.js";
import { SECURITY_ADMIN_RESOLVERS } from "./security-admin.js";
import { SECURITY_JOBS_RESOLVERS } from "./security-jobs.js";
import { SECURITY_SETTINGS_RESOLVERS } from "./security-settings.js";
import { STORAGE_RESOLVERS } from "./storage.js";
//#region server/resolve/resolvers/index.ts
const ALL = [
	...AUTH_LOGIN_RESOLVERS,
	...CLUSTER_SIZING_RESOLVERS,
	...COMPUTE_HARDENING_RESOLVERS,
	...CONSTRAINT_RESOLVERS,
	...COST_RESOLVERS,
	...ENDPOINT_RESOLVERS,
	...GOVERNANCE_RESOLVERS,
	...INTEROPERABILITY_RESOLVERS,
	...JOB_TRIGGERS_RESOLVERS,
	...LAYOUT_RESOLVERS,
	...METASTORE_RESOLVERS,
	...MODEL_LIFECYCLE_RESOLVERS,
	...OPERATIONAL_EXCELLENCE_RESOLVERS,
	...PLATFORM_RESOLVERS,
	...QUALITY_MONITORING_RESOLVERS,
	...RETENTION_RESOLVERS,
	...SECURITY_ADMIN_RESOLVERS,
	...SECURITY_JOBS_RESOLVERS,
	...SECURITY_SETTINGS_RESOLVERS,
	...STORAGE_RESOLVERS
];
function buildRegistry() {
	const registry = new ResolverRegistry();
	for (const resolver of ALL) registry.register(resolver);
	return registry;
}
//#endregion
export { CLUSTER_SIZING_RESOLVERS, COMPUTE_HARDENING_RESOLVERS, CONSTRAINT_RESOLVERS, COST_RESOLVERS, ENDPOINT_RESOLVERS, GOVERNANCE_RESOLVERS, INTEROPERABILITY_RESOLVERS, JOB_TRIGGERS_RESOLVERS, LAYOUT_RESOLVERS, METASTORE_RESOLVERS, MODEL_LIFECYCLE_RESOLVERS, OPERATIONAL_EXCELLENCE_RESOLVERS, PLATFORM_RESOLVERS, QUALITY_MONITORING_RESOLVERS, RETENTION_RESOLVERS, SECURITY_ADMIN_RESOLVERS, SECURITY_JOBS_RESOLVERS, SECURITY_SETTINGS_RESOLVERS, STORAGE_RESOLVERS, buildRegistry };
