// One page shape, so seven pages cannot be seven widths.
//
// They were: 4xl on findings, 5xl on checks and runs, 6xl on pillars, 7xl on the overview. The
// effect is not subtle when moving between them — the content edge jumps left and right on every
// navigation, and because the chrome column stays put the whole page appears to shift under the
// reader. Worse, the widest page was the densest one, so the eye had to travel furthest exactly
// where the most comparison was being asked of it.
//
// The measure and the gutters are now the shell's, in --wa-measure and .wa-page, which is why this
// component has almost nothing left in it: there is one width, one canvas padding and one vertical
// rhythm between regions, and a page gets all three by being a page.
//
// It takes no intro prose. Every page had a sentence explaining itself under its own title — "Each
// pillar scored on its own requirements, weighted by severity, beside how much of it this scan could
// answer" — and a paragraph of 13px grey text between the title and the content is the thing that
// makes a tool read as generated. What a column means belongs in the column header; what a number
// means belongs beside the number.

import type { ReactNode } from 'react';

export interface PageProps {
  /** Filters, a view switch, or a page-level action. Sits above the content, right-aligned. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function Page({ actions, children }: PageProps) {
  return (
    <div className="wa-page">
      {actions != null && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      {children}
    </div>
  );
}
