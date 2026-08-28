import { Link } from 'react-router';
import type { Finding, RemedyKind } from '../api/types';
import { ActionPanel, TechnicalDisclosure } from './system';
import { presentRemedy } from './remedy-language';

const ACTION_TITLE: Readonly<Record<RemedyKind, string>> = {
  grant: 'Grant the scanning identity the required access',
  enable: 'Enable the missing system source',
  're-authorise': 'Sign in to this app again',
  attest: 'Answer this requirement',
  retry: 'Run the assessment again',
  report: 'Report this application gap',
};

const OWNER: Readonly<Record<RemedyKind, string>> = {
  grant: 'A workspace or metastore admin',
  enable: 'An account admin',
  're-authorise': 'The signed-in user',
  attest: 'The accountable practice owner',
  retry: 'The assessment operator',
  report: 'The application owner',
};

const DESTINATION: Readonly<Record<RemedyKind, string>> = {
  grant: 'Databricks permissions for the refused source; this report records no safe exact URL.',
  enable: 'Metastore system-schema configuration; this report records no safe exact URL.',
  're-authorise': 'This Databricks App session; Databricks owns the sign-in control.',
  attest: 'Answers, opened on this requirement.',
  retry: 'The Dashboard scan control.',
  report: 'Application diagnostics.',
};

export function MeasurementRemedyAction({ finding }: { readonly finding: Finding }) {
  const remedy = finding.remedy;
  if (remedy == null) {
    return (
      <ActionPanel
        eyebrow="Close the measurement gap"
        title="Review why this requirement could not be measured"
        why={
          <div className="space-y-1.5">
            {finding.outcomeReason != null && <p>{finding.outcomeReason}</p>}
            <p>This assessment records no measurement remedy, so the app cannot identify a safe action from it.</p>
          </div>
        }
        action={<span className="wa-body-compact max-w-56 text-wa-text-secondary">No safe action is recorded.</span>}
        destination="No exact destination is recorded for this report."
        verification="A later assessment records a measured outcome for this requirement."
      />
    );
  }

  const presentation = presentRemedy(remedy.kind);
  const exactAction =
    presentation.action != null ? (
      <Link
        className="wa-customer-primary-action"
        to={`${presentation.action.to}?control=${encodeURIComponent(finding.controlId)}`}
      >
        {presentation.action.label}
      </Link>
    ) : remedy.kind === 'retry' ? (
      <Link className="wa-customer-primary-action" to="/overview">
        Open Dashboard
      </Link>
    ) : remedy.kind === 'report' ? (
      <Link className="wa-customer-primary-action" to="/diagnostics">
        Open diagnostics
      </Link>
    ) : (
      <span className="wa-body-compact max-w-56 text-wa-text-secondary">No safe exact link is recorded.</span>
    );

  return (
    <ActionPanel
      recommendation
      eyebrow="Close the measurement gap"
      title={ACTION_TITLE[remedy.kind]}
      why={
        <div className="space-y-1.5">
          {finding.outcomeReason != null && <p>{finding.outcomeReason}</p>}
          <p>{remedy.says}</p>
        </div>
      }
      action={exactAction}
      destination={DESTINATION[remedy.kind]}
      owner={presentation.owner ?? OWNER[remedy.kind]}
      verification={
        remedy.kind === 'attest'
          ? 'A current answer is recorded and the next published report includes it.'
          : 'A later assessment reads the previously unavailable source and records an outcome for this requirement.'
      }
      details={
        remedy.because != null || remedy.signals.length > 0 ? (
          <TechnicalDisclosure
            label="Technical measurement evidence"
            hint={
              remedy.signals.length > 0
                ? `${String(remedy.signals.length)} source signal${remedy.signals.length === 1 ? '' : 's'}`
                : undefined
            }
          >
            <div className="space-y-2">
              {remedy.because != null && <pre className="wa-code-block">{remedy.because}</pre>}
              {remedy.signals.length > 0 && (
                <p className="wa-caption">
                  Source signal IDs: <span className="wa-code">{remedy.signals.join(', ')}</span>
                </p>
              )}
            </div>
          </TechnicalDisclosure>
        ) : undefined
      }
    />
  );
}
