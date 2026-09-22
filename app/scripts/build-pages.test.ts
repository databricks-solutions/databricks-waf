import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const app = resolve(import.meta.dirname, '..');
const committedDocs = resolve(app, '..', 'docs');
let docs: string;
const landingScreenshots = [
  'dashboard.jpg',
  'assessment-review.jpg',
  'published-report.jpg',
  'investigation-workbench.jpg',
  'improvement-plan.jpg',
  'operate.jpg',
] as const;
const screenshotDimensions = new Map([
  ['dashboard.jpg', ['1270', '714']],
  ['assessment-review.jpg', ['1280', '720']],
  ['published-report.jpg', ['1270', '714']],
  ['investigation-workbench.jpg', ['1280', '720']],
  ['improvement-plan.jpg', ['1280', '720']],
  ['operate.jpg', ['1280', '720']],
]);

function generated(path: string): string {
  return readFileSync(resolve(docs, path), 'utf8');
}

function imageTags(page: string): string[] {
  return [...page.matchAll(/<img\b[^>]*>/g)].map(([tag]) => tag);
}

describe('static Pages layouts', () => {
  beforeAll(() => {
    docs = mkdtempSync(join(tmpdir(), 'waf-generated-docs-'));
    cpSync(committedDocs, docs, { recursive: true });
    rmSync(resolve(docs, 'index.html'));
    rmSync(resolve(docs, 'user-guide/index.html'));
    execFileSync(process.execPath, ['scripts/build-pages.mjs', '--docs-dir', docs, '--write'], {
      cwd: app,
      stdio: 'pipe',
    });
  });

  afterAll(() => {
    rmSync(docs, { recursive: true, force: true });
  });

  it('renders the landing homepage and keeps guide pages on the guide layout', () => {
    const homepage = generated('index.html');
    const guide = generated('user-guide/index.html');

    expect(homepage).toContain('href="/databricks-waf/assets/css/landing.css"');
    expect(homepage).toContain('href="#landing-content"');
    expect(homepage).toContain('<main id="landing-content" class="landing-main" tabindex="-1"');
    expect(homepage).not.toContain('class="sidebar"');

    expect(guide).toContain('href="/databricks-waf/assets/css/guide.css"');
    expect(guide).toContain('class="sidebar"');
    expect(guide).not.toContain('landing.css');
  });

  it('renders the local decorative Databricks logo only in the landing brand', () => {
    const homepage = generated('index.html');
    const guide = generated('user-guide/index.html');

    expect(generated('assets/databricks-logo.svg')).toContain('<svg');
    expect(homepage).toMatch(
      /<img\s+class="landing-brand-logo"\s+src="\/databricks-waf\/assets\/databricks-logo\.svg"/
    );
    expect(homepage).toContain('alt=""');
    expect(homepage).toContain('aria-hidden="true"');
    expect(homepage).not.toContain('class="landing-brand-mark"');
    expect(guide).toContain('class="brand-mark"');
    expect(guide).not.toContain('databricks-logo.svg');
  });

  it('keeps the generated landing anchors and primary calls to action', () => {
    const homepage = generated('index.html');

    for (const id of ['journey', 'review', 'publish', 'investigate', 'improve', 'operate']) {
      expect(homepage).toContain(`id="${id}"`);
    }
    expect(homepage).toContain('href="#journey">Journey</a>');
    expect(homepage).toContain('href="https://github.com/databricks-solutions/databricks-waf">View on GitHub</a>');
    expect(homepage).toContain('href="/databricks-waf/install/">Read the installation guide</a>');
    expect(homepage).toContain('href="/databricks-waf/user-guide/">Read the full customer journey guide</a>');
  });

  it('keeps generated landing screenshots accessible and within the allowlist', () => {
    const homepage = generated('index.html');
    const screenshots = imageTags(homepage).filter((tag) => tag.includes('/assets/images/'));
    const names = screenshots.map((tag) => basename(tag.match(/\bsrc="([^"]+)"/)?.[1] ?? ''));

    expect(names).toEqual([...landingScreenshots]);
    for (const [index, tag] of screenshots.entries()) {
      const dimensions = screenshotDimensions.get(names[index]);
      expect(dimensions, `${names[index]} must have known intrinsic dimensions`).toBeDefined();
      expect(tag).toMatch(/\balt="[^"]*\S[^"]*"/);
      expect(tag).toContain(`width="${dimensions?.[0]}"`);
      expect(tag).toContain(`height="${dimensions?.[1]}"`);
      if (index === 0) expect(tag).not.toContain('loading="lazy"');
      else expect(tag).toContain('loading="lazy"');
    }
  });

  it('renders a valid base-path favicon link on landing and guide pages', () => {
    const favicon = generated('assets/favicon.svg');

    expect(favicon).toContain('<svg');
    for (const page of [generated('index.html'), generated('user-guide/index.html')]) {
      expect(page).toContain('rel="icon"');
      expect(page).toContain('href="/databricks-waf/assets/favicon.svg"');
    }
  });

  it('keeps the generated example-data disclosure inclusive of the hero', () => {
    const homepage = generated('index.html');

    expect(homepage).toMatch(
      /all screenshots[\s\S]*including the hero[\s\S]*deterministic, anonymized example data[\s\S]*no customer workspace, user identity, or customer record appears/i
    );
  });

  it('puts the generated guide eyebrow and H1 on separate lines', () => {
    const guide = generated('user-guide/index.html');

    expect(guide).toMatch(
      /<p class="eyebrow">Use the app<\/p>\n\s*<!-- Page content starts on the next line\. -->\n\s*<h1\b/
    );
  });

  it('checks an explicit copied docs tree without touching committed output', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'waf-docs-'));
    const committedHomepage = readFileSync(resolve(committedDocs, 'index.html'), 'utf8');

    try {
      cpSync(docs, fixture, { recursive: true });
      writeFileSync(resolve(fixture, 'index.html'), '<p>stale fixture</p>\n');

      expect(() =>
        execFileSync(process.execPath, ['scripts/build-pages.mjs', '--docs-dir', fixture], {
          cwd: app,
          encoding: 'utf8',
          stdio: 'pipe',
        })
      ).toThrow(/stale: index\.html/);
      expect(readFileSync(resolve(committedDocs, 'index.html'), 'utf8')).toBe(committedHomepage);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects unsupported front-matter layouts with a clear error', () => {
    const sourcePath = resolve(docs, 'index.md');
    const original = readFileSync(sourcePath, 'utf8');
    const unsupported = original.replace('layout: landing', 'layout: unsupported');
    expect(unsupported).not.toBe(original);

    try {
      writeFileSync(sourcePath, unsupported);
      expect(() =>
        execFileSync(process.execPath, ['scripts/build-pages.mjs', '--docs-dir', docs], {
          cwd: app,
          encoding: 'utf8',
          stdio: 'pipe',
        })
      ).toThrow(/index\.md requests unsupported layout "unsupported"\. Expected default or landing\./);
    } finally {
      writeFileSync(sourcePath, original);
    }
  });
});
