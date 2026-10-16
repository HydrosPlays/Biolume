/**
 * Level-up learnsets bundled with the app for games PokeAPI has no move data
 * for. Today that is Pokémon Legends: Z-A: PokeAPI lists the `legends-za`
 * version group but no learnset rows, so the Encounter Analyzer would fall
 * back to another game's moves. `zaLearnsets.json` is generated from PKHeX's
 * game data by `scripts/build-za-data.mjs`.
 */
import zaLearnsets from '@renderer/data/zaLearnsets.json';
import type { PokemonDetail } from '@renderer/api/pokeapi';

interface LocalLearnsets {
  versionGroup: string;
  /** PokeAPI pokemon id → `[move slug, level]` in the order the game stores them. */
  learnsets: Record<string, [slug: string, level: number][]>;
}

const ZA = zaLearnsets as unknown as LocalLearnsets;

/** Whether the bundled Z-A data knows this Pokémon (i.e. it exists in Legends: Z-A). */
export function hasLocalLearnset(pokemonId: number): boolean {
  return ZA.learnsets[String(pokemonId)] !== undefined;
}

/**
 * Adds the bundled learnset to a Pokémon's movepool when PokeAPI has none for
 * that version group. Returns the same object when there is nothing to add, so
 * it is safe as a TanStack Query `select` function.
 */
export function withLocalLearnsets(detail: PokemonDetail): PokemonDetail {
  const local = ZA.learnsets[String(detail.id)];
  if (local === undefined) return detail;
  const existing = detail.moves[ZA.versionGroup];
  // PokeAPI caught up: its data wins.
  if (existing !== undefined && existing.levelUp.length > 0) return detail;
  return {
    ...detail,
    moves: {
      ...detail.moves,
      [ZA.versionGroup]: {
        levelUp: local.map(([slug, level]) => ({ slug, level })),
        other: existing?.other ?? { machine: [], egg: [], tutor: [] },
      },
    },
  };
}
