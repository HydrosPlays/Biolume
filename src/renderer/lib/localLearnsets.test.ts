import { describe, expect, it } from 'vitest';
import type { PokemonDetail } from '@renderer/api/pokeapi';
import { hasLocalLearnset, withLocalLearnsets } from './localLearnsets';
import { predictWildMoveset, resolveVersionGroup } from './moveset';

function detail(id: number, moves: PokemonDetail['moves']): PokemonDetail {
  return { id, slug: `pokemon-${id}`, moves } as PokemonDetail;
}

const NO_OTHER = { machine: [], egg: [], tutor: [] };

describe('withLocalLearnsets', () => {
  it('adds the bundled Legends: Z-A learnset when PokeAPI has none', () => {
    const fletchling = detail(661, {
      'scarlet-violet': { levelUp: [{ slug: 'tackle', level: 1 }], other: NO_OTHER },
    });
    const result = withLocalLearnsets(fletchling);

    expect(result).not.toBe(fletchling);
    expect(result.moves['scarlet-violet']).toBe(fletchling.moves['scarlet-violet']);
    expect(result.moves['legends-za']?.levelUp).toContainEqual({ slug: 'ember', level: 12 });
  });

  it('makes Z-A resolve without a fallback and feeds the moveset prediction', () => {
    const gastly = withLocalLearnsets(detail(92, {}));
    const resolved = resolveVersionGroup(gastly, ['legends-za', 'mega-dimension']);

    expect(resolved).toMatchObject({ versionGroup: 'legends-za', fallback: false });
    const { moves } = predictWildMoveset(gastly, 'legends-za', 25);
    expect(moves.map((move) => move.slug)).toContain('curse');
  });

  it('leaves PokeAPI data alone once it exists', () => {
    const upstream = detail(661, {
      'legends-za': { levelUp: [{ slug: 'peck', level: 1 }], other: NO_OTHER },
    });
    expect(withLocalLearnsets(upstream)).toBe(upstream);
  });

  it('returns the same object for Pokémon that are not in Legends: Z-A', () => {
    const sprigatito = detail(906, {});
    expect(hasLocalLearnset(906)).toBe(false);
    expect(withLocalLearnsets(sprigatito)).toBe(sprigatito);
  });
});
