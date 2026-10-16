import type { Ref, RefCallback } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

/** Tabbable descendants in DOM order (skips disabled, `hidden`, `inert` and aria-hidden subtrees). */
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex !== -1 &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      element.getAttribute('aria-disabled') !== 'true',
  );
}

/** One callback ref that feeds several refs (object refs, callback refs, or nothing). */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (node) => {
    const cleanups: (() => void)[] = [];
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') {
        const cleanup = ref(node);
        cleanups.push(typeof cleanup === 'function' ? cleanup : () => ref(null));
      } else {
        ref.current = node;
        cleanups.push(() => {
          ref.current = null;
        });
      }
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  };
}

/** `scrollIntoView({ block: 'nearest' })` where supported (jsdom lacks it). */
export function scrollIntoViewIfNeeded(element: Element | null): void {
  if (element && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'nearest' });
  }
}
