/**
 * Window placement maths and the shape of `window-state.json` — everything
 * `windows.ts` decides about bounds, kept apart from Electron so it can be
 * unit-tested. All rectangles are in device-independent pixels, like
 * `BrowserWindow` bounds and `Display.workArea`.
 *
 * This module must stay free of `electron` imports.
 */
import { z } from 'zod';
import { LIMITS } from '@shared/defaults';
import { OVERLAY_SIZE_LIMITS } from '@shared/ipc';
import { SCHEMA_VERSION } from '@shared/types';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** The part of an Electron `Display` the placement logic needs. */
export interface DisplayLike {
  workArea: Rect;
}

export const MAIN_WINDOW_SIZE = {
  width: 1240,
  height: 800,
  minWidth: 940,
  minHeight: 600,
} as const;

/** Gap between a freshly placed overlay and the edges of the work area. */
export const OVERLAY_MARGIN = 24;

export const WINDOW_STATE_FILE = 'window-state.json';

/**
 * How much of a saved window must overlap a display for the window to count as
 * being on it — enough of the title bar to grab and drag back.
 */
const MIN_VISIBLE: Size = { width: 160, height: 80 };

// ───────────────────────────── Persisted state ─────────────────────────────

export interface PersistedWindowState {
  /** Main window bounds in its normal (not maximized) state; null before the first save. */
  bounds: Rect | null;
  maximized: boolean;
  /** Main window pinned above other windows. */
  alwaysOnTop: boolean;
  /** Top-left corner of the mini-overlay; null until it has been placed once. */
  overlayPosition: Point | null;
}

export function defaultWindowState(): PersistedWindowState {
  return { bounds: null, maximized: false, alwaysOnTop: false, overlayPosition: null };
}

const coordinateSchema = z
  .number()
  .min(-1_000_000)
  .max(1_000_000)
  .transform((value) => Math.round(value));
const dimensionSchema = z
  .number()
  .min(1)
  .max(100_000)
  .transform((value) => Math.round(value));
const pointSchema = z.object({ x: coordinateSchema, y: coordinateSchema });
const rectSchema = pointSchema.extend({ width: dimensionSchema, height: dimensionSchema });

const windowStateSchema = z.object({
  bounds: rectSchema.nullable().catch(null),
  maximized: z.boolean().catch(false),
  alwaysOnTop: z.boolean().catch(false),
  overlayPosition: pointSchema.nullable().catch(null),
});

/** Any value → a usable window state; every field that does not fit falls back to its default. */
export function parseWindowState(raw: unknown): PersistedWindowState {
  const parsed = windowStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultWindowState();
}

/** The document written to `window-state.json`. */
export function serializeWindowState(state: PersistedWindowState): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, ...state };
}

// ───────────────────────────── Geometry ─────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function overlap(a: Rect, b: Rect): Size {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/** The display showing the largest part of `rect`, if any part of at least `minimum` is on it. */
function findHome(rect: Rect, displays: readonly DisplayLike[], minimum: Size): DisplayLike | null {
  let best: DisplayLike | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const shared = overlap(rect, display.workArea);
    if (shared.width < minimum.width || shared.height < minimum.height) continue;
    const area = shared.width * shared.height;
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

/** Whether enough of `rect` is on some display for the user to get hold of it. */
export function isReachable(rect: Rect, displays: readonly DisplayLike[]): boolean {
  const minimum = {
    width: Math.min(MIN_VISIBLE.width, rect.width),
    height: Math.min(MIN_VISIBLE.height, rect.height),
  };
  return findHome(rect, displays, minimum) !== null;
}

/** Moves `rect` (never resizes it) so it lies inside `workArea`; an oversized rect aligns top-left. */
export function keepInside(rect: Rect, workArea: Rect): Rect {
  return {
    x: clamp(rect.x, workArea.x, workArea.x + Math.max(0, workArea.width - rect.width)),
    y: clamp(rect.y, workArea.y, workArea.y + Math.max(0, workArea.height - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}

/** At least the minimum size, but never larger than the work area — the work area wins. */
function fitMainSize(size: Size, workArea: Rect): Size {
  return {
    width: Math.round(Math.min(Math.max(size.width, MAIN_WINDOW_SIZE.minWidth), workArea.width)),
    height: Math.round(
      Math.min(Math.max(size.height, MAIN_WINDOW_SIZE.minHeight), workArea.height),
    ),
  };
}

function centerIn(size: Size, workArea: Rect): Rect {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

/**
 * Where the main window opens. Saved bounds are honoured only as far as the
 * current displays allow: the window always ends up completely inside one work
 * area and never larger than it. A window whose display is gone (or that was
 * never placed) is centred on the primary display.
 */
export function resolveMainBounds(
  saved: Rect | null,
  displays: readonly DisplayLike[],
  primary: DisplayLike,
): Rect {
  if (saved === null) {
    return centerIn(fitMainSize(MAIN_WINDOW_SIZE, primary.workArea), primary.workArea);
  }
  const home = findHome(saved, displays, {
    width: Math.min(MIN_VISIBLE.width, saved.width),
    height: Math.min(MIN_VISIBLE.height, saved.height),
  });
  if (home === null) return centerIn(fitMainSize(saved, primary.workArea), primary.workArea);
  const size = fitMainSize(saved, home.workArea);
  return keepInside({ x: Math.round(saved.x), y: Math.round(saved.y), ...size }, home.workArea);
}

// ───────────────────────────── Overlay ─────────────────────────────

function clampDimension(
  value: unknown,
  limits: { readonly min: number; readonly max: number; readonly default: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limits.default;
  return clamp(Math.ceil(value), limits.min, limits.max);
}

/** The overlay's content size in CSS pixels, clamped to `OVERLAY_SIZE_LIMITS`. */
export function clampOverlaySize(size: Partial<Size> | null | undefined): Size {
  return {
    width: clampDimension(size?.width, OVERLAY_SIZE_LIMITS.width),
    height: clampDimension(size?.height, OVERLAY_SIZE_LIMITS.height),
  };
}

export function clampOverlayScale(scale: unknown): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
  return clamp(scale, LIMITS.overlayScale.min, LIMITS.overlayScale.max);
}

/** Window size for a content size shown at `scale` (which the overlay renderer applies as CSS zoom). */
export function scaleOverlaySize(content: Size, scale: number): Size {
  const factor = clampOverlayScale(scale);
  // The epsilon keeps binary noise (320 × 1.1 = 352.00000000000006) from adding a pixel.
  return {
    width: Math.ceil(content.width * factor - 1e-6),
    height: Math.ceil(content.height * factor - 1e-6),
  };
}

/** Top-right corner of the work area, `margin` away from its edges. */
export function defaultOverlayPosition(
  workArea: Rect,
  size: Size,
  margin: number = OVERLAY_MARGIN,
): Point {
  return { x: workArea.x + workArea.width - size.width - margin, y: workArea.y + margin };
}

/**
 * Where the overlay opens: at its saved position when that is still on a
 * display, otherwise top-right on the primary display — and always completely
 * inside a work area.
 */
export function resolveOverlayBounds(
  position: Point | null,
  size: Size,
  displays: readonly DisplayLike[],
  primary: DisplayLike,
): Rect {
  if (position !== null) {
    const rect = { x: Math.round(position.x), y: Math.round(position.y), ...size };
    const home = findHome(rect, displays, { width: 1, height: 1 });
    if (home !== null) return keepInside(rect, home.workArea);
  }
  const fallback = defaultOverlayPosition(primary.workArea, size);
  return keepInside({ ...fallback, ...size }, primary.workArea);
}

/**
 * Resizes around the corner nearest to a screen corner: an overlay parked at
 * the right edge keeps its right edge, one at the bottom keeps its bottom, so
 * content changes never push it off-screen or make it creep across the display.
 */
export function resizeAnchored(current: Rect, size: Size, workArea: Rect): Rect {
  const anchorRight = current.x + current.width / 2 > workArea.x + workArea.width / 2;
  const anchorBottom = current.y + current.height / 2 > workArea.y + workArea.height / 2;
  return keepInside(
    {
      x: anchorRight ? current.x + current.width - size.width : current.x,
      y: anchorBottom ? current.y + current.height - size.height : current.y,
      width: size.width,
      height: size.height,
    },
    workArea,
  );
}
