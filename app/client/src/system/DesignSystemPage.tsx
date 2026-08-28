import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleDashed,
  CircleOff,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router';

import { ThemeToggle } from '@/components/ThemeToggle';
import {
  ActionPanel,
  CustomerPage,
  Fact,
  FactList,
  PageLead,
  RecordButton,
  RecordLink,
  RecordList,
  RecordValue,
  Signal,
  StateNotice,
  Surface,
  TaskWorkspace,
  TechnicalDisclosure,
} from '@/components/system';

/**
 * Development-only acceptance surface for the shared customer system.
 *
 * It uses deterministic content and no API, so hierarchy and interaction can be reviewed locally in
 * latest Chrome before a page migration or labs deployment. App.tsx removes the route from production.
 */
export default function DesignSystemPage() {
  return (
    <div className="wa-system-gallery">
      <div className="wa-skip-links">
        <a href="#content">Skip to content</a>
      </div>
      <header className="wa-system-gallery-bar">
        <div className="wa-system-gallery-brand">
          <span className="wa-system-gallery-mark" aria-hidden />
          <span>Customer system gallery</span>
        </div>
        <div className="wa-system-gallery-actions">
          <Link to="/overview" className="wa-customer-secondary-action">
            <ArrowLeft aria-hidden className="h-4 w-4" /> Back to app
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <CustomerPage as="main" id="content" tabIndex={-1} className="wa-system-gallery-stack">
        <PageLead
          eyebrow="Design foundation"
          title="Clear priorities. Exact actions. Defensible evidence."
          summary={
            <p>
              This gallery proves the hierarchy shared by Dashboard, Assess, Investigate, Improve, Operate and executive
              reporting before those pages consume it.
            </p>
          }
          context={
            <>
              <span>Local latest Chrome</span>
              <span>Light and dark parity</span>
              <span>Keyboard complete</span>
              <span>WCAG 2.2 AA</span>
            </>
          }
        />

        <ActionPanel
          title="Move Daily usage ingestion to serverless compute"
          why={
            <p>
              The latest assessment observed three runs on an all-purpose cluster. This job is a repeatable production
              workload and is the highest-priority measured compute opportunity.
            </p>
          }
          action={
            <a href="#gallery-destination" className="wa-customer-primary-action">
              Open job settings <ArrowUpRight aria-hidden className="h-4 w-4" />
            </a>
          }
          destination="Workspace › Workflows › Jobs › Daily usage ingestion"
          owner="Platform engineering · Not assigned"
          verification="The next assessment reads the job compute configuration again"
          details={
            <TechnicalDisclosure label="Evidence and qualification" hint="3 observations · measured 21 Aug">
              <div className="wa-system-gallery-copy">
                <p>
                  Resource: <strong>Daily usage ingestion</strong> · Job
                </p>
                <p>
                  Observed: three completed runs used cluster <code>shared-etl-13</code>. The app has not inferred
                  savings or a platform outcome.
                </p>
              </div>
            </TechnicalDisclosure>
          }
        />

        <Surface
          tone="plain"
          title="Supporting signals"
          description="Settled posture, coverage and directional readings do not compete at the same visual weight."
        >
          <div className="wa-signal-grid">
            <Signal label="Measured requirements" value="171 / 184" detail="93% of the published report" />
            <Signal label="Material gaps" value="12" tone="critical" detail="3 high-priority requirements" />
            <Signal label="Verified improvements" value="8" tone="positive" detail="Since the prior eligible result" />
            <Signal
              label="Directional posture"
              value="72–94"
              tone="directional"
              detail="Close 13 evidence gaps to settle it"
            />
          </div>
        </Surface>

        <Surface
          tone="plain"
          title="Surface roles"
          description="Tone and elevation communicate information rank instead of drawing every region as the same plane."
        >
          <div className="wa-system-gallery-grid">
            <Surface
              tone="task"
              title="Primary task"
              headingLevel={3}
              description="The work a customer came to complete."
            >
              <div className="wa-system-gallery-copy">
                <p>Strong boundary, quiet elevation and enough space for a decision.</p>
                <button type="button" className="wa-customer-primary-action">
                  Continue review
                </button>
              </div>
            </Surface>
            <Surface
              tone="section"
              title="Supporting section"
              headingLevel={3}
              description="Context that helps the task."
            >
              <div className="wa-system-gallery-copy">
                <p>Evidence coverage, affected resources, ownership and material change.</p>
                <button type="button" className="wa-customer-secondary-action">
                  Inspect context
                </button>
              </div>
            </Surface>
            <Surface
              tone="inset"
              title="Technical evidence"
              headingLevel={3}
              description="Tertiary detail and provenance."
            >
              <div className="wa-system-gallery-copy">
                <p>Raw observations, identifiers, denominators and collection metadata remain available.</p>
                <TechnicalDisclosure hint="Collapsed on arrival">
                  <p>Statement, source, timestamp and exact observed payload.</p>
                </TechnicalDisclosure>
              </div>
            </Surface>
          </div>
        </Surface>

        <Surface
          tone="plain"
          title="Selection and record roles"
          description="Queues, selected work and evidence use normal flow instead of fitted viewport planes."
        >
          <TaskWorkspace
            queueLabel="Example priority queue"
            taskLabel="Example selected work"
            queue={
              <Surface
                tone="section"
                title="Priority queue"
                headingLevel={3}
                description="Ranked work only. Clean results do not appear here."
              >
                <RecordList label="Priority actions">
                  <RecordButton
                    selected
                    onSelect={() => undefined}
                    eyebrow="Reliability · High"
                    title="Separate production ingestion from shared compute"
                    summary="Daily usage ingestion"
                    meta="Owner not assigned"
                    aside="Current"
                  />
                  <RecordLink
                    to="#gallery-destination"
                    eyebrow="Cost optimization · Medium"
                    title="Move the nightly refresh to serverless"
                    summary="Finance aggregate refresh"
                    meta="Verification: next assessment"
                    aside="Open"
                  />
                  <RecordValue
                    eyebrow="Verified"
                    title="Cluster policy now requires approved runtimes"
                    summary="Platform baseline"
                    meta="Verified 21 August"
                    aside={<Check aria-label="Verified" className="h-4 w-4 text-wa-success" />}
                  />
                </RecordList>
              </Surface>
            }
            task={
              <Surface
                tone="task"
                title="Separate production ingestion from shared compute"
                headingLevel={3}
                description="The selected work leads with its customer identity and closure condition."
              >
                <FactList label="Selected action facts">
                  <Fact label="Affected resource" value="Daily usage ingestion" detail="Job" emphasis="strong" />
                  <Fact label="Owner" value="Not assigned" detail="Platform engineering" />
                  <Fact label="Verify" value="Next assessment" detail="Compute configuration is read again" />
                  <Fact
                    label="Requirement"
                    value="REL-03-02"
                    detail="Keep technical identity secondary"
                    emphasis="quiet"
                  />
                </FactList>
              </Surface>
            }
          />
        </Surface>

        <Surface
          tone="task"
          title="Interaction and system states"
          description="Every shared control has a visible purpose, focus treatment and non-colour state."
        >
          <div className="wa-system-gallery-state-stack">
            <section aria-labelledby="gallery-control-states">
              <h3 id="gallery-control-states" className="wa-type-title">
                Control states
              </h3>
              <div className="wa-system-gallery-actions">
                <button type="button" className="wa-customer-primary-action">
                  <Check aria-hidden className="h-4 w-4" /> Primary action
                </button>
                <button type="button" className="wa-customer-secondary-action">
                  Default
                </button>
                <button type="button" className="wa-customer-secondary-action wa-is-hovered">
                  Hover
                </button>
                <button type="button" className="wa-customer-secondary-action wa-is-selected" aria-pressed="true">
                  Selected
                </button>
                <button type="button" className="wa-customer-secondary-action wa-show-focus">
                  Keyboard focus
                </button>
                <button type="button" className="wa-customer-secondary-action" disabled>
                  Disabled
                </button>
              </div>
            </section>

            <section aria-labelledby="gallery-data-states">
              <h3 id="gallery-data-states" className="wa-type-title">
                Data states
              </h3>
              <div className="wa-system-state-grid" role="list">
                <div className="wa-system-state wa-system-state-loading" role="listitem">
                  <LoaderCircle aria-hidden />
                  <div>
                    <strong>Loading</strong>
                    <span>Measuring evidence</span>
                  </div>
                </div>
                <div className="wa-system-state wa-system-state-empty" role="listitem">
                  <CircleOff aria-hidden />
                  <div>
                    <strong>Empty</strong>
                    <span>Clean analyzers stay out of the queue</span>
                  </div>
                </div>
                <div className="wa-system-state wa-system-state-partial" role="listitem">
                  <CircleDashed aria-hidden />
                  <div>
                    <strong>Partial</strong>
                    <span>13 requirements need evidence</span>
                  </div>
                </div>
                <div className="wa-system-state wa-system-state-error" role="listitem">
                  <AlertTriangle aria-hidden />
                  <div>
                    <strong>Error</strong>
                    <span>Keep context and offer a safe retry</span>
                  </div>
                </div>
                <div className="wa-system-state wa-system-state-success" role="listitem">
                  <ShieldCheck aria-hidden />
                  <div>
                    <strong>Success</strong>
                    <span>Improvement verified</span>
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="gallery-notice-states">
              <h3 id="gallery-notice-states" className="wa-type-title">
                Task state notices
              </h3>
              <div className="wa-system-gallery-state-stack">
                <StateNotice
                  tone="loading"
                  announce="status"
                  title="Reading the saved assessment"
                  detail="The page keeps its identity while the current record loads."
                />
                <StateNotice
                  tone="partial"
                  announce="status"
                  title="One pillar did not complete"
                  detail="Six pillar records are available. Retry collection before publishing."
                  action={
                    <button type="button" className="wa-customer-secondary-action">
                      Retry collection
                    </button>
                  }
                />
                <StateNotice
                  tone="danger"
                  announce="alert"
                  title="The assessment could not be read"
                  detail="No result is shown from an incomplete read."
                  action={
                    <button type="button" className="wa-customer-secondary-action">
                      Try again
                    </button>
                  }
                />
                <StateNotice
                  tone="success"
                  announce="status"
                  title="Improvement verified"
                  detail="The next eligible assessment observed the expected state."
                />
              </div>
            </section>
          </div>
        </Surface>

        <Surface
          tone="accent"
          title="Depth tokens"
          description="Adjacent dark surfaces are measured, not merely assigned different hex values."
        >
          <div className="wa-system-gallery-grid" id="gallery-destination">
            <div className="wa-system-gallery-token wa-system-gallery-token-canvas">Application canvas</div>
            <div className="wa-system-gallery-token wa-system-gallery-token-task">Primary task</div>
            <div className="wa-system-gallery-token wa-system-gallery-token-section">Supporting section</div>
            <div className="wa-system-gallery-token wa-system-gallery-token-inset">Inset evidence</div>
          </div>
        </Surface>
      </CustomerPage>
    </div>
  );
}
