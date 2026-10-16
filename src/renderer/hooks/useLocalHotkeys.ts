/**
 * In-app hotkeys.
 *
 * While a Biolume window has focus the main process unregisters its OS-wide
 * shortcuts (`HotkeyMode` `app-focused`) so that keys such as Space stay
 * typeable in text fields; this hook handles the very same bindings from DOM
 * keyboard events instead.
 *
 * A binding wins over whatever control happens to hold focus — after clicking
 * a button, the count key must still count — except when:
 *   - the event comes from an editable target ({@link isEditableTarget}),
 *   - a modal / open dropdown / key recorder holds the keyboard
 *     (`useKeyboardCapture`), or main reports `capturing`,
 *   - the key is auto-repeating (holding a key counts once — and can never
 *     arm and confirm Shiny Found in one go).
 */
import { useEffect } from 'react';
import type { HotkeyAction, WindowKind } from '@shared/types';
import { getPlatform, matchBinding } from '@renderer/lib/accelerator';
import * as actions from '@renderer/store/actions';
import { getActiveHunt, useAppStore } from '@renderer/store/appStore';
import { toast, useUiStore } from '@renderer/store/uiStore';
import { isKeyboardCaptured } from './useKeyboardCapture';

const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);

/**
 * Whether a keyboard event target is somewhere the user types: `input`,
 * `textarea`, `select`, anything `contenteditable`, the ARIA text roles — or
 * any element inside a `data-hotkeys="off"` container (an explicit opt-out for
 * custom widgets that need raw keys).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-hotkeys="off"]')) return true;
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const role = target.getAttribute('role');
  return role !== null && EDITABLE_ROLES.has(role);
}

function noActiveHunt(): void {
  toast.info('No active hunt', {
    id: 'hotkey-no-hunt',
    description: 'Start or select a hunt to count encounters.',
    duration: 2600,
  });
}

/** Performs a hotkey action against the active hunt, exactly like the matching global shortcut. */
export async function runHotkeyAction(action: HotkeyAction, windowKind: WindowKind): Promise<void> {
  if (action === 'toggleOverlay') {
    await actions.toggleOverlay();
    return;
  }

  const hunt = getActiveHunt();
  if (!hunt) {
    noActiveHunt();
    return;
  }

  switch (action) {
    case 'increment':
      await actions.incrementHunt(hunt, 'hotkey-local');
      return;
    case 'decrement':
      await actions.decrementHunt(hunt, 'hotkey-local');
      return;
    case 'undo':
      await actions.undoHunt(hunt.id);
      return;
    case 'shinyFound':
      // Never completes on its own: the first press arms, a second one within
      // SHINY_CONFIRM_WINDOW_MS confirms (main decides which one this is).
      if (hunt.status === 'completed') {
        toast.info('Shiny already found', {
          id: 'hotkey-shiny-already-found',
          description: `${hunt.name} is complete. Reopen it from the Hunt view to keep counting.`,
          duration: 2600,
        });
        return;
      }
      await actions.requestShinyFound(hunt.id, 'hotkey-local');
      return;
    case 'logPhase':
      if (windowKind === 'main') {
        useUiStore.getState().openPhaseDialog({ huntId: hunt.id });
      } else {
        // The overlay has no dialog: quick-log an unidentified phase, like the global shortcut.
        await actions.logPhase(hunt.id, {
          speciesId: null,
          speciesName: '',
          source: 'hotkey-local',
        });
      }
      return;
  }
}

export interface LocalHotkeysOptions {
  /** Set false to detach the listener (default true). */
  enabled?: boolean;
}

/** Installs the in-app hotkey listener for this window. Mount once, near the root. */
export function useLocalHotkeys({ enabled = true }: LocalHotkeysOptions = {}): void {
  useEffect(() => {
    if (!enabled) return undefined;

    const platform = getPlatform();
    const windowKind = window.biolume.windowKind;
    /** Codes whose keydown we consumed; their keyup must not reach the focused control either. */
    const consumed = new Set<string>();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const state = useAppStore.getState();
      if (!state.ready || state.hotkeyStatus.mode === 'capturing') return;
      if (isKeyboardCaptured() || isEditableTarget(event.target)) return;

      const action = matchBinding(state.settings.hotkeys.bindings, event, platform);
      if (action === null) return;

      // Ours: keep Space / Enter from also activating a focused button or scrolling the page.
      event.preventDefault();
      event.stopPropagation();
      consumed.add(event.code);
      if (event.repeat) return;
      void runHotkeyAction(action, windowKind);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (!consumed.delete(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const onBlur = (): void => consumed.clear();

    // Capture phase: run before focused widgets so a binding behaves the same everywhere.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled]);
}
