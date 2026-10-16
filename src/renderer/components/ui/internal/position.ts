/**
 * Collision-aware positioning for popovers (Select, Combobox, Tooltip).
 * Floating elements are portalled to `document.body` and placed with
 * `position: fixed`, so no ancestor can clip them.
 */
import { useLayoutEffect, type RefObject } from 'react';

export type Placement = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PositionInput {
  anchor: Box;
  floating: { width: number; height: number };
  viewport: { width: number; height: number };
  placement: Placement;
  align: Align;
  /** Gap between anchor and floating element. */
  offset: number;
  /** Minimum distance kept from the viewport edges. */
  padding: number;
}

export interface PositionResult {
  top: number;
  left: number;
  /** The side actually used after flipping. */
  placement: Placement;
  /** Room along the placement axis — lets a listbox shrink and scroll instead of overflowing. */
  available: number;
}

const OPPOSITE: Record<Placement, Placement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

function spaceOn(side: Placement, { anchor, viewport, offset, padding }: PositionInput): number {
  switch (side) {
    case 'top':
      return anchor.top - offset - padding;
    case 'bottom':
      return viewport.height - (anchor.top + anchor.height) - offset - padding;
    case 'left':
      return anchor.left - offset - padding;
    case 'right':
      return viewport.width - (anchor.left + anchor.width) - offset - padding;
  }
}

function clampInto(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

/** Pure placement maths: flips to the roomier side when the preferred one is too small, then shifts into view. */
export function computePosition(input: PositionInput): PositionResult {
  const { anchor, floating, viewport, align, offset, padding } = input;
  const vertical = input.placement === 'top' || input.placement === 'bottom';
  const needed = vertical ? floating.height : floating.width;

  let placement = input.placement;
  if (
    spaceOn(placement, input) < needed &&
    spaceOn(OPPOSITE[placement], input) > spaceOn(placement, input)
  ) {
    placement = OPPOSITE[placement];
  }
  const available = Math.max(0, spaceOn(placement, input));

  const alignAlong = (start: number, size: number, floatingSize: number): number => {
    if (align === 'start') return start;
    if (align === 'end') return start + size - floatingSize;
    return start + (size - floatingSize) / 2;
  };

  let top: number;
  let left: number;
  if (vertical) {
    const height = Math.min(floating.height, available);
    top = placement === 'top' ? anchor.top - offset - height : anchor.top + anchor.height + offset;
    left = clampInto(
      alignAlong(anchor.left, anchor.width, floating.width),
      padding,
      viewport.width - floating.width - padding,
    );
  } else {
    left =
      placement === 'left'
        ? anchor.left - offset - floating.width
        : anchor.left + anchor.width + offset;
    top = clampInto(
      alignAlong(anchor.top, anchor.height, floating.height),
      padding,
      viewport.height - floating.height - padding,
    );
  }

  return {
    top: Math.round(top),
    left: Math.round(left),
    placement,
    available: Math.floor(available),
  };
}

export interface AnchoredPositionOptions {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  floatingRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  align?: Align;
  offset?: number;
  padding?: number;
  /** Make the floating element at least as wide as the anchor (dropdowns). */
  matchWidth?: boolean;
}

/**
 * Keeps a fixed-position floating element glued to its anchor while `open`.
 * Writes `top` / `left` (and `min-width`) straight to the element, exposes the
 * room available as `--available-size`, and the resolved side as
 * `data-placement`. Re-measures on scroll, resize and content changes.
 */
export function useAnchoredPosition({
  open,
  anchorRef,
  floatingRef,
  placement = 'bottom',
  align = 'start',
  offset = 6,
  padding = 8,
  matchWidth = false,
}: AnchoredPositionOptions): void {
  useLayoutEffect(() => {
    if (!open) return undefined;
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return undefined;

    const update = (): void => {
      const anchorRect = anchor.getBoundingClientRect();
      if (matchWidth) floating.style.minWidth = `${Math.round(anchorRect.width)}px`;
      // Measure the natural size: lift the height cap from the previous pass first.
      floating.style.removeProperty('--available-size');
      const result = computePosition({
        anchor: anchorRect,
        floating: { width: floating.offsetWidth, height: floating.offsetHeight },
        viewport: {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        },
        placement,
        align,
        offset,
        padding,
      });
      floating.style.top = `${result.top}px`;
      floating.style.left = `${result.left}px`;
      floating.style.setProperty('--available-size', `${result.available}px`);
      floating.dataset.placement = result.placement;
    };

    update();

    window.addEventListener('resize', update);
    // Capture: scroll events do not bubble, and any scrolling ancestor moves the anchor.
    window.addEventListener('scroll', update, { capture: true, passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(anchor);
    observer?.observe(floating);

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, { capture: true });
      observer?.disconnect();
    };
  }, [open, anchorRef, floatingRef, placement, align, offset, padding, matchWidth]);
}
