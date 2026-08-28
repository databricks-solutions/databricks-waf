import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { applyTheme, storePreference } from '@/lib/theme';
import {
  CUSTOMER_ACCEPTANCE_CASES,
  CUSTOMER_ACCEPTANCE_RENDER_COUNT,
  CUSTOMER_ACCEPTANCE_THEMES,
  CUSTOMER_ACCEPTANCE_WIDTHS,
  acceptanceRenderId,
  type CustomerAcceptanceCase,
  type CustomerAcceptanceTheme,
} from './customer-acceptance';
import '../styles/customer-acceptance.css';

interface AcceptanceRender {
  readonly one: CustomerAcceptanceCase;
  readonly viewport: (typeof CUSTOMER_ACCEPTANCE_WIDTHS)[number];
  readonly theme: CustomerAcceptanceTheme;
}

interface AcceptanceReading {
  readonly id: string;
  readonly problems: readonly string[];
}

const SHELL_HEADING: Readonly<Record<string, string>> = {
  dashboard: 'Dashboard',
  assess: 'Review',
  investigate: 'Investigation workbench',
  improvement: 'Improvements',
  operate: 'Next actions',
  report: 'Report',
};

const SHELL_TASK: Readonly<Record<string, string>> = {
  dashboard: 'Dashboard',
  assess: 'Assess',
  investigate: 'Investigate',
  improvement: 'Improve',
  operate: 'Operate',
  report: 'Investigate',
};

const RENDERS: readonly AcceptanceRender[] = CUSTOMER_ACCEPTANCE_CASES.flatMap((one) =>
  CUSTOMER_ACCEPTANCE_WIDTHS.flatMap((viewport) =>
    CUSTOMER_ACCEPTANCE_THEMES.map((theme) => ({ one, viewport, theme }))
  )
);

/** Development-only latest-Chrome acceptance runner for the exact customer compositions. */
export default function CustomerAcceptancePage() {
  const [params, setParams] = useSearchParams();
  const all = params.get('run') === 'all';
  const selected = selectRender(params);
  const [index, setIndex] = useState(0);
  const [readings, setReadings] = useState<readonly AcceptanceReading[]>([]);
  const completed = useRef(new Set<string>());
  const current = all ? RENDERS[index] : selected;
  const currentId = current == null ? 'complete' : acceptanceRenderId(current.one, current.viewport, current.theme);

  useEffect(() => {
    if (current == null) return;
    storePreference(current.theme);
    applyTheme(document.documentElement, current.theme);
  }, [current]);

  const failures = useMemo(() => readings.filter((reading) => reading.problems.length > 0), [readings]);
  const finished = all && readings.length === CUSTOMER_ACCEPTANCE_RENDER_COUNT;

  const accept = (reading: AcceptanceReading) => {
    if (completed.current.has(reading.id)) return;
    completed.current.add(reading.id);
    if (!all) {
      setReadings([reading]);
      return;
    }
    setReadings((seen) => {
      if (seen.some((one) => one.id === reading.id)) return seen;
      return [...seen, reading];
    });
    setIndex((seen) => Math.min(seen + 1, RENDERS.length - 1));
  };

  const toggleRun = () => {
    if (all) {
      setParams({});
      return;
    }
    completed.current.clear();
    setIndex(0);
    setReadings([]);
    setParams({ run: 'all' });
  };

  return (
    <main className="wa-acceptance" aria-labelledby="acceptance-title">
      <header className="wa-acceptance-header">
        <div>
          <p>Development-only customer-system gate</p>
          <h1 id="acceptance-title">Local Chrome acceptance</h1>
          <span>
            {all
              ? `${String(readings.length)} of ${String(CUSTOMER_ACCEPTANCE_RENDER_COUNT)} renders checked`
              : currentId}
          </span>
        </div>
        <div className="wa-acceptance-actions">
          <button type="button" onClick={toggleRun}>
            {all ? 'Inspect one render' : `Run all ${String(CUSTOMER_ACCEPTANCE_RENDER_COUNT)} renders`}
          </button>
        </div>
      </header>

      {finished ? (
        <section className="wa-acceptance-result" data-result={failures.length === 0 ? 'pass' : 'fail'}>
          <h2>
            {failures.length === 0
              ? `All ${String(CUSTOMER_ACCEPTANCE_RENDER_COUNT)} acceptance renders passed`
              : `${String(failures.length)} renders failed`}
          </h2>
          <p>
            Checked horizontal overflow, clipped primary action or page identity, breadcrumb and control separation,
            shell and heading ownership, deterministic preview isolation, empty-state continuation, customer-visible
            internal labels and identifier-first headings at every declared width in both themes.
          </p>
          {failures.length > 0 && (
            <ol>
              {failures.map((reading) => (
                <li key={reading.id}>
                  <strong>{reading.id}</strong>: {reading.problems.join('; ')}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : current == null ? null : (
        <AcceptanceFrame key={currentId} render={current} onRead={accept} />
      )}
    </main>
  );
}

function AcceptanceFrame({
  render,
  onRead,
}: {
  readonly render: AcceptanceRender;
  readonly onRead: (reading: AcceptanceReading) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const id = acceptanceRenderId(render.one, render.viewport, render.theme);
  const scale = Math.min(1, 660 / render.viewport.width);

  const inspect = () => {
    const themeControl = frame.current?.contentDocument?.querySelector<HTMLButtonElement>(
      `[role="radio"][aria-label="${render.theme === 'dark' ? 'Dark' : 'Light'}"]`
    );
    themeControl?.click();
    window.setTimeout(() => {
      const browser = frame.current?.contentWindow;
      const document = frame.current?.contentDocument;
      if (browser == null || document == null) {
        onRead({ id, problems: ['preview frame did not load'] });
        return;
      }
      const root = document.documentElement;
      const primary = [...document.querySelectorAll<HTMLElement>('.wa-customer-primary-action')];
      const headings = [...document.querySelectorAll<HTMLElement>('main h1, main h2, main h3, main h4')];
      const primaryHeadings = headings.filter((heading) => /^H[12]$/.test(heading.tagName));
      const emptyStates = [...document.querySelectorAll<HTMLElement>('[data-empty-reason]')];
      const recommendations = [...document.querySelectorAll<HTMLElement>('[data-customer-action="recommendation"]')];
      const visibleText = document.body.innerText;
      const shellHeadingNode = document.querySelector<HTMLElement>('.wa-page-header h1');
      const shellHeading = shellHeadingNode?.innerText.trim();
      const currentTask = document
        .querySelector<HTMLElement>('.wa-summary-link[aria-current], .wa-task-link[aria-current]')
        ?.innerText.trim();
      const problems: string[] = [];
      if (root.scrollWidth > browser.innerWidth + 1)
        problems.push(`horizontal overflow ${String(root.scrollWidth - browser.innerWidth)}px`);
      if (
        primary.some((action) => {
          const box = action.getBoundingClientRect();
          return box.left < -1 || box.right > browser.innerWidth + 1;
        })
      ) {
        problems.push('primary action is clipped horizontally');
      }
      if (primaryHeadings.length === 0 && shellHeading == null)
        problems.push('customer composition has no primary heading');
      if (shellHeading !== SHELL_HEADING[render.one.surface]) {
        problems.push(
          `shell heading is ${JSON.stringify(shellHeading)} rather than ${JSON.stringify(SHELL_HEADING[render.one.surface])}`
        );
      }
      if (shellHeadingNode != null && shellHeadingNode.scrollWidth > shellHeadingNode.clientWidth + 1) {
        problems.push('shell heading is clipped');
      }
      const breadcrumb = document.querySelector<HTMLElement>('.wa-page-header nav[aria-label="Breadcrumb"]');
      const runControls = document.querySelector<HTMLElement>('#run-controls');
      if (breadcrumb != null && runControls != null) {
        const one = breadcrumb.getBoundingClientRect();
        const other = runControls.getBoundingClientRect();
        if (one.left < other.right && one.right > other.left && one.top < other.bottom && one.bottom > other.top) {
          problems.push('breadcrumb overlaps header controls');
        }
      }
      if (currentTask !== SHELL_TASK[render.one.surface]) {
        problems.push(
          `selected task is ${JSON.stringify(currentTask)} rather than ${JSON.stringify(SHELL_TASK[render.one.surface])}`
        );
      }
      const shellText = document.querySelector<HTMLElement>('.wa-page-header')?.innerText ?? '';
      if (!/Preview data/.test(shellText) || /\b(?:Scanning|Run a scan|Run complete)\b/.test(shellText)) {
        problems.push('deterministic preview is showing live run state');
      }
      const bodyHeadingText = headings.map((heading) => heading.innerText.trim()).filter((text) => text !== '');
      if (render.one.surface === 'improvement' && new Set(bodyHeadingText).size !== bodyHeadingText.length) {
        problems.push('the selected improvement outcome is repeated as a body heading');
      }
      if (
        render.one.state === 'empty' &&
        ['investigate', 'improvement'].includes(render.one.surface) &&
        document.querySelector('[data-empty-reason] a, [data-empty-reason] button') == null
      ) {
        problems.push('clean action workspace has no continuation');
      }
      if (emptyStates.length > 1) problems.push('customer composition renders more than one empty state');
      if (
        recommendations.some(
          (recommendation) =>
            !/\bDo this\b/i.test(recommendation.innerText) ||
            !/\bWhy\b/i.test(recommendation.innerText) ||
            recommendation.querySelector('a[href], button') == null
        )
      ) {
        problems.push('recommendation does not expose Do this, Why and an exact handoff');
      }
      if (/\b(?:pull request|PR #\d+|126[a-g]|preview-)\b/i.test(visibleText))
        problems.push('internal delivery label is visible');
      if (headings.some((heading) => /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-/i.test(heading.innerText))) {
        problems.push('a UUID is used as a heading');
      }
      onRead({ id, problems });
    }, 350);
  };

  return (
    <section className="wa-acceptance-current" aria-label="Current acceptance render">
      <div className="wa-acceptance-meta">
        <strong>
          {render.one.surface} · {render.one.state}
        </strong>
        <span>
          {render.viewport.width}×{render.viewport.height} · {render.theme}
        </span>
      </div>
      <div
        className="wa-acceptance-stage"
        style={{ width: render.viewport.width * scale, height: render.viewport.height * scale }}
      >
        <iframe
          ref={frame}
          title={id}
          src={render.one.path}
          width={render.viewport.width}
          height={render.viewport.height}
          style={{ transform: `scale(${String(scale)})` }}
          onLoad={inspect}
        />
      </div>
    </section>
  );
}

function selectRender(params: URLSearchParams): AcceptanceRender {
  const fallback = CUSTOMER_ACCEPTANCE_CASES[0];
  if (fallback == null) throw new Error('The customer acceptance matrix has no cases.');
  const one = CUSTOMER_ACCEPTANCE_CASES.find((candidate) => candidate.id === params.get('case')) ?? fallback;
  const viewport =
    CUSTOMER_ACCEPTANCE_WIDTHS.find((candidate) => candidate.name === params.get('width')) ??
    CUSTOMER_ACCEPTANCE_WIDTHS[0];
  const requestedTheme = params.get('theme');
  const theme = CUSTOMER_ACCEPTANCE_THEMES.find((candidate) => candidate === requestedTheme) ?? 'light';
  return { one, viewport, theme };
}
