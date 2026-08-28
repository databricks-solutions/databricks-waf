#!/usr/bin/env -S npx tsx
// The gate over `unbound-calls.mts` — see that file for what a finding is and why eslint has none.
//
// Two programs because the repository has two: the server and the client are separate projects with
// different libs, and a call in either breaks the same way.
//
//   npm run check:unbound-calls

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { unboundCalls, type UnboundCall } from './unbound-calls.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = ['tsconfig.server.json', 'tsconfig.client.json'];

const problems: UnboundCall[] = [];
let read = 0;

for (const project of PROJECTS) {
  const path = join(APP, project);
  const config = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (config.error != null) {
    process.stderr.write(`Cannot read ${project}: ${ts.flattenDiagnosticMessageText(config.error.messageText, ' ')}\n`);
    process.exit(1);
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, APP);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    // A project's file list can reach outside it through an import; only what this repository authors is
    // ours to fix, and `dist` is our own output rather than a source.
    if (!source.fileName.startsWith(`${APP}/`)) continue;
    if (source.fileName.includes('/node_modules/') || source.fileName.includes('/dist/')) continue;
    read += 1;
    problems.push(...unboundCalls(source, checker, relative(APP, source.fileName)));
  }
}

// Both projects include `shared` and `scripts`, so a call there is found twice.
const distinct = [...new Map(problems.map((one) => [`${one.file}:${String(one.line)}:${one.expression}`, one])).values()];

process.stdout.write(
  `Unbound calls: ${String(read)} files across ${String(PROJECTS.length)} projects, ${String(distinct.length)} found.\n`
);

// A project list that stops matching this repository's files would otherwise report no findings and
// pass, which is `check-grain`'s "so this checked nothing" in a gate that cannot say it.
if (read === 0) {
  process.stderr.write(
    `\nNo file was read from ${PROJECTS.join(' or ')}, so this checked nothing. Either the projects no\n` +
      'longer list this repository\'s sources or the filter above excludes all of them.\n'
  );
  process.exit(1);
}

if (distinct.length > 0) {
  process.stderr.write('\nA method is called with its receiver dropped:\n\n');
  for (const one of distinct) {
    process.stderr.write(
      `  - ${one.file}:${String(one.line)} — \`${one.expression}\` is evaluated to a value here, so the\n` +
        `    call passes no \`${one.receiver}\` as \`this\`. It is declared as a method at\n` +
        `    ${relative(APP, one.declaredAt)}, and Node answers a detached call to one with "Illegal\n` +
        '    invocation" — #302 is what that looked like in production.\n' +
        `    Wrap it: \`(() => ${one.expression}())\`. If it is safe, say why on the line above with\n` +
        '    `// unbound-ok: <reason>`.\n\n'
    );
  }
  process.exit(1);
}

process.stdout.write('No call drops a receiver.\n');
