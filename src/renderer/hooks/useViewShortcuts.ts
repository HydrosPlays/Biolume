import { useEffect } from 'react';
import { VIEW_IDS } from '@shared/ipc';
import { isKeyboardCaptured } from './useKeyboardCapture';
import { navigate } from './useView';

/**
 * Ctrl+1 … Ctrl+6 (⌘ on macOS) switch between the views in `VIEW_IDS` order.
 * Works from text fields too, but not while a modal holds the keyboard.
 */
export function useViewShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const match = /^Digit([1-9])$/.exec(event.code);
      if (!match?.[1]) return;
      const view = VIEW_IDS[Number(match[1]) - 1];
      if (view === undefined || isKeyboardCaptured()) return;
      event.preventDefault();
      navigate(view);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
