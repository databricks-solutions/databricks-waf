import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const app = resolve(import.meta.dirname, '..');
const docs = resolve(app, '..', 'docs');

describe('static Pages layouts', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-pages.mjs', '--write'], {
      cwd: app,
      stdio: 'pipe',
    });
  });

  it('renders the landing homepage and keeps guide pages on the guide layout', () => {
    const homepage = readFileSync(resolve(docs, 'index.html'), 'utf8');
    const guide = readFileSync(resolve(docs, 'user-guide/index.html'), 'utf8');

    expect(homepage).toContain('href="/databricks-waf/assets/css/landing.css"');
    expect(homepage).toContain('<main id="landing-content"');
    expect(homepage).not.toContain('class="sidebar"');
    expect(homepage).toContain('src="/databricks-waf/assets/images/dashboard.jpg"');
    expect(homepage).toContain('href="/databricks-waf/install/"');

    expect(guide).toContain('href="/databricks-waf/assets/css/guide.css"');
    expect(guide).toContain('class="sidebar"');
    expect(guide).not.toContain('landing.css');
  });
});
