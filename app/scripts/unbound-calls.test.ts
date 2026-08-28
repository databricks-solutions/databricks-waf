// The apparatus, measured on fixtures — including the expression `#304` fixed.
//
// `AGENTS.md` asks for this by name: a premise replaced by a measurement is only as good as the thing
// the measurement was taken with. It earned the paragraph here twice over. The first pass at this check
// read the callee of the call rather than through the parentheses to the operands, and reported nothing
// on the real defect while printing a confident zero. The second reported eleven, ten of which were
// `(options.now ?? (() => new Date()))()` — a property holding a function, which has no receiver to
// lose — so the gate would have shipped with ten comments explaining why each was fine, which is a gate
// people learn to annotate rather than read.
//
// So both directions are cases below: the ones that must fire, and the ones that must not.

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { unboundCalls } from './unbound-calls.js';

/** The declarations a fixture is compiled against, so a method is a method and a property is not. */
const AMBIENT = `
  interface Crypto {
    randomUUID(): string;
  }
  declare const crypto: Crypto;
  declare const console: { log(text: string): void };
  interface Options {
    readonly newId?: () => string;
    readonly now?: () => Date;
  }
  declare const options: Options;
  declare const free: () => string;
`;

function findings(body: string): readonly string[] {
  const name = '/fixture.ts';
  const text = `${AMBIENT}\n${body}\n`;
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost({}),
    getSourceFile: (file, target) =>
      file === name ? source : ts.createCompilerHost({}).getSourceFile(file, target),
    fileExists: (file) => file === name || ts.sys.fileExists(file),
    readFile: (file) => (file === name ? text : ts.sys.readFile(file)),
  };
  const program = ts.createProgram([name], { noLib: true, target: ts.ScriptTarget.ESNext }, host);
  const compiled = program.getSourceFile(name);
  if (compiled == null) throw new Error('the fixture did not compile into the program');
  return unboundCalls(compiled, program.getTypeChecker(), 'fixture.ts').map((one) => one.expression);
}

describe('a call that drops its receiver', () => {
  it('finds the expression #304 fixed, which is the one this check exists for', () => {
    // Verbatim, `this.options` replaced by a local of the same shape. If this case ever passes silently
    // the check has stopped covering the defect it was built for, whatever else it still reports.
    expect(findings('const id = (options.newId ?? crypto.randomUUID)();')).toEqual(['crypto.randomUUID']);
  });

  it('finds one behind `||`, `&&` and a conditional, since all three evaluate their operands', () => {
    expect(findings('const a = (options.newId || crypto.randomUUID)();')).toEqual(['crypto.randomUUID']);
    expect(findings('const b = (free && crypto.randomUUID)();')).toEqual(['crypto.randomUUID']);
    expect(findings('const c = (free ? free : crypto.randomUUID)();')).toEqual(['crypto.randomUUID']);
  });

  it('finds one nested inside another, so a longer chain of defaults is not a way past this', () => {
    expect(findings('const a = (options.newId ?? (free || crypto.randomUUID))();')).toEqual([
      'crypto.randomUUID',
    ]);
  });

  it('finds every method in the callee rather than the first, because either one may be taken', () => {
    expect(findings('const a = (console.log ?? crypto.randomUUID)();')).toEqual([
      'console.log',
      'crypto.randomUUID',
    ]);
  });

  it('takes an explicit `unbound-ok` and no more than that, on the line or the one above', () => {
    expect(findings('// unbound-ok: measured\nconst a = (options.newId ?? crypto.randomUUID)();')).toEqual([]);
    expect(findings('const a = (options.newId ?? crypto.randomUUID)(); // unbound-ok: measured')).toEqual([]);
    // Two lines above is not the line above. A comment that drifts from its expression stops describing
    // it, and a check that accepted one anywhere nearby would be excused by any comment in the file.
    expect(findings('// unbound-ok: measured\n\nconst a = (options.newId ?? crypto.randomUUID)();')).toEqual([
      'crypto.randomUUID',
    ]);
  });

  it('reads the excuse as a comment, so the same text inside a string does not excuse anything', () => {
    // The gate above this prints `// unbound-ok: <reason>` in its own message, so the text occurs in
    // string literals in this repository already. A line-level regex over the source would have let any
    // line carrying one silence every finding on it, which is an opt-out nobody wrote.
    expect(
      findings("const note = '// unbound-ok: not an excuse';\nconst a = (options.newId ?? crypto.randomUUID)();")
    ).toEqual(['crypto.randomUUID']);
    expect(
      findings("const a = (options.newId ?? crypto.randomUUID)(); const note = '// unbound-ok: nor here';")
    ).toEqual(['crypto.randomUUID']);
  });
});

describe('a call that keeps its receiver, or has none to keep', () => {
  it('leaves a property holding a function alone, which is ten of the eleven this repository has', () => {
    // `now` is `() => Date`, a property. Nothing in it is bound to `options`, so the call is not the
    // defect and flagging it would make the gate noise. This is the case that decided the design.
    expect(findings('const at = (options.now ?? (() => new Date()))();')).toEqual([]);
    expect(findings('const id = (options.newId ?? (() => crypto.randomUUID()))();')).toEqual([]);
  });

  it('leaves a plain call and a parenthesised member access alone, since neither loses anything', () => {
    // `(crypto.randomUUID)()` passes `crypto`: parentheses around a member access keep the reference.
    // A check that read this as a finding would be reporting on punctuation.
    expect(findings('const a = crypto.randomUUID();')).toEqual([]);
    expect(findings('const b = (crypto.randomUUID)();')).toEqual([]);
  });

  it('leaves a method it is handed rather than called through, since that is a different mistake', () => {
    // Passing `crypto.randomUUID` as an argument is the two-statement form's cousin, and this check says
    // it does not cover it. The case is here so that stays a decision rather than an accident.
    expect(findings('declare function take(mint: () => string): void;\ntake(crypto.randomUUID);')).toEqual([]);
  });
});
