/** The deterministic customer states and render matrix owned by the `110f` visual release gate. */

export const CUSTOMER_PREVIEW_STATES = ['complete', 'sparse', 'empty', 'changed'] as const;
export type CustomerPreviewState = (typeof CUSTOMER_PREVIEW_STATES)[number];

/** The Dashboard also owns the completed-run state before a final assessment exists. */
export const DASHBOARD_PREVIEW_STATES = [
  ...CUSTOMER_PREVIEW_STATES,
  'automated',
  'automated-partial',
  'automated-composite',
  'automated-over-published',
] as const;

export const ASSESS_PREVIEW_STATES = ['loading', 'review', 'partial', 'published', 'empty', 'error'] as const;
export type AssessPreviewState = (typeof ASSESS_PREVIEW_STATES)[number];

export const OPERATE_PREVIEW_STATES = ['loading', 'attention', 'clean', 'partial', 'recovery'] as const;
export type OperatePreviewState = (typeof OPERATE_PREVIEW_STATES)[number];

export const CUSTOMER_ACCEPTANCE_WIDTHS = [
  { name: 'desktop', width: 1512, height: 845 },
  { name: 'laptop', width: 1280, height: 800 },
] as const;

export const CUSTOMER_ACCEPTANCE_THEMES = ['light', 'dark'] as const;

export const CUSTOMER_ACCEPTANCE_SURFACES = [
  { surface: 'dashboard', states: DASHBOARD_PREVIEW_STATES },
  { surface: 'assess', states: ASSESS_PREVIEW_STATES },
  { surface: 'investigate', states: CUSTOMER_PREVIEW_STATES },
  { surface: 'improvement', states: CUSTOMER_PREVIEW_STATES },
  { surface: 'operate', states: OPERATE_PREVIEW_STATES },
  { surface: 'report', states: CUSTOMER_PREVIEW_STATES },
] as const;

export type CustomerAcceptanceTheme = (typeof CUSTOMER_ACCEPTANCE_THEMES)[number];

export interface CustomerAcceptanceCase {
  readonly id: string;
  readonly surface: string;
  readonly state: string;
  readonly path: string;
}

export const CUSTOMER_ACCEPTANCE_CASES: readonly CustomerAcceptanceCase[] = CUSTOMER_ACCEPTANCE_SURFACES.flatMap(
  ({ surface, states }) =>
    states.map((state) => ({
      id: `${surface}-${state}`,
      surface,
      state,
      path: `/preview/${surface}/${state}`,
    }))
);

export const CUSTOMER_ACCEPTANCE_RENDER_COUNT =
  CUSTOMER_ACCEPTANCE_CASES.length * CUSTOMER_ACCEPTANCE_WIDTHS.length * CUSTOMER_ACCEPTANCE_THEMES.length;

export function acceptanceRenderId(
  one: CustomerAcceptanceCase,
  width: (typeof CUSTOMER_ACCEPTANCE_WIDTHS)[number],
  theme: CustomerAcceptanceTheme
): string {
  return `${one.id}-${width.name}-${theme}`;
}
