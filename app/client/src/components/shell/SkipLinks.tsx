/**
 * The links that let a keyboard reader jump past a pane instead of tabbing through it.
 *
 * Three panes, three links, in the order they appear in the document: the navigation column, the
 * header's run controls, and the content. One link was not enough. The rail carries fourteen items
 * and, on the pillars page, eight more beneath them, and the header carries a theme toggle, an
 * export menu and a run button — so a reader arriving on a finding could be twenty-five tab stops
 * from the thing they came for, and a reader who wanted the export menu had to pass the whole rail
 * to reach it.
 *
 * Visible only when focused, which is WCAG 2.4.1's escape hatch and also the reason they are the
 * first thing in the document: a bypass mechanism that is not the first tab stop is not a bypass.
 * They stay in the tab order at all times (`sr-only`, never `display: none`) because a link that is
 * only added on focus cannot be focused.
 */
export function SkipLinks() {
  return (
    <div className="wa-skip-links">
      <a href="#navigation">Skip to navigation</a>
      <a href="#run-controls">Skip to run controls</a>
      <a href="#content">Skip to content</a>
    </div>
  );
}
