// The step from an advisor finding to somebody's work.
//
// A link rather than a form. Raising an action needs a plan to raise it in, an owner, a date and a
// definition of done, and none of those belong on a page about a warehouse — an advisor page that
// grew a second form would be two surfaces, and the second one would be the worse copy of the one
// the improvements pages already have.
//
// What travels is the reference: which advisory, which advisor, which resource, which rule. The
// finding's own words are not carried, because they would arrive as a sentence attributed to the
// advisor that came out of a URL. The server reads them from the stored advisory when the action is
// written, which is what makes them worth reading afterwards.

import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import type { Advisor } from '../api/types';
import { adviceHref } from '../pages/advice-link';

export interface RaiseFromAdviceProps {
  /**
   * The advisory this finding was read from. Absent while nothing has been read.
   *
   * Absent means no link, rather than a link that cannot resolve: an action carries the advisory it
   * came from, and one raised without an id would be work whose reason nobody can look up.
   */
  readonly advisoryId?: string;
  readonly advisor: Advisor;
  /** The query shape, warehouse id or job id this finding was found on. */
  readonly resource: string;
  readonly rule: string;
  /** Primary when there is no exact Databricks destination beside this handoff. */
  readonly primary?: boolean;
}

export function RaiseFromAdvice({ advisoryId, advisor, resource, rule, primary = false }: RaiseFromAdviceProps) {
  if (advisoryId == null) return null;

  return (
    <Link
      className={primary ? 'wa-customer-primary-action' : 'wa-customer-secondary-action'}
      to={adviceHref('/improvements', { advisoryId, advisor, resource, rule })}
    >
      Add to improvement plan
      <ArrowRight aria-hidden className="ml-1 inline h-3 w-3" />
    </Link>
  );
}
