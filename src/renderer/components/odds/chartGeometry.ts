/**
 * Pure geometry for the probability chart: scales, SVG paths, axis ticks,
 * keyboard scrubbing and label placement. No DOM, no React — everything here
 * is unit-tested in `chartGeometry.test.ts`.
 *
 * The x axis is an encounter count from 0 to `maxN`, the y axis a cumulative
 * probability from 0 to 1 (y grows downwards in pixels).
 */
import type { CurvePoint } from '@renderer/lib/probability';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The inner rectangle the curve is drawn in, in SVG pixels. */
export interface PlotArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** Room for the y labels (left), x labels (bottom) and milestone captions (top). */
export const CHART_MARGINS: Margins = { top: 24, right: 18, bottom: 28, left: 46 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A usable x-range: at least 1, never NaN. */
function safeMax(maxN: number): number {
  return Number.isFinite(maxN) && maxN >= 1 ? maxN : 1;
}

/** The plot rectangle inside an SVG of the given size; never collapses below 1 × 1. */
export function plotArea(
  width: number,
  height: number,
  margins: Margins = CHART_MARGINS,
): PlotArea {
  const left = margins.left;
  const top = margins.top;
  const right = Math.max(left + 1, width - margins.right);
  const bottom = Math.max(top + 1, height - margins.bottom);
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/** Pixel x of an encounter count (clamped to the range). */
export function xToPixel(n: number, maxN: number, area: PlotArea): number {
  const max = safeMax(maxN);
  return area.left + (clamp(Number.isFinite(n) ? n : 0, 0, max) / max) * area.width;
}

/** Pixel y of a probability (clamped to 0–1). */
export function yToPixel(probability: number, area: PlotArea): number {
  return area.bottom - clamp(Number.isFinite(probability) ? probability : 0, 0, 1) * area.height;
}

/** The whole encounter count under a pixel x (clamped to the plot). */
export function pixelToCount(pixelX: number, maxN: number, area: PlotArea): number {
  const max = safeMax(maxN);
  return Math.round(clamp((pixelX - area.left) / area.width, 0, 1) * max);
}

function coordinate(value: number): string {
  // Two decimals are plenty at screen resolution and keep the path short.
  return String(Math.round(value * 100) / 100);
}

/** `M x y L x y …` through every sample; an empty string for an empty curve. */
export function linePath(points: readonly CurvePoint[], maxN: number, area: PlotArea): string {
  return points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${coordinate(xToPixel(point.n, maxN, area))} ${coordinate(yToPixel(point.probability, area))}`,
    )
    .join(' ');
}

/** The line closed down to the x axis, for the gradient fill. */
export function areaPath(points: readonly CurvePoint[], maxN: number, area: PlotArea): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return '';
  const baseline = coordinate(area.bottom);
  return `${linePath(points, maxN, area)} L${coordinate(xToPixel(last.n, maxN, area))} ${baseline} L${coordinate(xToPixel(first.n, maxN, area))} ${baseline} Z`;
}

/** Roughly one x tick per 110 px, between 2 and 8. */
export function tickTarget(plotWidth: number): number {
  return clamp(Math.round(plotWidth / 110), 2, 8);
}

/** The "nice" step (1, 2, 2.5 or 5 × 10^k, whole numbers only) giving about `target` intervals up to `max`. */
export function niceStep(max: number, target: number): number {
  const rough = safeMax(max) / Math.max(1, target);
  if (rough <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return Math.max(1, Math.round(factor * magnitude));
}

/** Tick values from 0 up to (at most) `maxN`, on a nice whole-number step. */
export function countTicks(maxN: number, target = 5): number[] {
  const max = safeMax(maxN);
  const step = niceStep(max, target);
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-9; value += step) ticks.push(value);
  return ticks;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/**
 * Compact axis label once counts get long: `950`, `12,500`, `120k`, `1.5M`.
 * Below 100,000 the caller's own formatter (thousands separators) reads better.
 */
export function formatAxisCount(value: number, formatSmall: (value: number) => string): string {
  if (!Number.isFinite(value)) return '';
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (magnitude >= 100_000) return `${trimDecimal(value / 1_000)}k`;
  return formatSmall(value);
}

/** Keyboard scrub distance: 1 % of the range, or 10 % for the large step — at least one encounter. */
export function scrubStep(maxN: number, large = false): number {
  return Math.max(1, Math.round(safeMax(maxN) * (large ? 0.1 : 0.01)));
}

/**
 * Where a key press moves the crosshair, or null when the key is not a
 * scrubbing key. `current` null (nothing shown yet) starts from `origin`.
 */
export function scrubTo(
  current: number | null,
  key: string,
  shiftKey: boolean,
  maxN: number,
  origin = 0,
): number | null {
  const max = Math.round(safeMax(maxN));
  const from = clamp(current ?? origin, 0, max);
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(from + scrubStep(max, shiftKey), 0, max);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(from - scrubStep(max, shiftKey), 0, max);
    case 'PageUp':
      return clamp(from + scrubStep(max, true), 0, max);
    case 'PageDown':
      return clamp(from - scrubStep(max, true), 0, max);
    case 'Home':
      return 0;
    case 'End':
      return max;
    default:
      return null;
  }
}

/** Left edge of a tooltip centred on `anchorX`, kept `padding` px inside the container. */
export function tooltipLeft(
  anchorX: number,
  tooltipWidth: number,
  containerWidth: number,
  padding = 6,
): number {
  const max = Math.max(padding, containerWidth - tooltipWidth - padding);
  return clamp(anchorX - tooltipWidth / 2, padding, max);
}

/** Top edge of a tooltip: below the point while it sits in the upper part of the plot, above it otherwise. */
export function tooltipTop(
  pointY: number,
  tooltipHeight: number,
  area: PlotArea,
  gap = 14,
): number {
  const below = pointY + gap;
  const above = pointY - gap - tooltipHeight;
  const preferBelow = pointY < area.top + area.height * 0.45;
  if (preferBelow && below + tooltipHeight <= area.bottom) return below;
  return Math.max(0, above);
}

/**
 * Which labels to draw when several sit on one line: walking left to right, a
 * label is dropped when it would start within `minGap` px of the last one kept.
 */
export function visibleLabels(positions: readonly number[], minGap: number): boolean[] {
  const order = positions.map((x, index) => ({ x, index })).sort((a, b) => a.x - b.x);
  const visible = new Array<boolean>(positions.length).fill(false);
  let lastShown = -Infinity;
  for (const { x, index } of order) {
    if (!Number.isFinite(x) || x - lastShown < minGap) continue;
    visible[index] = true;
    lastShown = x;
  }
  return visible;
}

/** SVG `text-anchor` that keeps a label of about `labelWidth` px inside the plot. */
export function labelAnchor(
  x: number,
  labelWidth: number,
  area: PlotArea,
): 'start' | 'middle' | 'end' {
  if (x - labelWidth / 2 < area.left) return 'start';
  if (x + labelWidth / 2 > area.right) return 'end';
  return 'middle';
}
