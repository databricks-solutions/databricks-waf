#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { load as loadYaml } from 'js-yaml';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsOption = process.argv.indexOf('--docs-dir');
if (docsOption !== -1 && process.argv[docsOption + 1] == null) {
  throw new Error('--docs-dir requires a path.');
}
const DOCS = docsOption === -1 ? resolve(APP, '..', 'docs') : resolve(process.cwd(), process.argv[docsOption + 1]);
const WRITE = process.argv.includes('--write');
const CONTROLS = join(APP, 'config', 'controls');
const PILLAR_SNAPSHOT_TOKEN = '<!-- generated-pillar-snapshots -->';
const PILLAR_FILES = [
  'operational-excellence.yaml',
  'security-compliance-and-privacy.yaml',
  'reliability.yaml',
  'performance-efficiency.yaml',
  'cost-optimization.yaml',
  'data-and-ai-governance.yaml',
  'interoperability-and-usability.yaml',
];
const PAGES = [
  ['index.md', 'index.html'],
  ['install.md', 'install/index.html'],
  ['configuration.md', 'configuration/index.html'],
  ['user-guide.md', 'user-guide/index.html'],
  ['pages.md', 'pages/index.html'],
  ['operations.md', 'operations/index.html'],
  ['troubleshooting.md', 'troubleshooting/index.html'],
  ['contributing.md', 'contributing/index.html'],
  ['deployment-lifecycle.md', 'deployment-lifecycle/index.html'],
  ['scheduled-scans.md', 'scheduled-scans/index.html'],
  ['404-source.md', '404.html'],
];
const LAYOUTS = new Set(['default', 'landing']);

const config = loadYaml(readFileSync(join(DOCS, '_config.yml'), 'utf8'));
const base = config.baseurl ?? '';
const failures = [];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function controlRoute(control) {
  if (control.measurability === 'attestation') {
    return { label: 'Human review', className: 'human' };
  }
  if (control.evaluator_status === 'implemented') {
    return { label: 'Automated evidence', className: 'automated' };
  }
  return { label: 'Planned measurement', className: 'planned' };
}

function renderPillarSnapshots() {
  const catalogues = PILLAR_FILES.map((file) => loadYaml(readFileSync(join(CONTROLS, file), 'utf8')));

  const details = catalogues
    .map(({ pillar, principles }) => {
      const controls = principles.flatMap((principle) => principle.controls);
      const counts = controls.reduce(
        (result, control) => {
          result[controlRoute(control).className] += 1;
          return result;
        },
        { automated: 0, human: 0, planned: 0 }
      );
      const countLabels = [
        `<span class="pillar-total">${controls.length} requirements</span>`,
        counts.automated > 0
          ? `<span class="pillar-route-count automated">${counts.automated} automated evidence</span>`
          : '',
        counts.human > 0 ? `<span class="pillar-route-count human">${counts.human} human review</span>` : '',
        counts.planned > 0
          ? `<span class="pillar-route-count planned">${counts.planned} planned measurement</span>`
          : '',
      ]
        .filter(Boolean)
        .join('\n        ');
      const principleMarkup = principles
        .filter(({ controls: principleControls }) => principleControls.length > 0)
        .map(({ title, controls: principleControls }) => {
          const controlMarkup = principleControls
            .map((control) => {
              const route = controlRoute(control);
              const title = escapeHtml(control.title);
              const linkedTitle =
                control.source_anchor == null ? title : `<a href="${escapeHtml(control.source_anchor)}">${title}</a>`;
              return `          <li class="pillar-control" data-control-id="${escapeHtml(control.id)}">
            <span class="control-id">${escapeHtml(control.id)}</span>
            <span class="control-title">${linkedTitle}</span>
            <span class="control-route ${route.className}">${route.label}</span>
          </li>`;
            })
            .join('\n');
          return `      <section class="pillar-principle">
        <h3>${escapeHtml(title)}</h3>
        <ul class="pillar-controls">
${controlMarkup}
        </ul>
      </section>`;
        })
        .join('\n');

      return `  <details class="pillar-snapshot" data-pillar-code="${escapeHtml(pillar.code)}" data-total="${controls.length}" data-automated="${counts.automated}" data-human="${counts.human}" data-planned="${counts.planned}">
    <summary class="pillar-snapshot-summary">
      <span class="pillar-identity">
        <span class="pillar-code">${escapeHtml(pillar.code)}</span>
        <span class="pillar-title">${escapeHtml(pillar.title)}</span>
      </span>
      <span class="pillar-counts">
        ${countLabels}
      </span>
    </summary>
    <div class="pillar-snapshot-body">
${principleMarkup}
    </div>
  </details>`;
    })
    .join('\n');

  return `<div class="pillar-snapshots">
${details}
</div>`;
}

function frontMatter(document, source) {
  const match = document.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match == null) throw new Error(`${source} has no YAML front matter.`);
  return { attributes: loadYaml(match[1]) ?? {}, body: document.slice(match[0].length) };
}

function relativeUrls(value) {
  return value.replace(/\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}/g, (_whole, path) => `${base}${path}`);
}

function imageClasses(value) {
  return value.replace(
    /^!\[([^\]]*)\]\(([^)]+)\)\{:[ \t]*\.([A-Za-z0-9_-]+)[ \t]*\}[ \t]*$/gm,
    (_whole, alt, src, className) =>
      `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="${escapeHtml(className)}">`
  );
}

function slug(value) {
  return String(value)
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function renderMarkdown(value) {
  const seen = new Map();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        const content = this.parser.parseInline(tokens);
        const stem = slug(text) || 'section';
        const count = seen.get(stem) ?? 0;
        seen.set(stem, count + 1);
        const id = count === 0 ? stem : `${stem}-${count + 1}`;
        return `<h${depth} id="${id}">${content}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        let target = href;
        const local = href.match(/^([^/#]+)\.md(#[^\s]*)?$/);
        if (local != null) target = `${base}/${local[1]}/${local[2] ?? ''}`;
        const titleAttribute = title == null ? '' : ` title="${escapeHtml(title)}"`;
        return `<a href="${escapeHtml(target)}"${titleAttribute}>${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });
  return marked.parse(imageClasses(relativeUrls(value)));
}

function renderLayout(attributes, content, source) {
  const layoutName = attributes.layout ?? 'default';
  if (!LAYOUTS.has(layoutName)) {
    throw new Error(`${source} requests unsupported layout "${layoutName}". Expected default or landing.`);
  }
  const layout = readFileSync(join(DOCS, '_layouts', `${layoutName}.html`), 'utf8');
  const pageTitle = attributes.title == null ? '' : `${escapeHtml(attributes.title)} · `;
  const description = escapeHtml(attributes.description ?? config.description ?? '');
  const eyebrow = attributes.eyebrow == null ? '' : `<p class="eyebrow">${escapeHtml(attributes.eyebrow)}</p>`;
  const rendered = relativeUrls(layout)
    .replace(/\{%\s*if page\.title\s*%\}\s*\{\{\s*page\.title\s*\}\}\s*·\s*\{%\s*endif\s*%\}/g, pageTitle)
    .replace('{{ site.title }}', escapeHtml(config.title))
    .replace('{{ page.description | default: site.description | escape }}', description)
    .replace(
      /\{%\s*if page\.eyebrow\s*%\}\s*<p class="eyebrow">\{\{\s*page\.eyebrow\s*\}\}<\/p>\s*\{%\s*endif\s*%\}/g,
      eyebrow
    )
    .replace('{{ content }}', content);
  if (rendered.includes('{{') || rendered.includes('{%')) {
    throw new Error(`${source} left an unresolved Liquid expression in its generated page.`);
  }
  return rendered
    .replace('<html lang="en">', `<!-- Generated by app/scripts/build-pages.mjs from ${source}. -->\n<html lang="en">`)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '\n');
}

for (const [sourceName, targetName] of PAGES) {
  const source = readFileSync(join(DOCS, sourceName), 'utf8');
  const { attributes, body } = frontMatter(source, sourceName);
  const hasPillarSnapshots = body.includes('{{ pillar_snapshots }}');
  const pageBody = hasPillarSnapshots ? body.replaceAll('{{ pillar_snapshots }}', PILLAR_SNAPSHOT_TOKEN) : body;
  const renderedBody = renderMarkdown(pageBody);
  const content = hasPillarSnapshots
    ? renderedBody.replaceAll(PILLAR_SNAPSHOT_TOKEN, renderPillarSnapshots())
    : renderedBody;
  const expected = renderLayout(attributes, content, sourceName);
  const target = join(DOCS, targetName);
  if (WRITE) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, expected);
  } else if (!existsSync(target) || readFileSync(target, 'utf8') !== expected) {
    failures.push(targetName);
  }
}

if (!existsSync(join(DOCS, '.nojekyll'))) failures.push('.nojekyll');

if (failures.length > 0) {
  console.error(`The branch-published Pages site is stale: ${failures.join(', ')}. Run npm run docs:build.`);
  process.exit(1);
}

console.log(`${PAGES.length} pre-rendered Pages documents match their Markdown sources.`);
