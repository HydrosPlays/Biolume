/**
 * "The keyboard belongs to a widget right now."
 *
 * Modals, open dropdowns and key-recording fields claim the keyboard while
 * they are active; `useLocalHotkeys` (and the Ctrl+1..6 view shortcuts) stand
 * down for as long as at least one claim is held, so typing a letter into an
 * open listbox never counts an encounter.
 */
import { useEffect } from 'react';

let claims = 0;

/** Claims the keyboard. Returns the (idempotent) release function. */
export function captureKeyboard(): () => void {
  claims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims = Math.max(0, claims - 1);
  };
}

/** Whether any widget currently holds the keyboard. */
export function isKeyboardCaptured(): boolean {
  return claims > 0;
}

/** Drops every claim (tests). */
export function resetKeyboardCapture(): void {
  claims = 0;
}

/** Holds a keyboard claim while `active` is true (and releases it on unmount). */
export function useKeyboardCapture(active: boolean): void {
  useEffect(() => (active ? captureKeyboard() : undefined), [active]);
}
