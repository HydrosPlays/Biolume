import { describe, expect, it } from 'vitest';
import {
  SPRITE_BASE_URL,
  nextSpriteCandidate,
  pokemonIdFromSpriteUrl,
  spriteCandidates,
  spriteUrl,
  targetSprites,
} from './sprites';

describe('spriteUrl', () => {
  it('builds each documented path from the pokemon id', () => {
    expect(spriteUrl(25, { style: 'pixel' })).toBe(`${SPRITE_BASE_URL}/25.png`);
    expect(spriteUrl(25, { style: 'pixel', shiny: true })).toBe(`${SPRITE_BASE_URL}/shiny/25.png`);
    expect(spriteUrl(25, { style: 'home' })).toBe(`${SPRITE_BASE_URL}/other/home/25.png`);
    expect(spriteUrl(25, { style: 'home', shiny: true })).toBe(
      `${SPRITE_BASE_URL}/other/home/shiny/25.png`,
    );
    expect(spriteUrl(25, { style: 'artwork' })).toBe(
      `${SPRITE_BASE_URL}/other/official-artwork/25.png`,
    );
    expect(spriteUrl(25, { style: 'artwork', shiny: true })).toBe(
      `${SPRITE_BASE_URL}/other/official-artwork/shiny/25.png`,
    );
  });

  it('defaults to the regular HOME render and uses form ids as-is', () => {
    expect(spriteUrl(10103)).toBe(`${SPRITE_BASE_URL}/other/home/10103.png`);
  });

  it('returns null for ids that cannot exist', () => {
    for (const id of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(spriteUrl(id)).toBeNull();
    }
  });
});

describe('spriteCandidates', () => {
  it('starts with the preferred style and falls back through the other two', () => {
    expect(spriteCandidates(906, { style: 'artwork' })).toEqual([
      `${SPRITE_BASE_URL}/other/official-artwork/906.png`,
      `${SPRITE_BASE_URL}/other/home/906.png`,
      `${SPRITE_BASE_URL}/906.png`,
    ]);
    expect(spriteCandidates(906, { style: 'pixel' })[0]).toBe(`${SPRITE_BASE_URL}/906.png`);
    expect(spriteCandidates(906)[0]).toBe(`${SPRITE_BASE_URL}/other/home/906.png`);
  });

  it('never mixes regular sprites into a shiny request', () => {
    const candidates = spriteCandidates(906, { shiny: true });
    expect(candidates).toHaveLength(3);
    expect(candidates.every((url) => url.includes('/shiny/'))).toBe(true);
    expect(spriteCandidates(906).some((url) => url.includes('/shiny/'))).toBe(false);
  });

  it('is empty for an invalid id', () => {
    expect(spriteCandidates(0)).toEqual([]);
  });
});

describe('nextSpriteCandidate', () => {
  const candidates = spriteCandidates(1, { style: 'home' });

  it('walks the list as images fail to load', () => {
    expect(nextSpriteCandidate(candidates, null)).toBe(candidates[0]);
    expect(nextSpriteCandidate(candidates, candidates[0])).toBe(candidates[1]);
    expect(nextSpriteCandidate(candidates, candidates[1])).toBe(candidates[2]);
  });

  it('returns null once exhausted or for a foreign url', () => {
    expect(nextSpriteCandidate(candidates, candidates[2])).toBeNull();
    expect(nextSpriteCandidate(candidates, 'https://example.com/x.png')).toBeNull();
    expect(nextSpriteCandidate([], null)).toBeNull();
  });
});

describe('targetSprites', () => {
  it('returns the pixel pair used by TargetRef', () => {
    expect(targetSprites(10103)).toEqual({
      spriteUrl: `${SPRITE_BASE_URL}/10103.png`,
      shinySpriteUrl: `${SPRITE_BASE_URL}/shiny/10103.png`,
    });
  });

  it('yields nulls rather than broken urls for an invalid id', () => {
    expect(targetSprites(0)).toEqual({ spriteUrl: null, shinySpriteUrl: null });
  });
});

describe('pokemonIdFromSpriteUrl', () => {
  it('round-trips every style', () => {
    for (const style of ['pixel', 'home', 'artwork'] as const) {
      for (const shiny of [false, true]) {
        expect(pokemonIdFromSpriteUrl(spriteUrl(10272, { style, shiny }))).toBe(10272);
      }
    }
  });

  it('rejects urls that are not PokeAPI sprites', () => {
    expect(pokemonIdFromSpriteUrl(null)).toBeNull();
    expect(pokemonIdFromSpriteUrl('')).toBeNull();
    expect(pokemonIdFromSpriteUrl('https://example.com/sprites/pokemon/25.png')).toBeNull();
    expect(pokemonIdFromSpriteUrl(`${SPRITE_BASE_URL}/substitute.png`)).toBeNull();
  });
});
