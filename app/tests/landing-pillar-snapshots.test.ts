import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('landing-page pillar snapshots', () => {
  let temporaryDocs: string;
  let source: string;
  let html: string;
  let css: string;
  let catalogues: Catalogue[];

  beforeAll(() => {
    source = readFileSync(join(DOCS, 'index.md'), 'utf8');
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
    html = readFileSync(join(temporaryDocs, 'index.html'), 'utf8');
  });

  afterAll(() => {
    rmSync(temporaryDocs, { recursive: true, force: true });
  });

  it('removes the preview-data paragraph and keeps a generated placeholder', () => {
    expect(source).not.toContain(PREVIEW_DATA);
    expect(source).toContain('{{ pillar_snapshots }}');
  });

  it('renders exactly seven native disclosures in established pillar order', () => {
    const details = [...html.matchAll(/<details class="pillar-snapshot"[^>]*>/g)].map(([tag]) => tag);
    expect(details).toHaveLength(7);
    expect(details.map((tag) => attribute(tag, 'data-pillar-code'))).toEqual(
      catalogues.map(({ pillar }) => pillar.code)
    );
    expect(html.match(/<summary class="pillar-snapshot-summary">/g)).toHaveLength(7);
    expect(html).not.toMatch(/pillar-snapshot[^]*?<script/i);
  });

  it('renders every catalogue control once under its pillar and no unexpected control', () => {
    const expectedIds = catalogues.flatMap(({ principles }) =>
      principles.flatMap(({ controls }) => controls.map(({ id }) => id))
    );
    const renderedIds = [...html.matchAll(/<li class="pillar-control" data-control-id="([^"]+)"/g)].map(([, id]) => id);
    expect(renderedIds).toEqual(expectedIds);

    for (const catalogue of catalogues) {
      const start = html.indexOf(`data-pillar-code="${catalogue.pillar.code}"`);
      const end = html.indexOf('</details>', start);
      const pillarHtml = html.slice(start, end);
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
    const detailTags = [...html.matchAll(/<details class="pillar-snapshot"[^>]*>/g)].map(([tag]) => tag);

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

      const start = html.indexOf(detailTags[index]);
      const end = html.indexOf('</details>', start);
      const labels = [...html.slice(start, end).matchAll(/<span class="control-route[^"]*">([^<]+)<\/span>/g)].map(
        ([, label]) => label
      );
      expect(labels).toEqual(controls.map(route));
    });
  });

  it('preserves source links and provides responsive, accessible structure without JavaScript', () => {
    const linkedControls = catalogues
      .flatMap(({ principles }) => principles.flatMap(({ controls }) => controls))
      .filter((control) => control.source_anchor != null);

    for (const control of linkedControls) {
      expect(html).toContain(`<a href="${escapeHtml(control.source_anchor!)}">${escapeHtml(control.title)}</a>`);
    }
    expect(html).toContain('same versioned control catalogue used by the App');
    expect(css).toMatch(/@media \(max-width: 700px\)[^]*\.pillar-snapshot-summary/s);
  });
});
