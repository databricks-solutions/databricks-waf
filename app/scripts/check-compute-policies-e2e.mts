// Real Chrome against the built app and production routes; only the workspace uses synthetic HTTP data.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { open } from './browser.mjs';
import { FIXTURE_HEADERS, serveComputePolicyApp } from './fixtures/compute-policy-app.js';

const fixture = await serveComputePolicyApp();
let page: Awaited<ReturnType<typeof open>> | undefined;
const output = resolve(process.env.E2E_ARTIFACT_DIR ?? 'node_modules/.cache/compute-policies-e2e');
mkdirSync(output, { recursive: true });
const results: { theme: string; width: number; outcome: string; screenshot: string }[] = [];
try {
  page = await open();
  await page.send('Network.setExtraHTTPHeaders', { headers: FIXTURE_HEADERS });
  for (const width of [1512, 1280]) {
    await page.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await page.prefer(theme);
      for (const policy of [false, true]) {
        const scan = await fixture.scan({
          clusters: [
            { id: 'interactive', source: 'UI', policy: true },
            { id: 'nightly-etl', source: 'JOB', policy },
          ],
        });
        const published = await fixture.publish(scan);
        const outcome = policy ? 'pass' : 'fail';
        for (const controlId of ['OE-02-02', 'IU-03-03']) {
          assert.equal(scan.findings.find((finding) => finding.controlId === controlId)?.outcome, outcome);
          assert.equal(
            published.result?.finalAssessment?.outcome.findings.find((entry) => entry.finding.controlId === controlId)
              ?.finding.outcome,
            outcome,
            `${controlId} retains its measured outcome in the published result`
          );
        }
        await page.goto(`${fixture.origin}/findings?control=OE-02-02`);
        const content = (await page.evaluate(
          "document.querySelector('main')?.innerText ?? document.body.innerText"
        )) as string;
        assert.ok(content.includes('OE-02-02'), 'selected requirement renders');
        const badges = (await page.evaluate(
          '[...document.querySelectorAll(\'main [aria-label="Selected requirement"] span\')].map((element) => element.textContent?.trim())'
        )) as string[];
        assert.ok(badges.includes(policy ? 'Met' : 'Not met'), 'rendered finding outcome matches the scan');
        assert.ok(content.includes('1 of 1 classic all-purpose'), 'all-purpose denominator renders');
        assert.ok(content.includes(`${policy ? 1 : 0} of 1 classic job`), 'job denominator renders');
        assert.ok(content.includes('not every job definition'), 'inventory limitation renders');
        if (!policy) assert.ok(content.includes('nightly-etl'), 'affected job resource renders');
        const geometry = (await page.evaluate(
          '({ width: innerWidth, content: document.documentElement.scrollWidth })'
        )) as { width: number; content: number };
        assert.ok(geometry.content <= geometry.width + 1, 'page has no horizontal overflow');
        const screenshot = `${width}-${theme}-${outcome}.png`;
        writeFileSync(resolve(output, screenshot), await page.screenshot());
        results.push({ theme, width, outcome, screenshot });
        console.log(
          `PASS ${width}px ${theme}: OE-02-02 ${outcome}, both policy populations and inventory caveat visible`
        );
      }
    }
  }
  writeFileSync(
    resolve(output, 'results.json'),
    JSON.stringify(
      {
        boundary: 'synthetic Databricks HTTP responses; real built client, API, SQL collector, scanner and storage',
        results,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Passed ${results.length} Chrome scenarios. Artifacts: ${output}`);
} catch (error) {
  writeFileSync(
    resolve(output, 'failure.txt'),
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  );
  if (page != null) {
    writeFileSync(resolve(output, 'failure-page.txt'), String(await page.evaluate('document.body.innerText')));
    writeFileSync(resolve(output, 'failure.png'), await page.screenshot());
  }
  throw error;
} finally {
  page?.close();
  await fixture.close();
}
