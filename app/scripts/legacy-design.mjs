#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const CLIENT = join(APP, 'client', 'src');
const DEPRECATED_MODULES = ['Plane', 'Panes', 'Workbench', 'Detail', 'fit'];
const DEPRECATED_ELEMENTS = [
  'Plane',
  'Panes',
  'Workbench',
  'Detail',
  'DetailHead',
  'DetailSection',
  'DetailField',
  'DetailNote',
  'DetailSnippet',
  'DetailLink',
];
const LEGACY_SELECTORS = ['panel', 'panes', 'workbench', 'fit-body', 'fit-yields', 'pane-scroll'];

function filesBelow(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const file = join(root, entry);
    if (statSync(file).isDirectory()) out.push(...filesBelow(file));
    else out.push(file);
  }
  return out;
}

function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])
  );
}

export function legacyDesignClasses(source) {
  const inSource = {};
  const classPattern = new RegExp('\\bwa-(' + LEGACY_SELECTORS.join('|') + ')\\b', 'g');
  for (const [, name] of withoutComments(source).matchAll(classPattern)) increment(inSource, 'wa-' + name);
  return sortedRecord(inSource);
}

/**
 * The exact production dependency on the pre-126 visual system.
 *
 * Counts are per file rather than one total. A migration lowers the manifest; moving the same debt to
 * another module changes it; and one new call cannot hide behind one removal elsewhere.
 */
export function legacyDesignInventory() {
  const imports = {};
  const elements = {};
  const fittedLists = {};
  const classes = {};
  const selectors = {};

  const modulePattern = new RegExp('/ui/(' + DEPRECATED_MODULES.join('|') + ')$');
  const elementPattern = new RegExp('<(' + DEPRECATED_ELEMENTS.join('|') + ')\\b', 'g');

  for (const file of filesBelow(CLIENT)) {
    const rel = relative(APP, file).split('\\').join('/');

    if (/\.tsx?$/.test(file) && !/\.test\.[cm]?tsx?$/.test(file)) {
      const code = withoutComments(readFileSync(file, 'utf8'));

      for (const [, source] of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        const found = modulePattern.exec(source)?.[1];
        if (found == null) continue;
        const names = imports[rel] ?? [];
        if (!names.includes(found)) names.push(found);
        imports[rel] = names;
      }

      const inFile = {};
      for (const [, name] of code.matchAll(elementPattern)) increment(inFile, name);
      if (Object.keys(inFile).length > 0) elements[rel] = sortedRecord(inFile);

      if (!file.endsWith('/fit.ts')) {
        const calls = [...code.matchAll(/\buseFitRows\s*\(/g)].length;
        if (calls > 0) fittedLists[rel] = calls;
      }

      const inFileClasses = legacyDesignClasses(code);
      if (Object.keys(inFileClasses).length > 0) classes[rel] = sortedRecord(inFileClasses);
      continue;
    }

    if (file.endsWith('.css')) {
      const css = withoutComments(readFileSync(file, 'utf8'));
      const inFile = {};
      const selectorPattern = new RegExp('\\.wa-(' + LEGACY_SELECTORS.join('|') + ')\\b', 'g');
      for (const [, name] of css.matchAll(selectorPattern)) increment(inFile, '.wa-' + name);
      if (Object.keys(inFile).length > 0) selectors[rel] = sortedRecord(inFile);
    }
  }

  return {
    deprecatedImports: sortedRecord(imports),
    deprecatedElements: sortedRecord(elements),
    fittedLists: sortedRecord(fittedLists),
    legacyClasses: sortedRecord(classes),
    legacySelectors: sortedRecord(selectors),
  };
}

export function legacyDesignTotals(inventory) {
  const total = (section) =>
    Object.values(section).reduce(
      (sum, value) => sum + (typeof value === 'number' ? value : Object.values(value).reduce((a, b) => a + b, 0)),
      0
    );

  return {
    importingFiles: Object.keys(inventory.deprecatedImports).length,
    elements: total(inventory.deprecatedElements),
    fittedLists: total(inventory.fittedLists),
    classes: total(inventory.legacyClasses),
    selectors: total(inventory.legacySelectors),
  };
}

export function legacyDesignIsEmpty(inventory) {
  return Object.values(legacyDesignTotals(inventory)).every((count) => count === 0);
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  const inventory = legacyDesignInventory();
  if (!legacyDesignIsEmpty(inventory)) {
    process.stderr.write('Deprecated design references remain: ' + JSON.stringify(inventory, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write('Deprecated design references: 0.\n');
}
