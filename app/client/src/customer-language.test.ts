import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL('../../server/', import.meta.url));
const SOURCE_ROOTS = [CLIENT_ROOT, SERVER_ROOT] as const;
const INTERNAL_SERVER_LANGUAGE = new Set([
  join(SERVER_ROOT, 'review/postgres-store.ts'),
  join(SERVER_ROOT, 'review/store.ts'),
  join(SERVER_ROOT, 'store/audit-log.ts'),
]);
const FORMER_UI_TERMS = [
  /customer result/i,
  /final assessment/i,
  /operating inbox/i,
  /active inbox/i,
  /owned work/i,
  /create remediation/i,
  /raising remediation/i,
  /remediation (workflow|queue)/i,
  /provenance and remediation/i,
  /needs remediation/i,
  /query shape/i,
  /write shape/i,
  /empty this install/i,
  /acts recorded/i,
  /\b(no|any|every|recorded|these) acts?\b/i,
  /chain (now )?ends at act/i,
  /every pillar has a record/i,
  /when every pillar has been confirmed/i,
  /published assessment/i,
  /immutable result/i,
  /published result/i,
  /final result/i,
  /costs a handful of statements/i,
  /advisor over the estate/i,
  /immutable assessment/i,
  /published pillar result/i,
  /review inbox/i,
  /published dashboard/i,
  /published summary/i,
  /its result could not be read/i,
  /this result records/i,
  /topology response/i,
  /run a scan/i,
  /technical scoring shape/i,
  /in this process/i,
  /raise it here/i,
  /result store/i,
  /safe result/i,
  /review store/i,
] as const;

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (
      !['.ts', '.tsx'].includes(extname(entry.name)) ||
      entry.name.includes('.test.') ||
      INTERNAL_SERVER_LANGUAGE.has(path)
    )
      return [];
    return [path];
  });
}

function renderedWords(path: string): readonly string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const words: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      words.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return words;
}

describe('customer-facing language', () => {
  it('keeps former implementation terms out of rendered strings', () => {
    const failures = SOURCE_ROOTS.flatMap((root) =>
      sourceFiles(root).flatMap((path) =>
        renderedWords(path).flatMap((words) =>
          FORMER_UI_TERMS.filter((term) => term.test(words)).map(
            (term) => `${relative(root, path)}: ${String(term)} matched ${JSON.stringify(words.trim())}`
          )
        )
      )
    );

    expect(failures).toEqual([]);
  });
});
