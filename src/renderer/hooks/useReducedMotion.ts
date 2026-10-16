import { useEffect, useSyncExternalStore } from 'react';
import { useAppStore } from '@renderer/store/appStore';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Live result of a CSS media query; false where `matchMedia` is unavailable. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
  );
}

/**
 * Whether motion should be minimised: `settings.general.reducedMotion` when it
 * is `on` / `off`, the OS preference when it is `system`. CSS animations are
 * handled globally (see {@link useMotionPreference}); use this for motion
 * driven from JavaScript — canvases, timers, count-up effects.
 */
export function useReducedMotion(): boolean {
  const preference = useAppStore((state) => state.settings.general.reducedMotion);
  const system = useMediaQuery(REDUCED_MOTION_QUERY);
  return preference === 'on' || (preference === 'system' && system);
}

/**
 * Mirrors `settings.general.reducedMotion` onto `<html data-motion>` so the
 * rules in base.css can force (`reduced`) or re-enable (`full`) animation
 * regardless of the OS setting. Mount once per window.
 */
export function useMotionPreference(): void {
  const preference = useAppStore((state) => state.settings.general.reducedMotion);
  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'on') root.dataset.motion = 'reduced';
    else if (preference === 'off') root.dataset.motion = 'full';
    else delete root.dataset.motion;
  }, [preference]);
}
