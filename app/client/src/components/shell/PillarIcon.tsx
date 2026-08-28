// An icon per pillar.
//
// The design system forbids a colour per pillar, and is right to: seven accent hues turn every
// status colour into noise, because the reader can no longer tell whether orange means Cost
// Optimization or means a warning. An icon carries no such load — it is a shape, the status
// colours stay the only colours that mean anything, and a reader who has learned the shield
// finds Security in a list of seven without reading.
//
// Reliability and Security deliberately do not share a shield. They are the two pillars most
// often mistaken for each other, and giving them the same silhouette would make the icons worse
// than none at all.
//
// Exported as a component that takes a pillar id, rather than as a function returning the icon
// component to render. That is not a style preference: a component looked up during another
// component's render is indistinguishable, to React and to the lint rule that enforces this, from
// a component *defined* during render — which remounts and loses its state on every pass. Keeping
// the lookup inside one small component makes every caller's reference static.

import { CircleDot, Coins, Gauge, HeartPulse, Plug, ServerCog, ShieldCheck, Table2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ICONS: Readonly<Record<string, LucideIcon>> = {
  'cost-optimization': Coins,
  'data-and-ai-governance': Table2,
  'interoperability-and-usability': Plug,
  'operational-excellence': ServerCog,
  'performance-efficiency': Gauge,
  reliability: HeartPulse,
  'security-compliance-and-privacy': ShieldCheck,
};

export interface PillarIconProps {
  readonly pillarId: string;
  /** Sized by the caller, because a rail row and a card heading want different sizes. */
  readonly className?: string;
}

/** A pillar's mark. Decorative by definition — the pillar's name is always beside it. */
export function PillarIcon({ pillarId, className = 'h-4 w-4' }: PillarIconProps): React.JSX.Element {
  // A pillar added upstream appears with a neutral mark rather than breaking the page.
  const Icon = ICONS[pillarId] ?? CircleDot;
  return <Icon aria-hidden className={className} />;
}
