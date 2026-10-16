/**
 * Where a Pokémon can be found, per game — the contract between the data
 * sources and the Target view's locations panel.
 *
 * Two sources produce the same {@link GameEncounterSlice}:
 *   - bundled files `src/renderer/data/encounters/<gameId>.json`
 *     ({@link BundledEncounterFile}), extracted from PKHeX's game data by
 *     `scripts/build-*-data.mjs` for games PokeAPI has no location data for
 *     (Legends: Z-A, Brilliant Diamond / Shining Pearl, Legends: Arceus,
 *     Scarlet / Violet);
 *   - PokeAPI's `/pokemon/{id}/encounters`, normalised at runtime, for the
 *     games it covers (Red / Blue through Sword / Shield).
 */

/** What kind of encounter a row describes. Drives the label and icon in the UI. */
export type EncounterKind =
  /** Ordinary wild spawn (walking, grass, overworld). */
  | 'wild'
  /** Surfing / on water. */
  | 'surf'
  /** Fishing; `method` names the rod. */
  | 'fishing'
  /** Rock Smash, Headbutt, Honey trees, shaking trees and similar interactions. */
  | 'interact'
  /** Alpha Pokémon (Legends: Arceus, Legends: Z-A). */
  | 'alpha'
  /** Mass / massive mass outbreaks. */
  | 'outbreak'
  /** Swarms, Poké Radar-only, DexNav-only, hordes, SOS-only and other special wild mechanics. */
  | 'special'
  /** Grand Underground, Hidden Grottoes, Max Raid dens and other separate spawn tables. */
  | 'den'
  /** Tera / Max raids. */
  | 'raid'
  /** One-off encounters you walk into or press A on (legendaries, fixed symbols). */
  | 'static'
  /** Gifts and revived fossils. */
  | 'gift'
  /** In-game trades. */
  | 'trade';

/**
 * One way to meet the Pokémon. Short keys keep the bundled files small;
 * every optional field is omitted when it does not apply.
 */
export interface EncounterRow {
  /** Kind of encounter. */
  k: EncounterKind;
  /** Location id — a key of the slice's `locations`. 0 when unknown. */
  l: number;
  /** Minimum level. */
  n: number;
  /** Maximum level. */
  x: number;
  /** Method detail shown next to the kind, e.g. `Old Rod`, `Tera Raid ★5`, `Space-time distortion`. */
  m?: string;
  /** Version mask: bit i set = available in `versions[i]`. Omitted = every version of the game. */
  v?: number;
  /** Conditions in plain English, e.g. `Night`, `Rain`, `After the main story`, `Swarm`. */
  c?: string[];
  /** Encounter rate in percent, when the source knows it. */
  r?: number;
  /** 1 = this encounter can never be shiny (shiny-locked). */
  s?: 1;
}

export interface EncounterPokemon {
  /** Regional Pokédex number, when the game has one for it. */
  dex?: number | null;
  /** 1 = belongs to the game's DLC / expansion rather than the base game. */
  dlc?: 1;
  rows: EncounterRow[];
}

/** Shape of `src/renderer/data/encounters/<gameId>.json`. */
export interface BundledEncounterFile {
  version: 2;
  /** Biolume game id (see oddsMethods.json), e.g. `sv`. */
  gameId: string;
  /** ISO date of extraction. */
  updated: string;
  /** Attribution shown in the UI, e.g. `PKHeX (github.com/kwsch/PKHeX) game data`. */
  source: string;
  /** Display names of the game's versions, in mask-bit order, e.g. `["Scarlet", "Violet"]`. */
  versions: string[];
  /** Location id → English name. */
  locations: Record<string, string>;
  /**
   * PokeAPI `pokemon` id → its encounters. Every Pokémon that exists in the
   * game has an entry (possibly with no rows: obtainable only by evolving,
   * breeding …); a Pokémon without an entry does not exist in the game.
   */
  pokemon: Record<string, EncounterPokemon>;
}

/** What either source yields for one Pokémon in one game. */
export interface GameEncounterSlice {
  gameId: string;
  source: string;
  versions: string[];
  locations: Record<string, string>;
  /**
   * The Pokémon's encounters. `null` means it does not exist in the game —
   * only reported when `availabilityKnown` is true.
   */
  pokemon: EncounterPokemon | null;
  /**
   * True for bundled data, which lists every Pokémon in the game. PokeAPI only
   * lists locations, so an empty result there may just mean "no wild
   * encounter" and availability is unknown.
   */
  availabilityKnown: boolean;
}
