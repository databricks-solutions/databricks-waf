#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(APP, '..', 'THIRD_PARTY_LICENSES.md');
const README = join(APP, '..', 'README.md');
const LOCKFILE = join(APP, 'package-lock.json');
const README_START = '<!-- third-party-licenses:start -->';
const README_END = '<!-- third-party-licenses:end -->';

// npm carries this package's legacy `licenses` array and MIT file in the tarball,
// but package-lock v3 does not copy the declaration into its package record.
const LICENCE_FROM_TARBALL = new Map([['json-bignum@0.0.3', 'MIT']]);

function packageParts(identifier) {
  const splitAt = identifier.lastIndexOf('@');
  if (splitAt <= 0) throw new Error(`Could not parse package identifier ${identifier}`);
  return { name: identifier.slice(0, splitAt), version: identifier.slice(splitAt + 1) };
}

function markdown(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function packageName(path) {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
const unique = new Map();
for (const [path, details] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/') || details.dev === true || !details.version) continue;
  const name = packageName(path);
  if (name.startsWith('@databricks/')) continue;
  const identifier = `${name}@${details.version}`;
  const licence = details.license ?? LICENCE_FROM_TARBALL.get(identifier);
  if (!licence) {
    throw new Error(`${identifier} has no licence recorded in package-lock.json or approved tarball metadata.`);
  }
  unique.set(identifier, { ...packageParts(identifier), licence });
}
const packages = [...unique.values()].sort(
  (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
);

const counts = new Map();
for (const { licence } of packages) {
  counts.set(licence, (counts.get(licence) ?? 0) + 1);
}

const summary = [...counts.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([licence, count]) => `| ${markdown(licence)} | ${count} |`)
  .join('\n');

const rows = packages
  .map(({ name, version, licence }) => {
    const source = `https://www.npmjs.com/package/${name}/v/${version}`;
    return `| ${markdown(name)} | ${markdown(version)} | ${markdown(licence)} | [source](${source}) |`;
  })
  .join('\n');

const directPackages = Object.entries(lock.packages[''].dependencies)
  .filter(([name]) => !name.startsWith('@databricks/'))
  .map(([name]) => {
    const details = lock.packages[`node_modules/${name}`];
    if (!details?.version || !details.license) {
      throw new Error(`${name} has no resolved version or licence in package-lock.json.`);
    }
    return { name, version: details.version, licence: details.license };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const directRows = directPackages
  .map(({ name, version, licence }) => {
    const source = `https://www.npmjs.com/package/${name}/v/${version}`;
    return `| ${markdown(name)} | ${version} | ${markdown(licence)} | [npm](${source}) |`;
  })
  .join('\n');

const readmeSummary = [...counts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .map(([licence, count]) => `| ${markdown(licence)} | ${count} |`)
  .join('\n');

const readmeBlock = `${README_START}
<details>
<summary><strong>Third-party licence summary and direct libraries</strong></summary>

| Licence | Resolved production packages |
| --- | ---: |
${readmeSummary}

| Direct third-party library | Version | Licence | Source |
| --- | --- | --- | --- |
${directRows}

First-party \`@databricks/*\` packages are governed separately by their published Apache-2.0 terms.

</details>
${README_END}`;

const generated = `# Third-party licences

This file inventories every non-development third-party package resolved by the production lockfile for
Databricks WAF 0.1.0, including optional packages for every supported runtime platform. The application
itself is governed by the [Databricks License](LICENSE.md). First-party \`@databricks/*\` packages are
governed separately by their published Apache-2.0 terms and are excluded from this third-party inventory.

The inventory is generated directly from \`app/package-lock.json\`. Do not edit it
by hand. Run \`npm run third-party:licenses\` from \`app/\`, and commit the result with every production
dependency change.

## Licence summary

| SPDX licence expression | Packages |
| --- | ---: |
${summary}

## Complete production inventory

| Package | Version | Licence | Project |
| --- | --- | --- | --- |
${rows}
`;

if (process.argv.includes('--write')) {
  writeFileSync(TARGET, generated);
  const readme = readFileSync(README, 'utf8');
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start < 0 || end < start) throw new Error('README.md is missing the third-party licence markers.');
  writeFileSync(README, `${readme.slice(0, start)}${readmeBlock}${readme.slice(end + README_END.length)}`);
  console.log(`Wrote ${packages.length} third-party package licences and ${directPackages.length} direct libraries.`);
  process.exit(0);
}

let committed = '';
try {
  committed = readFileSync(TARGET, 'utf8');
} catch {
  console.error('THIRD_PARTY_LICENSES.md is missing. Run npm run third-party:licenses.');
  process.exit(1);
}

if (committed !== generated) {
  console.error(
    'THIRD_PARTY_LICENSES.md is stale against the resolved production dependency tree. ' +
      'Run npm run third-party:licenses.'
  );
  process.exit(1);
}

const readme = readFileSync(README, 'utf8');
if (!readme.includes(readmeBlock)) {
  console.error('README.md third-party licence table is stale. Run npm run third-party:licenses.');
  process.exit(1);
}

console.log(
  `Third-party attribution covers ${packages.length} production packages and ${directPackages.length} direct libraries.`
);
