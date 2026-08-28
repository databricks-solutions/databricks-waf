// The resources a finding was found on, gathered from its evidence into one list.
//
// `EvidencePayload.at` arrives per evidence row, because that is where the resolver produced it:
// `offenders()` names the members of the estate that fall short and returns them beside the
// sentence that counted them. Read down the pane that put a finding's resources in three places,
// under three labels, in the order the resolver happened to emit them — and the auto-termination
// requirement put the same label, *Without it*, on two of them.
//
// So this folds them, and the folding is the whole of what this module decides. What it may say is
// bounded by `LocatedPayload` and by nothing else:
//
// - **A resource appears once under a lead.** Two evidence rows sharing a lead are one list, not
//   two, and a resource named by both is named once in it. The identity is the kind, the label and
//   the workspace — see `identity` for why all three, and for what the auto-termination requirement
//   does to a fold keyed on the name alone. The link and the note come from the first mention,
//   because both are derived from the same row on the server.
// - **Across two different leads it appears twice, and that is not a duplicate.** A cluster that is
//   both on GPU nodes and never auto-terminating is two findings' worth of fact about one resource,
//   and dropping it from the second list would make that list's sentence false about an estate it
//   is describing. The count is distinct, so the same resource is never counted twice.
// - **A count comes only from the items, and only where nothing was truncated.** The server names
//   five per row and reports the rest as `more`, so a total over a truncated list would be a
//   count of what the reader can see presented as a count of what exists. Where any row truncated,
//   there is no count — the disclosure is the server's own "and N more" instead.
// - **Nothing here says what a resource inherits, propagates or costs.** `LocatedPayload` carries a
//   label, a workspace, a note and a URL. It carries no edges, and the app reads none: ADR 0082 is
//   why this section is not the brief's blast radius and may not be labelled as one.

import type { Evidence, LocatedItem } from '../api/types';

export interface FoundOnGroup {
  /** The server's own words for why these are here, as it wrote them. */
  readonly lead: string;
  readonly items: readonly LocatedItem[];
  /**
   * How many the server did not name, summed over the rows folded into this group.
   *
   * A sum across rows sharing a lead, which is a count of unnamed resources of the same kind and
   * reads as one. It is never a count of anything a reader can see.
   */
  readonly more?: number;
}

export interface FoundOn {
  readonly groups: readonly FoundOnGroup[];
  /**
   * How many resources are named, once each.
   *
   * Absent where any group truncated, because then the named ones are a sample and a number beside
   * the heading would be read as the size of the problem.
   */
  readonly named?: number;
}

/**
 * The located resources across a finding's evidence, or nothing where it names none.
 *
 * Order is the resolver's: the first row to carry a lead fixes where that lead sits, so the list
 * follows the argument the finding makes rather than the alphabet.
 */
export function foundOn(evidence: readonly Evidence[]): FoundOn | undefined {
  interface Gathering {
    readonly lead: string;
    readonly items: LocatedItem[];
    readonly under: Set<string>;
    unnamed: number;
  }

  const gathered: Gathering[] = [];
  const byLead = new Map<string, Gathering>();
  const distinct = new Set<string>();

  for (const one of evidence) {
    const at = one.at;
    if (at == null) continue;

    let group = byLead.get(at.lead);
    if (group == null) {
      group = { lead: at.lead, items: [], under: new Set(), unnamed: 0 };
      byLead.set(at.lead, group);
      gathered.push(group);
    }

    for (const item of at.items) {
      const key = identity(item);
      if (group.under.has(key)) continue;
      group.under.add(key);
      distinct.add(key);
      group.items.push(item);
    }

    group.unnamed += at.more ?? 0;
  }

  if (gathered.length === 0) return undefined;

  const groups = gathered.map((group) => ({
    lead: group.lead,
    items: group.items,
    ...(group.unnamed > 0 ? { more: group.unnamed } : {}),
  }));

  const truncated = groups.some((group) => group.more != null);
  return { groups, ...(truncated ? {} : { named: distinct.size }) };
}

/**
 * What makes two mentions the same resource.
 *
 * The kind, the label and the workspace. Two resources of the same name in different workspaces
 * are two resources, which is why `in` is in the key — the server puts it there for the same
 * reason. The kind is in it because a name is not unique across kinds either: the auto-termination
 * requirement folds clusters and warehouses under one lead, and an estate with a cluster and a
 * warehouse both called `analytics` would otherwise lose one of them from the list and from the
 * count.
 *
 * Not the URL, as the primary key: a resource whose workspace URL could not be read has none, and
 * keying on one would name it twice on a finding that mentions it twice. It stands in for the kind
 * on a record written before the field existed, where it distinguishes the same two cases — the
 * route it points at carries the kind.
 */
function identity(item: LocatedItem): string {
  const kind = item.kind ?? item.url ?? '';
  return `${kind}\u0000${item.label}\u0000${item.in ?? ''}`;
}
