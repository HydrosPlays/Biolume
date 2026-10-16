import { useEffect } from 'react';
import { useAppStore } from '@renderer/store/appStore';
import { toast, useUiStore } from '@renderer/store/uiStore';
import { useShinyFoundFeedback } from './useShinyFoundFeedback';

/** The sticky "Phase logged" toast that offers to name a quick-logged phase. */
function announcePhaseLogged(huntId: string, phaseId: string): void {
  toast.info('Phase logged', {
    id: `phase-logged:${phaseId}`,
    description: 'A shiny that is not your target — identify it when you have a moment.',
    duration: 0,
    action: {
      label: 'Identify',
      onClick: () => useUiStore.getState().openPhaseDialog({ huntId, phaseId }),
    },
  });
}

/**
 * Reacts to global hotkeys that fired while Biolume was in the background
 * (the main process has already applied them). Counts need no UI — the store
 * and the audio feedback follow the state events — but a few cases do:
 *   - a quick-logged phase is still unidentified, so a sticky toast offers to
 *     name it once the user is back — for the Stream Deck's Log Phase key too,
 *     which arrives as a state event rather than a hotkey action;
 *   - a count key pressed with no active hunt would otherwise fail silently;
 *   - Shiny Found needs a second press: its "press again" prompt and the
 *     completion toast come from {@link useShinyFoundFeedback}, mounted here
 *     because they serve global hotkeys and the Stream Deck alike.
 * Main window only; mount once.
 */
export function useGlobalHotkeyEvents(): void {
  useShinyFoundFeedback();

  useEffect(() => {
    return window.biolume.hotkeys.onAction((event) => {
      if (event.action === 'toggleOverlay') return;

      if (event.huntId === null) {
        toast.info('No active hunt', {
          id: 'hotkey-no-hunt',
          description: 'Start or select a hunt to count encounters.',
        });
        return;
      }

      if (event.action === 'logPhase' && event.phaseId !== undefined) {
        announcePhaseLogged(event.huntId, event.phaseId);
      }
    });
  }, []);

  useEffect(() => {
    // A direct store subscription: it must also follow events while React defers rendering.
    return useAppStore.subscribe((state, previous) => {
      const { lastChange } = state;
      if (lastChange === null || lastChange === previous.lastChange) return;
      const { change, huntId } = lastChange;
      if (
        change.kind === 'phase-logged' &&
        change.source === 'streamdeck' &&
        change.phaseId !== undefined
      ) {
        announcePhaseLogged(huntId, change.phaseId);
      }
    });
  }, []);
}
