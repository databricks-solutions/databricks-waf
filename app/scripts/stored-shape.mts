// The shape of a scan as it is stored, derived from the types, digested and pinned beside CODEC_VERSION.
//
// This is the gate that would have stopped row 81, and `90` is the row that explains why nothing did.
// `81` added `terminal` to the stored per-surface counters without bumping the codec version and without
// an upgrade, and `npm run verify` was green on both sides of it. Three layers each had a reason not to
// see it:
//
//   the type says the field is always there — `decodeScan` returns `Scan`, and from that point the
//   compiler is describing a document it never checked;
//
//   every fixture is built by the code under test — `new CollectionScheduler().footprint()` carries
//   whatever this build carries, so a fixture cannot disagree with the build about shape;
//
//   the one test with a real database writes a current-shape document and reads it back, asserting three
//   `spend` fields that `81` did not touch.
//
// So the shape is taken from neither the code's behaviour nor a sample of its output. It is read out of
// the type declarations with the TypeScript compiler, which is the only source that cannot drift from the
// record: a field added anywhere inside `Scan` moves the digest on the commit that adds it, whether or not
// any fixture populates it and whether or not any test asserts on it. `history-fixtures.test.ts` uses the
// same instrument for the same reason.
//
// What this does *not* know is whether a shape change needs an upgrade, a refusal, or nothing at all.
// That is a judgement, and the point of failing here is that somebody makes it while the change is in
// front of them — the version bump, the `READABLE` entry, the fixture, or a note saying none was needed.
//
//   node --import tsx scripts/stored-shape.mts            # rewrite the recording
//   node --import tsx scripts/stored-shape.mts --check     # fail when the shape moved and the version did not

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CODEC_VERSION } from '../server/scan/codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const RECORDING = join(HERE, 'recordings/stored-shape.json');

/**
 * What `encodeScan` drops on the way out, so the digest is of what is stored rather than of `Scan`.
 *
 * One entry. Raw signal values are dropped deliberately — a finding carries its own evidence, and two of
 * the payloads cannot survive JSON at all: the workspace settings probe answers with a `Map`, which
 * `JSON.stringify` renders as `{}` without complaint. Including it here would make the digest move every
 * time a collector's payload type changed, for a field no stored document has ever carried.
 */
const DROPPED = new Set(['signals[].value']);

/** Depth beyond which a path is not followed. Reached by nothing today; a guard, not a policy. */
const MAX_DEPTH = 12;

function program(): ts.Program {
  const configPath = join(APP, 'tsconfig.server.json');
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (read.error != null) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, APP);
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

/** The exported `Scan` interface, as a type the checker can walk. */
function scanType(checker: ts.TypeChecker, source: ts.SourceFile): ts.Type {
  const module = checker.getSymbolAtLocation(source);
  if (module == null) throw new Error('server/scan/scan.ts exports nothing the checker can see.');
  const scan = checker.getExportsOfModule(module).find((symbol) => symbol.getName() === 'Scan');
  if (scan == null) throw new Error('server/scan/scan.ts no longer exports Scan.');
  return checker.getDeclaredTypeOfSymbol(scan);
}

/**
 * Every leaf of a type, as `path:kind` lines.
 *
 * Sorted at the end, so a field moving within an interface does not move the digest — a reordering is not
 * a shape change, and a digest that fired on one would teach people to re-record without looking.
 *
 * Unions are named as their sorted members rather than followed one branch at a time, because a member
 * appearing or disappearing is exactly the kind of change this exists to catch: `outcome` gaining a
 * seventh value changes what a stored document may hold.
 */
function leaves(checker: ts.TypeChecker, type: ts.Type, at: string, depth: number, seen: ReadonlySet<ts.Type>): string[] {
  // Without the `?`: an optional property arrives here already marked, so matching the raw path would let
  // `signals[].value?` through the drop list while `signals[].value` was caught — silently, since a path
  // that is not dropped just appears in the digest.
  if (DROPPED.has(at.replace(/\?$/, ''))) return [];
  if (depth > MAX_DEPTH) return [`${at}:...`];

  // A type already open on this path. Recursion is legitimate — a comment thread carries replies — and
  // naming it rather than following it keeps the digest finite without pretending the field is a leaf.
  if (seen.has(type)) return [`${at}:recursive`];

  if (type.isUnion()) {
    const members = type.types;
    // An optional property arrives as `T | undefined`. Recorded as optional on the path rather than as a
    // union member, so that making a required field optional moves the digest — which is a change to what
    // a stored document may omit, and therefore to what the read path must handle.
    const defined = members.filter((member) => (member.flags & ts.TypeFlags.Undefined) === 0);
    // An optional property is both `SymbolFlags.Optional` and a `| undefined` union, so the mark is added
    // only if the caller has not already added it. `Partial<Record<FailureKind, number>>` hits both and
    // was reading `terminal.deadline??`, which invites a reader to wonder what the second one means.
    const optional = defined.length !== members.length && !at.endsWith('?');
    const mark = optional ? `${at}?` : at;
    if (defined[0] != null && defined.length === 1) return leaves(checker, defined[0], mark, depth, seen);
    if (defined.every((member) => isLeafKind(checker, member))) {
      return [`${mark}:${defined.map((member) => checker.typeToString(member)).sort().join('|')}`];
    }
    return defined
      .flatMap((member, index) => leaves(checker, member, `${mark}|${String(index)}`, depth + 1, seen))
      .sort();
  }

  if (isLeafKind(checker, type)) return [`${at}:${kind(checker, type)}`];

  const element = elementOf(checker, type);
  if (element != null) return leaves(checker, element, `${at}[]`, depth + 1, new Set([...seen, type]));

  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) {
    // An index signature — `Record<string, Counters>` is how the footprint counts surfaces, and the key
    // set is data rather than shape. The value's shape is what matters, and `terminal` lived in one.
    const index = checker.getIndexInfosOfType(type)[0];
    if (index != null) return leaves(checker, index.type, `${at}{}`, depth + 1, new Set([...seen, type]));
    return [`${at}:${checker.typeToString(type)}`];
  }

  const inside = new Set([...seen, type]);
  return properties
    .flatMap((property) => {
      /*
       * `getTypeOfSymbol`, not `getTypeOfSymbolAtLocation` with a fallback.
       *
       * The first version of this reached for `property.valueDeclaration` and fell back to
       * `getDeclaredTypeOfSymbol` when there was none. A property of a mapped type has no declaration —
       * `footprint.tasks` is `Record<Surface, SurfaceCounters>`, and its six properties are synthesised —
       * so every one of them took the fallback, which answers `any` for a property symbol and is not an
       * error. The walk stopped at exactly that boundary and the recording came out with
       * `footprint.tasks.ai:any` and no `terminal` anywhere in 1747 paths.
       *
       * So the instrument built to catch row 81 could not see the field row 81 added, and it produced a
       * plausible digest while blind to it. That is `H1`'s fixture with one column missing, one layer up:
       * a real, reproducible measurement of something other than the subject. It was caught by asking the
       * recording whether it contained `terminal`, which is now the first thing shape.test.ts asks.
       */
      const held = checker.getTypeOfSymbol(property);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      const path = `${at === '' ? '' : `${at}.`}${property.getName()}${optional ? '?' : ''}`;
      return leaves(checker, held, path, depth + 1, inside);
    })
    .sort();
}

/**
 * Whether a type is something a document holds rather than something it nests.
 *
 * `Date` is a leaf here even though it is an object with a hundred methods: it is stored as a string and
 * revived field by field, so its internals are not part of the stored shape. Walking it would add a
 * hundred paths that no change to this app can move.
 */
function isLeafKind(checker: ts.TypeChecker, type: ts.Type): boolean {
  /*
   * `StringLike` and `NumberLike` rather than `String` and `Number`.
   *
   * The narrow flags miss a template literal type, and a review caught what that cost: `SignalId` is
   * `${Surface}:${string}`, which is `TemplateLiteral` and not `String`, so the walk did not stop at it —
   * it asked the type for its properties, got `String`'s prototype, and recorded 270 of 1812 paths as
   * `findings[].evidence[].signal|0.charAt:(pos: number) => string` and its neighbours. Fifteen per cent
   * of the digest was the standard library, the stored field itself was described as its own prototype,
   * and a TypeScript upgrade that added a `String` method would have failed the gate for a reason with
   * nothing to do with a stored scan. That last part is the worse half: a rule that fires on an unrelated
   * change is a rule people learn to ignore.
   *
   * The wide flags are the ones that mean "assignable to string" and "assignable to number", so they
   * cover template literals, `Uppercase<T>` and friends, and every literal — which is what "the stored
   * document holds a scalar here" actually means.
   */
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Any |
    ts.TypeFlags.ESSymbolLike;
  if ((type.flags & primitive) !== 0) return true;
  const named = checker.typeToString(type);
  return named === 'Date' || named.startsWith('Map<') || named.startsWith('Set<');
}

function kind(checker: ts.TypeChecker, type: ts.Type): string {
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) return JSON.stringify((type as ts.StringLiteralType).value);
  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) return String((type as ts.NumberLiteralType).value);
  return checker.typeToString(type);
}

/** The element type of an array or readonly array, or null for anything else. */
function elementOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker.getTypeArguments(type as ts.TypeReference)[0] ?? null;
  }
  const named = checker.typeToString(type);
  if (/^(readonly )?.*\[\]$/.test(named)) {
    return checker.getTypeArguments(type as ts.TypeReference)[0] ?? null;
  }
  return null;
}

function shape(): { readonly paths: readonly string[]; readonly digest: string } {
  const built = program();
  const checker = built.getTypeChecker();
  const source = built.getSourceFile(join(APP, 'server/scan/scan.ts'));
  if (source == null) throw new Error('server/scan/scan.ts is not in the program.');

  const paths = leaves(checker, scanType(checker, source), '', 0, new Set()).sort();
  if (paths.length < 50) {
    // The apparatus check. A walk that silently resolved nothing would produce a short, stable list and a
    // digest that never moves, which is a gate that reads as passing forever — the failure mode `H1`'s
    // first measurement had, where a real reproducible number described a statement that did not exist.
    throw new Error(
      `The type walk found only ${String(paths.length)} paths in Scan, which is too few to be the stored ` +
        'shape. Something stopped resolving rather than the shape shrinking.'
    );
  }

  return { paths, digest: createHash('sha256').update(paths.join('\n')).digest('hex').slice(0, 16) };
}

const now = shape();
const recorded = existsSync(RECORDING)
  ? (JSON.parse(readFileSync(RECORDING, 'utf8')) as { codecVersion: number; digest: string; paths: readonly string[] })
  : null;

if (!process.argv.includes('--check')) {
  writeFileSync(
    RECORDING,
    `${JSON.stringify(
      {
        what:
          'The shape of a scan as it is stored, read out of the type declarations, with the codec version ' +
          'that was current when the shape was last recorded. See scripts/stored-shape.mts and row 90.',
        codecVersion: CODEC_VERSION,
        digest: now.digest,
        pathCount: now.paths.length,
        paths: now.paths,
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(
    `Recorded the stored shape: ${String(now.paths.length)} paths, digest ${now.digest}, codec version ${String(CODEC_VERSION)}.\n`
  );
} else if (recorded == null) {
  process.stderr.write('No recording of the stored scan shape. Run `npm run shape:record` and commit it.\n');
  process.exit(1);
} else if (recorded.digest === now.digest) {
  if (recorded.codecVersion !== CODEC_VERSION) {
    process.stderr.write(
      `The codec version is ${String(CODEC_VERSION)} and the shape recorded against ` +
        `${String(recorded.codecVersion)} has not changed. A bump with no shape change is not wrong, but the ` +
        'recording has to say which version the shape belongs to. Run `npm run shape:record` and commit it.\n'
    );
    process.exit(1);
  }
  process.stdout.write(
    `The stored scan shape is unchanged: ${String(now.paths.length)} paths at codec version ${String(CODEC_VERSION)}.\n`
  );
} else if (recorded.codecVersion === CODEC_VERSION) {
  const was = new Set(recorded.paths);
  const is = new Set(now.paths);
  const added = now.paths.filter((path) => !was.has(path));
  const gone = recorded.paths.filter((path) => !is.has(path));

  process.stderr.write(
    'The shape of a stored scan has changed and the codec version has not.\n\n' +
      `${added.map((path) => `  + ${path}`).join('\n')}\n${gone.map((path) => `  - ${path}`).join('\n')}\n\n` +
      'This is row 81, which added a field to the stored counters at version 2 and left the version at 2, so\n' +
      'a version 2 document may or may not carry it and the number cannot say which. Every stored scan in\n' +
      'the served app then crashed the route that rendered it.\n\n' +
      'One of these is now owed:\n' +
      `  - bump CODEC_VERSION past ${String(CODEC_VERSION)}, and decide in server/scan/codec.ts whether the\n` +
      '    older shape is upgraded on read or refused by name;\n' +
      '  - or, if a stored document cannot be affected — a field no encoder has ever written — say so where\n' +
      '    the change is, and re-record.\n\n' +
      'Then `npm run shape:record` and commit the recording.\n'
  );
  process.exit(1);
} else {
  process.stdout.write(
    `The stored scan shape changed and the codec version moved with it, ` +
      `${String(recorded.codecVersion)} to ${String(CODEC_VERSION)}. Run \`npm run shape:record\` and commit.\n`
  );
  process.exit(1);
}
