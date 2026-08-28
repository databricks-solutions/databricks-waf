import { ExternalLink } from 'lucide-react';

export const DEPLOYMENT_GUIDE_URL =
  'https://databricks-solutions.github.io/databricks-waf/deployment-lifecycle/';

/**
 * The app reports its footing; the installer changes it outside the app through DABs.
 *
 * Kept as an external repository link rather than an in-app settings action because the application
 * is deliberately unable to grant itself access or replace its own infrastructure.
 */
export function DeploymentGuideLink() {
  return (
    <a className="wa-button-secondary" href={DEPLOYMENT_GUIDE_URL} target="_blank" rel="noreferrer">
      <ExternalLink aria-hidden className="h-3.5 w-3.5" />
      Deployment guide
    </a>
  );
}
