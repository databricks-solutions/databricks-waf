// Carrying one advisor finding from the page that shows it to the page that raises work from it.
//
// Four ids in a query string, and deliberately nothing else. The obvious alternative is to carry the
// finding's headline as well, so the improvements pages can show a sentence rather than a rule id —
// and it would be a sentence attributed to the advisor that came from a URL somebody could edit. What
// the advisor said is read from the stored advisory, by the server, when the action is written; until
// then these pages name the finding rather than quoting it.
//
// The ids are enough to name it because that is what the reference is: `advice.ts` on the server takes
// the same four and resolves them, or refuses.

import type { AdviceReference, Advisor } from '../api/types';

const ADVISORS: readonly Advisor[] = ['workload', 'sizing', 'jobs', 'writes', 'serverless'];

/** What each advisor is called where a reader meets it, which is the Optimisation surface's own word. */
const ADVISOR_LABEL: Readonly<Record<Advisor, string>> = {
  workload: 'query workload',
  sizing: 'warehouse sizing',
  jobs: 'job health',
  writes: 'write patterns',
  serverless: 'serverless readiness',
};

/** What the finding was found on, so the phrase below says a warehouse rather than a resource. */
const SUBJECT: Readonly<Record<Advisor, string>> = {
  workload: 'query group',
  sizing: 'warehouse',
  jobs: 'job',
  // A write shape and a query shape are the same kind of thing, identified by the same fingerprint over
  // the same normalised text — see `AdviceResourceKind` on the server.
  writes: 'write group',
  serverless: 'job',
};

/** The path with the reference on it, for a link out of a finding. */
export function adviceHref(path: string, reference: AdviceReference): string {
  const params = new URLSearchParams({
    advisory: reference.advisoryId,
    advisor: reference.advisor,
    resource: reference.resource,
    rule: reference.rule,
  });
  return `${path}?${params.toString()}`;
}

/**
 * The reference a URL carries, or nothing where it carries none.
 *
 * All four or none. Three of them name a set of findings rather than one, and a page that offered to
 * raise an action from a partial reference would be offering something the server refuses.
 */
export function adviceIn(params: URLSearchParams): AdviceReference | undefined {
  const advisoryId = params.get('advisory');
  const advisor = params.get('advisor');
  const resource = params.get('resource');
  const rule = params.get('rule');

  if (advisoryId == null || advisor == null || resource == null || rule == null) return undefined;
  if (advisoryId === '' || resource === '' || rule === '') return undefined;
  if (!ADVISORS.includes(advisor as Advisor)) return undefined;

  return { advisoryId, advisor: advisor as Advisor, resource, rule };
}

/**
 * What is being raised from, in ids the reader can check against the page they came from.
 *
 * No claim about what the finding says: this module has not read the advisory, and the pages that use
 * it have not either. The rule's own words arrive with the action, from the server.
 */
export function advicePhrase(reference: AdviceReference): string {
  return `the ${ADVISOR_LABEL[reference.advisor]} advisor's ${reference.rule} finding on ${SUBJECT[reference.advisor]} ${reference.resource}`;
}
