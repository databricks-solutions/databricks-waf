// A picture of the schedule panel as it reads the workspace this server is pointed at.
//
// The drive script stubs the API to walk every state; this one stubs nothing, so what it shows is what a
// reader on that workspace sees. Used to check the states that only a real workspace produces — a failure
// whose reason is a sentence the app itself wrote, and an identity that is not the job's run-as.

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, requireScan, settle } from './browser.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';
const INTO = process.env.INTO ?? 'build/shots';

const PANEL = `(() => {
  const one = document.querySelector('[aria-label="Scheduled assessment"]');
  if (one == null) return undefined;
  const box = one.getBoundingClientRect();
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
})()`;

mkdirSync(INTO, { recursive: true });

await requireScan(ORIGIN);
const page = await open({ width: 1512, height: 845 });

try {
  for (const [name, at] of [
    ['history', '/history'],
    ['history-job-runs', '/history?runs=job'],
  ]) {
    await page.goto(`${ORIGIN}${at}`);
    await settle(1500);
    writeFileSync(`${INTO}/${name}.png`, await page.screenshot());
    if (name === 'history') {
      const panel = await page.evaluate(PANEL);
      if (panel != null) writeFileSync(`${INTO}/schedule-panel.png`, await page.screenshot({ ...panel, scale: 1 }));
    }
    console.log(`${name.padEnd(18)} ${at}`);
  }
} finally {
  await page.close();
}
