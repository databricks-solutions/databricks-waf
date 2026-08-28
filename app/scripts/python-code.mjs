// A Python file's code without its prose.
//
// Extracted from `check-evidence-script.mjs` so it can be tested on its own, which it needed to be.
// The checks that matter most in that file — that the evidence script never names `secrets/get`,
// never names a mutating verb — are `body.includes(...)` against whatever this returns. If this drops
// a string literal, those checks pass on a script that contains the very thing they forbid, and they
// pass quietly. That happened: see the note on depth below.
//
// The checks have to run against code rather than the whole file, because the evidence script's whole
// purpose is to be read. Its docstring says it never calls `secrets/get`, and a check that failed on
// that sentence would forbid documenting the guarantee it enforces.

import { execFileSync } from 'node:child_process';

/**
 * The Python that does the tokenising, as a program rather than a regex.
 *
 * Python's own tokeniser rather than a pattern here, so a `#` inside a string cannot fool it and a
 * triple-quoted block cannot end early.
 *
 * A string is prose when it stands where a statement would and nothing encloses it: at the top of a
 * module, a class or a function body, or after a completed statement. Inside brackets it is data,
 * whatever precedes it.
 *
 * Both halves of that are load-bearing, and each was learned the same way.
 *
 * Depth, because for a while this classified any string after a line break as prose. Python emits NL
 * for a line break inside brackets, so every path and field name in a multi-line tuple — which is
 * where the whole probe table lives — was taken for a docstring and thrown away. A `secrets/get`
 * planted in a field list was invisible to the check that exists to forbid it.
 *
 * And the previous *significant* token, because dropping NL alone is not enough: a comment and a
 * non-logical line break do not move a statement along, so neither can stand in as "what came
 * before". The evidence script's module docstring sits under a shebang, which is exactly that case.
 */
const TOKENISE = [
  'import sys, tokenize',
  'kept = []',
  'previous = tokenize.ENCODING',
  'depth = 0',
  'with open(sys.argv[1], "rb") as handle:',
  '    for token in tokenize.tokenize(handle.readline):',
  '        if token.type == tokenize.OP and token.string in "([{":',
  '            depth += 1',
  '        elif token.type == tokenize.OP and token.string in ")]}":',
  '            depth -= 1',
  '        prose = token.type == tokenize.STRING and depth == 0 and previous in (',
  '            tokenize.ENCODING, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)',
  '        if token.type != tokenize.COMMENT and not prose:',
  '            kept.append(token.string)',
  '        if token.type not in (tokenize.COMMENT, tokenize.NL):',
  '            previous = token.type',
  'sys.stdout.write(" ".join(kept))',
].join('\n');

/**
 * Every token of `file` except its comments and docstrings, joined by spaces.
 *
 * Space-joined, so patterns matched against the result have to tolerate loose spacing: the source's
 * `subprocess.run(` arrives here as `subprocess . run (`.
 *
 * @param {string} file Absolute path to a Python file.
 * @returns {string} The file's code, with every other string literal intact.
 */
export function codeOf(file) {
  return execFileSync('python3', ['-c', TOKENISE, file], { encoding: 'utf8' });
}
