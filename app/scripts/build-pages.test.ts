import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const app = resolve(import.meta.dirname, '..');
const docs = resolve(app, '..', 'docs');
const landingScreenshots = [
  'dashboard.jpg',
  'assessment-review.jpg',
  'published-report.jpg',
  'investigation-workbench.jpg',
  'improvement-plan.jpg',
  'operate.jpg',
] as const;

function generated(path: string): string {
  return readFileSync(resolve(docs, path), 'utf8');
}

function imageTags(page: string): string[] {
  return [...page.matchAll(/<img\b[^>]*>/g)].map(([tag]) => tag);
}

describe('static Pages layouts', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-pages.mjs', '--write'], {
      cwd: app,
      stdio: 'pipe',
    });
  });

  it('renders the landing homepage and keeps guide pages on the guide layout', () => {
    const homepage = generated('index.html');
    const guide = generated('user-guide/index.html');

    expect(homepage).toContain('href="/databricks-waf/assets/css/landing.css"');
    expect(homepage).toContain('href="#landing-content"');
    expect(homepage).toContain('<main id="landing-content"');
    expect(homepage).not.toContain('class="sidebar"');

    expect(guide).toContain('href="/databricks-waf/assets/css/guide.css"');
    expect(guide).toContain('class="sidebar"');
    expect(guide).not.toContain('landing.css');
  });

  it('keeps the generated landing anchors and primary calls to action', () => {
    const homepage = generated('index.html');

    for (const id of ['review', 'publish', 'investigate', 'improve', 'operate']) {
      expect(homepage).toContain(`id="${id}"`);
    }
    expect(homepage).toContain('href="https://github.com/databricks-solutions/databricks-waf">View on GitHub</a>');
    expect(homepage).toContain('href="/databricks-waf/install/">Read the installation guide</a>');
  });

  it('keeps generated landing screenshots accessible and within the allowlist', () => {
    const homepage = generated('index.html');
    const screenshots = imageTags(homepage);
    const names = screenshots.map((tag) => basename(tag.match(/\bsrc="([^"]+)"/)?.[1] ?? ''));

    expect(names).toEqual([...landingScreenshots]);
    for (const [index, tag] of screenshots.entries()) {
      expect(tag).toMatch(/\balt="[^"]*\S[^"]*"/);
      if (index === 0) expect(tag).not.toContain('loading="lazy"');
      else expect(tag).toContain('loading="lazy"');
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

    expect(guide).toMatch(/<p class="eyebrow">Use the app<\/p>\s*\n\s*<h1\b/);
  });

  it('rejects unsupported front-matter layouts with a clear error', () => {
    const sourcePath = resolve(docs, 'index.md');
    const original = readFileSync(sourcePath, 'utf8');
    const unsupported = original.replace('layout: landing', 'layout: unsupported');
    expect(unsupported).not.toBe(original);

    try {
      writeFileSync(sourcePath, unsupported);
      expect(() =>
        execFileSync(process.execPath, ['scripts/build-pages.mjs'], {
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
