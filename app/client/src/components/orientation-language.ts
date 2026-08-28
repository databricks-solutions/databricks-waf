// What this app is, in the words a reader meets it with.
//
// Content as data, for two reasons that are both about it staying true.
//
// A promise and a boundary are claims, and a claim in JSX is a claim nothing can check. Here the
// same words are reachable from a test, so "it changes nothing" is asserted against the invariant
// the collector is actually held to (`scripts/check-read-only.mjs`) rather than against a paragraph
// somebody wrote once. If the collector ever gains a write, a test fails on the sentence as well.
//
// And the vocabulary is the app's own. Every one of these words is a page, a column heading or a
// verdict elsewhere in the product, so the definition has to be the one the product means — a
// glossary written beside the welcome and never read again drifts from the thing it defines, and a
// wrong glossary is worse than no glossary because it is believed.

/** The framework this app scores against, at the published pages the catalogue was harvested from. */
export const FRAMEWORK_URL = 'https://docs.databricks.com/aws/en/lakehouse-architecture';

/**
 * The promise, in one sentence and then in three.
 *
 * Plain enough for somebody who has never heard of the framework, and specific enough that they can
 * tell whether it is the thing they were sent here to do. "Assess your Databricks estate" says
 * nothing: every tool in this category says it. What it reads, as whom, and what comes out are the
 * three facts that distinguish this from a questionnaire.
 */
export const PROMISE = {
  heading: 'What this is',
  lead:
    'A Well-Architected assessment of your Databricks environment that combines automated evidence ' +
    'with focused questions where platform data cannot provide the answer.',
  points: [
    'It reads system tables and workspace APIs using the scanning identity, then evaluates the pillars ' +
      'selected for this assessment.',
    'Where nothing can be read, it asks a person instead, and keeps their answer with their name and the ' +
      'date on it.',
    'The published report shows posture by pillar, the requirements behind it, and the evidence behind ' +
      'each requirement.',
  ],
} as const;

/**
 * What it does not do.
 *
 * First, before the reader has a score to be pleased with. Every line here is a limit somebody has
 * mistaken for a capability, and the first is the one that decides whether they let it near
 * production at all.
 */
export const LIMITS = {
  heading: 'What it does not do',
  points: [
    {
      claim: 'It does not change your Databricks environment.',
      detail:
        'Assessment collectors are read-only. The app records answers, decisions, exceptions, and improvement ' +
        'plans in its own database; it does not apply changes to Databricks resources.',
    },
    {
      claim: 'It does not see what you cannot see.',
      detail:
        'A scan runs as the signed-in user, so a requirement you are not granted the data for comes back ' +
        'as not measured. It never comes back as a pass.',
    },
    {
      claim: 'It does not certify anything.',
      detail:
        'A score here is this application\u2019s reading of published guidance. It is not an audit opinion, a ' +
        'Databricks certification, or a commitment about your estate.',
    },
    {
      claim: 'It does not apply fixes for you.',
      detail:
        'You can create an improvement plan, assign work, and record completion. A later assessment then ' +
        'checks the environment again.',
    },
    {
      claim: 'It is not a substitute for a security review.',
      detail:
        'The security pillar is one seventh of a design framework. It does not look at your data, your ' +
        'users\u2019 behaviour, or anything outside Databricks.',
    },
  ],
} as const;

/**
 * What a number here is, and what makes two of them comparable.
 *
 * Separate from the limits above, because this is not a caveat — it is how to read the only thing
 * most people will take away. A reader who thinks the score is a rating will compare last month's to
 * this month's across a changed scope and a changed catalogue, and conclude something false about
 * their estate from two numbers that were never answers to the same question.
 */
export const STANDING = {
  heading: 'How to read a score',
  points: [
    'It is out of 100, weighted by the methodology recorded on that run. Public releases carry their ' +
      'version and exact manifest; older development records stay visibly pre-release.',
    'Only what was measured counts. Coverage is reported beside every score, and a score over thin ' +
      'coverage is a statement about a small part of the estate.',
    'Two runs are comparable only when their public methodology and measurement basis agree. Change the ' +
      'identity, scope, lookback, pillars, or scoring basis and they answer different questions.',
  ],
} as const;

/** One term and what this app means by it. Every term is somewhere else in the product. */
export interface Word {
  readonly term: string;
  readonly meaning: string;
  /** Where the reader meets it, when the app has a page for it. */
  readonly at?: string;
}

/**
 * The vocabulary, in the order the words depend on each other.
 *
 * Not alphabetical. A reader meeting all of these at once needs "requirement" before "finding" and
 * "definition" before "run", and an alphabetical list puts answer, coverage and decision in front of
 * the three nouns the rest of it is built from.
 */
export const WORDS: readonly Word[] = [
  {
    term: 'Pillar',
    meaning:
      'One of the seven parts of the framework — governance, interoperability, operational excellence, ' +
      'security, reliability, performance, cost. Each is scored separately.',
    at: '/investigate',
  },
  {
    term: 'Requirement',
    meaning:
      'One thing the framework asks for, written so that it can be decided either by a query or by a ' +
      'person. The catalogue holds them all; a scan decides the ones it can reach.',
    at: '/checks',
  },
  {
    term: 'Check',
    meaning: 'The query a scan runs to decide a requirement, and the permission that query needs.',
    at: '/checks',
  },
  {
    term: 'Finding',
    meaning:
      'What a requirement came out as on a particular run — met, not met, or not measured — with the ' +
      'evidence it was decided from.',
    at: '/investigate',
  },
  {
    term: 'Answer',
    meaning:
      'A requirement no query can reach, decided by a person. Kept with who said it, when, and when it ' +
      'is due to be looked at again.',
    at: '/answers',
  },
  {
    term: 'Definition',
    meaning:
      'What an assessment covers and who owns it: purpose, owners, which workspaces, how far back, which ' +
      'pillars. Versioned, so a change to any of it is a new version rather than an edit.',
    at: '/definitions',
  },
  {
    term: 'Run',
    meaning:
      'One execution of a definition, recorded with the identity it ran as, what it managed to read, and ' +
      'what it could not.',
    at: '/history',
  },
  {
    term: 'Coverage',
    meaning:
      'How much of a score was measured rather than assumed. Reported beside every score, because the ' +
      'two together are the result and the number alone is not.',
  },
  {
    term: 'Fingerprint',
    meaning:
      'A hash of what a definition measures. Equal fingerprints mean two runs asked the same question of ' +
      'the same estate, which is the only case where comparing their scores means anything.',
  },
  {
    term: 'Decision',
    meaning:
      'What somebody undertook to do about a finding — accepted, planned, or claimed fixed. It does not ' +
      'change the score, and the next run says whether the estate agrees.',
    at: '/decisions',
  },
];

/** Where to go from here, in the order somebody who has just read this would want them. */
export const ONWARD = {
  heading: 'Where to start',
  detail:
    'Define what this assessment covers and who owns it, then run it. Defining takes a few minutes and ' +
    'can be left half-finished — what you have written is kept.',
} as const;
