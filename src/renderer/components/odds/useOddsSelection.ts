/**
 * The odds selection the Odds view edits.
 *
 * With an active hunt it is that hunt's `odds`: edits show at once from a local
 * draft and are written back through `updateHunt` — immediately for discrete
 * choices, debounced for rapid number edits — and the main process stays the
 * source of truth (an outside change replaces the draft unless an edit of ours
 * is still waiting to be written). With no active hunt the view is a standalone
 * calculator on local state, remembered for the app session.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hunt, OddsSelection } from '@shared/types';
import { oddsEngine } from '@renderer/lib/oddsData';
import { actions, useActiveHunt } from '@renderer/store';

/** Quiet period after the last number edit before the hunt is written. */
export const ODDS_WRITE_DELAY_MS = 250;

/** The standalone calculator's selection survives leaving and re-opening the view. */
let standaloneSelection: OddsSelection | null = null;

/** Forgets the standalone calculator's remembered selection (tests). */
export function resetStandaloneSelection(): void {
  standaloneSelection = null;
}

function sameSelection(a: OddsSelection, b: OddsSelection): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function initialSelection(hunt: Hunt | null): OddsSelection {
  if (hunt) return oddsEngine.normalizeSelection(hunt.odds);
  return standaloneSelection ?? oddsEngine.defaultSelection();
}

/** Identity of what the store currently holds, to notice changes that did not come from this view. */
function sourceKey(hunt: Hunt | null): string {
  return hunt ? `${hunt.id}|${JSON.stringify(hunt.odds)}` : '';
}

export interface OddsSelectionBinding {
  /** The active hunt the selection is bound to, or null for the standalone calculator. */
  hunt: Hunt | null;
  /** Normalised selection to render from. */
  selection: OddsSelection;
  /**
   * Applies a new selection. `debounce` delays the write to the hunt (number
   * fields, slider drags); without it the hunt is written at once.
   */
  change: (next: OddsSelection, options?: { debounce?: boolean }) => void;
  /** Writes a debounced edit now (slider released, field blurred). */
  flush: () => void;
}

export function useOddsSelection(): OddsSelectionBinding {
  const hunt = useActiveHunt();
  const huntId = hunt?.id ?? null;

  const [draft, setDraft] = useState<OddsSelection>(() => initialSelection(hunt));
  const [syncedKey, setSyncedKey] = useState(() => sourceKey(hunt));
  /** True while an edit made here has not been handed to the main process yet. */
  const [dirty, setDirty] = useState(false);

  // Adopt outside changes (another hunt became active, an import, an undo) while
  // rendering, so no frame shows the stale draft. An unwritten edit of ours wins.
  const incomingKey = sourceKey(hunt);
  if (incomingKey !== syncedKey) {
    setSyncedKey(incomingKey);
    if (!dirty) {
      const incoming = initialSelection(hunt);
      if (!sameSelection(incoming, draft)) setDraft(incoming);
    }
  }

  const pendingRef = useRef<{ huntId: string; odds: OddsSelection } | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef(0);

  const flush = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) {
      if (inFlightRef.current === 0) setDirty(false);
      return;
    }
    // Stay "dirty" until the main process has answered: its change event for an
    // earlier write must not overwrite a newer edit that is still on its way.
    inFlightRef.current++;
    setDirty(true);
    void actions.updateHunt(pending.huntId, { odds: pending.odds }).then((saved) => {
      inFlightRef.current--;
      if (inFlightRef.current === 0 && pendingRef.current === null) setDirty(false);
      // The write failed (the action has already toasted why): show what the store holds.
      if (saved === null) setSyncedKey('');
    });
  }, []);

  const change = useCallback(
    (next: OddsSelection, options: { debounce?: boolean } = {}) => {
      const normalized = oddsEngine.normalizeSelection(next);
      setDraft(normalized);
      if (huntId === null) {
        standaloneSelection = normalized;
        return;
      }
      pendingRef.current = { huntId, odds: normalized };
      window.clearTimeout(timerRef.current);
      if (options.debounce === true) {
        setDirty(true);
        timerRef.current = window.setTimeout(flush, ODDS_WRITE_DELAY_MS);
      } else {
        flush();
      }
    },
    [huntId, flush],
  );

  // A pending edit belongs to the hunt it was made on: write it before the
  // binding moves to another hunt, and when the view closes.
  useEffect(() => flush, [huntId, flush]);

  return { hunt, selection: draft, change, flush };
}
