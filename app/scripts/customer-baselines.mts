// The 110f customer-quality gate: committed pictures of every deterministic customer state.
//
// Writing and accepting are deliberately separate acts. `--write` renders the current candidate into
// the committed artifact directory. `--check` is browser-free: it proves that all 108 declared images
// are present, that their pixels still match the manifest, and that no client source has changed since
// those pixels were rendered. A visual change therefore makes the ordinary verification suite fail
// until somebody renders and reviews a replacement set.
//
//   ORIGIN=http://127.0.0.1:8000 npm run customer-baselines:write
//   npm run customer-baselines:check

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER_ACCEPTANCE_CASES,
  CUSTOMER_ACCEPTANCE_RENDER_COUNT,
  CUSTOMER_ACCEPTANCE_THEMES,
  CUSTOMER_ACCEPTANCE_WIDTHS,
  acceptanceRenderId,
} from '../shared/customer-acceptance';
import { open } from './browser.mjs';

interface BaselineImage {
  readonly id: string;
  readonly surface: string;
  readonly state: string;
  readonly route: string;
  readonly viewport: string;
  readonly width: number;
  readonly height: number;
  readonly theme: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface BaselineManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly browser: string;
  readonly source: { readonly files: number; readonly sha256: string };
  readonly renders: number;
  readonly images: readonly BaselineImage[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const REPOSITORY = resolve(APP, '..');
const ARTIFACT = join(
  REPOSITORY,
  'docs',
  'pilot-uplift',
  'artifacts',
  '2026-08-24-customer-quality-baselines'
);
const SHOTS = join(ARTIFACT, 'screenshots');
const MANIFEST = join(ARTIFACT, 'manifest.json');
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8000';
const MODE = process.argv[2];

if (MODE !== '--write' && MODE !== '--check') {
  process.stderr.write('Use customer-baselines.mts with --write or --check.\n');
  process.exit(1);
}

const visualSources = [
  ...filesBelow(join(APP, 'client', 'src')).filter((file) => /\.(?:css|svg|ts|tsx)$/.test(file)),
  join(APP, 'client', 'index.html'),
  join(APP, 'client', 'vite.config.ts'),
  join(APP, 'package.json'),
  join(APP, 'package-lock.json'),
].sort();
const source = fingerprint(visualSources);

if (MODE === '--check') {
  check();
} else {
  await write();
}

async function write(): Promise<void> {
  const health = await fetch(`${ORIGIN}/health`).catch(() => null);
  if (health == null || !health.ok) {
    throw new Error(`${ORIGIN} is not a healthy local app. Start the development server before writing baselines.`);
  }

  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  const first = CUSTOMER_ACCEPTANCE_WIDTHS[0];
  if (first == null) throw new Error('The customer acceptance matrix declares no viewport.');
  const page = await open({ width: first.width, height: first.height });
  const images: BaselineImage[] = [];
  let browser = 'unknown';

  try {
    const version = (await page.send('Browser.getVersion')) as { product?: string };
    browser = version.product ?? browser;
    for (const one of CUSTOMER_ACCEPTANCE_CASES) {
      for (const viewport of CUSTOMER_ACCEPTANCE_WIDTHS) {
        await page.resize(viewport.width, viewport.height);
        for (const theme of CUSTOMER_ACCEPTANCE_THEMES) {
          const id = acceptanceRenderId(one, viewport, theme);
          const file = `${id}.png`;
          await page.prefer(theme);
          await page.send('Emulation.setEmulatedMedia', {
            features: [
              { name: 'prefers-color-scheme', value: theme },
              { name: 'prefers-reduced-motion', value: 'reduce' },
            ],
          });
          const arrival = await page.goto(`${ORIGIN}${one.path}`);
          if (!arrival.settled) {
            throw new Error(`${id} did not come to rest after ${String(arrival.waited)}ms: ${arrival.reason}`);
          }
          const rendered = (await page.evaluate(`(() => ({
            page: document.querySelectorAll('.wa-customer-page').length,
            preview: /\\bPreview data\\b/.test(document.body.innerText),
            width: window.innerWidth,
            height: window.innerHeight,
          }))()`)) as { page: number; preview: boolean; width: number; height: number };
          if (rendered.page !== 1 || !rendered.preview) {
            throw new Error(`${id} did not render exactly one deterministic customer page.`);
          }
          if (rendered.width !== viewport.width || rendered.height !== viewport.height) {
            throw new Error(
              `${id} rendered at ${String(rendered.width)}x${String(rendered.height)}, not ` +
                `${String(viewport.width)}x${String(viewport.height)}.`
            );
          }
          const png = await page.screenshot();
          const dimensions = pngDimensions(png);
          if (dimensions.width !== viewport.width || dimensions.height !== viewport.height) {
            throw new Error(`${id} produced a ${String(dimensions.width)}x${String(dimensions.height)} PNG.`);
          }
          writeFileSync(join(SHOTS, file), png);
          images.push({
            id,
            surface: one.surface,
            state: one.state,
            route: one.path,
            viewport: viewport.name,
            width: viewport.width,
            height: viewport.height,
            theme,
            file: `screenshots/${file}`,
            bytes: png.byteLength,
            sha256: sha(png),
          });
          process.stdout.write(`${String(images.length).padStart(3)}/${String(CUSTOMER_ACCEPTANCE_RENDER_COUNT)} ${id}\n`);
        }
      }
    }
  } finally {
    page.close();
  }

  const manifest: BaselineManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    browser,
    source,
    renders: images.length,
    images,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  check();
}

function check(): void {
  if (!existsSync(MANIFEST)) throw new Error(`${relative(REPOSITORY, MANIFEST)} is missing. Render the baseline set.`);
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as BaselineManifest;
  const expected = CUSTOMER_ACCEPTANCE_CASES.flatMap((one) =>
    CUSTOMER_ACCEPTANCE_WIDTHS.flatMap((viewport) =>
      CUSTOMER_ACCEPTANCE_THEMES.map((theme) => ({
        id: acceptanceRenderId(one, viewport, theme),
        one,
        viewport,
        theme,
      }))
    )
  );
  const problems: string[] = [];

  if (manifest.schemaVersion !== 1) problems.push(`manifest schema is ${String(manifest.schemaVersion)}, expected 1`);
  if (manifest.renders !== CUSTOMER_ACCEPTANCE_RENDER_COUNT || manifest.images.length !== expected.length) {
    problems.push(
      `manifest has ${String(manifest.images.length)} images and says ${String(manifest.renders)} renders; ` +
        `${String(CUSTOMER_ACCEPTANCE_RENDER_COUNT)} are required`
    );
  }
  const actualById = new Map(manifest.images.map((image) => [image.id, image]));
  if (actualById.size !== manifest.images.length) problems.push('manifest contains duplicate render ids');

  for (const wanted of expected) {
    const image = actualById.get(wanted.id);
    if (image == null) {
      problems.push(`${wanted.id} is absent from the manifest`);
      continue;
    }
    const expectedFile = `screenshots/${wanted.id}.png`;
    if (
      image.surface !== wanted.one.surface ||
      image.state !== wanted.one.state ||
      image.route !== wanted.one.path ||
      image.viewport !== wanted.viewport.name ||
      image.width !== wanted.viewport.width ||
      image.height !== wanted.viewport.height ||
      image.theme !== wanted.theme ||
      image.file !== expectedFile
    ) {
      problems.push(`${wanted.id} metadata does not match the declared acceptance matrix`);
    }
    const path = join(ARTIFACT, image.file);
    if (!existsSync(path)) {
      problems.push(`${image.file} is missing`);
      continue;
    }
    const png = readFileSync(path);
    const dimensions = pngDimensions(png);
    if (dimensions.width !== image.width || dimensions.height !== image.height) {
      problems.push(`${image.file} dimensions do not match its manifest entry`);
    }
    if (png.byteLength !== image.bytes || sha(png) !== image.sha256) {
      problems.push(`${image.file} pixels do not match its manifest entry`);
    }
  }

  for (const file of filesBelow(SHOTS).filter((one) => one.endsWith('.png'))) {
    const named = `screenshots/${relative(SHOTS, file)}`;
    if (!manifest.images.some((image) => image.file === named)) problems.push(`${named} is an undeclared screenshot`);
  }
  if (source.files !== manifest.source.files || source.sha256 !== manifest.source.sha256) {
    problems.push('client visual sources changed after the baseline set was rendered');
  }

  if (problems.length > 0) {
    process.stderr.write(`Customer visual baseline drift (${String(problems.length)} problems):\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.stderr.write('\nRender into a reviewable diff with `npm run customer-baselines:write`.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `All ${String(CUSTOMER_ACCEPTANCE_RENDER_COUNT)} customer visual baselines are complete, hash-linked and current.\n`
  );
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile() && statSync(path).size >= 0) files.push(path);
  }
  return files;
}

function fingerprint(files: readonly string[]): { files: number; sha256: string } {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(relative(REPOSITORY, file));
    digest.update('\0');
    digest.update(sha(readFileSync(file)));
    digest.update('\n');
  }
  return { files: files.length, sha256: digest.digest('hex') };
}

function sha(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.byteLength < 24 || png.toString('ascii', 1, 4) !== 'PNG' || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('A customer baseline is not a PNG with an IHDR header.');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
