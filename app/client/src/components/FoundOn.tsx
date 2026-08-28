// A named section of the inspector: which resources the finding was found on.
//
// The brief asks for affected resources as the fifth section of the finding inspector, between
// what was expected and the evidence records — see `docs/design/reference/prompts/06-finding-inspector.md`
// and gap register D1. It was a clause inside the Observed field until this row, which put the
// answer to *where is it* in three places on one pane and labelled two of them the same.
//
// It is not the brief's blast radius and it is not labelled as one. That phrase asserts what
// inherits the problem, and this app reads no edge between two resources — ADR 0082.

import { Surface } from './system';
import { foundOn, type FoundOnGroup } from './found-on';
import type { Evidence, Located, LocatedItem } from '../api/types';

export interface FoundOnSectionProps {
  readonly evidence: readonly Evidence[];
  /**
   * Which recorded destinations remain actions on the surface rendering this section.
   *
   * Record and report surfaces keep the URL as provenance. Investigate supplies the latest
   * workspace-directory decision so an unavailable historical destination remains named without
   * becoming a second, stale action below the governed closure panel.
   */
  readonly itemHref?: (item: LocatedItem) => string | undefined;
}

/**
 * The resources, once each, under the words the resolver used for them.
 *
 * Renders nothing where a finding names none, which is most of them: a control measuring a share of
 * the estate names members only where some fell short.
 */
export function FoundOnSection({ evidence, itemHref = (item) => item.url }: FoundOnSectionProps) {
  const found = foundOn(evidence);
  if (found == null) return null;

  return (
    <Surface
      tone="raised"
      title="Resources this was found on"
      {...(found.named != null ? { description: countOf(found.named) } : {})}
      headingLevel={3}
    >
      {found.groups.map((group) => (
        <p key={group.lead} className="wa-body-compact text-wa-text">
          <Group group={group} itemHref={itemHref} />
        </p>
      ))}
    </Surface>
  );
}

/**
 * How many resources are named.
 *
 * Only ever a count of the items above it, which is why it is absent whenever the server truncated
 * a list: see `found-on.ts`. "Named" rather than "found", because the second would be a claim about
 * the estate and this is a count of what is on the screen.
 */
function countOf(named: number): string {
  return `${named.toLocaleString('en-US')} named`;
}

function Group({
  group,
  itemHref,
}: {
  readonly group: FoundOnGroup;
  readonly itemHref: FoundOnSectionProps['itemHref'];
}) {
  return (
    <>
      {group.lead}:{' '}
      {group.items.map((item, index) => (
        <span key={`${item.label}-${String(index)}`}>
          {index > 0 && ', '}
          <Item item={item} href={itemHref?.(item)} />
        </span>
      ))}
      {/* The server's own disclosure, kept as the server's own words. It says the list is a
          sample of the resources this was found on, which is the one thing a reader cannot
          infer from a list. */}
      {group.more != null && ` and ${group.more.toLocaleString('en-US')} more`}
    </>
  );
}

function Item({ item, href }: { readonly item: LocatedItem; readonly href?: string }) {
  return (
    <>
      {/* Underlined, not coloured alone. Against body text at this size the action colour is
          under a 3:1 ratio in the dark theme, and a sentence where four of five names are
          links needs the affordance to survive a reader who cannot see the difference. */}
      {href != null ? (
        <a
          className="text-wa-action underline decoration-wa-action/40 underline-offset-2 hover:decoration-wa-action"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {item.label}
        </a>
      ) : (
        item.label
      )}
      {aside(item)}
    </>
  );
}

/**
 * Where a resource is and why it is here, in one parenthesis, outside the link.
 *
 * Must produce the same words as the server's own sentence — see `describeItem` — because the two
 * are read side by side: this pane and the spreadsheet exported from it.
 */
function aside(item: Pick<Located['items'][number], 'in' | 'note'>): string {
  const parts = [item.in, item.note].filter((part) => part != null);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}
