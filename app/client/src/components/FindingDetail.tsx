// One requirement, in full.
//
// This is the card that used to be repeated 148 times down a scrolling page. As a detail pane it can
// afford to show everything at once — evidence, criteria, remediation, source — because there is
// exactly one of it, and the reader chose it. The accordion it used to hide the remediation behind
// is gone with the repetition that made the accordion necessary.
//
// The order follows the customer action grammar: requirement identity, the exact next action and its
// evidence-bounded reason, then the affected resources and deeper evidence that defend it. Repeating
// the full outcome explanation above that action makes the pane read like a report before it becomes
// useful, so an actionable finding carries that explanation in the action panel's Why section.
//
// The current customer surfaces and fact roles keep this reading order consistent wherever a
// requirement appears; technical identifiers and provenance stay behind disclosure.

import { Link } from 'react-router';
import { Fragment, type ReactNode } from 'react';
import { useAssessment, type AlsoAsking } from '../api/assessment-context';
import { coverageNote, measuredTogether } from './verdict-language';
import { collectorNote, provenanceSentence } from './provenance-language';
import { attributionPhrase, renewalPhrase } from '../pages/attest-language';
import { DecisionNote, StandingBadge } from './DecisionNote';
import { RemedyNote } from './RemedyNote';
import { RaisedWork } from './RaisedWork';
import { NoteThread } from './NoteThread';
import { AttestedBadge, IdentifierBadge, OutcomeBadge, SeverityBadge } from './ui/StatusBadge';
import { ActionPanel as CustomerActionPanel, Fact, FactList, Surface, TechnicalDisclosure } from './system';
import { FindingConfidence, FindingHistory } from './FindingConfidence';
import { FindingGuidance } from './FindingGuidance';
import { FoundOnSection } from './FoundOn';
import { MeasurementRemedyAction } from './MeasurementRemedyAction';
import { findingActionReason } from './finding-action-language';
import type {
  AttestedFact,
  CatalogueControl,
  Decision,
  Finding,
  ImprovementAction,
  LocatedItem,
  Note,
  Scan,
} from '../api/types';

export interface FindingDetailProps {
  readonly finding: Finding;
  /**
   * Where another requirement sharing this reading opens.
   *
   * Legacy callers keep `/findings`; Investigate supplies its composed route so following the
   * relationship preserves the workbench rather than returning to the old record page.
   */
  readonly controlHref?: (controlId: string) => string;
  /**
   * What somebody decided to do about it, where a decision has been recorded.
   *
   * Passed in rather than fetched here, because this pane renders in three places — the findings
   * page, the printed report, a pillar's worst results — and a component that fetched per instance
   * would issue one request per finding on a page that shows several.
   */
  readonly decision?: Decision;
  /**
   * Whether this pane is part of an artefact rather than part of the app.
   *
   * The report renders this component once per finding, and everything that offers to change something
   * has to come off it — a box asking the holder of a printed page to write a note, and the warning
   * that notes are held in memory, which is advice to whoever runs the app. Left alone, the warning
   * printed thirty-four times on the labs report, once per finding.
   *
   * A prop rather than a print stylesheet because `/report` is read on a screen as often as it is
   * printed, and `display: none` would leave the requests behind it being made either way.
   */
  readonly printed?: boolean;
  /**
   * Work already raised against this requirement, when the parent has already asked for every
   * control. The report passes this so ninety findings do not issue ninety requests.
   */
  readonly raised?: readonly ImprovementAction[];
  /**
   * Notes already read about this requirement, when the parent has already asked for every
   * control. Same reason as `raised`.
   */
  readonly notes?: readonly Note[];
  /** A surface-specific next action, placed immediately after the finding identity. */
  readonly leadingAction?: ReactNode;
  /** A surface-specific gate for recorded resource destinations in the evidence section. */
  readonly resourceHref?: (item: LocatedItem) => string | undefined;
  /**
   * An explicit assessment reading for deterministic document previews.
   *
   * Production callers omit this and use AssessmentProvider. The development-only report preview
   * supplies the same four reads so it can render the exact report without writing fixture data.
   */
  readonly assessment?: {
    readonly controlOf: (controlId: string) => CatalogueControl | undefined;
    readonly alsoAsking: (controlId: string) => readonly AlsoAsking[];
    readonly pillarTitle: (pillarId: string) => string;
    readonly scan?: Scan;
  };
}

export function FindingDetail({
  finding,
  controlHref = (controlId) => `/findings?control=${encodeURIComponent(controlId)}`,
  decision,
  printed = false,
  raised,
  notes,
  leadingAction,
  resourceHref,
  assessment,
}: FindingDetailProps) {
  const current = useAssessment();
  const { alsoAsking, controlOf, pillarTitle, scan } = assessment ?? current;
  const control = controlOf(finding.controlId);
  const kin = alsoAsking(finding.controlId);
  const coverage = coverageNote(finding.coverage);
  // Provenance comes off the first piece of evidence: which collector saw this, and when. Absent
  // for a finding that was never observed, where a timestamp would be an invention.
  const first = finding.evidence[0];
  const read = provenanceSentence(first?.provenance);
  const collector = collectorNote(first?.provenance);
  // The rows with something to say above the resources section. A row carrying `at` is rendered
  // there in full, so it appears here only where it also states an expectation — which no resolver
  // does today, and which would otherwise be dropped silently if one did.
  const measured = finding.evidence.filter((evidence) => evidence.at == null || evidence.expected != null);
  const needsClosure =
    finding.outcome === 'fail' || finding.outcome === 'partial' || finding.outcome === 'unmeasurable';
  const closureTitle =
    control?.remediation?.summary ?? finding.remedy?.says ?? `Create an improvement plan to close ${finding.controlId}`;
  const closureWhy = findingActionReason(finding.outcomeReason, control?.rationale);
  const closureVerification =
    control?.criteria ?? 'A later assessment will evaluate this requirement against current evidence.';

  return (
    <div className="space-y-3">
      <Surface
        tone="accent"
        title={finding.title}
        description={pillarTitle(finding.pillarId)}
        action={<IdentifierBadge>{finding.controlId}</IdentifierBadge>}
        headingLevel={2}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <OutcomeBadge outcome={finding.outcome} />
          <SeverityBadge severity={finding.severity} />
          {finding.attested?.bearing === 'outcome' && <AttestedBadge />}
          {decision != null && <StandingBadge standing={decision.standing} />}
          {control?.provenance === 'extension' && <span className="wa-badge">Extension to the framework</span>}
        </div>
        {finding.outcomeReason != null && (printed || (!needsClosure && leadingAction == null)) && (
          <p className="wa-body-compact mt-2 text-wa-text-secondary">{finding.outcomeReason}</p>
        )}
        {finding.occurrence != null && <FindingHistory occurrence={finding.occurrence} outcome={finding.outcome} />}
      </Surface>

      {leadingAction ??
        (finding.outcome === 'unmeasurable' && !printed ? (
          <MeasurementRemedyAction finding={finding} />
        ) : needsClosure && !printed ? (
          <CustomerActionPanel
            recommendation
            eyebrow="Do this"
            title={closureTitle}
            why={<p className="wa-body-compact text-wa-text-secondary">{closureWhy}</p>}
            action={
              <Link
                className="wa-customer-primary-action"
                to={`/improvements?control=${encodeURIComponent(finding.controlId)}`}
              >
                Create improvement plan
              </Link>
            }
            destination="The governed improvement workflow for this requirement"
            owner="Assign in the improvement plan"
            verification={closureVerification}
          />
        ) : null)}

      {kin.length > 0 && <AlsoMeasured kin={kin} pillarTitle={pillarTitle} controlHref={controlHref} />}
      {finding.attested != null && <Attested fact={finding.attested} />}
      {decision != null && (
        <Surface tone="raised" title="Recorded decision" headingLevel={3}>
          <DecisionNote decision={decision} badged={false} />
        </Surface>
      )}

      {measured.length > 0 && (
        <Surface tone="raised" title="Observed and expected" headingLevel={3}>
          <FactList>
            {measured.map((evidence, index) => (
              <Fragment key={`${evidence.signal}-${String(index)}`}>
                {evidence.at == null && (
                  <Fact
                    label={evidence.bearing === 'detail' ? 'Where' : 'Observed'}
                    value={evidence.observed}
                    emphasis="strong"
                  />
                )}
                {evidence.expected != null && <Fact label="Expected" value={evidence.expected} emphasis="quiet" />}
              </Fragment>
            ))}
          </FactList>
        </Surface>
      )}

      <FoundOnSection evidence={finding.evidence} {...(resourceHref != null ? { itemHref: resourceHref } : {})} />
      {finding.confidence != null && <FindingConfidence confidence={finding.confidence} />}
      {finding.remedy != null && (printed || finding.outcome !== 'unmeasurable') && (
        <RemedyNote remedy={finding.remedy} controlId={finding.controlId} />
      )}
      <RaisedWork controlId={finding.controlId} {...(printed ? { actions: raised ?? [] } : {})} />
      <NoteThread
        subject={{ kind: 'control', id: finding.controlId }}
        {...(scan?.id != null ? { observedIn: scan.id } : {})}
        label="Notes on this requirement"
        writable={!printed}
        {...(printed ? { notes: notes ?? [] } : {})}
      />

      {(control?.criteria != null || control?.rationale != null) && (
        <Surface tone="inset" title="Requirement intent" headingLevel={3}>
          <FactList>
            {control.criteria != null && <Fact label="How this is judged" value={control.criteria} emphasis="quiet" />}
            {control.rationale != null && <Fact label="Why it matters" value={control.rationale} emphasis="quiet" />}
          </FactList>
        </Surface>
      )}

      {control?.remediation != null && (
        <TechnicalDisclosure label="Implementation detail" hint="Commands, caveats and reference">
          <div className="space-y-3">
            {control.remediation.summary != null && (
              <p className="wa-body-compact text-wa-text-secondary">{control.remediation.summary}</p>
            )}
            {control.remediation.caveat != null && (
              <p className="wa-body-compact text-wa-text-secondary">
                <span className="text-wa-text">Before you apply it: </span>
                {control.remediation.caveat}
              </p>
            )}
            {control.remediation.byHand != null && (
              <p className="wa-body-compact text-wa-text-secondary">
                <span className="text-wa-text">By hand: </span>
                {control.remediation.byHand}
              </p>
            )}
            {control.remediation.sql != null && <Snippet label="SQL" body={control.remediation.sql} />}
            {control.remediation.cli != null && <Snippet label="CLI" body={control.remediation.cli} />}
            {control.remediation.terraform != null && (
              <Snippet label="Terraform" body={control.remediation.terraform} />
            )}
            {control.remediation.docUrl != null && (
              <ExternalDetailLink href={control.remediation.docUrl}>Databricks documentation</ExternalDetailLink>
            )}
          </div>
        </TechnicalDisclosure>
      )}

      <FindingGuidance controlId={finding.controlId} outcome={finding.outcome} />

      {(first != null || coverage != null || control?.sourceRef != null) && (
        <TechnicalDisclosure label="Evidence source" hint="Coverage, collector and source">
          <div className="space-y-2">
            {first != null && (
              <>
                <p className="wa-caption">
                  Collected {new Date(first.collectedAt).toLocaleString()} by{' '}
                  <span className="wa-code">{first.signal}</span>
                </p>
                {read != null && (
                  <p className="wa-caption">
                    {read}
                    {collector != null && <span className="text-wa-text-muted"> · {collector}</span>}
                  </p>
                )}
              </>
            )}
            {coverage != null && <p className="wa-caption">{coverage}</p>}
            {control?.sourceRef != null && (
              <p className="wa-caption">
                Source: <ExternalDetailLink href={control.sourceRef}>{control.sourceRef}</ExternalDetailLink>
              </p>
            )}
          </div>
        </TechnicalDisclosure>
      )}
    </div>
  );
}

function Snippet({ label, body }: { readonly label: string; readonly body: string }) {
  return (
    <div>
      <p className="wa-label">{label}</p>
      <pre className="wa-code-block mt-1 rounded-sm bg-wa-surface-subtle">{body}</pre>
    </div>
  );
}

function ExternalDetailLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      className="wa-aside-link wa-caption text-wa-action underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

/**
 * The other requirements this reading answers, and what that means for the score.
 *
 * Named by title rather than by pillar, because the two situations behind a shared reading look
 * different to a reader and the pillar only distinguishes one of them. Where the guidance repeats
 * itself across pillars the titles match and the pillar is the difference; where two neighbouring
 * requirements share this app's only reading of them, the pillar is the same and the titles are the
 * difference. Naming pillars covered the first case and printed "Operational excellence and
 * Operational excellence" for the second.
 *
 * A link each, because the reader's next act is to go and look — usually to check the other one
 * carries the same verdict, which it does, which is the point.
 */
function AlsoMeasured({
  kin,
  pillarTitle,
  controlHref,
}: {
  readonly kin: readonly AlsoAsking[];
  readonly pillarTitle: (pillarId: string) => string;
  readonly controlHref: (controlId: string) => string;
}) {
  return (
    <Surface
      tone="inset"
      title={kin.length === 1 ? 'This reading also answers' : 'This reading also answers these'}
      headingLevel={3}
    >
      <div className="wa-body-compact text-wa-text-secondary">
        {kin.map((one) => (
          <span key={one.controlId} className="block">
            <Link to={controlHref(one.controlId)} className="text-wa-action hover:underline">
              {one.title}
            </Link>{' '}
            <span className="wa-caption">
              {pillarTitle(one.pillarId)} · {one.controlId}
            </span>
          </span>
        ))}
        <span className="mt-1 block">{measuredTogether(kin.length + 1)}</span>
      </div>
    </Surface>
  );
}

/**
 * The answer behind the outcome, or recorded beside it.
 *
 * Both cases render, and the heading is the difference. A statement recorded against a requirement
 * the app went on to measure itself is worth keeping — it is often the reason somebody looked — but
 * presenting it under the same heading as one that decided the verdict would invite the reader to
 * think the measurement had been overridden. It cannot be; the resolver settles it and this sits
 * beside it.
 */
function Attested({ fact }: { fact: AttestedFact }) {
  const decided = fact.bearing === 'outcome';

  return (
    <Surface tone="raised" title={decided ? 'Answered by a person' : 'Also answered by a person'} headingLevel={3}>
      <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text">
        {fact.statement}
      </blockquote>
      <p className="wa-caption mt-2">
        {attributionPhrase(fact.by, fact.at)}. Accountable: {fact.owner}.{' '}
        {decided ? renewalPhrase(fact.reviewBy, 'current') : 'This did not decide the outcome above.'}
      </p>
      {fact.evidenceUrl != null && (
        <ExternalDetailLink href={fact.evidenceUrl}>Evidence for this answer</ExternalDetailLink>
      )}
    </Surface>
  );
}
