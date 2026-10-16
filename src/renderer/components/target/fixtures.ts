/**
 * Test fixtures for the Target view: a Geodude whose learnset walks through
 * Self-Destruct, Explosion and Double-Edge — the moves the analyzer exists for.
 */
import type { PokemonDetail, SpeciesDetail } from '@renderer/api/pokeapi';
import { oddsEngine } from '@renderer/lib/oddsData';

/** Version group of the default game, so the fixture resolves without a fallback. */
export const FIXTURE_VERSION_GROUP = oddsEngine.defaultGame.versionGroups[0] ?? 'scarlet-violet';

export const GEODUDE: PokemonDetail = {
  id: 74,
  slug: 'geodude',
  speciesId: 74,
  name: 'Geodude',
  types: ['rock', 'ground'],
  stats: { hp: 40, atk: 80, def: 100, spa: 30, spd: 30, spe: 20, total: 300 },
  abilities: [
    { slug: 'rock-head', name: 'Rock Head', hidden: false },
    { slug: 'sturdy', name: 'Sturdy', hidden: false },
    { slug: 'sand-veil', name: 'Sand Veil', hidden: true },
  ],
  height: 0.4,
  weight: 20,
  sprites: {
    pixel: null,
    pixelShiny: null,
    home: null,
    homeShiny: null,
    artwork: null,
    artworkShiny: null,
  },
  moves: {
    [FIXTURE_VERSION_GROUP]: {
      levelUp: [
        { slug: 'tackle', level: 1 },
        { slug: 'defense-curl', level: 1 },
        { slug: 'rock-polish', level: 6 },
        { slug: 'rollout', level: 10 },
        { slug: 'bulldoze', level: 12 },
        { slug: 'rock-throw', level: 16 },
        { slug: 'smack-down', level: 18 },
        { slug: 'self-destruct', level: 24 },
        { slug: 'stealth-rock', level: 28 },
        { slug: 'rock-blast', level: 30 },
        { slug: 'earthquake', level: 34 },
        { slug: 'explosion', level: 36 },
        { slug: 'double-edge', level: 40 },
        { slug: 'stone-edge', level: 42 },
      ],
      other: { machine: [], egg: [], tutor: [] },
    },
  },
};

export const GEODUDE_SPECIES: SpeciesDetail = {
  id: 74,
  slug: 'geodude',
  name: 'Geodude',
  generation: 1,
  captureRate: 255,
  genderRate: 4,
  baseHappiness: 70,
  growthRate: 'medium-slow',
  eggGroups: ['mineral'],
  hatchCounter: 15,
  isLegendary: false,
  isMythical: false,
  isBaby: false,
  hasGenderDifferences: false,
  genus: 'Rock Pokémon',
  flavorText: 'Commonly found near mountain trails and the like.',
  flavorTextVersion: 'scarlet',
  varieties: [
    { pokemonId: 74, slug: 'geodude', isDefault: true },
    { pokemonId: 10109, slug: 'geodude-alola', isDefault: false },
  ],
};
