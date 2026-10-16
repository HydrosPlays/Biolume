/**
 * Per-device preferences of the Target view, kept in `localStorage` (they are
 * view conveniences, not hunt data, so they stay out of the main-process state).
 */
import { useCallback, useEffect, useState } from 'react';
import { SPRITE_STYLES, type SpriteStyle } from '@renderer/lib/sprites';
import { parseRecents, pushRecent, RECENTS_KEY } from './helpers';

const SPRITE_STYLE_KEY = 'biolume.target.spriteStyle';

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable or full; the preference simply does not persist.
  }
}

export interface RecentTargets {
  /** `pokemon` ids, newest first. */
  recents: number[];
  remember: (pokemonId: number) => void;
  clear: () => void;
}

/** The short list of recently previewed Pokémon. */
export function useRecentTargets(): RecentTargets {
  const [recents, setRecents] = useState<number[]>(() => parseRecents(readLocal(RECENTS_KEY)));

  useEffect(() => {
    writeLocal(RECENTS_KEY, JSON.stringify(recents));
  }, [recents]);

  const remember = useCallback((pokemonId: number) => {
    setRecents((list) => (list[0] === pokemonId ? list : pushRecent(list, pokemonId)));
  }, []);
  const clear = useCallback(() => setRecents([]), []);

  return { recents, remember, clear };
}

function isSpriteStyle(value: string | null): value is SpriteStyle {
  return value !== null && (SPRITE_STYLES as readonly string[]).includes(value);
}

/** The art style of the normal / shiny comparison; HOME renders by default. */
export function useSpriteStyle(): [SpriteStyle, (style: SpriteStyle) => void] {
  const [style, setStyle] = useState<SpriteStyle>(() => {
    const stored = readLocal(SPRITE_STYLE_KEY);
    return isSpriteStyle(stored) ? stored : 'home';
  });
  const change = useCallback((next: SpriteStyle) => {
    setStyle(next);
    writeLocal(SPRITE_STYLE_KEY, next);
  }, []);
  return [style, change];
}
