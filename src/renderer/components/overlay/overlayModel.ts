/**
 * What the mini-overlay shows for a hunt, as pure functions: the lines of text,
 * the sprite candidates and the size it reports to the main process.
 */
import { LIMITS } from '@shared/defaults';
import { huntTotal, type Hunt, type TargetRef } from '@shared/types';
import { formatCount, formatOdds, formatPercent } from '@renderer/lib/format';
import type { OddsEngine } from '@renderer/lib/odds';
import { oddsEngine } from '@renderer/lib/oddsData';
import { cumulativeProbability } from '@renderer/lib/probability';
import { spriteCandidates } from '@renderer/lib/sprites';

export type OverlayState = 'empty' | 'active' | 'completed' | 'archived';

export function overlayState(hunt: Hunt | null): OverlayState {
  if (hunt === null) return 'empty';
  return hunt.status;
}

/** The headline: the hunt's own name, else its target, else a neutral label. */
export function overlayTitle(hunt: Hunt): string {
  return hunt.name.trim() || hunt.target?.name || 'Untitled hunt';
}

/**
 * "1 in 4,096 · 26.3 % so far": the odds of one counted encounter and the
 * chance of having seen a shiny by now, over every encounter of the hunt.
 * Null when the hunt's method yields no usable odds.
 */
export function overlayOddsLine(hunt: Hunt, engine: OddsEngine = oddsEngine): string | null {
  let probability: number;
  try {
    probability = engine.compute(hunt.odds).perEncounter;
  } catch {
    return null;
  }
  if (!Number.isFinite(probability) || probability <= 0) return null;
  const soFar = cumulativeProbability(Math.min(probability, 1), huntTotal(hunt));
  return `${formatOdds(probability)} · ${formatPercent(soFar)} so far`;
}

/** "Phase 3 · 5,432 total" — the phase being counted and every encounter of the hunt. */
export function overlayPhaseLine(hunt: Hunt): string {
  return `Phase ${formatCount(hunt.phases.length + 1)} · ${formatCount(huntTotal(hunt))} total`;
}

/**
 * Shiny sprites to try in order, pixel art first (it stays crisp this small).
 * Only ever shiny ones: a regular sprite next to a shiny counter would mislead.
 */
export function overlaySprites(target: TargetRef | null): string[] {
  if (target === null) return [];
  const candidates = [
    target.shinySpriteUrl,
    ...spriteCandidates(target.pokemonId, { shiny: true, style: 'pixel' }),
  ];
  return [...new Set(candidates.filter((url): url is string => Boolean(url)))];
}

/** Font-size step of the big count, so even eight-digit totals fit the card. */
export function countSize(count: number): 'lg' | 'md' | 'sm' {
  const length = formatCount(count).length;
  if (length <= 6) return 'lg';
  return length <= 8 ? 'md' : 'sm';
}

export function clampOverlayScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, LIMITS.overlayScale.min), LIMITS.overlayScale.max);
}

export function clampOverlayOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return 1;
  return Math.min(Math.max(opacity, LIMITS.overlayOpacity.min), LIMITS.overlayOpacity.max);
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Converts the space the scaled overlay takes up in the window back into
 * unscaled CSS pixels — the unit `window.resizeOverlay` expects. Rounded to
 * 1/100 px so float noise (355 / 1.25 = 284.00000000000006) cannot make the
 * main process, which rounds up, add a pixel.
 */
export function unscaledSize(measured: Size, scale: number): Size {
  const factor = clampOverlayScale(scale);
  const unscale = (value: number): number => Math.round((value / factor) * 100) / 100;
  return { width: unscale(measured.width), height: unscale(measured.height) };
}
