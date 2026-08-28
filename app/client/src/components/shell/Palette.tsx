// ⌘K, and the reason the app needs one.
//
// There are twenty-one routes and a hundred and eighty-four requirements. Every one of them is
// reachable — that is what the rail, the filters and the drill-through links are for — but reaching a
// named requirement takes a page, a filter and a scroll, and the reader who does that already knows
// which one they want. A palette is the shortest path between knowing the name of a thing and
// standing on it, and it is the only navigation in the app that does not require knowing where the
// thing was filed.
//
// It goes places and does nothing. See `PaletteEntry` for why there is no "run a scan" row.
//
// The listbox is written here rather than taken from AppKit's `Command`, which would have supplied
// one. Two reasons, both about what the checks can see: cmdk renders an unlabelled search glyph and
// a heading outside the dialog content, so `npm run check:a11y` fails on a surface we cannot pass
// props to; and its own filtering is a fuzzy score, where this app matches whole words on purpose
// (`palette-search.ts`). What is taken from AppKit is the dialog — the portal, the scrim, the focus
// trap, Escape, and returning focus to the button afterwards — which is the part worth not writing.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@databricks/appkit-ui/react';
import { Search } from 'lucide-react';
import { useAssessment } from '../../api/assessment-context';
import { PaletteList } from './PaletteList';
import { paletteEntries, paletteResults, searchElsewhere } from './palette-search';
import type { Outcome } from '../../api/types';

/** One row of the list, whichever kind it is. The fallback row is one of these too. */
interface PaletteRow {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  readonly detail?: string;
  readonly outcome?: Outcome;
}

/**
 * Which modifier this reader's keyboard has.
 *
 * Read once, and defaulted to Control rather than to Command: a printed shortcut that is wrong is
 * worse than a generic one, and Control is right everywhere except one platform which this correctly
 * detects. Both are bound regardless — see `onKeyDown` below — so the only thing at stake is the
 * caption.
 */
const MOD = /mac|darwin|iphone|ipad/i.test(
  typeof navigator === 'undefined' ? '' : `${navigator.platform ?? ''} ${navigator.userAgent}`
)
  ? '⌘'
  : 'Ctrl ';

export function Palette() {
  const [open, setOpen] = useState(false);

  /*
   * The keystroke, on the document rather than on the shell's own element.
   *
   * Both modifiers are bound whatever the caption says, because a workspace is opened from a Mac and
   * from Windows by the same two people and neither should have to learn the other's key. Defaulted
   * rather than prevented only on match: `preventDefault` is needed because Firefox gives ⌘K to its
   * own search bar, and a shortcut the browser eats is a shortcut that appears broken.
   */
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      setOpen((was) => !was);
    };
    document.addEventListener('keydown', listen);
    return () => document.removeEventListener('keydown', listen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/*
         * A button and not only a shortcut. A keystroke nothing on screen mentions is a feature for
         * the person who wrote it: the reader this app is for opens it once a quarter, and the header
         * is where they will look for a search box because that is where every other tool puts one.
         * The key is printed on it so the second visit costs nothing.
         */}
        <button type="button" className="wa-button-secondary" aria-keyshortcuts="Meta+K Control+K">
          <Search aria-hidden className="h-3.5 w-3.5" />
          Search
          <span aria-hidden className="wa-key ml-1 hidden md:inline-flex">
            {MOD}K
          </span>
        </button>
      </DialogTrigger>

      {/*
       * Mounted only while open, which is what resets the query between visits. A palette that
       * reopens showing the last thing somebody typed is a palette whose first keystroke is Backspace.
       */}
      <DialogContent className="wa-palette" showCloseButton={false}>
        <DialogTitle className="sr-only">Go to</DialogTitle>
        <DialogDescription className="sr-only">
          Search the pages, the pillars and the requirements, and press Enter to go there.
        </DialogDescription>
        <PaletteBody onLeave={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({ onLeave }: { readonly onLeave: () => void }) {
  const { catalogue, scan } = useAssessment();
  const navigate = useNavigate();
  const list = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');

  const entries = useMemo(() => paletteEntries(catalogue, scan), [catalogue, scan]);
  const groups = useMemo(() => paletteResults(entries, query), [entries, query]);
  const fallback = searchElsewhere(query);

  const rows: readonly PaletteRow[] = useMemo(
    () => [
      ...groups.flatMap((group) => group.entries),
      ...(fallback == null ? [] : [{ id: 'elsewhere', label: fallback.label, to: fallback.to }]),
    ],
    [groups, fallback]
  );

  /*
   * The active row, and the query it was chosen for.
   *
   * Compared during render rather than reset in an effect, for the reason the pager gives at length in
   * ui/paging.ts: an effect paints the stale selection first, and here that is a visible highlight on
   * the row that was under the cursor before the last keystroke — which is the row Enter would have
   * taken, so it is not merely a flicker.
   */
  const [chosen, setChosen] = useState({ at: 0, of: query });
  if (chosen.of !== query) setChosen({ at: 0, of: query });
  const at = Math.min(chosen.of === query ? chosen.at : 0, Math.max(rows.length - 1, 0));
  const active = rows[at];

  const move = (to: number) => {
    if (rows.length === 0) return;
    const wrapped = ((to % rows.length) + rows.length) % rows.length;
    setChosen({ at: wrapped, of: query });
    // The list is 320px and the results are not, so the arrow keys have to carry the viewport with
    // them. `nearest` rather than `center`, which would scroll on every keypress in a short list.
    requestAnimationFrame(() => {
      list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  };

  const go = (row?: PaletteRow) => {
    if (row == null) return;
    onLeave();
    void navigate(row.to);
  };

  return (
    <div
      onKeyDown={(event) => {
        // Escape and Tab are the dialog's own, and the dialog is holding focus in here on purpose.
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(at + 1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(at - 1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          move(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          move(rows.length - 1);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          go(active);
        }
      }}
    >
      {/*
       * A combobox over a listbox, which is the pattern for a field whose value is a filter and whose
       * result is a choice. The rows are never focused: they are named as the active option and the
       * field keeps focus, so a screen reader reads the row on each arrow press without the browser
       * having to move anything.
       */}
      <input
        // Autofocused because the dialog exists to be typed into. Radix would focus this first
        // anyway; saying so keeps it true if a second control is ever added above it.
        autoFocus
        type="text"
        role="combobox"
        aria-expanded
        aria-controls="wa-palette-list"
        aria-autocomplete="list"
        {...(active != null ? { 'aria-activedescendant': `wa-palette-${active.id}` } : {})}
        aria-label="Go to a page, a pillar or a requirement"
        className="wa-palette-field"
        placeholder="Go to a page, a pillar or a requirement"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div ref={list}>
        <PaletteList
          groups={groups}
          {...(fallback != null ? { fallback: fallback.label } : {})}
          activeId={active?.id}
          onPick={(id) => go(rows.find((row) => row.id === id))}
        />
      </div>

      <div className="wa-palette-foot">
        <span className="wa-caption">
          {rows.length === 0
            ? 'Nothing by that name'
            : `${String(rows.length)} ${rows.length === 1 ? 'result' : 'results'}`}
        </span>
        {/*
          The three keys, as a legend, and hidden from the accessibility tree in full.
          
          Not because the keys do not matter to a screen reader, but because they are the ones its
          reader already has: the combobox role announces that the arrows move through the options, and
          Escape closing a dialog is the platform's convention rather than this app's invention. Read
          aloud, this line is six words of instruction between the result count and the results.
        */}
        <span aria-hidden className="wa-caption flex items-center gap-1.5">
          <Legend keys="↑↓" does="to move" />
          <Legend keys="↵" does="to go" />
          <Legend keys="Esc" does="to close" />
        </span>
      </div>
    </div>
  );
}

function Legend({ keys, does }: { readonly keys: string; readonly does: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="wa-key">{keys}</span>
      {does}
    </span>
  );
}
