// Status, in two channels: a word and a shape.
//
// The design system's rule is that colour alone is insufficient, and the previous badges met
// only half of it — they carried the word but leaned on a tinted fill to distinguish six
// outcomes from each other. That fails twice over: for a colour-blind reader, and for anyone
// scanning a list of forty rows, where a word has to be read but a shape resolves peripherally.
//
// The icons are chosen to differ in silhouette rather than in detail, because at 14px only the
// outline survives: a tick, a cross, a half-filled circle, a question mark, a slash, a shield.
//
// Every status in the app renders through `Badge` below, and `Badge` cannot be called without an
// icon — which is what makes the rule hold rather than being a thing to remember. Six other badge
// components had grown up beside these ones carrying a word and a fill and nothing else: severity
// below high, decision standing, a serverless verdict, whether a requirement had been answered, and
// the scan state in the header. Each one was a status a reader could only tell apart by hue.
//
// The `data-status` attribute is how `scripts/check-a11y.mjs` finds them in the rendered page. An
// element that declares it is asserting that it conveys a status, and the gate holds it to carrying
// both channels: text a screen reader can read, and a shape that survives at 14px in greyscale.

import {
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Clock,
  Info,
  Loader2,
  MessageSquareQuote,
  OctagonAlert,
  ShieldCheck,
  SignalHigh,
  SignalLow,
  SignalMedium,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Outcome, Severity } from '@/api/types';
import { OUTCOME_LABEL, SEVERITY_LABEL } from '../verdict-language';

/**
 * The five fills a status may take.
 *
 * Exported because the tone belongs beside the icon in whichever language file names both — a badge
 * whose colour is decided in one file and whose shape in another is how the two came to disagree.
 */
export type Tone = 'neutral' | 'danger' | 'warning' | 'success' | 'info';

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: '',
  danger: 'wa-badge-danger',
  warning: 'wa-badge-warning',
  success: 'wa-badge-success',
  info: 'wa-badge-info',
};

interface Presentation {
  readonly tone: Tone;
  readonly Icon: LucideIcon;
}

/**
 * Tone by meaning, not by sentiment.
 *
 * Unmeasured is neutral rather than amber on purpose: it is a gap in what the tool could see,
 * not a gap in the estate, and colouring it as a warning teaches people to read their own blind
 * spots as findings. Not-applicable is neutral for the same reason in reverse — it is not a
 * quiet pass and must not look like one.
 */
const OUTCOME_PRESENTATION: Readonly<Record<Outcome, Presentation>> = {
  pass: { tone: 'success', Icon: CheckCircle2 },
  'satisfied-by-architecture': { tone: 'success', Icon: ShieldCheck },
  partial: { tone: 'warning', Icon: CircleDashed },
  fail: { tone: 'danger', Icon: XCircle },
  unmeasurable: { tone: 'neutral', Icon: CircleHelp },
  'not-applicable': { tone: 'neutral', Icon: Ban },
};

/**
 * Severity as a ramp, because severity is a rank rather than a set of states.
 *
 * Three bars, two bars, one bar: a reader comparing two rows is being asked which is worse, and a
 * ramp answers that from the silhouette. Critical breaks the ramp deliberately — it is the one that
 * has to stop a reader rather than take its place in an ordering — and informational is not on the
 * scale at all, being a note rather than a degree of risk.
 */
const SEVERITY_ICON: Readonly<Record<Severity, LucideIcon>> = {
  critical: OctagonAlert,
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
  informational: Info,
};

/**
 * Severity carries no fill below high.
 *
 * A list where every row is tinted has no emphasis left to spend on the rows that deserve it.
 * Critical and high are coloured; medium, low and informational state their word and stop.
 */
const SEVERITY_TONE: Readonly<Record<Severity, Tone>> = {
  critical: 'danger',
  high: 'warning',
  medium: 'neutral',
  low: 'neutral',
  informational: 'neutral',
};

function badgeClass(tone: Tone, className?: string): string {
  return ['wa-badge', TONE_CLASS[tone], className].filter((part) => part != null && part !== '').join(' ');
}

export interface BadgeProps {
  readonly tone: Tone;
  readonly Icon: LucideIcon;
  readonly children: ReactNode;
  readonly title?: string;
  readonly className?: string;
}

/**
 * The one way this app draws a status.
 *
 * `Icon` is required rather than optional, which is the whole point: a badge that could omit its
 * shape is a badge that will, on the status somebody adds in a hurry. The icon is `aria-hidden`
 * because the word beside it already says the same thing, and announcing both would read as
 * "critical critical".
 */
export function Badge({ tone, Icon, children, title, className }: BadgeProps) {
  return (
    <span data-status className={badgeClass(tone, className)} {...(title != null ? { title } : {})}>
      <Icon aria-hidden className="h-3 w-3 shrink-0" />
      {children}
    </span>
  );
}

export function OutcomeBadge({ outcome, className }: { outcome: Outcome; className?: string }) {
  const { tone, Icon } = OUTCOME_PRESENTATION[outcome];
  return (
    <Badge tone={tone} Icon={Icon} className={className}>
      {OUTCOME_LABEL[outcome]}
    </Badge>
  );
}

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Badge tone={SEVERITY_TONE[severity]} Icon={SEVERITY_ICON[severity]} className={className}>
      {SEVERITY_LABEL[severity]}
    </Badge>
  );
}

/**
 * The outcome beside this rests on somebody's statement rather than on a measurement.
 *
 * Beside the outcome badge and not instead of it, because the outcome is still the outcome — the
 * requirement is met or it is not. What this adds is the basis, and it has to travel with the
 * verdict everywhere the verdict goes. A green tick in a list of forty that came from an answered
 * question, presented identically to thirty-nine observations, is the single change that would make
 * the whole assessment unreliable, and it would be invisible.
 */
export function AttestedBadge({ children = 'Attested' }: { children?: string }) {
  return (
    <Badge tone="info" Icon={MessageSquareQuote} title="Answered by a person. Not observed by this app.">
      {children}
    </Badge>
  );
}

/** Evidence older than the reader is likely to assume. Its own status, not an outcome. */
export function StaleBadge({ children }: { children: string }) {
  return (
    <Badge tone="warning" Icon={Clock}>
      {children}
    </Badge>
  );
}

/** A scan in flight. Announced elsewhere in a live region; this is the visual half. */
export function CollectingBadge({ children = 'Collecting' }: { children?: string }) {
  // The one permitted spin. Reduced-motion callers get a static icon, because the reduced-motion
  // rule in wa-tailwind.css flattens the animation globally.
  return (
    <Badge tone="info" Icon={Loader2} className="[&>svg]:animate-spin">
      {children}
    </Badge>
  );
}

/** A control id, a signal name, a resource path. Monospaced so it can be compared by eye. */
export function IdentifierBadge({ children }: { children: string }) {
  return <span className={badgeClass('neutral', 'wa-code font-normal')}>{children}</span>;
}
