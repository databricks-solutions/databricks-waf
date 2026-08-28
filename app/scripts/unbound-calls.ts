// Finding a method called with its receiver dropped — the class of defect that reached `main` in `#302`
// and was removed by `#304`, having been found by driving the app rather than by anything here.
//
// `(this.options.newId ?? crypto.randomUUID)()` shipped and threw. `??` evaluates to the *value* of
// `crypto.randomUUID`, which is a function with no receiver, and `crypto.randomUUID` needs one: Node
// answers a detached call with `TypeError: Illegal invocation`. So a review that had never been
// finalised could not be, and the write path that recovered a completed review threw on the line that
// minted the id.
//
// Two halves, and both are needed to make the finding worth reading.
//
// **The syntax.** `(obj.m)()` is fine — a parenthesised member access keeps the reference and passes
// `obj` as `this`. What loses the receiver is a member access that becomes a *value* on the way to being
// called, which in JavaScript is exactly the operands of `??`, `||`, `&&` and `?:`. So this half is the
// language's own semantics rather than a guess at what looks risky.
//
// **The type.** Syntax alone is not enough, measured: it reports eleven expressions here and ten of them
// are `(options.now ?? (() => new Date()))()`, where `now` is a *property* holding a function and has no
// receiver to lose. `randomUUID` is a *method*, declared with method syntax on the `Crypto` interface,
// and a method is the thing that may use a `this`. So a finding needs both: an operand that is
// evaluated to a value, and a symbol declared as a method. That distinction is the whole difference
// between a check somebody reads and eleven comments explaining why each is fine.
//
// **`@typescript-eslint/unbound-method` does not catch it**, which is why this exists rather than a line
// in `eslint.config.js`. Measured 2026-08-13, on `server/review/postgres-store.ts` with `#302`'s
// expression restored: `npx eslint server/review/postgres-store.ts` reported "No issues found", with
// `recommendedTypeChecked` — which includes that rule — in force. The file is in `tsconfig.server.json`,
// so the type-aware rule had the program it needs. This check, on the same file in the same state,
// reports it and exits 1.
//
// What it does not catch, said plainly rather than left implied: the two-statement form,
// `const mint = crypto.randomUUID; mint();`. Catching that needs flow analysis, no instance of it exists
// here, and a check that claimed to cover it would be worse than one that says it does not.

import ts from 'typescript';

/** One call that drops a receiver, in the shape both the reporter and the test read. */
export interface UnboundCall {
  readonly file: string;
  readonly line: number;
  readonly expression: string;
  readonly receiver: string;
  /** Where the method is declared, so the reader can see it is a method rather than take our word. */
  readonly declaredAt: string;
}

/** The operators whose operands are evaluated to a value, and so lose a method's receiver. */
const DETACHING = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

/**
 * How a deliberate one says so: a line in a diff a reviewer sees, rather than a value quietly chosen.
 *
 * On the line itself or the line above, because a short expression carries its comment beside it and one
 * spanning lines carries it before.
 */
const ALLOW = /^\/\/\s*unbound-ok:/;

/**
 * The lines carrying a real `unbound-ok` comment, read as comments rather than as text.
 *
 * Tested against the string form: a line-level regex over the source would let
 * `'// unbound-ok: …'` inside a literal — this file prints one, and so does the gate above it —
 * silence every finding on the line it appears on, which is an opt-out nobody wrote.
 */
function allowed(source: ts.SourceFile): ReadonlySet<number> {
  const text = source.getFullText();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, source.languageVariant, text);
  const lines = new Set<number>();
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    if (!ALLOW.test(scanner.getTokenText().trim())) continue;
    lines.add(source.getLineAndCharacterOfPosition(scanner.getTokenStart()).line);
  }
  return lines;
}

/**
 * Every call in one source file whose callee is a method that arrived as a value.
 *
 * Takes the checker rather than building one, so the caller can hold a program across every file and so
 * the test can drive this with a program of two fixtures.
 */
export function unboundCalls(source: ts.SourceFile, checker: ts.TypeChecker, name = source.fileName): readonly UnboundCall[] {
  const excused = allowed(source);
  const found: UnboundCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      for (const detached of receiverless(node.expression)) {
        const line = source.getLineAndCharacterOfPosition(detached.getStart(source)).line;
        if (excused.has(line) || excused.has(line - 1)) continue;
        const where = declaredAsMethod(detached, checker);
        if (where == null) continue;
        found.push({
          file: name,
          line: line + 1,
          expression: detached.getText(source),
          receiver: detached.expression.getText(source),
          declaredAt: where,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

/**
 * Where the accessed property is declared, if it is declared as a method, and nothing otherwise.
 *
 * Method syntax is the signal — `randomUUID(): UUID` on an interface, or a method on a class — because
 * that is the declaration that may use a `this`. A property whose type is a function, `now?: () => Date`,
 * cannot: nothing in it is bound to the object it hangs off.
 *
 * A symbol nothing resolves is not a finding. That is the honest answer for an unresolvable expression
 * and it is the one direction this check is willing to be wrong in, because the alternative is a gate
 * that fails on whether a program could be built.
 */
function declaredAsMethod(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): string | undefined {
  const symbol = checker.getSymbolAtLocation(access.name);
  for (const declaration of symbol?.declarations ?? []) {
    if (!ts.isMethodSignature(declaration) && !ts.isMethodDeclaration(declaration)) continue;
    const file = declaration.getSourceFile();
    const line = file.getLineAndCharacterOfPosition(declaration.getStart(file)).line + 1;
    return `${file.fileName}:${String(line)}`;
  }
  return undefined;
}

/**
 * The member accesses inside a callee that were evaluated to a value on the way to being called.
 *
 * Recurses through parentheses and through nested detaching operators, so `(a ?? b ?? obj.m)()` and
 * `(a ?? (b || obj.m))()` are both found.
 */
function receiverless(callee: ts.Expression): readonly ts.PropertyAccessExpression[] {
  if (ts.isParenthesizedExpression(callee)) return receiverless(callee.expression);
  if (ts.isBinaryExpression(callee) && DETACHING.has(callee.operatorToken.kind)) {
    return [...operand(callee.left), ...operand(callee.right)];
  }
  if (ts.isConditionalExpression(callee)) {
    return [...operand(callee.whenTrue), ...operand(callee.whenFalse)];
  }
  return [];
}

/**
 * One operand: a member access is a candidate, and anything else is searched for one.
 *
 * `this.f` is a candidate like any other, because `(a ?? this.f)()` drops `this` exactly as it drops
 * anything else — the reason `#302`'s expression read as safe is that half of it was `this.options`.
 */
function operand(node: ts.Expression): readonly ts.PropertyAccessExpression[] {
  if (ts.isParenthesizedExpression(node)) return operand(node.expression);
  // `a.b.c` is one candidate, on the outermost access, since that is the one whose receiver the call drops.
  if (ts.isPropertyAccessExpression(node)) return [node];
  return receiverless(node);
}
