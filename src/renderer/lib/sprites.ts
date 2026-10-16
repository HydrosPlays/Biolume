/**
 * Sprite URLs for the PokeAPI sprite repository.
 *
 * Every image is addressed by its PokeAPI `pokemon` id (species id for the
 * base variety, 10001+ for alternate forms), so a URL can be derived offline
 * from the bundled species index — no API call needed. The renderer CSP allows
 * `img-src https://raw.githubusercontent.com`.
 */
import type { TargetRef } from '@shared/types';

export const SPRITE_BASE_URL =
  'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

/**
 * - `pixel`   — 96 px game sprite (`{id}.png`); the most complete set.
 * - `home`    — 512 px Pokémon HOME render; the best-looking shiny reference.
 * - `artwork` — 475 px official artwork.
 */
export type SpriteStyle = 'pixel' | 'home' | 'artwork';

export const SPRITE_STYLES: readonly SpriteStyle[] = ['pixel', 'home', 'artwork'];

export interface SpriteOptions {
  /** Shiny colouring (default false). */
  shiny?: boolean;
  /** Preferred art style (default `home`). */
  style?: SpriteStyle;
}

const STYLE_PATH: Record<SpriteStyle, string> = {
  pixel: '',
  home: 'other/home/',
  artwork: 'other/official-artwork/',
};

/** Which styles to try, in order, when the preferred one is missing for a Pokémon. */
const FALLBACK_ORDER: Record<SpriteStyle, readonly SpriteStyle[]> = {
  home: ['home', 'artwork', 'pixel'],
  artwork: ['artwork', 'home', 'pixel'],
  pixel: ['pixel', 'home', 'artwork'],
};

const DEFAULT_STYLE: SpriteStyle = 'home';

/** PokeAPI ids are positive integers; anything else has no sprite. */
export function isValidPokemonId(pokemonId: number): boolean {
  return Number.isInteger(pokemonId) && pokemonId > 0;
}

/**
 * The URL of one sprite, without checking that it exists upstream — prefer
 * {@link spriteCandidates} for `<img>` elements. Returns null for an invalid id.
 */
export function spriteUrl(pokemonId: number, options: SpriteOptions = {}): string | null {
  if (!isValidPokemonId(pokemonId)) return null;
  const style = options.style ?? DEFAULT_STYLE;
  return `${SPRITE_BASE_URL}/${STYLE_PATH[style]}${options.shiny ? 'shiny/' : ''}${pokemonId}.png`;
}

/**
 * Ordered list of URLs to try for a Pokémon: the preferred style first, then
 * the other two. Newer Pokémon and some alternate forms lack individual sets,
 * so render the first candidate and advance on the image's `error` event
 * (see {@link nextSpriteCandidate}).
 *
 * A shiny request only ever yields shiny URLs — silently falling back to the
 * regular colouring would mislead a shiny hunter.
 */
export function spriteCandidates(pokemonId: number, options: SpriteOptions = {}): string[] {
  if (!isValidPokemonId(pokemonId)) return [];
  const shiny = options.shiny ?? false;
  const candidates: string[] = [];
  for (const style of FALLBACK_ORDER[options.style ?? DEFAULT_STYLE]) {
    const url = spriteUrl(pokemonId, { shiny, style });
    if (url) candidates.push(url);
  }
  return candidates;
}

/**
 * The candidate to try after `failedUrl` (the `src` that just failed to load),
 * or null when the list is exhausted or the URL is not one of the candidates.
 */
export function nextSpriteCandidate(
  candidates: readonly string[],
  failedUrl: string | null | undefined,
): string | null {
  if (!failedUrl) return candidates[0] ?? null;
  const index = candidates.indexOf(failedUrl);
  return index < 0 ? null : (candidates[index + 1] ?? null);
}

/**
 * The sprite pair stored on a {@link TargetRef} / phase entry. Pixel sprites
 * are used because they exist for every variety and stay crisp at the small
 * sizes of the mini-overlay; views that want larger art call
 * {@link spriteCandidates} with `target.pokemonId`.
 */
export function targetSprites(pokemonId: number): Pick<TargetRef, 'spriteUrl' | 'shinySpriteUrl'> {
  return {
    spriteUrl: spriteUrl(pokemonId, { style: 'pixel' }),
    shinySpriteUrl: spriteUrl(pokemonId, { style: 'pixel', shiny: true }),
  };
}

const SPRITE_URL_PATTERN = /\/sprites\/pokemon\/(?:[a-z-]+\/)*(\d+)\.(?:png|gif|svg)$/;

/** Recovers the `pokemon` id from a PokeAPI sprite URL (any style), or null for foreign URLs. */
export function pokemonIdFromSpriteUrl(url: string | null | undefined): number | null {
  if (!url || !url.startsWith('https://raw.githubusercontent.com/PokeAPI/sprites/')) return null;
  const match = SPRITE_URL_PATTERN.exec(url);
  if (!match?.[1]) return null;
  const id = Number.parseInt(match[1], 10);
  return isValidPokemonId(id) ? id : null;
}
