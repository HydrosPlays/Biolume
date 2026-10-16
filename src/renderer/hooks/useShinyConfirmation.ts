/**
 * The live countdown of a hunt's pending Shiny Found confirmation.
 *
 * A hotkey or Stream Deck press arms Shiny Found for SHINY_CONFIRM_WINDOW_MS;
 * the main process broadcasts it and the store mirrors it (`shinyArmed`). This
 * hook turns that into something to draw: it re-renders a few times a second
 * while the window is open and returns null the moment it closes — even if the
 * expiry event from the main process has not arrived yet.
 */
import { useEffect, useState } from 'react';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import type { CounterSource } from '@shared/types';
import { shinyArmedRemaining, useShinyArmed } from '@renderer/store/appStore';

export interface ShinyConfirmation {
  /** Epoch ms the confirmation window closes. */
  armedUntil: number;
  /** What armed it: `streamdeck`, `hotkey-global`, `hotkey-local`, … */
  source: CounterSource;
  /** Milliseconds left, within 0 … SHINY_CONFIRM_WINDOW_MS. */
  remainingMs: number;
  /** Share of the window that is left, from 1 (just armed) down towards 0. */
  fraction: number;
  /** Whole seconds left, rounded up — what a person reads: 3, 2, 1. */
  seconds: number;
}

/** Re-render cadence while armed: smooth enough for a ring, cheap for three seconds. */
const TICK_MS = 100;

/** Derives the countdown at `now`; null when nothing is armed or the window has closed. */
export function describeShinyConfirmation(
  armed: { armedUntil: number; source: CounterSource } | null,
  now: number,
): ShinyConfirmation | null {
  if (armed === null) return null;
  const remainingMs = shinyArmedRemaining(armed, now);
  if (remainingMs <= 0) return null;
  return {
    armedUntil: armed.armedUntil,
    source: armed.source,
    remainingMs,
    fraction: remainingMs / SHINY_CONFIRM_WINDOW_MS,
    seconds: Math.ceil(remainingMs / 1000),
  };
}

/** The hunt's pending Shiny Found confirmation with its countdown, or null. */
export function useShinyConfirmation(huntId: string | null | undefined): ShinyConfirmation | null {
  const armed = useShinyArmed(huntId);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (armed === null) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= armed.armedUntil) window.clearInterval(interval);
    }, TICK_MS);
    return () => window.clearInterval(interval);
  }, [armed]);

  return describeShinyConfirmation(armed, now);
}
