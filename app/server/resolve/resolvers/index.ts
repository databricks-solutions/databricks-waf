// The resolver registry.
//
// Assembled in one place so the set of controls the app can actually answer is a
// single readable list rather than something inferred from imports. The registry
// refuses duplicate registrations, so two resolvers claiming the same control is a
// startup failure rather than a silent order-dependent choice between them.

import { ResolverRegistry } from '../resolver.js';
import { AUTH_LOGIN_RESOLVERS } from './auth-login.js';
import { CLUSTER_SIZING_RESOLVERS } from './cluster-sizing.js';
import { COMPUTE_HARDENING_RESOLVERS } from './compute-hardening.js';
import { CONSTRAINT_RESOLVERS } from './constraints.js';
import { COST_RESOLVERS } from './cost.js';
import { ENDPOINT_RESOLVERS } from './endpoints.js';
import { GOVERNANCE_RESOLVERS } from './governance.js';
import { INTEROPERABILITY_RESOLVERS } from './interoperability.js';
import { JOB_TRIGGERS_RESOLVERS } from './job-triggers.js';
import { LAYOUT_RESOLVERS } from './layout.js';
import { METASTORE_RESOLVERS } from './metastore.js';
import { MODEL_LIFECYCLE_RESOLVERS } from './model-lifecycle.js';
import { OPERATIONAL_EXCELLENCE_RESOLVERS } from './operational-excellence.js';
import { PLATFORM_RESOLVERS } from './platform.js';
import { QUALITY_MONITORING_RESOLVERS } from './quality-monitoring.js';
import { RETENTION_RESOLVERS } from './retention.js';
import { SECURITY_ADMIN_RESOLVERS } from './security-admin.js';
import { SECURITY_JOBS_RESOLVERS } from './security-jobs.js';
import { SECURITY_SETTINGS_RESOLVERS } from './security-settings.js';
import { STORAGE_RESOLVERS } from './storage.js';

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
  ...STORAGE_RESOLVERS,
];

export function buildRegistry(): ResolverRegistry {
  const registry = new ResolverRegistry();
  for (const resolver of ALL) registry.register(resolver);
  return registry;
}

/** Every control the app has an implemented check for. Compared against the catalogue in CI. */
export function resolvedControls(): string[] {
  return ALL.flatMap((resolver) => resolver.controls).sort();
}

export {
  CLUSTER_SIZING_RESOLVERS,
  COMPUTE_HARDENING_RESOLVERS,
  CONSTRAINT_RESOLVERS,
  COST_RESOLVERS,
  ENDPOINT_RESOLVERS,
  GOVERNANCE_RESOLVERS,
  INTEROPERABILITY_RESOLVERS,
  JOB_TRIGGERS_RESOLVERS,
  LAYOUT_RESOLVERS,
  METASTORE_RESOLVERS,
  MODEL_LIFECYCLE_RESOLVERS,
  OPERATIONAL_EXCELLENCE_RESOLVERS,
  PLATFORM_RESOLVERS,
  QUALITY_MONITORING_RESOLVERS,
  RETENTION_RESOLVERS,
  SECURITY_ADMIN_RESOLVERS,
  SECURITY_JOBS_RESOLVERS,
  SECURITY_SETTINGS_RESOLVERS,
  STORAGE_RESOLVERS,
};
