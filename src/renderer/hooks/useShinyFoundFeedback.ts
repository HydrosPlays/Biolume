/**
 * Toasts for the two-press Shiny Found, whatever sent the presses — an in-app
 * hotkey, a global hotkey while the game has focus, or a Stream Deck key:
 *
 *   - armed: "Press again to confirm Shiny Found", for as long as the window
 *     is open — only while this window is visible (nobody can read it hidden);
 *   - confirmed or expired: that toast goes away;
 *   - completed by a confirming press: "Shiny found!" with Undo, exactly like
 *     the Hunt view's own button offers (that one raises its toast itself).
 *
 * Driven by the store (`shinyArmed`, `lastChange`), i.e. by events from the
 * main process. Main window only — mounted through `useGlobalHotkeyEvents`.
 */
import { useEffect } from 'react';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import { huntTotal, type CounterSource } from '@shared/types';
import { formatAccelerator } from '@renderer/lib/accelerator';
import { formatCount } from '@renderer/lib/format';
import * as actions from '@renderer/store/actions';
import {
  selectHunt,
  shinyArmedRemaining,
  useAppStore,
  type AppStoreState,
  type ShinyArmedState,
} from '@renderer/store/appStore';
import { toast } from '@renderer/store/uiStore';

/** Sources that go through the two-press confirmation (the Hunt view's button does not). */
const CONFIRMING_SOURCES: ReadonlySet<CounterSource> = new Set([
  'hotkey-local',
  'hotkey-global',
  'streamdeck',
]);

/** Toast id of a hunt's "press again" prompt. */
export function shinyArmedToastId(huntId: string): string {
  return `shiny-armed:${huntId}`;
}

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/** "Press F16 again …" / "Press Shiny Found on your Stream Deck again …", in seconds. */
export function describeArmedPrompt(
  source: CounterSource,
  shinyFoundBindings: readonly string[],
  remainingMs: number,
  huntName: string | null,
): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const press =
    source === 'streamdeck'
      ? 'Press Shiny Found on your Stream Deck'
      : (source === 'hotkey-global' || source === 'hotkey-local') &&
          shinyFoundBindings[0] !== undefined
        ? `Press ${formatAccelerator(shinyFoundBindings[0]).join(' + ')}`
        : 'Press Shiny Found';
  const target = huntName === null ? 'the hunt' : `“${huntName}”`;
  return `${press} again within ${seconds} s to complete ${target}.`;
}

function announceArmed(state: AppStoreState, huntId: string, entry: ShinyArmedState): void {
  if (!isDocumentVisible()) return;
  const remainingMs = shinyArmedRemaining(entry, Date.now());
  if (remainingMs <= 0) return;
  const hunt = selectHunt(state, huntId);
  toast.warning('Press again to confirm Shiny Found', {
    id: shinyArmedToastId(huntId),
    description: describeArmedPrompt(
      entry.source,
      state.settings.hotkeys.bindings.shinyFound,
      Math.min(remainingMs, SHINY_CONFIRM_WINDOW_MS),
      hunt?.name ?? null,
    ),
    duration: remainingMs,
  });
}

function announceCompleted(state: AppStoreState, huntId: string): void {
  const hunt = selectHunt(state, huntId);
  if (hunt === null) return;
  // Same id as the Hunt view's own completion toast, so the two never stack.
  toast.success('Shiny found!', {
    id: `hunt-completed:${huntId}`,
    description: `${hunt.name} · ${formatCount(huntTotal(hunt))} encounters`,
    action: { label: 'Undo', onClick: () => void actions.undoHunt(huntId) },
  });
}

/** Installs the Shiny Found confirmation toasts for this window. Main window only; mount once. */
export function useShinyFoundFeedback(): void {
  useEffect(() => {
    if (window.biolume.windowKind !== 'main') return undefined;

    // A direct store subscription: it must also follow events while React defers rendering.
    return useAppStore.subscribe((state, previous) => {
      if (state.shinyArmed !== previous.shinyArmed) {
        for (const [huntId, entry] of Object.entries(state.shinyArmed)) {
          if (previous.shinyArmed[huntId]?.armedUntil === entry.armedUntil) continue;
          announceArmed(state, huntId, entry);
        }
        for (const huntId of Object.keys(previous.shinyArmed)) {
          if (!(huntId in state.shinyArmed)) toast.dismiss(shinyArmedToastId(huntId));
        }
      }

      const { lastChange } = state;
      if (
        lastChange !== null &&
        lastChange !== previous.lastChange &&
        lastChange.change.kind === 'completed' &&
        CONFIRMING_SOURCES.has(lastChange.change.source)
      ) {
        toast.dismiss(shinyArmedToastId(lastChange.huntId));
        announceCompleted(state, lastChange.huntId);
      }
    });
  }, []);
}
