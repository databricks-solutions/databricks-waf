// Rerunning one pillar, with what it will do stated before it does it.
//
// A rerun costs the customer's warehouse real queries, so the control says what it will execute
// before offering to execute it — but in the label, not underneath it. The earlier version put two
// sentences of grey 12px text below the button: the query cost and a reassurance that other pillars
// are carried forward. In a panel header that is three lines of explanation attached to one control,
// and grey explanation text under a button is the exact signature this design system exists to
// remove. The cost is now three words in the label; the reassurance is the button's accessible
// description, where a reader who wants it finds it and a reader who does not is not charged for it.
//
// Only one run happens at a time across the whole app, so a pillar whose rerun is not the one in
// flight says which state it is in. A row of buttons that all look busy while one pillar is
// being measured is indistinguishable from a full scan.

import { RefreshCw } from 'lucide-react';
import { useAssessment } from '../api/assessment-context';
import { usePlan } from '../api/hooks';
import { costCount, costSentence } from '../pages/checks-language';
import { CollectingBadge } from './ui/StatusBadge';

export function RerunPillar({ pillarId }: { pillarId: string }) {
  const { runScan, scanning, scanningPillars, scanError } = useAssessment();
  const plan = usePlan();

  const pillar = plan.data?.pillars.find((candidate) => candidate.pillarId === pillarId);
  // Nothing to rerun for a pillar this build does not measure, and a button that started a run
  // which measured nothing would be worse than no button.
  if (pillar != null && !pillar.measured) return null;

  const mine = scanningPillars?.includes(pillarId) === true;
  const elsewhere = scanning && !mine;

  const describedBy = `rerun-${pillarId}-detail`;
  const cost = pillar == null ? undefined : costSentence(pillar.cost);

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="wa-button-secondary"
        onClick={() => {
          runScan({ pillars: [pillarId] });
        }}
        disabled={scanning}
        aria-describedby={describedBy}
      >
        <RefreshCw aria-hidden className="h-3.5 w-3.5" />
        Rerun
        {/* The cost, in the control that spends it. Muted so the label is still one word wide. */}
        {pillar != null && <span className="wa-caption font-normal">· {costCount(pillar.cost)}</span>}
      </button>

      {/*
        Referenced by the button rather than rendered beside it. Screen readers announce it with the
        control; sighted readers get it on hover from the title. Neither gets two lines of grey text
        wedged into a panel header.
      */}
      <span id={describedBy} className="sr-only">
        {cost} Every other pillar is carried forward from the latest scan unchanged, and will say so.
      </span>

      {mine && <CollectingBadge>Measuring</CollectingBadge>}
      {elsewhere && <span className="wa-caption">Another run is in flight</span>}
      {scanError != null && mine && <p className="wa-caption text-wa-warning">{scanError}</p>}
    </span>
  );
}
