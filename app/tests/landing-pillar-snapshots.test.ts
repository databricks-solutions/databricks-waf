import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';

const APP = resolve(import.meta.dirname, '..');
const ROOT = resolve(APP, '..');
const DOCS = join(ROOT, 'docs');
const CONTROLS = join(APP, 'config', 'controls');
const PILLAR_FILES = [
  'operational-excellence.yaml',
  'security-compliance-and-privacy.yaml',
  'reliability.yaml',
  'performance-efficiency.yaml',
  'cost-optimization.yaml',
  'data-and-ai-governance.yaml',
  'interoperability-and-usability.yaml',
];
const PREVIEW_DATA =
  'Preview data: All screenshots on this page, including the hero above, contain deterministic, anonymized example data. No customer workspace, user identity, or customer record appears.';

type Control = {
  id: string;
  title: string;
  source_anchor?: string;
  measurability?: string;
  evaluator_status?: string;
};

type Catalogue = {
  pillar: { code: string; title: string };
  principles: Array<{ title: string; controls: Control[] }>;
};

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function route(control: Control) {
  if (control.measurability === 'attestation') return 'Human review';
  if (control.evaluator_status === 'implemented') return 'Automated evidence';
  return 'Planned measurement';
}

function attribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('landing-page pillar snapshots', () => {
  let temporaryDocs: string;
  let homeSource: string;
  let pillarsSource: string;
  let homeHtml: string;
  let pillarsHtml: string;
  let landingLayout: string;
  let css: string;
  let catalogues: Catalogue[];

  beforeAll(() => {
    homeSource = readFileSync(join(DOCS, 'index.md'), 'utf8');
    const pillarsSourcePath = join(DOCS, 'pillars.md');
    pillarsSource = existsSync(pillarsSourcePath) ? readFileSync(pillarsSourcePath, 'utf8') : '';
    landingLayout = readFileSync(join(DOCS, '_layouts', 'landing.html'), 'utf8');
    css = readFileSync(join(DOCS, 'assets', 'css', 'landing.css'), 'utf8');
    catalogues = PILLAR_FILES.map((file) => loadYaml(readFileSync(join(CONTROLS, file), 'utf8')) as Catalogue);

    temporaryDocs = mkdtempSync(join(tmpdir(), 'waf-pillar-snapshots-'));
    cpSync(DOCS, temporaryDocs, { recursive: true });
    const build = spawnSync(
      process.execPath,
      [join(APP, 'scripts', 'build-pages.mjs'), '--docs-dir', temporaryDocs, '--write'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(build.status, build.stderr).toBe(0);
    homeHtml = readFileSync(join(temporaryDocs, 'index.html'), 'utf8');
    const pillarsHtmlPath = join(temporaryDocs, 'pillars', 'index.html');
    pillarsHtml = existsSync(pillarsHtmlPath) ? readFileSync(pillarsHtmlPath, 'utf8') : '';
  });

  afterAll(() => {
    rmSync(temporaryDocs, { recursive: true, force: true });
  });

  it('keeps the homepage compact and links to the dedicated pillars page', () => {
    expect(homeSource).not.toContain(PREVIEW_DATA);
    expect(homeSource).not.toContain('{{ pillar_snapshots }}');
    expect(homeSource).toContain("{{ '/pillars/' | relative_url }}");
    expect(homeSource).toContain('class="pillar-list"');
    expect(homeHtml).not.toContain('<details class="pillar-snapshot"');
    expect(homeHtml).toContain('href="/databricks-waf/pillars/"');
    for (const { pillar } of catalogues) {
      expect(homeSource).toContain(pillar.title);
    }
  });

  it('generates a dedicated landing-layout pillar page from the placeholder', () => {
    expect(pillarsSource).toContain('layout: landing');
    expect(pillarsSource).toContain('permalink: /pillars/');
    expect(pillarsSource).toContain('{{ pillar_snapshots }}');
    expect(pillarsSource).toContain('Explore what each pillar assesses');
    expect(pillarsHtml).toContain('Explore what each pillar assesses');
  });

  it('renders exactly seven native disclosures in established pillar order', () => {
    const details = [...pillarsHtml.matchAll(/<details class="pillar-snapshot"[^>]*>/g)].map(([tag]) => tag);
    expect(details).toHaveLength(7);
    expect(details.map((tag) => attribute(tag, 'data-pillar-code'))).toEqual(
      catalogues.map(({ pillar }) => pillar.code)
    );
    expect(details.map((tag) => attribute(tag, 'name'))).toEqual(Array(7).fill('pillar-snapshot'));
    expect(pillarsHtml.match(/<summary class="pillar-snapshot-summary">/g)).toHaveLength(7);
    expect(pillarsHtml).not.toMatch(/pillar-snapshot[^]*?<script/i);
  });

  it('uses the full landing width and keeps the homepage trust boundary below its compact summary', () => {
    const boundaryRule = cssRule(css, '.landing-boundary');
    const cardRule = cssRule(css, '.boundary-card');

    expect(boundaryRule).toContain('display: block');
    expect(boundaryRule).not.toContain('grid-template-columns');
    expect(cardRule).toMatch(/margin-top:\s*clamp\(/);
  });

  it('renders every catalogue control once under its pillar and no unexpected control', () => {
    const expectedIds = catalogues.flatMap(({ principles }) =>
      principles.flatMap(({ controls }) => controls.map(({ id }) => id))
    );
    const renderedIds = [...pillarsHtml.matchAll(/<li class="pillar-control" data-control-id="([^"]+)"/g)].map(
      ([, id]) => id
    );
    expect(renderedIds).toEqual(expectedIds);

    for (const catalogue of catalogues) {
      const start = pillarsHtml.indexOf(`data-pillar-code="${catalogue.pillar.code}"`);
      const end = pillarsHtml.indexOf('</details>', start);
      const pillarHtml = pillarsHtml.slice(start, end);
      for (const principle of catalogue.principles) {
        if (principle.controls.length > 0) {
          expect(pillarHtml).toContain(escapeHtml(principle.title));
        }
        for (const control of principle.controls) {
          expect(pillarHtml).toContain(`data-control-id="${escapeHtml(control.id)}"`);
          expect(pillarHtml).toContain(escapeHtml(control.title));
        }
      }
    }
  });

  it('publishes catalogue totals and derived route counts and labels', () => {
    const detailTags = [...pillarsHtml.matchAll(/<details class="pillar-snapshot"[^>]*>/g)].map(([tag]) => tag);

    catalogues.forEach((catalogue, index) => {
      const controls = catalogue.principles.flatMap(({ controls }) => controls);
      const counts = {
        'data-total': controls.length,
        'data-automated': controls.filter((control) => route(control) === 'Automated evidence').length,
        'data-human': controls.filter((control) => route(control) === 'Human review').length,
        'data-planned': controls.filter((control) => route(control) === 'Planned measurement').length,
      };
      for (const [name, count] of Object.entries(counts)) {
        expect(Number(attribute(detailTags[index], name))).toBe(count);
      }

      const start = pillarsHtml.indexOf(detailTags[index]);
      const end = pillarsHtml.indexOf('</details>', start);
      const labels = [
        ...pillarsHtml.slice(start, end).matchAll(/<span class="control-route[^"]*">([^<]+)<\/span>/g),
      ].map(([, label]) => label);
      expect(labels).toEqual(controls.map(route));
    });
  });

  it('preserves HTTPS source links and provides responsive, accessible structure without JavaScript', () => {
    const linkedControls = catalogues
      .flatMap(({ principles }) => principles.flatMap(({ controls }) => controls))
      .filter((control) => control.source_anchor?.startsWith('https:'));

    for (const control of linkedControls) {
      expect(pillarsHtml).toContain(`<a href="${escapeHtml(control.source_anchor!)}">${escapeHtml(control.title)}</a>`);
    }
    expect(pillarsHtml).toContain('same versioned control catalogue used by the App');
    expect(css).toMatch(/@media \(max-width: 700px\)[^]*\.pillar-snapshot-summary/s);
  });

  it('adds the Pillars tab and root-qualifies homepage navigation from both landing pages', () => {
    expect(landingLayout).toContain("{{ '/pillars/' | relative_url }}");
    for (const anchor of ['journey', 'review', 'publish', 'investigate', 'improve', 'operate']) {
      expect(landingLayout).toContain(`{{ '/' | relative_url }}#${anchor}`);
      expect(homeHtml).toContain(`href="/databricks-waf/#${anchor}"`);
      expect(pillarsHtml).toContain(`href="/databricks-waf/#${anchor}"`);
    }
  });

  it('renders non-HTTPS source anchors as escaped plain text', async () => {
    const { renderSourceTitle } = await import('../scripts/build-pages.mjs');

    expect(renderSourceTitle('Official <guide>', 'https://docs.databricks.com/guide?a=1&b=2')).toBe(
      '<a href="https://docs.databricks.com/guide?a=1&amp;b=2">Official &lt;guide&gt;</a>'
    );
    expect(renderSourceTitle('Unsafe <title>', 'http://example.com/control')).toBe('Unsafe &lt;title&gt;');
    expect(renderSourceTitle('Unsafe <title>', 'javascript:alert(1)')).toBe('Unsafe &lt;title&gt;');
    expect(renderSourceTitle('Unsafe <title>', 'not a URL')).toBe('Unsafe &lt;title&gt;');
  });
});
