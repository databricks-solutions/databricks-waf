#!/usr/bin/env node
// Holds the client to the design system.
//
// The instruction behind this file was that the design system "must become the UX for all
// additional work". That is not something a stylesheet can enforce. A stylesheet offers
// tokens; the next feature under time pressure reaches for `text-red-500` because it is
// three seconds faster than finding out what the semantic name is, and every one of those
// is invisible in review and permanent afterwards. Six months of that and the system is a
// folder nobody imports from.
//
// So the rules are checked rather than documented. A useful check names the replacement — because a
// check that only says no teaches nothing, and the author will simply pick a different way around it.
//
// What this file is NOT is the design authority. The current authority is
// docs/design/customer-design-system.md (ADR 0107). Family 126b removed the structural rules copied
// from the historical Architecture Studio kit and measured composition. What remains guards semantic
// tokens, accessible semantics and accidental divergence; it does not prescribe radius, shadow, page
// measure, pane count, fitted lists or a universal type ramp. Amend a stale rule with the system it
// would otherwise block. The check exists to stop a rule being lost by accident under time pressure,
// not to stop it being changed on purpose — an amendment here is reviewable, a component quietly
// opting out with an arbitrary value is not, and that asymmetry is the point.
//
// Scope is the client's own source. A vendor package is not audited: AppKit's internals are
// its business, and the theme layer re-tones it from outside by redeclaring the semantic
// variables it already consumes. The same path is what a second vendor stylesheet takes —
// import the package, do not copy it into client/src. Measured 2026-08-18 against
// @xyflow/react 12.11.3's style.css (ADR 0098): copying it in failed colour-literal 57 times
// and shadow 3, the latter on the variable `--xy-controls-box-shadow-default`, which the
// Tailwind grep cannot tell from a utility. Importing from the package, as index.css already
// does for AppKit, is not a failure. That is the intended signal, not a reason to exempt a
// copied file.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyDesignInventory, legacyDesignIsEmpty } from './legacy-design.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..');
const CLIENT = join(APP, 'client', 'src');
const ENTRY = join(CLIENT, 'index.css');

/**
 * The two files that hold the palette. They are the only place raw colour values, shadow
 * definitions and pixel radii are permitted, because they are what the rest of the app
 * refers to instead of writing its own.
 */
const THEME_FILES = ['client/src/styles/wa-theme.css', 'client/src/styles/wa-tailwind.css'];

/**
 * Everything a `wa-` class name can legitimately be, read out of the stylesheets themselves.
 *
 * This exists because of the one failure mode the rules below cannot see: a class name that is
 * spelled wrong, or invented on the spot, is not an error anywhere. `className="wa-button"` when the
 * kit calls it `wa-button-secondary` compiles, renders, passes every other check, and produces an
 * unstyled element — two overlapping words where a button should be. Nothing fails except the page.
 *
 * Read rather than listed, so the set cannot drift from the stylesheets it is describing. The print
 * layer counts: a class defined only there exists, it is just only in force on paper.
 */
const STYLE_FILES = [
  ...THEME_FILES,
  'client/src/styles/customer-system.css',
  'client/src/styles/customer-acceptance.css',
  'client/src/styles/wa-print.css',
];

function definedClasses() {
  const found = new Set();
  for (const rel of STYLE_FILES) {
    const text = readFileSync(join(APP, rel), 'utf8');
    for (const [, name] of text.matchAll(/\.(wa-[a-z0-9-]+)/g)) found.add(name);
  }
  return found;
}

/** The colour tokens Tailwind will accept after `text-`, `bg-` and the rest. */
function definedColours() {
  const found = new Set();
  for (const rel of THEME_FILES) {
    const text = readFileSync(join(APP, rel), 'utf8');
    for (const [, name] of text.matchAll(/--color-(wa-[a-z0-9-]+):/g)) found.add(name);
  }
  return found;
}

/** Tailwind's palette families. Naming one in a component hardcodes a colour. */
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

/** Utilities that take a colour, so `text-red-500` matches but `text-sm` does not. */
const COLOURABLE =
  'bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|accent|caret|placeholder';

/**
 * Numeric values already present during the role-token migration.
 *
 * New customer components use the --wa-type-* roles. Keeping the known legacy values prevents an
 * unrelated page from blocking the foundation change while still catching a fresh one-off size.
 */
const LEGACY_TYPE_VALUES = [11, 12, 13, 14, 16, 20, 24, 36, 48];

/**
 * The spacing scale. Every gap, pad and inset is one of these.
 *
 * Open against the brief (gap C4): the kit is a 4px grid — 4, 8, 12, 16, 20, 24, 32, 40. Seven
 * values here are off that grid.
 */
const SPACING = [0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64];

const RULES = [
  {
    id: 'arbitrary-type-size',
    // Tailwind's arbitrary-value syntax for font size, e.g. text-[15px]. The ramp values are
    // allowed so a component can pin a step where a semantic class does not exist yet.
    pattern: new RegExp(
      `\\btext-\\[(?!(?:${LEGACY_TYPE_VALUES.join('|')})px\\])(?!(?:var\\(--wa-type-[^)]+\\))\\])[^\\]]+\\]`,
      'g'
    ),
    why: 'adds an unowned one-off type size',
    instead:
      'use a customer type role — wa-type-display, wa-type-page, wa-type-section, wa-type-title,\n' +
      '      or a --wa-type-* token. The role owns responsive size and hierarchy; a new literal at\n' +
      '      the call site has neither.',
  },
  {
    id: 'arbitrary-spacing',
    // Arbitrary padding, margin and gap. Same reasoning as the ramp: a 13px gap beside a 12px one
    // is not a decision anybody made, it is a number somebody typed.
    pattern: new RegExp(
      `\\b(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y)-\\[(?!(?:${SPACING.join('|')})px\\])[^\\]]+\\]`,
      'g'
    ),
    why: 'sets spacing outside the scale',
    instead:
      'use the scale: 0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64px — which in\n' +
      '      Tailwind units is 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 16. Spacing off\n' +
      '      the scale is what makes a dense layout look slightly wrong in a way nobody can point at.',
  },
  {
    id: 'raw-palette',
    pattern: new RegExp(`\\b(?:${COLOURABLE})-(?:${PALETTE})-(?:50|\\d{3})\\b`, 'g'),
    why: 'names a raw Tailwind palette colour',
    instead:
      'use a semantic token: wa-danger, wa-warning, wa-success, wa-info for status; wa-text,\n' +
      '      wa-text-secondary, wa-text-muted for text; wa-surface, wa-surface-subtle, wa-canvas\n' +
      '      for planes. A raw palette colour does not change between light and dark, so it is a\n' +
      '      bug in one of the two themes by construction.',
  },
  {
    id: 'colour-literal',
    // Six- and three-digit hex, plus the functional notations. Matched inside quotes and
    // template literals as well as bare, since a colour smuggled through a string is the
    // same colour.
    //
    // The token test is exempt, and only that file: it reads the theme's own declarations and
    // computes contrast ratios from them, so it has to parse `#rrggbb` and `rgba(...)` and it has
    // to name the plane a badge sits on. A check that forbade it would forbid the test that proves
    // the palette is legible, which is the wrong way round.
    skip: (rel) => rel === 'client/src/styles/tokens.test.ts',
    pattern: /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\s*\(/g,
    why: 'writes a colour value directly',
    instead:
      'declare it once in client/src/styles/wa-theme.css and refer to the variable. A value\n' +
      '      written at the point of use cannot be re-toned for dark mode and cannot be found again.',
  },
  {
    id: 'gradient',
    pattern:
      /\bbg-gradient-to-[a-z]+\b|\bbg-(?:linear|radial|conic)-|(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/g,
    why: 'uses a gradient',
    instead:
      'flat fills only. Where a gradient encodes data rather than decorating — the uncertainty\n' +
      '      hatch on a score bar, for instance — put it in wa-tailwind.css as a named class so the\n' +
      '      colour stays in the theme and the meaning stays reviewable.',
  },
  {
    id: 'glass',
    pattern: /\bbackdrop-(?:blur|saturate|brightness)-[a-z0-9[\]/-]+/g,
    why: 'uses a backdrop filter',
    instead:
      'opaque surfaces. Glassmorphism costs contrast, which the accessibility target does not\n' +
      '      have to spare, and dates a tool that has to look current for years.',
  },
];

/** Lines a rule may not fire on, each with the reason it is exempt. */
const EXEMPT = [
  /\bcheck-design-system\b/,
  /eslint-disable/,
  // max-w-prose is a measure for running text, not a page width: it is the one place a component
  // legitimately constrains itself, and it is expressed in characters rather than pixels.
  /max-w-prose/,
];

/**
 * File-level rules, as opposed to the line-level greps above.
 *
 * The disclaimer rule is the one the kit is emphatic about and the one most likely to be lost:
 * the number this app computes is its own, Databricks publishes no such score, and a screenshot
 * of "55.2 out of 100" with no sentence attached will be read as an official rating by the next
 * person to see it. Whoever adds the eighth surface that prints a score will not think to add
 * it, so the check does the thinking.
 */
const FILE_RULES = [
  {
    id: 'unstriped-table',
    // Any <table> that is not the shared one. .wa-table owns header, selection, alignment and the
    // row-link affordance; its exact banding is a visual-system choice rather than a grep rule.
    //
    // Tests are exempt: a test that asserts on the string "<table" is discussing markup, not
    // rendering an interface, and the rule would be arguing with the test that proves the rule.
    skip: (rel) => /\.test\.tsx?$/.test(rel),
    applies: (text) => /<table\b/.test(text),
    satisfied: (text) => !/<table\b(?![^>]*className="wa-table")/.test(text),
    why: 'renders a table outside the shared accessible table treatment',
    instead:
      'use <table className="wa-table"> or the DataTable component. The shared treatment owns\n' +
      '      alignment, focus, selection, wrapping and compact alternatives; visual banding may\n' +
      '      change with the current customer system.',
  },
  {
    id: 'undisclaimed-score',
    // Calls, not declarations: the module that defines the tone rule prints no number, and the
    // module that defines the disclaimer must not be required to import itself.
    // Tests and non-TSX data modules assemble score-shaped records but render no customer surface;
    // requiring a presentation component there is a false positive rather than a guard. Renderers
    // are TSX in this client, which keeps the check on every place a number can reach the screen.
    skip: (rel) => /\.test\.tsx?$/.test(rel) || !rel.endsWith('.tsx'),
    applies: (text) =>
      /\bscoreTone\(|\bscore\.overall\b/.test(text) && !/export function scoreTone|SCORE_DISCLAIMER =/.test(text),
    satisfied: (text) => /ScoreDisclaimer(?:Mark)?\b/.test(text),
    why: 'renders a score without the disclaimer beside it',
    instead:
      'import ScoreDisclaimer (or ScoreDisclaimerMark where the layout is tight) from\n' +
      '      components/ui/ScoreDisclaimer and place it with the number. The score is calculated by\n' +
      '      this application from published guidance; it is not an official Databricks score, and a\n' +
      '      number that travels into a slide without that sentence will be quoted as if it were.',
  },
];

/** Block comments, line comments and JSX comment wrappers, replaced by nothing. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Bodies of every `@media (max-width: Npx) { ... }` in `css`, braces matched. */
function cssMediaBlocks(css, query) {
  const needle = `${query} {`;
  const blocks = [];
  let from = 0;
  while (true) {
    const start = css.indexOf(needle, from);
    if (start === -1) return blocks;
    const open = start + needle.length - 1;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          blocks.push(css.slice(open + 1, i));
          from = i + 1;
          break;
        }
      }
    }
    if (from <= start) return blocks;
  }
}

function sourceFiles(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(?:tsx?|css)$/u.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every class name a file asks for, from its `className` attributes only.
 *
 * Attributes rather than the whole file, because `wa-`-prefixed strings are also localStorage keys
 * and data attributes, and a rule that flagged `localStorage.getItem('wa-theme')` as a missing class
 * would be wrong in a way that teaches the next author to ignore it.
 */
function classesIn(code) {
  const asked = [];
  for (const [, quoted, braced] of code.matchAll(/className\s*=\s*(?:"([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/g)) {
    // Inside a braced expression only the literals are class names. The identifiers around them
    // hold classes that are checked wherever they were written.
    const text = quoted ?? [...(braced ?? '').matchAll(/['"`]([^'"`]*)['"`]/g)].map(([, literal]) => literal).join(' ');

    for (const token of text.split(/\s+/)) {
      if (token === '') continue;
      // Variants (`hover:`, `data-[x]:`) prefix the utility they modify, and the utility is what
      // has to exist. Arbitrary values are left alone: other rules own those.
      const bare = token.slice(token.lastIndexOf(':') + 1).replace(/^!/, '');
      // A name built at runtime is not a name this can check. Skipped rather than guessed at: the
      // alternative is reporting `wa-chip-${tone}` as missing on every render path, which would make
      // the rule something authors learn to scroll past.
      if (bare === '' || bare.includes('[') || bare.includes('$')) continue;
      asked.push(bare);
    }
  }
  return asked;
}

const DEFINED_CLASSES = definedClasses();
const DEFINED_COLOURS = definedColours();

const problems = [];
const counts = new Map();
let scanned = 0;

/*
 * Family 141 removed the compatibility system. Any deprecated API, fitted call, class use or emitted
 * selector is now a regression rather than debt to record in a baseline.
 */
{
  const current = legacyDesignInventory();
  if (!legacyDesignIsEmpty(current)) {
    problems.push({
      where: 'client/src',
      rule: {
        why: 'restores a reference to the removed pre-126 visual or fitted-layout system',
        instead: 'use the customer-system page, surface, record, task and disclosure roles.',
      },
      found: JSON.stringify(current),
    });
  }
}

/*
 * Historical artefacts stay readable, but their first screenful must route a contributor to the current
 * authority. Body text is historical evidence and may use the language that was current on its named date.
 */
for (const [file, required] of [
  ['AGENTS.md', ['docs/design/customer-design-system.md', 'historical inputs']],
  ['.databricks-impeccable.md', ['docs/design/customer-design-system.md', 'historical inputs']],
  ['docs/design/composition.md', ['Historical implementation record', 'customer-design-system.md']],
  ['docs/design/gap-register.md', ['Closed historical comparison', 'customer-design-system.md']],
  ['docs/design/reference/README.md', ['Historical supplier kit', 'customer-design-system.md']],
  ['docs/pilot-uplift/README.md', ['Historical release plan', 'customer-design-system.md']],
  ['docs/pilot-uplift/07-customer-experience-quality.md', ['Historical', 'customer-design-system.md']],
  ['docs/plan/110-customer-experience-quality.md', ['Historical', 'customer-design-system.md']],
]) {
  if (!existsSync(join(ROOT, file))) continue;
  const source = readFileSync(join(ROOT, file), 'utf8');
  const firstScreen = file === 'CONTRIBUTING.md' ? source : source.split('\n').slice(0, 16).join('\n');
  const missing = required.filter((phrase) => !firstScreen.includes(phrase));
  if (missing.length === 0) continue;
  problems.push({
    where: '../' + file,
    rule: {
      why: 'can be read as a live design authority before its historical status is visible',
      instead:
        'put the historical status and a link to docs/design/customer-design-system.md in the first\n' +
        '      screenful. Preserve the dated body as evidence rather than rewriting it to sound current.',
    },
    found: 'missing ' + missing.join(', '),
  });
}

for (const file of sourceFiles(CLIENT)) {
  const rel = relative(APP, file).split('\\').join('/');
  if (THEME_FILES.includes(rel)) continue;

  scanned += 1;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  // File rules read the code, not the commentary. These files explain their own rules in prose
  // above the code that obeys them, and a rule that reads its own explanation as a violation
  // punishes the file for being documented.
  const code = withoutComments(text);

  // A class that does not exist. Its own pass rather than a line rule, because the answer depends on
  // the stylesheets rather than on the line.
  if (!/\.test\.tsx?$/.test(rel)) {
    const missing = new Set();
    for (const asked of classesIn(code)) {
      if (asked.startsWith('wa-')) {
        if (!DEFINED_CLASSES.has(asked)) missing.add(asked);
        continue;
      }
      const colour = /^(?:[a-z-]+)-(wa-[a-z0-9-]+)$/.exec(asked);
      if (colour?.[1] != null && !DEFINED_COLOURS.has(colour[1]) && !DEFINED_CLASSES.has(asked)) {
        missing.add(asked);
      }
    }
    if (missing.size > 0) {
      counts.set('undefined-class', (counts.get('undefined-class') ?? 0) + missing.size);
      problems.push({
        where: rel,
        rule: {
          why: 'asks for a class the stylesheets do not define, so it renders as nothing',
          instead:
            'check the name against client/src/styles/. A misspelt or invented wa- class is silent —\n' +
            '      it compiles, renders and passes every other check, and the only symptom is an\n' +
            '      unstyled element nobody sees until a reader does. Colour utilities have to name a\n' +
            '      --color-wa-* token: text-wa-text-muted exists, text-wa-muted does not.',
        },
        found: [...missing].join(', '),
      });
    }
  }

  for (const rule of FILE_RULES) {
    if (rule.skip?.(rel) === true) continue;
    // The component that defines the disclaimer is not a consumer of it.
    if (rule.satisfied(code) || !rule.applies(code)) continue;
    counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
    problems.push({ where: rel, rule, found: rule.id });
  }

  lines.forEach((line, index) => {
    if (EXEMPT.some((pattern) => pattern.test(line))) return;

    for (const rule of RULES) {
      if (rule.skip?.(rel) === true) continue;
      // Fresh lastIndex per line: these are /g regexes reused across the whole tree.
      rule.pattern.lastIndex = 0;
      const found = line.match(rule.pattern);
      if (found == null) continue;

      counts.set(rule.id, (counts.get(rule.id) ?? 0) + found.length);
      problems.push({
        where: `${rel}:${index + 1}`,
        rule,
        found: [...new Set(found)].join(', '),
      });
    }
  });
}

// The theme is only in force because it is loaded after AppKit's stylesheet, where it wins on
// source order. Reversing the two would revert the entire design system and break nothing
// that any other check can see, so the order is asserted rather than trusted to a comment.
// Matched against the @import statements only, not the whole file: the header comment names
// these same files while explaining the order, and matching that text would let a file pass on
// the strength of its own documentation.
const imports = readFileSync(ENTRY, 'utf8')
  .split('\n')
  .filter((line) => line.trimStart().startsWith('@import'))
  .join('\n');
const appkitAt = imports.indexOf('@databricks/appkit-ui/styles.css');
const themeAt = imports.indexOf('wa-theme.css');
const tailwindAt = imports.indexOf('wa-tailwind.css');

if (appkitAt === -1 || themeAt === -1 || tailwindAt === -1) {
  problems.push({
    where: 'client/src/index.css',
    rule: {
      why: 'does not import all three style layers',
      instead:
        "import '@databricks/appkit-ui/styles.css', then './styles/wa-theme.css', then\n" +
        "      './styles/wa-tailwind.css'.",
    },
    found: 'missing import',
  });
} else if (!(appkitAt < themeAt && themeAt < tailwindAt)) {
  problems.push({
    where: 'client/src/index.css',
    rule: {
      why: 'imports the style layers in the wrong order',
      instead:
        'AppKit first, then wa-theme.css, then wa-tailwind.css. wa-theme.css redeclares the same\n' +
        '      semantic variables AppKit declares and only wins by coming second. In the other order\n' +
        '      every AppKit component silently reverts to AppKit\u2019s palette.',
    },
    found: 'wrong order',
  });
}

// Tailwind scans the repository for class names, and this app commits its bundle, so without
// these exclusions the previous build's output becomes an input to the next build's CSS and the
// output stops being a function of the source alone. The symptom is remote: the bundle-freshness
// job fails with a diff that rebuilding cannot fix. Asserted here because the fix is two lines
// that look like housekeeping and would be an obvious thing to tidy away.
const tailwindLayer = readFileSync(join(CLIENT, 'styles', 'wa-tailwind.css'), 'utf8');
for (const path of ['../../dist', '../../../dist']) {
  if (tailwindLayer.includes(`@source not "${path}"`)) continue;
  problems.push({
    where: 'client/src/styles/wa-tailwind.css',
    rule: {
      why: 'does not exclude the committed bundle from Tailwind source detection',
      instead:
        `add @source not "${path}"; — dist is tracked because the platform runs the committed\n` +
        '      bundle, so Tailwind scans it, so the CSS depends on the last build rather than only on\n' +
        '      the source. Builds then differ between machines for no visible reason.',
    },
    found: `missing @source not "${path}"`,
  });
}

// 32l / GAP-022: the rail, the header menu and the sheet's gate are one number. They held two
// (900px in CSS, 768px in the trigger and AppKit's `useIsMobile`) and left 768–899px with no
// navigation a pointer can reach. This is not a twelfth grep in RULES — AGENTS.md still names
// eleven — it is the same class of lock as `@source not` above.
{
  const chromeWidthFile = join(CLIENT, 'components', 'shell', 'chrome-width.ts');
  const chromeWidthSource = readFileSync(chromeWidthFile, 'utf8');
  const chromeMin = Number(/export const CHROME_MIN_WIDTH_PX = (\d+)/.exec(chromeWidthSource)?.[1]);
  const chromeWhere = relative(APP, chromeWidthFile);

  if (!Number.isFinite(chromeMin) || chromeMin < 1) {
    problems.push({
      where: chromeWhere,
      rule: {
        why: 'does not export CHROME_MIN_WIDTH_PX as a positive integer',
        instead:
          "export const CHROME_MIN_WIDTH_PX = 900 — the kit's list-first cut. CSS, the menu\n" +
          '      trigger and the sheet gate all read from this.',
      },
      found: 'missing or unreadable',
    });
  } else {
    const hideAt = chromeMin - 1;
    const query = `@media (max-width: ${String(hideAt)}px)`;
    const blocks = cssMediaBlocks(tailwindLayer, query);
    const paired = blocks.find(
      (block) =>
        /\.wa-chrome\s*\{[^}]*display:\s*none/.test(block) && /\.wa-nav-menu\s*\{[^}]*display:\s*block/.test(block)
    );
    if (paired === undefined) {
      problems.push({
        where: 'client/src/styles/wa-tailwind.css',
        rule: {
          why: 'hides the chrome column and reveals the header menu at different widths',
          instead:
            `${query} must contain both \`.wa-chrome { display: none }\` and \`.wa-nav-menu { display:\n` +
            `      block }\`, so a pointer in the ${String(hideAt)}px band can reach the sheet. The width is\n` +
            '      CHROME_MIN_WIDTH_PX in chrome-width.ts.',
        },
        found: blocks.length === 0 ? `no ${query}` : `${query} without both rules`,
      });
    }
    if (!/\.wa-nav-menu\s*\{\s*display:\s*none/.test(tailwindLayer)) {
      problems.push({
        where: 'client/src/styles/wa-tailwind.css',
        rule: {
          why: 'does not hide the header menu where the chrome column is shown',
          instead:
            '`.wa-nav-menu { display: none }` by default, revealed only in the query that hides\n' +
            '      `.wa-chrome`. Otherwise the button sits next to the rail.',
        },
        found: 'no default hide',
      });
    }

    const appSource = withoutComments(readFileSync(join(CLIENT, 'App.tsx'), 'utf8'));
    if (!appSource.includes('useChromeColumnVisible') || !appSource.includes('chrome-width')) {
      problems.push({
        where: 'client/src/App.tsx',
        rule: {
          why: 'gates the navigation sheet on something other than the chrome column',
          instead:
            'import useChromeColumnVisible from chrome-width.ts and open the sheet only while the\n' +
            "      column is gone. AppKit's useIsMobile is 768px and is how the 768–899px band had no nav.",
        },
        found: 'does not import useChromeColumnVisible',
      });
    }
    if (/\buseIsMobile\b/.test(appSource)) {
      problems.push({
        where: 'client/src/App.tsx',
        rule: {
          why: "gates the navigation sheet on AppKit's 768px hook",
          instead:
            'use useChromeColumnVisible from chrome-width.ts. useIsMobile is 768px; the rail hides\n' +
            '      at CHROME_MIN_WIDTH_PX.',
        },
        found: 'useIsMobile',
      });
    }

    const headerSource = withoutComments(readFileSync(join(CLIENT, 'components', 'shell', 'ReviewHeader.tsx'), 'utf8'));
    if (!headerSource.includes('wa-nav-menu')) {
      problems.push({
        where: 'client/src/components/shell/ReviewHeader.tsx',
        rule: {
          why: 'does not put the navigation trigger in .wa-nav-menu',
          instead:
            'wrap the menu in class wa-nav-menu so the 899px query that hides the rail also shows\n' +
            "      the button. md:hidden is Tailwind's 768px and is the other half of the gap.",
        },
        found: 'no wa-nav-menu',
      });
    }
    if (/\bmd:hidden\b/.test(headerSource)) {
      problems.push({
        where: 'client/src/components/shell/ReviewHeader.tsx',
        rule: {
          why: "hides the navigation trigger at Tailwind's 768px rather than the chrome column's width",
          instead:
            'class wa-nav-menu, revealed in the same query that hides .wa-chrome. md:hidden is how\n' +
            '      768–899px had a hidden rail and no button.',
        },
        found: 'md:hidden',
      });
    }
  }
}

if (scanned === 0) {
  // An empty pass would keep passing after a move, and the guarantee would become a comment.
  console.error(
    `check-design-system scanned no files under ${relative(APP, CLIENT)}, so it proved nothing.\n` +
      'The client source moved, or the extension list is wrong.'
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error(`The design system is not being followed in ${problems.length} place(s):\n`);
  for (const problem of problems) {
    console.error(
      `  ${problem.where}\n    ${problem.rule.why}: ${problem.found}\n    Instead: ${problem.rule.instead}\n`
    );
  }
  console.error(
    'These are guards for the current customer design system, checked rather than documented, because the\n' +
      'alternative is that the system decays one shortcut at a time.\n'
  );
  process.exit(1);
}

console.log(
  `Design system holds across ${scanned} client files ` +
    `(${RULES.length + FILE_RULES.length + 1} rules, import order verified, ` +
    `${DEFINED_CLASSES.size} classes and ${DEFINED_COLOURS.size} colour tokens read from the stylesheets).`
);
