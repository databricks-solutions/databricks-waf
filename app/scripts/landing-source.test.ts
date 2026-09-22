import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const docs = resolve(import.meta.dirname, '../../docs');
const landingScreenshots = [
  'dashboard.jpg',
  'assessment-review.jpg',
  'published-report.jpg',
  'investigation-workbench.jpg',
  'improvement-plan.jpg',
  'operate.jpg',
] as const;
const repositoryImages = [...landingScreenshots, 'readme-evidence-to-action.jpg', 'readme-seven-pillars.jpg'].sort();

function source(path: string): string {
  const file = resolve(docs, path);
  expect(existsSync(file), `${path} must exist`).toBe(true);
  return readFileSync(file, 'utf8');
}

function imageTags(page: string): string[] {
  return [...page.matchAll(/<img\b[^>]*>/g)].map(([tag]) => tag);
}

describe('landing page source contract', () => {
  it('provides a dedicated no-sidebar layout with landing navigation', () => {
    const layout = source('_layouts/landing.html');

    expect(layout).toContain("{{ '/assets/css/landing.css' | relative_url }}");
    expect(layout).toContain('href="#landing-content"');
    expect(layout).toContain('<main id="landing-content"');
    expect(layout).toContain('{{ page.title }}');
    expect(layout).toContain('{{ page.description');
    expect(layout).toContain('{{ content }}');
    expect(layout).not.toContain('class="sidebar"');

    for (const target of ['#review', '#publish', '#investigate', '#improve', '#operate']) {
      expect(layout).toContain(`href="${target}"`);
    }
    expect(layout).toContain("{{ '/install/' | relative_url }}");
    expect(layout).toContain('https://github.com/databricks-solutions/databricks-waf');
  });

  it('defines responsive, keyboard-visible and reduced-motion landing styles', () => {
    const css = source('assets/css/landing.css');

    expect(css).toMatch(/position:\s*sticky/);
    expect(css).toContain(':focus-visible');
    expect(css).toContain('scroll-margin-top');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css.match(/@media \(max-width:/g)).toHaveLength(2);

    // CSS Overflow-3 treats a mixed visible/non-visible pair as clipping both axes, which crops focus rings.
    expect(css).not.toMatch(/\.landing-main\s*\{[^}]*\boverflow(?:-x|-y)?\s*:/);
  });

  it('tells the verified product story with accessible deterministic screenshots', () => {
    const page = source('index.md');

    expect(page).toMatch(/^---\n[\s\S]*\nlayout: landing\n[\s\S]*\n---/);
    expect(page).toContain('Evidence-backed posture');
    expect(page).toContain('Honest coverage');
    expect(page).toContain('Resource-level investigation');
    expect(page).toContain('Later-run verification');
    expect(page).toContain('system tables and APIs');
    expect(page).toContain('customer-owned Lakebase');
    expect(page).toContain('all seven pillars');
    expect(page).toContain('not a Databricks certification');
    expect(page).toContain('Alpha');
    expect(page).toContain('current desktop and laptop Chrome');

    for (const id of ['review', 'publish', 'investigate', 'improve', 'operate']) {
      expect(page).toContain(`id="${id}"`);
    }

    const images = landingScreenshots.map((name, index) => [name, index !== 0] as const);
    const referencedScreenshots = imageTags(page).map((tag) => tag.match(/\/assets\/images\/([^'"]+)/)?.[1] ?? '');
    expect(referencedScreenshots).toEqual([...landingScreenshots]);

    for (const [name, lazy] of images) {
      const image = page.match(new RegExp(`<img[^>]+${name.replace('.', '\\.')}[^>]*>`))?.[0] ?? '';
      expect(image, `${name} must use a raw HTML img element`).not.toBe('');
      expect(image).toMatch(/\balt="[^"]*\S[^"]*"/);
      expect(image).toMatch(/\bwidth="\d+"/);
      expect(image).toMatch(/\bheight="\d+"/);
      if (lazy) expect(image).toContain('loading="lazy"');
      else expect(image).not.toContain('loading="lazy"');
    }
    expect(page.match(/<figure\b/g)).toHaveLength(6);

    const captions = [...page.matchAll(/<figcaption>([\s\S]*?)<\/figcaption>/g)].map(([, body]) => body.trim());
    expect(captions).toHaveLength(6);
    for (const caption of captions) {
      expect(caption.length, 'each figcaption must carry descriptive text').toBeGreaterThan(10);
    }

    expect(page).toContain('deterministic, anonymized example data');
    // The anonymization statement must cover every screenshot, hero included, not only the ones below the hero.
    expect(page).toMatch(
      /all screenshots[\s\S]*including the hero[\s\S]*deterministic, anonymized example data[\s\S]*no customer workspace, user identity, or customer record appears/i
    );
    expect(page).not.toMatch(/screenshots?\s+below[\s\S]*deterministic, anonymized example data/i);
  });

  it('keeps approved screenshots as tracked documentation assets', () => {
    const imageInventory = readdirSync(resolve(docs, 'assets/images')).sort();
    const trackedImages = execFileSync('git', ['ls-files', 'docs/assets/images/*'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((path) => basename(path))
      .sort();

    expect(imageInventory).toEqual(repositoryImages);
    expect(trackedImages).toEqual(repositoryImages);
    for (const screenshot of landingScreenshots) {
      expect(existsSync(resolve(docs, 'assets/images', screenshot)), screenshot).toBe(true);
    }
  });

  it('states the workspace and pillar scope the way the guide does', () => {
    const page = source('index.md');

    // Workspace choices are mutually exclusive, so they must be joined with "or", never listed together with a pillar clause.
    expect(page).toContain('every visible workspace or an explicit workspace selection');
    expect(page).not.toContain('Choose one workspace, every visible workspace, and any subset of pillars');
    expect(page).toMatch(/any single pillar, any subset, or all seven pillars/);
  });

  it('describes improvement verification as the guide does', () => {
    const page = source('index.md');

    // Marking an action done changes the requirement's outcome only when a later assessment verifies it.
    expect(page).toContain("does not change a requirement's outcome");
  });

  it('teases the safe, explicit installation sequence', () => {
    const page = source('index.md');
    const normalized = page.toLowerCase();

    expect(page).toContain('existing SQL warehouse');
    expect(page).toContain('existing Lakebase');
    expect(page).toContain('assessor group');
    expect(normalized).toContain('validate');
    expect(normalized).toContain('preview');
    expect(normalized).toContain('explicit apply');
    expect(page).toContain("{{ '/install/' | relative_url }}");
    expect(normalized).not.toContain('one-command');
  });
});
