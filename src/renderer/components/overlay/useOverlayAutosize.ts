import { useEffect, type RefObject } from 'react';
import { unscaledSize } from './overlayModel';

/** Content changes arrive in bursts (a count, then its odds line); one resize per burst is enough. */
export const AUTOSIZE_DEBOUNCE_MS = 50;

/**
 * Keeps the overlay window exactly as large as its content.
 *
 * `frameRef` is the element around the scaled card: it is not zoomed itself,
 * so its box is the space the card takes up in the window. That box, divided
 * by the scale, is reported to the main process as the unscaled content size
 * (`window.resizeOverlay`); main clamps it and sizes the window to size × scale.
 * The frame must size itself from its content, never from the window, or the
 * two would chase each other.
 */
export function useOverlayAutosize(frameRef: RefObject<HTMLElement | null>, scale: number): void {
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return undefined;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastReport = '';

    const report = (): void => {
      timer = null;
      const { width, height } = frame.getBoundingClientRect();
      // Not laid out yet (or a test environment without layout): nothing worth reporting.
      if (width <= 0 || height <= 0) return;
      const size = unscaledSize({ width, height }, scale);
      const signature = `${size.width}x${size.height}@${scale}`;
      if (signature === lastReport) return;
      lastReport = signature;
      window.biolume.window.resizeOverlay(size);
    };

    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(report, AUTOSIZE_DEBOUNCE_MS);
    };

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(frame);
    schedule();

    return () => {
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [frameRef, scale]);
}
