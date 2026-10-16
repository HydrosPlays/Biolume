/**
 * The main window's current view, kept in `location.hash` as `#/<id>`.
 *
 * The hash is the source of truth, so views are deep-linkable, survive a
 * reload, and can be driven from outside (the smoke test sets `location.hash`).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { VIEW_IDS, type ViewId } from '@shared/ipc';

export const DEFAULT_VIEW: ViewId = 'hunt';

function isViewId(value: string): value is ViewId {
  return (VIEW_IDS as readonly string[]).includes(value);
}

/**
 * The view a hash addresses, or null when it names none. Only the first path
 * segment counts, so `#/log/sessions` and `#/log?hunt=3` both resolve to `log`.
 */
export function parseViewHash(hash: string): ViewId | null {
  const segment = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return isViewId(segment) ? segment : null;
}

/** The hash (and link `href`) of a view: `hunt` → `#/hunt`. */
export function viewHref(view: ViewId): string {
  return `#/${view}`;
}

/** The view currently addressed by the URL; unknown or empty hashes fall back to the default. */
export function getCurrentView(): ViewId {
  return parseViewHash(window.location.hash) ?? DEFAULT_VIEW;
}

/** Switches view from anywhere (event handlers, actions, toasts). */
export function navigate(view: ViewId): void {
  if (window.location.hash !== viewHref(view)) window.location.hash = viewHref(view);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/**
 * `[view, setView]` for the main window. Re-renders on every hash change,
 * whoever caused it.
 */
export function useView(): readonly [view: ViewId, setView: (view: ViewId) => void] {
  const view = useSyncExternalStore(subscribe, getCurrentView);

  useEffect(() => {
    // Rewrite an unknown or missing hash so the address always names the view on screen.
    if (parseViewHash(window.location.hash) === null) {
      window.history.replaceState(window.history.state, '', viewHref(DEFAULT_VIEW));
    }
  }, [view]);

  const setView = useCallback((next: ViewId) => navigate(next), []);
  return [view, setView] as const;
}
