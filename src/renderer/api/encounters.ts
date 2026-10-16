/**
 * Where to find a Pokémon in the games PokeAPI has location data for — Gold /
 * Silver / Crystal through Sword / Shield (with Let's Go and the Sword /
 * Shield expansions) — as the {@link GameEncounterSlice} the Target view
 * renders for every game (see data/encounterSchema.ts; the other games come
 * from bundled PKHeX extracts).
 *
 * One request per Pokémon (`/pokemon/{id}/encounters`, up to ~1 MB raw for
 * Magikarp) is trimmed at once into compact rows for every supported game and
 * cached and persisted like the other PokeAPI queries. The hook picks one game
 * out of the cached data with `select`, so switching games never refetches.
 * Location names are resolved at select time from the bundled
 * `locationIndex.json` (scripts/build-location-index.mjs).
 *
 * Reading PokeAPI's encounter data
 * --------------------------------
 * PokeAPI lists every encounter SLOT of a location area per version: a Pokémon
 * in two grass slots appears twice. Slots that only exist under a condition
 * carry condition values (`time-night`, `swarm-yes`), and slots that a toggle
 * replaces carry its "off" value (`swarm-no`: the slot a swarm takes over).
 * Per (area, method, version) the slots are combined into the rate a player
 * sees in each game state (`r` = summed slot chances, `n`–`x` = the lowest and
 * highest level among them):
 *   - state conditions — time of day, season, weather, before / after the Hall
 *     of Fame or the National Pokédex, a Max Raid den's beam — always have
 *     exactly one value, so the rate is worked out for every value and values
 *     with the same outcome share a row ("Morning / Day" 55 %, "Night" 60 %; no
 *     condition at all when every value gives the same outcome);
 *   - every other condition (swarm, Poké Radar, dual-slot game, radio, story
 *     flags, items, …) is an extra requirement: the default row sums the slots
 *     that need nothing (plus the "off" slots), and each requirement gets its
 *     own row whose rate counts the slots still active under it — a swarm row
 *     drops the `swarm-no` slots it replaces — but only in the states where it
 *     changes this Pokémon's outcome. A raid's star rating goes into the method
 *     label (`Max Raid ★3`).
 * Rows that come out identical in several versions are merged into one row
 * with a version mask; expansion versions fold into their base game with a
 * condition ("Crown Tundra"). "Off" values never appear as conditions. No rate
 * is given where PokeAPI's chance is not a per-encounter rate (honey-tree
 * groups, roamers) or only restates a gift / static / trade (100 %). A
 * weather condition is named against the weathers the area can have (from the
 * location index), so "Any weather except …" never lists one that cannot
 * happen there. Known slips in PokeAPI's data (misfiled areas, lost times of
 * day, Rolling Fields' beam tag) are corrected before the slots are read.
 *
 * Shiny locks: PokeAPI flags some locked encounters (`never_shiny`); PKHeX's
 * gift / static / trade tables (summarised into locationIndex.json) fill in
 * the rest for gift, static and trade rows, matched by species and level.
 */
import { queryOptions, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import { z } from 'zod';
import type {
  EncounterKind,
  EncounterRow,
  GameEncounterSlice,
} from '@renderer/data/encounterSchema';
import locationIndex from '@renderer/data/locationIndex.json';
import { findByPokemonId, findBySlug } from '@renderer/lib/species';
import {
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  POKEAPI_BASE_URL,
  PokeApiError,
  isPokeApiError,
  titleCaseSlug,
  type PokeApiClientOptions,
  type RequestOptions,
} from './pokeapi';
import { POKEAPI_QUERY_ROOT } from './queryClient';

/** Attribution shown with PokeAPI-sourced locations. */
export const POKEAPI_ENCOUNTER_SOURCE = 'PokeAPI (pokeapi.co) encounter data';

// ───────────────────────────── Games and versions ─────────────────────────────

interface GameVersions {
  /** Display names in mask-bit order. */
  names: readonly string[];
  /** PokeAPI version slug → mask bit, plus a condition for expansion versions. */
  versions: Readonly<Record<string, { bit: number; condition?: string }>>;
}

/**
 * Biolume game id → its PokeAPI versions (slugs checked against
 * https://pokeapi.co/api/v2/version?limit=100). The Sword / Shield expansions
 * are separate PokeAPI versions; they fold into Sword / Shield with a
 * condition naming the expansion.
 */
const GAMES: Readonly<Record<string, GameVersions>> = {
  gsc: {
    names: ['Gold', 'Silver', 'Crystal'],
    versions: { gold: { bit: 0 }, silver: { bit: 1 }, crystal: { bit: 2 } },
  },
  rse: {
    names: ['Ruby', 'Sapphire', 'Emerald'],
    versions: { ruby: { bit: 0 }, sapphire: { bit: 1 }, emerald: { bit: 2 } },
  },
  frlg: {
    names: ['FireRed', 'LeafGreen'],
    versions: { firered: { bit: 0 }, leafgreen: { bit: 1 } },
  },
  dppt: {
    names: ['Diamond', 'Pearl', 'Platinum'],
    versions: { diamond: { bit: 0 }, pearl: { bit: 1 }, platinum: { bit: 2 } },
  },
  hgss: {
    names: ['HeartGold', 'SoulSilver'],
    versions: { heartgold: { bit: 0 }, soulsilver: { bit: 1 } },
  },
  bw: {
    names: ['Black', 'White'],
    versions: { black: { bit: 0 }, white: { bit: 1 } },
  },
  b2w2: {
    names: ['Black 2', 'White 2'],
    versions: { 'black-2': { bit: 0 }, 'white-2': { bit: 1 } },
  },
  xy: {
    names: ['X', 'Y'],
    versions: { x: { bit: 0 }, y: { bit: 1 } },
  },
  oras: {
    names: ['Omega Ruby', 'Alpha Sapphire'],
    versions: { 'omega-ruby': { bit: 0 }, 'alpha-sapphire': { bit: 1 } },
  },
  sm: {
    names: ['Sun', 'Moon'],
    versions: { sun: { bit: 0 }, moon: { bit: 1 } },
  },
  usum: {
    names: ['Ultra Sun', 'Ultra Moon'],
    versions: { 'ultra-sun': { bit: 0 }, 'ultra-moon': { bit: 1 } },
  },
  lgpe: {
    names: ["Let's Go, Pikachu!", "Let's Go, Eevee!"],
    versions: { 'lets-go-pikachu': { bit: 0 }, 'lets-go-eevee': { bit: 1 } },
  },
  swsh: {
    names: ['Sword', 'Shield'],
    versions: {
      sword: { bit: 0 },
      shield: { bit: 1 },
      'the-isle-of-armor-sword': { bit: 0, condition: 'Isle of Armor' },
      'the-isle-of-armor-shield': { bit: 1, condition: 'Isle of Armor' },
      'the-crown-tundra-sword': { bit: 0, condition: 'Crown Tundra' },
      'the-crown-tundra-shield': { bit: 1, condition: 'Crown Tundra' },
    },
  },
};

/** Biolume game ids whose locations come from PokeAPI. */
export const POKEAPI_ENCOUNTER_GAMES: ReadonlySet<string> = new Set(Object.keys(GAMES));

interface VersionInfo {
  gameId: string;
  bit: number;
  condition: string | null;
}

const VERSION_INFO: ReadonlyMap<string, VersionInfo> = new Map(
  Object.entries(GAMES).flatMap(([gameId, game]) =>
    Object.entries(game.versions).map(([slug, { bit, condition }]): [string, VersionInfo] => [
      slug,
      { gameId, bit, condition: condition ?? null },
    ]),
  ),
);

// ───────────────────────────── Encounter methods ─────────────────────────────

export interface EncounterMethodInfo {
  k: EncounterKind;
  /** Readable method label, used as the row's `m`. */
  m: string;
}

/**
 * Every PokeAPI encounter method (https://pokeapi.co/api/v2/encounter-method,
 * 66 as of 2026-10). Unknown future methods fall back to `special` with a
 * title-cased label.
 */
export const ENCOUNTER_METHODS: Readonly<Record<string, EncounterMethodInfo>> = {
  walk: { k: 'wild', m: 'Grass / cave' },
  'old-rod': { k: 'fishing', m: 'Old Rod' },
  'good-rod': { k: 'fishing', m: 'Good Rod' },
  'super-rod': { k: 'fishing', m: 'Super Rod' },
  surf: { k: 'surf', m: 'Surfing' },
  'rock-smash': { k: 'interact', m: 'Rock Smash' },
  headbutt: { k: 'interact', m: 'Headbutt' },
  'dark-grass': { k: 'special', m: 'Dark grass' },
  'grass-spots': { k: 'special', m: 'Rustling grass' },
  'cave-spots': { k: 'special', m: 'Dust cloud' },
  'bridge-spots': { k: 'special', m: 'Bridge shadow' },
  'super-rod-spots': { k: 'fishing', m: 'Super Rod (rippling water)' },
  'surf-spots': { k: 'surf', m: 'Surfing (rippling water)' },
  'yellow-flowers': { k: 'wild', m: 'Yellow flowers' },
  'purple-flowers': { k: 'wild', m: 'Purple flowers' },
  'red-flowers': { k: 'wild', m: 'Red flowers' },
  'rough-terrain': { k: 'wild', m: 'Rough terrain' },
  gift: { k: 'gift', m: 'Gift' },
  'gift-egg': { k: 'gift', m: 'Egg gift' },
  static: { k: 'static', m: 'Static encounter' },
  pokeflute: { k: 'static', m: 'Poké Flute' },
  'headbutt-low': { k: 'interact', m: 'Headbutt (low-rate tree)' },
  'headbutt-normal': { k: 'interact', m: 'Headbutt (normal tree)' },
  'headbutt-high': { k: 'interact', m: 'Headbutt (high-rate tree)' },
  'squirt-bottle': { k: 'static', m: 'Squirt Bottle' },
  'wailmer-pail': { k: 'static', m: 'Wailmer Pail' },
  seaweed: { k: 'surf', m: 'Diving (seaweed)' },
  'roaming-grass': { k: 'special', m: 'Roaming (grass)' },
  'roaming-water': { k: 'special', m: 'Roaming (water)' },
  'devon-scope': { k: 'static', m: 'Devon Scope' },
  'feebas-tile-fishing': { k: 'fishing', m: 'Fishing (Feebas tiles)' },
  'island-scan': { k: 'special', m: 'Island Scan' },
  sos: { k: 'special', m: 'SOS battle' },
  'bubbling-spots': { k: 'fishing', m: 'Fishing (bubbling spot)' },
  'berry-trees': { k: 'interact', m: 'Berry tree' },
  'npc-trade': { k: 'trade', m: 'In-game trade' },
  'sos-from-bubbling-spot': { k: 'special', m: 'SOS battle (bubbling spot)' },
  overworld: { k: 'wild', m: 'Overworld' },
  'overworld-water': { k: 'surf', m: 'Overworld (water)' },
  'overworld-flying': { k: 'wild', m: 'Overworld (flying)' },
  'overworld-special': { k: 'special', m: 'Rare spawn (Lure / catch combo)' },
  'overworld-flying-special': { k: 'special', m: 'Rare flying spawn (Lure / catch combo)' },
  'overworld-water-special': { k: 'special', m: 'Rare water spawn (Lure / catch combo)' },
  horde: { k: 'special', m: 'Horde encounter' },
  'colosseum-bonus-disc-us': { k: 'gift', m: 'Colosseum Bonus Disc (US)' },
  'colosseum-bonus-disc-jpn': { k: 'gift', m: 'Colosseum Bonus Disc (Japan)' },
  'pokemon-channel-pal': { k: 'gift', m: 'Pokémon Channel (PAL)' },
  'pokemon-ranger': { k: 'gift', m: 'Pokémon Ranger (Manaphy Egg)' },
  'pokemon-battle-revolution': { k: 'gift', m: 'Pokémon Battle Revolution' },
  'new-york-pokecenter-wish-eggs': { k: 'gift', m: 'Pokémon Center New York (Wish Egg)' },
  snag: { k: 'static', m: 'Snag' },
  'snag-rematch': { k: 'static', m: 'Snag (rematch)' },
  pokespot: { k: 'wild', m: 'Poké Spot' },
  'hidden-grotto': { k: 'den', m: 'Hidden Grotto' },
  'honey-tree': { k: 'interact', m: 'Honey tree' },
  'overworld-dirt': { k: 'wild', m: 'Overworld (from the ground)' },
  wanderer: { k: 'wild', m: 'Fixed overworld spawn' },
  'wanderer-water': { k: 'surf', m: 'Fixed overworld spawn (water)' },
  'chase-water': { k: 'surf', m: 'Chases you on water' },
  'dynamax-adventure': { k: 'raid', m: 'Dynamax Adventure' },
  'max-raid': { k: 'raid', m: 'Max Raid' },
  'trash-can-ambush': { k: 'interact', m: 'Trash can' },
  'rustling-bush-ambush': { k: 'special', m: 'Ambush (rustling bush)' },
  'ceiling-ambush': { k: 'special', m: 'Ambush (from the ceiling)' },
  'ground-ambush': { k: 'special', m: 'Ambush (from the ground)' },
  'sky-ambush': { k: 'special', m: 'Ambush (from the sky)' },
};

/** Kind and label of a PokeAPI encounter method. */
export function encounterMethod(slug: string): EncounterMethodInfo {
  return Object.hasOwn(ENCOUNTER_METHODS, slug)
    ? (ENCOUNTER_METHODS[slug] ?? { k: 'special', m: titleCaseSlug(slug) })
    : { k: 'special', m: titleCaseSlug(slug) };
}

/**
 * The method as it applies in one area. PokeAPI lists the wild Pokémon that
 * visit Isle Abeens in Poké Pelago (Sun / Moon, Ultra Sun / Ultra Moon) as
 * "gifts"; they are random visitors, not a fixed gift.
 */
export function encounterMethodAt(method: string, areaSlug: string): EncounterMethodInfo {
  if (method === 'gift' && areaSlug.startsWith('poke-pelago-')) {
    return { k: 'special', m: 'Poké Pelago visitor (Isle Abeens)' };
  }
  return encounterMethod(method);
}

/** Methods whose PokeAPI `chance` is not a per-encounter rate (group shares, roaming odds). */
const RATE_UNKNOWN_METHODS: ReadonlySet<string> = new Set([
  'honey-tree',
  'roaming-grass',
  'roaming-water',
]);

/**
 * Kinds and methods whose PokeAPI slots are single fixed spawns at 100 % each
 * (a Voltorb trap, a Kecleon revealed by the Devon Scope, a Wild Area
 * "wanderer"): 100 % per slot only restates that the encounter is this
 * Pokémon, so such a row gets no rate. It does not count them either: PokeAPI
 * repeats some of these slots (FireRed / LeafGreen list Moltres twice; Ruby /
 * Emerald list New Mauville's three Voltorb twice over), so a count would be
 * wrong where a hunter can least check it.
 */
const FIXED_KINDS: ReadonlySet<EncounterKind> = new Set(['static', 'gift', 'trade']);
const FIXED_SPAWN_METHODS: ReadonlySet<string> = new Set([
  'wanderer',
  'wanderer-water',
  'chase-water',
  'island-scan',
  'overworld-special',
  'overworld-flying-special',
  'overworld-water-special',
  'dynamax-adventure',
]);

// ───────────────────────────── Conditions ─────────────────────────────

type StateCategory =
  'time' | 'season' | 'weather' | 'hall-of-fame' | 'national-dex' | 'max-den-rarity';

/**
 * Conditions that are always in exactly one of these values. Slots without a
 * value of a category apply to all of its values.
 */
const STATE_DOMAINS: Readonly<Record<StateCategory, readonly string[]>> = {
  time: ['time-morning', 'time-day', 'time-night'],
  season: ['season-spring', 'season-summer', 'season-autumn', 'season-winter'],
  weather: [
    'weather-normal',
    'weather-overcast',
    'weather-raining',
    'weather-thunderstorm',
    'weather-snowing',
    'weather-snowstorm',
    'weather-sandstorm',
    'weather-intense-sun',
    'weather-fog',
  ],
  'hall-of-fame': ['story-progress-before-hall-of-fame', 'story-progress-hall-of-fame'],
  'national-dex': ['story-progress-before-national-dex', 'story-progress-national-dex'],
  // A Max Raid den shines with one kind of beam at a time.
  'max-den-rarity': ['max-den-rarity-common', 'max-den-rarity-rare', 'max-den-rarity-special'],
};

const STATE_CATEGORIES = Object.keys(STATE_DOMAINS) as StateCategory[];

const STATE_OF_VALUE: ReadonlyMap<string, StateCategory> = new Map(
  STATE_CATEGORIES.flatMap((category) =>
    STATE_DOMAINS[category].map((value): [string, StateCategory] => [value, category]),
  ),
);

/**
 * "Off" values: the default state of a toggle. They are never shown; a slot
 * carrying one is replaced while its toggle is on. Value → toggle category.
 */
const OFF_VALUES: ReadonlyMap<string, string> = new Map([
  ['swarm-no', 'swarm'],
  ['radar-off', 'radar'],
  ['slot2-none', 'slot2'],
  ['radio-off', 'radio'],
  ['bug-catching-contest-no', 'bug-catching-contest'],
  ['johto-safari-blocks-inactive', 'johto-safari-blocks'],
  ['backlot-not-mentioned', 'backlot'],
  ['great-marsh-daily-slot-none', 'great-marsh-daily-slot'],
  ['story-progress-none', 'story-progress-none'],
  ['other-none', 'other-none'],
  ['item-none', 'item-none'],
]);

/** Toggle categories: turning one on replaces the slots carrying its "off" value. */
const TOGGLE_CATEGORIES = [
  'swarm',
  'radar',
  'slot2',
  'radio',
  'bug-catching-contest',
  'johto-safari-blocks',
  'backlot',
  'great-marsh-daily-slot',
] as const;

function toggleCategory(value: string): string | null {
  return TOGGLE_CATEGORIES.find((category) => value.startsWith(`${category}-`)) ?? null;
}

const MAX_RAID_RATING = /^max-den-rating-(\d)-stars?$/;

/** Labels that are not derived from a pattern below. */
const CONDITION_LABELS: Readonly<Record<string, string>> = {
  'swarm-yes': 'Swarm',
  'time-morning': 'Morning',
  'time-day': 'Day',
  'time-night': 'Night',
  'radar-on': 'Poké Radar',
  'radio-hoenn': 'Hoenn Sound (radio)',
  'radio-sinnoh': 'Sinnoh Sound (radio)',
  'season-spring': 'Spring',
  'season-summer': 'Summer',
  'season-autumn': 'Autumn',
  'season-winter': 'Winter',
  'tv-option-blue': 'Answered "blue" to the TV news report',
  'tv-option-red': 'Answered "red" to the TV news report',
  'story-progress-awakened-beasts': 'After awakening the legendary beasts (Burned Tower)',
  'story-progress-beat-galactic-coronet':
    'After visiting Lake Verity once Team Galactic is beaten at Mt. Coronet',
  'story-progress-oak-eterna-city': 'After talking to Professor Oak in Eterna City',
  'story-progress-vermilion-copycat': "After visiting the Pokémon Fan Club with Copycat's doll",
  'story-progress-met-tornadus-thundurus': 'After meeting Tornadus or Thundurus',
  'story-progress-beat-elite-four-round-two': 'After beating the Elite Four a second time',
  'story-progress-hall-of-fame': 'After entering the Hall of Fame',
  'story-progress-before-hall-of-fame': 'Before entering the Hall of Fame',
  'story-progress-national-dex': 'After obtaining the National Pokédex',
  'story-progress-before-national-dex': 'Before obtaining the National Pokédex',
  'other-snorlax-11-beat-league':
    'After beating the League, if the Route 11 Snorlax was knocked out',
  'other-virtual-console': 'Virtual Console release only',
  'story-progress-cure-eldritch-nightmares': "After curing the nightmares of Eldritch's son",
  'other-talk-to-cynthias-grandmother': "After talking to Cynthia's grandmother",
  'story-progress-defeat-jupiter': 'After defeating Jupiter',
  'story-progress-beat-team-galactic-iron-island': 'After defeating Team Galactic on Iron Island',
  'other-correct-password': 'After entering the correct password',
  'story-progress-zephyr-badge': 'After earning the Zephyr Badge',
  'story-progress-beat-red': 'After defeating Red',
  'other-received-kanto-starter': 'After receiving a Kanto starter',
  'story-progress-receive-tm-from-claire': 'After receiving TM59 from Clair',
  'other-regirock-regice-registeel-in-party': 'Regirock, Regice and Registeel in the party',
  'first-party-pokemon-high-friendship': 'Lead Pokémon has high friendship',
  'story-progress-defeat-mars': 'After defeating Mars',
  'other-talked-to-32-people-underground': 'After talking to 32 people in the Underground',
  'story-progress-returned-machine-part': 'After returning the Machine Part',
  'other-event-arceus-in-party': 'Event Arceus in the party',
  'special-encounter-couldnt-capture-before': 'If not caught at the first encounter',
  'story-progress-juniper-cave-of-being': 'After meeting Professor Juniper in the Cave of Being',
  'story-progress-quake-badge': 'After earning the Quake Badge',
  'other-captured-reshiram-or-zekrom': 'After catching Reshiram or Zekrom',
  'defeated-ghetsis': 'After defeating Ghetsis',
  'other-found-11-times-roaming': 'After meeting it 11 times while it roams',
  'time-minute-00-to-19': 'Minutes :00–:19 of each hour',
  'time-minute-20-to-39': 'Minutes :20–:39 of each hour',
  'time-minute-40-to-59': 'Minutes :40–:59 of each hour',
  'time-04-00-to-19-59': '04:00–19:59',
  'time-20-00-to-21-59': '20:00–21:59',
  // The slug says 21-00, PokeAPI's own description and the game say 22:00.
  'time-21-00-to-03-59': '22:00–03:59',
  'story-progress-defeated-groudon-or-kyogre': 'After defeating or catching Groudon or Kyogre',
  'other-uxie-mesprit-azelf-in-party': 'Uxie, Mesprit and Azelf in the party',
  'other-nicknamed-cold-item-regice-regirock-registeel3':
    'Nicknamed Regice holding a cold item, Regirock and Registeel in the party',
  'other-dialga-or-palkia-in-party': 'Dialga or Palkia in the party',
  'other-castform-in-party': 'Castform in the party',
  'other-level-100-pokemon-in-party': 'A level 100 Pokémon in the party',
  'other-tornadus-thundurus-in-party': 'Tornadus and Thundurus in the party',
  'other-reshiram-zekrom-in-party': 'Reshiram and Zekrom in the party',
  'other-captured-all-ultra-beasts': 'After catching every Ultra Beast',
  'story-progress-finished-looker-sidequest': "After finishing Looker's side quest",
  'story-progress-beat-olivias-trial': "After Olivia's grand trial",
  'other-raikou-entei-in-party': 'Raikou and Entei in the party',
  'other-groudon-kyogre-in-party': 'Groudon and Kyogre in the party',
  'other-dialga-palkia-in-party': 'Dialga and Palkia in the party',
  'other-scan-qr-code': 'Scan a QR code',
  'other-caught-articuno': 'After catching Articuno',
  'other-caught-zapdos': 'After catching Zapdos',
  'other-caught-moltres': 'After catching Moltres',
  'story-progress-catch-all-shadow-pokemon': 'After snagging every Shadow Pokémon',
  'other-complete-mt-battle': 'After completing Mt. Battle',
  'honey-tree-group-a': 'Honey tree group A (70% on normal trees, 20% on Munchlax trees)',
  'honey-tree-group-b': 'Honey tree group B (20% on normal trees, 70% on Munchlax trees)',
  'honey-tree-group-c': 'Honey tree group C (Munchlax trees only, 1%)',
  'headbutt-tree-common': 'Common trees',
  'headbutt-tree-rare': 'Rare trees',
  'headbutt-tree-secret': 'Secret trees',
  'backlot-mentioned': 'After Mr. Backlot mentions it (Trophy Garden)',
  'bug-catching-contest-yes': 'Bug-Catching Contest',
  'save-data-from-lets-go-pikachu': "Let's Go, Pikachu! save data",
  'save-data-from-lets-go-eevee': "Let's Go, Eevee! save data",
  'story-progress-master-dojo-complete-first-trial': 'After the first Master Dojo trial',
  'story-progress-master-dojo-complete-third-trial': 'After all three Master Dojo trials',
  'story-progress-save-village-from-glastrier-spectrier':
    'After saving Freezington from Glastrier or Spectrier',
  'story-progress-catch-five-ultra-beasts': 'After catching 5 Ultra Beasts in Dynamax Adventures',
  'weather-normal': 'Normal weather',
  'weather-overcast': 'Overcast',
  'weather-raining': 'Raining',
  'weather-thunderstorm': 'Thunderstorm',
  'weather-snowing': 'Snowing',
  'weather-snowstorm': 'Snowstorm',
  'weather-sandstorm': 'Sandstorm',
  'weather-intense-sun': 'Intense sun',
  'weather-fog': 'Fog',
  'other-giratina-not-caught-in-distortion-world':
    'If Giratina was not caught in the Distortion World',
  'other-find-50-cavern-footprints': 'After finding 50 Cavern Footprints',
  'other-find-50-grassland-footprints': 'After finding 50 Grassland Footprints',
  'other-find-50-iron-will-footprints': 'After finding 50 Iron Will Footprints',
  'other-regirock-regice-registeel-regieleki-regidrago-in-party':
    'Regirock, Regice, Registeel, Regieleki and Regidrago in the party',
  'other-choose-regieleki-pattern': 'Regieleki pattern chosen (Split-Decision Ruins)',
  'other-choose-regidrago-pattern': 'Regidrago pattern chosen (Split-Decision Ruins)',
  'other-grow-iceroot-carrot': 'After growing an Iceroot Carrot',
  'other-grow-shaderoot-carrot': 'After growing a Shaderoot Carrot',
  'other-talked-to-32-people': 'After talking to 32 people (Ballimere Lake tombstone)',
  'other-eat-curry-with-cobalion-terrakion-virizion':
    'After eating curry with Cobalion, Terrakion and Virizion',
  'other-witness-galarian-bird-fight': 'After seeing the Galarian birds fight (Dyna Tree Hill)',
  'max-den-rarity-common': 'Red beam (common den)',
  'max-den-rarity-rare': 'Purple beam (rare den)',
  'max-den-rarity-special': 'Wild Area News event den',
  'trash-can-type-daily': 'Trash can (daily)',
  'trash-can-type-tuesday': 'Trash can (Tuesdays)',
  'trash-can-type-thursday': 'Trash can (Thursdays)',
  'trade-togepi-or-togetic': 'Give Togepi or Togetic',
  'trade-any-pokemon': 'Give any Pokémon',
};

const DUAL_SLOT_GAMES: Readonly<Record<string, string>> = {
  ruby: 'Ruby',
  sapphire: 'Sapphire',
  emerald: 'Emerald',
  firered: 'FireRed',
  leafgreen: 'LeafGreen',
};

function pokemonName(slug: string): string {
  const ref = findBySlug(slug);
  return ref ? (ref.form?.name ?? ref.species.name) : titleCaseSlug(slug);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Plain-English text of a PokeAPI encounter condition value, or null for an
 * "off" value that only means the default state (`swarm-no`, `radar-off`, …).
 * Covers every value of https://pokeapi.co/api/v2/encounter-condition-value
 * (361 as of 2026-10); unknown values fall back to a title-cased slug.
 */
export function conditionLabel(value: string): string | null {
  if (OFF_VALUES.has(value)) return null;
  if (Object.hasOwn(CONDITION_LABELS, value)) return CONDITION_LABELS[value] ?? null;
  let match: RegExpExecArray | null;
  if (
    (match = /^slot2-(\w+)$/.exec(value)) &&
    match[1] &&
    Object.hasOwn(DUAL_SLOT_GAMES, match[1])
  ) {
    return `${DUAL_SLOT_GAMES[match[1]] ?? match[1]} in slot 2`;
  }
  if ((match = /^starter-([a-z-]+)$/.exec(value)) && match[1]) {
    return `Chose ${pokemonName(match[1])} as starter`;
  }
  if ((match = /^trade-([a-z0-9-]+)$/.exec(value)) && match[1]) {
    return `Give ${pokemonName(match[1])}`;
  }
  if ((match = /^weekday-([a-z]+)$/.exec(value)) && match[1]) {
    return `${capitalise(match[1])}s`;
  }
  if ((match = /^coins-(\d+)$/.exec(value)) && match[1]) {
    return `Game Corner prize (${Number(match[1]).toLocaleString('en-US')} coins)`;
  }
  if ((match = /^item-([a-z0-9-]+)$/.exec(value)) && match[1]) {
    return `Needs the ${titleCaseSlug(match[1])}`;
  }
  if ((match = /^friend-safari-slot-(\d)$/.exec(value)) && match[1]) {
    return `Friend Safari slot ${match[1]}`;
  }
  if ((match = /^great-marsh-daily-slot-(\d+)-of-(\d+)$/.exec(value)) && match[1] && match[2]) {
    return `Great Marsh daily Pokémon (${match[1]} of ${match[2]} days)`;
  }
  if ((match = /^johto-safari-blocks-([a-z]+)-min-(\d+)$/.exec(value)) && match[1] && match[2]) {
    return `Safari Zone: ${match[2]}+ ${capitalise(match[1])} block points`;
  }
  if ((match = /^alolan-diglett-found-(\d+)$/.exec(value)) && match[1]) {
    return `After finding ${match[1]} Alolan Diglett`;
  }
  if ((match = MAX_RAID_RATING.exec(value)) && match[1]) {
    return `${match[1]}★ raid`;
  }
  if ((match = /^berry-tree-type-([a-z]+)$/.exec(value)) && match[1]) {
    return `${capitalise(match[1])} berry tree`;
  }
  return titleCaseSlug(value);
}

// ───────────────────────────── Shiny locks ─────────────────────────────

type ShinyRule = 'never' | 'always';

/** PKHeX entry levels of one species by rule (`random` only listed next to a non-random rule). */
type SpeciesShinyLevels = Partial<Record<ShinyRule | 'random', number[]>>;

interface LocationIndexFile {
  areas: Record<string, string>;
  /** Game id → PKHeX gifts / statics (`fixed`) and trades by species id. */
  shiny: Record<
    string,
    { fixed: Record<string, SpeciesShinyLevels>; trade: Record<string, SpeciesShinyLevels> }
  >;
  /** Area slug → the weathers it can have, for areas that do not have all of them. */
  weathers?: Record<string, string[]>;
}

const INDEX = locationIndex as unknown as LocationIndexFile;

/** Games in which PKHeX models some NPC gifts PokeAPI calls gifts as trades (Kenya the Spearow, …). */
const GIFTS_AS_TRADES: ReadonlySet<string> = new Set(['gsc', 'rse', 'frlg', 'dppt', 'hgss']);

const RULES = ['never', 'always', 'random'] as const;

/** The single rule of the entries whose level lies in [min, max] (0 = unknown level, matches all). */
function ruleAtLevels(
  levels: SpeciesShinyLevels | undefined,
  min: number,
  max: number,
  anyLevel: boolean,
): ShinyRule | 'random' | 'mixed' | null {
  if (!levels) return null;
  const inRange = (level: number): boolean =>
    anyLevel || level === 0 || (level >= min && level <= max);
  const matched = RULES.filter((rule) => levels[rule]?.some(inRange));
  if (matched.length === 0) return null;
  return matched.length === 1 ? (matched[0] ?? null) : 'mixed';
}

/**
 * PKHeX's shiny rule for a gift / static / trade row: the rule shared by the
 * species' PKHeX entries of that category whose level lies in the row's level
 * range; null when none match or they disagree (a Gen 2 Odd Egg can be both).
 * Trade levels are minimums that PokeAPI and PKHeX count differently, so a
 * trade falls back to all of the species' trades. A gift PokeAPI lists may be
 * a trade in PKHeX (Gen 2–4 NPC gifts).
 */
function pkhexShinyRule(
  gameId: string,
  speciesId: number,
  kind: EncounterKind,
  min: number,
  max: number,
): ShinyRule | null {
  const table = INDEX.shiny[gameId];
  if (!table || (kind !== 'static' && kind !== 'gift' && kind !== 'trade')) return null;
  const key = String(speciesId);
  const lookup = (map: Record<string, SpeciesShinyLevels>) =>
    Object.hasOwn(map, key) ? map[key] : undefined;
  let rule: ReturnType<typeof ruleAtLevels>;
  if (kind === 'trade') {
    const trades = lookup(table.trade);
    rule = ruleAtLevels(trades, min, max, false) ?? ruleAtLevels(trades, min, max, true);
  } else {
    rule = ruleAtLevels(lookup(table.fixed), min, max, false);
    if (rule === null && kind === 'gift' && GIFTS_AS_TRADES.has(gameId)) {
      const trades = lookup(table.trade);
      rule = ruleAtLevels(trades, min, max, false) ?? ruleAtLevels(trades, min, max, true);
    }
  }
  return rule === 'never' || rule === 'always' ? rule : null;
}

// ───────────────────────────── Locations ─────────────────────────────

/** English display name of a PokeAPI location-area slug, e.g. `sprout-tower-2f` → `Sprout Tower — 2F`. */
export function areaDisplayName(slug: string): string {
  if (Object.hasOwn(INDEX.areas, slug)) {
    const name = INDEX.areas[slug];
    if (name) return name;
  }
  // Unknown area (newer than the bundled index): a readable title-cased slug.
  return titleCaseSlug(slug.replace(/-area$/, '')).replace(/\b(B?\d+)f\b/gi, (floor) =>
    floor.toUpperCase(),
  );
}

// ───────────────────────────── Raw payload ─────────────────────────────

const namedResource = z.object({ name: z.string().min(1) });

const rawEncountersSchema = z.array(
  z.object({
    location_area: namedResource,
    version_details: z.array(
      z.object({
        version: namedResource,
        encounter_details: z.array(
          z.object({
            min_level: z.number().nullish(),
            max_level: z.number().nullish(),
            chance: z.number().nullish(),
            method: namedResource,
            condition_values: z.array(namedResource).nullish(),
            pokemon_details: z
              .object({
                always_shiny: z.boolean().nullish(),
                never_shiny: z.boolean().nullish(),
              })
              .nullish(),
          }),
        ),
      }),
    ),
  }),
);

// ───────────────────────────── Normalisation ─────────────────────────────

/** One game's encounters as cached: rows whose `l` is a 1-based index into `areas` (area slugs). */
export interface CachedGameEncounters {
  areas: string[];
  rows: EncounterRow[];
}

/** What the encounters query caches for one Pokémon. */
export interface PokeApiEncounterData {
  pokemonId: number;
  /** Every game of {@link POKEAPI_ENCOUNTER_GAMES}, possibly with no rows. */
  games: Record<string, CachedGameEncounters>;
}

/** One PokeAPI slot, classified. */
interface Slot {
  states: Map<StateCategory, string>;
  /** Sorted values that must hold (toggles that are on, story flags, items, …). */
  requirements: string[];
  /** Toggle categories whose "off" state this slot needs. */
  offToggles: Set<string>;
  min: number;
  max: number;
  chance: number | null;
  neverShiny: boolean;
  alwaysShiny: boolean;
}

interface Totals {
  min: number;
  max: number;
  chance: number | null;
  neverShiny: boolean;
  alwaysShiny: boolean;
}

interface Outcome extends Totals {
  requirements: string[];
  /** Labels of the state values this outcome holds in (empty = all of them). */
  states: string[];
}

/**
 * Known slips in PokeAPI's condition data. Rolling Fields (Sword / Shield) tags
 * its pre-Hall-of-Fame overworld, grass, berry-tree and fixed spawns with
 * `max-den-rarity-special` where every other Wild Area zone uses
 * `story-progress-before-hall-of-fame` (each paired with a
 * `story-progress-hall-of-fame` slot); a max-den value means nothing outside
 * a Max Raid.
 */
function correctedCondition(value: string, method: string): string {
  if (value === 'max-den-rarity-special' && method !== 'max-raid') {
    return 'story-progress-before-hall-of-fame';
  }
  return value;
}

type RawArea = z.infer<typeof rawEncountersSchema>[number];
type RawDetail = RawArea['version_details'][number]['encounter_details'][number];

/**
 * Encounters PokeAPI files under the wrong area or version (checked against
 * Bulbapedia): `to` re-files them, `null` drops them.
 *   - Black / White: the roaming Tornadus / Thundurus sit in Kalos's Team Flare
 *     Secret HQ instead of the (otherwise empty) "roaming Unova" area.
 *   - HeartGold / SoulSilver: Latias / Latios roam Kanto, not Johto (the
 *     legendary beasts sharing that area do roam Johto).
 *   - Sun: three of Sapphire's New Mauville Voltorb / Electrode slots are filed
 *     under Sun; New Mauville is in Hoenn.
 *   - Ultra Sun / Ultra Moon: the Trainers' School Gastly and Drifloon appear a
 *     second time under Sinnoh's Trainers' School.
 *   - HeartGold / SoulSilver: Vermilion City has one water table, but PokeAPI
 *     adds an "S.S. Anne dock" copy of it that lost the Wingull swarm tag and
 *     puts Magikarp in every rod slot (a "100 %" Super Rod Magikarp that does
 *     not exist). Gold / Silver / Crystal's own dock table is genuine.
 */
const MISFILED: readonly {
  versions: readonly string[];
  area: string;
  species?: readonly number[];
  to: string | null;
}[] = [
  { versions: ['black', 'white'], area: 'team-flare-secret-hq-area', to: 'roaming-unova-area' },
  {
    versions: ['heartgold', 'soulsilver'],
    area: 'roaming-johto-area',
    species: [380, 381],
    to: 'roaming-kanto-area',
  },
  { versions: ['sun'], area: 'new-mauville-area', to: null },
  { versions: ['ultra-sun', 'ultra-moon'], area: 'trainers-school-area', to: null },
  { versions: ['heartgold', 'soulsilver'], area: 'vermilion-city-ss-anne-dock', to: null },
];

const TIME_VALUES: ReadonlySet<string> = new Set(STATE_DOMAINS.time);

function hasTime(detail: RawDetail): boolean {
  return (detail.condition_values ?? []).some((value) => TIME_VALUES.has(value.name));
}

function slotSignature(details: readonly RawDetail[]): string {
  return details
    .map(
      (detail) => `${detail.chance ?? '-'}/${detail.min_level ?? '-'}/${detail.max_level ?? '-'}`,
    )
    .sort()
    .join(',');
}

function withTime(detail: RawDetail, time: string): RawDetail {
  return { ...detail, condition_values: [...(detail.condition_values ?? []), { name: time }] };
}

/**
 * Gold / Silver / Crystal slots that lost their time of day in PokeAPI
 * (checked against Bulbapedia and pret/pokecrystal):
 *   - Silver's Super Rod slots in 7 areas (Olivine, Cianwood, Cherrygrove,
 *     Union Cave B2F, Routes 19, 34 and 40) carry no time, so Corsola (morning
 *     and day) and Staryu (night) read as all-day and Krabby's three time
 *     copies add up. Gold's identical tables keep the times: a version whose
 *     slots for a method have no time takes its sibling's when they match
 *     slot for slot.
 *   - Crystal's Kanto Route 13 grass lists the morning, day and night tables
 *     without times. Morning and day are identical there, so a slot found
 *     three times is in all of them, twice is morning and day, once is night.
 *   - Crystal's Route 42 grass gives Golbat's night-only 1 % slot no time.
 */
const TIME_SIBLINGS: Readonly<Record<string, string>> = { gold: 'silver', silver: 'gold' };

function restoreTimes(
  areaSlug: string,
  version: string,
  details: readonly RawDetail[],
  siblings: ReadonlyMap<string, readonly RawDetail[]>,
): RawDetail[] {
  const byMethod = new Map<string, RawDetail[]>();
  for (const detail of details) {
    const list = byMethod.get(detail.method.name);
    if (list) list.push(detail);
    else byMethod.set(detail.method.name, [detail]);
  }
  const result: RawDetail[] = [];
  for (const [method, list] of byMethod) {
    const sibling = TIME_SIBLINGS[version];
    const theirs = sibling
      ? (siblings.get(sibling) ?? []).filter((detail) => detail.method.name === method)
      : [];
    if (
      !list.some(hasTime) &&
      theirs.some(hasTime) &&
      slotSignature(theirs) === slotSignature(list)
    ) {
      result.push(...theirs);
    } else if (
      version === 'crystal' &&
      areaSlug === 'kanto-route-13-area' &&
      method === 'walk' &&
      !list.some(hasTime)
    ) {
      const copies = new Map<string, number>();
      for (const detail of list) {
        const key = slotSignature([detail]);
        copies.set(key, (copies.get(key) ?? 0) + 1);
      }
      const seen = new Map<string, number>();
      for (const detail of list) {
        const key = slotSignature([detail]);
        const index = seen.get(key) ?? 0;
        seen.set(key, index + 1);
        const times =
          copies.get(key) === 1 ? ['time-night'] : ['time-morning', 'time-day', 'time-night'];
        result.push(withTime(detail, times[index] ?? 'time-night'));
      }
    } else if (version === 'crystal' && areaSlug === 'johto-route-42-area' && method === 'walk') {
      result.push(
        ...list.map((detail) =>
          hasTime(detail) || (detail.condition_values ?? []).length > 0
            ? detail
            : withTime(detail, 'time-night'),
        ),
      );
    } else {
      result.push(...list);
    }
  }
  return result;
}

/**
 * One area's encounters in one version with PokeAPI's known slips corrected:
 * the area they really belong to, or null to drop them.
 */
export function correctedEncounters(
  areaSlug: string,
  version: string,
  speciesId: number | null,
  details: readonly RawDetail[],
  siblings: ReadonlyMap<string, readonly RawDetail[]> = new Map(),
): { area: string; details: RawDetail[] } | null {
  const misfiled = MISFILED.find(
    (entry) =>
      entry.area === areaSlug &&
      entry.versions.includes(version) &&
      (!entry.species || (speciesId !== null && entry.species.includes(speciesId))),
  );
  if (misfiled?.to === null) return null;
  return {
    area: misfiled?.to ?? areaSlug,
    details: restoreTimes(areaSlug, version, details, siblings),
  };
}

function toSlot(
  method: string,
  detail: {
    min_level?: number | null;
    max_level?: number | null;
    chance?: number | null;
    condition_values?: { name: string }[] | null;
    pokemon_details?: { always_shiny?: boolean | null; never_shiny?: boolean | null } | null;
  },
): Slot | null {
  const min = detail.min_level ?? detail.max_level;
  const max = detail.max_level ?? detail.min_level;
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  const states = new Map<StateCategory, string>();
  const requirements = new Set<string>();
  const offToggles = new Set<string>();
  for (const condition of detail.condition_values ?? []) {
    const name = correctedCondition(condition.name, method);
    const state = STATE_OF_VALUE.get(name);
    const off = OFF_VALUES.get(name);
    if (state) states.set(state, name);
    else if (off) offToggles.add(off);
    else requirements.add(name);
  }
  return {
    states,
    requirements: [...requirements].sort(),
    offToggles,
    min: Math.min(min, max),
    max: Math.max(min, max),
    chance: typeof detail.chance === 'number' ? detail.chance : null,
    neverShiny: detail.pokemon_details?.never_shiny === true,
    alwaysShiny: detail.pokemon_details?.always_shiny === true,
  };
}

function totals(slots: readonly Slot[]): Totals {
  let min = Infinity;
  let max = -Infinity;
  let chance: number | null = 0;
  for (const slot of slots) {
    min = Math.min(min, slot.min);
    max = Math.max(max, slot.max);
    chance = chance === null || slot.chance === null ? null : chance + slot.chance;
  }
  return {
    min,
    max,
    chance,
    neverShiny: slots.every((slot) => slot.neverShiny),
    alwaysShiny: slots.every((slot) => slot.alwaysShiny),
  };
}

function* cartesian(lists: readonly (readonly string[])[]): Generator<string[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [head = [], ...rest] = lists;
  for (const value of head) {
    for (const tail of cartesian(rest)) yield [value, ...tail];
  }
}

/**
 * Splits a set of state tuples into products of per-category value sets:
 * {(morning, before), (day, before), (morning, after), (day, after)} →
 * [[[morning, day], [before, after]]].
 */
function decompose(tuples: readonly string[][]): string[][][] {
  if (tuples.length === 0) return [];
  if ((tuples[0]?.length ?? 0) === 0) return [[]];
  const restByHead = new Map<string, string[][]>();
  for (const [head = '', ...rest] of tuples) {
    const list = restByHead.get(head);
    if (list) list.push(rest);
    else restByHead.set(head, [rest]);
  }
  const bySignature = new Map<string, { heads: string[]; rest: string[][] }>();
  for (const [head, rest] of restByHead) {
    const signature = rest
      .map((tuple) => tuple.join('|'))
      .sort()
      .join(',');
    const group = bySignature.get(signature);
    if (group) group.heads.push(head);
    else bySignature.set(signature, { heads: [head], rest });
  }
  const products: string[][][] = [];
  for (const { heads, rest } of bySignature.values()) {
    for (const tail of decompose(rest)) products.push([heads, ...tail]);
  }
  return products;
}

/** Nouns for "Any weather except Snowing / Snowstorm" when most of a long domain applies. */
const STATE_NOUNS: Partial<Record<StateCategory, string>> = {
  weather: 'weather',
  season: 'season',
};

/**
 * Values whose coverage makes a state condition pointless, where not the whole
 * domain: a raid Pokémon found in red- and purple-beam dens alike needs no
 * beam condition, whatever the temporary Wild Area News dens hold.
 */
const STATE_COVERAGE: Partial<Record<StateCategory, readonly string[]>> = {
  'max-den-rarity': ['max-den-rarity-common', 'max-den-rarity-rare'],
};

/**
 * The values a state category can take in one area: every weather, except in
 * areas the location index lists with only some (the Isle of Armor never
 * snows, the Crown Tundra has no sandstorm). Values the slots carry are always
 * kept, so a newer PokeAPI than the bundled index loses nothing.
 */
function stateDomain(
  category: StateCategory,
  areaSlug: string,
  slots: readonly Slot[],
): readonly string[] {
  const domain = STATE_DOMAINS[category];
  const weathers = INDEX.weathers;
  if (category !== 'weather' || !weathers || !Object.hasOwn(weathers, areaSlug)) return domain;
  const local = new Set(weathers[areaSlug]);
  for (const slot of slots) {
    const value = slot.states.get(category);
    if (value !== undefined) local.add(value);
  }
  return domain.filter((value) => local.has(value));
}

function stateLabel(
  values: readonly string[],
  category: StateCategory,
  domain: readonly string[],
): string | null {
  const coverage = STATE_COVERAGE[category] ?? domain;
  if (coverage.every((value) => values.includes(value))) return null;
  const label = (value: string): string => conditionLabel(value) ?? value;
  const noun = STATE_NOUNS[category];
  if (noun && domain.length >= 4 && values.length > domain.length / 2) {
    const missing = domain.filter((value) => !values.includes(value));
    return `Any ${noun} except ${missing.map(label).join(' / ')}`;
  }
  return values.map(label).join(' / ');
}

/**
 * The outcome of `active` slots in every combination of state values, merged
 * where equal. With a `baseline`, combinations in which `active` gives the
 * same outcome as the baseline slots are left out.
 */
function expandStates(
  active: readonly Slot[],
  baseline: readonly Slot[] | null,
  domainOf: (category: StateCategory) => readonly string[],
): { states: string[]; totals: Totals }[] {
  const categories = STATE_CATEGORIES.filter((category) =>
    active.some((slot) => slot.states.has(category)),
  );
  const domains = categories.map(domainOf);

  const valueLists = categories.map((category, index) => {
    const domain = domains[index] ?? STATE_DOMAINS[category];
    // Slots without a value of the category exist in all of its values.
    if (active.some((slot) => !slot.states.has(category))) return domain;
    const seen = new Set(active.map((slot) => slot.states.get(category)));
    return domain.filter((value) => seen.has(value));
  });
  const inState = (tuple: readonly string[]) => (slot: Slot) =>
    categories.every((category, index) => {
      const value = slot.states.get(category);
      return value === undefined || value === tuple[index];
    });

  const groups = new Map<string, { totals: Totals; tuples: string[][] }>();
  for (const tuple of cartesian(valueLists)) {
    const matching = active.filter(inState(tuple));
    if (matching.length === 0) continue;
    const result = totals(matching);
    const key = JSON.stringify(result);
    if (baseline) {
      const before = baseline.filter(inState(tuple));
      if (before.length > 0 && JSON.stringify(totals(before)) === key) continue;
    }
    const group = groups.get(key);
    if (group) group.tuples.push(tuple);
    else groups.set(key, { totals: result, tuples: [tuple] });
  }

  const expanded: { states: string[]; totals: Totals }[] = [];
  for (const group of groups.values()) {
    if (categories.length === 0) {
      expanded.push({ states: [], totals: group.totals });
      continue;
    }
    for (const product of decompose(group.tuples)) {
      const states = product
        .map((values, index) => {
          const category = categories[index];
          const domain = domains[index];
          return category && domain ? stateLabel(values, category, domain) : null;
        })
        .filter((label): label is string => label !== null);
      expanded.push({ states, totals: group.totals });
    }
  }
  return expanded;
}

/** Combines the slots of one (area, method, version) into the rows a player would see. */
function outcomes(slots: readonly Slot[], areaSlug: string): Outcome[] {
  const domainOf = (category: StateCategory) => stateDomain(category, areaSlug, slots);
  const variants = new Map<string, string[]>([['', []]]);
  for (const slot of slots) variants.set(slot.requirements.join('+'), slot.requirements);

  const activeUnder = (requirements: readonly string[]): Slot[] => {
    const required = new Set(requirements);
    const toggled = new Set(requirements.map(toggleCategory).filter((category) => category));
    return slots.filter(
      (slot) =>
        slot.requirements.every((value) => required.has(value)) &&
        ![...slot.offToggles].some((category) => toggled.has(category)),
    );
  };

  const result: Outcome[] = [];
  const baseSlots = activeUnder([]);
  for (const requirements of variants.values()) {
    const isBase = requirements.length === 0;
    const active = isBase ? baseSlots : activeUnder(requirements);
    if (active.length === 0) continue;
    // Under a requirement, only the states in which it changes this Pokémon's outcome get a row.
    for (const { states, totals: sum } of expandStates(
      active,
      isBase ? null : baseSlots,
      domainOf,
    )) {
      result.push({ requirements, states, ...sum });
    }
  }
  return result;
}

interface GameBuilder {
  areas: string[];
  areaIndex: Map<string, number>;
  /** Row key (row without `v`) → row and version mask. */
  rows: Map<string, { row: EncounterRow; mask: number }>;
}

function toRow(
  method: string,
  info: EncounterMethodInfo,
  outcome: Outcome,
  location: number,
  dlc: string | null,
  lock: ShinyRule | null,
): EncounterRow {
  let label = info.m;
  const conditions: string[] = dlc ? [dlc] : [];
  for (const value of outcome.requirements) {
    const rating = MAX_RAID_RATING.exec(value);
    if (rating) {
      label = `${label} ★${rating[1] ?? ''}`;
      continue;
    }
    const text = conditionLabel(value);
    if (text) conditions.push(text);
  }
  conditions.push(...outcome.states);
  const alwaysShiny = lock === 'always' || (outcome.alwaysShiny && lock !== 'never');
  if (alwaysShiny) conditions.push('Always shiny');

  const chance = outcome.chance;
  const fixedSpawns =
    (FIXED_KINDS.has(info.k) || FIXED_SPAWN_METHODS.has(method)) &&
    chance !== null &&
    chance >= 100 &&
    chance % 100 === 0;

  const row: EncounterRow = { k: info.k, l: location, n: outcome.min, x: outcome.max, m: label };
  if (conditions.length > 0) row.c = conditions;
  if (chance !== null && chance > 0 && !fixedSpawns && !RATE_UNKNOWN_METHODS.has(method)) {
    row.r = Math.min(100, Math.round(chance * 100) / 100);
  }
  if (!alwaysShiny && (lock === 'never' || outcome.neverShiny)) row.s = 1;
  return row;
}

function invalidResponse(url: string, issues: z.core.$ZodIssue[]): PokeApiError {
  const first = issues[0];
  const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  return new PokeApiError(
    'invalid-response',
    `Unexpected PokeAPI encounter response${where}${first ? `: ${first.message}` : ''}`,
    { url },
  );
}

/**
 * Reduces a raw `/pokemon/{id}/encounters` payload to compact rows for every
 * game of {@link POKEAPI_ENCOUNTER_GAMES} (other versions are dropped).
 * @throws PokeApiError (`invalid-response`) when the payload is not an encounter list.
 */
export function trimEncounters(
  raw: unknown,
  pokemonId: number,
  url = `${POKEAPI_BASE_URL}/pokemon/${pokemonId}/encounters`,
): PokeApiEncounterData {
  const parsed = rawEncountersSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse(url, parsed.error.issues);
  const speciesId =
    findByPokemonId(pokemonId)?.species.id ?? (pokemonId <= 1025 ? pokemonId : null);

  const builders = new Map<string, GameBuilder>();
  for (const gameId of POKEAPI_ENCOUNTER_GAMES) {
    builders.set(gameId, { areas: [], areaIndex: new Map(), rows: new Map() });
  }

  for (const area of parsed.data) {
    const siblings = new Map(
      area.version_details.map((detail) => [detail.version.name, detail.encounter_details]),
    );
    for (const versionDetail of area.version_details) {
      const version = VERSION_INFO.get(versionDetail.version.name);
      const builder = version ? builders.get(version.gameId) : undefined;
      if (!version || !builder) continue;
      const corrected = correctedEncounters(
        area.location_area.name,
        versionDetail.version.name,
        speciesId,
        versionDetail.encounter_details,
        siblings,
      );
      if (!corrected) continue;
      const slug = corrected.area;

      const slotsByMethod = new Map<string, Slot[]>();
      for (const detail of corrected.details) {
        const slot = toSlot(detail.method.name, detail);
        if (!slot) continue;
        const list = slotsByMethod.get(detail.method.name);
        if (list) list.push(slot);
        else slotsByMethod.set(detail.method.name, [slot]);
      }

      for (const [method, slots] of slotsByMethod) {
        let location = builder.areaIndex.get(slug);
        if (location === undefined) {
          builder.areas.push(slug);
          location = builder.areas.length;
          builder.areaIndex.set(slug, location);
        }
        const info = encounterMethodAt(method, slug);
        for (const outcome of outcomes(slots, slug)) {
          const lock =
            speciesId === null
              ? null
              : pkhexShinyRule(version.gameId, speciesId, info.k, outcome.min, outcome.max);
          const row = toRow(method, info, outcome, location, version.condition, lock);
          const key = JSON.stringify(row);
          const existing = builder.rows.get(key);
          if (existing) existing.mask |= 1 << version.bit;
          else builder.rows.set(key, { row, mask: 1 << version.bit });
        }
      }
    }
  }

  const games: Record<string, CachedGameEncounters> = {};
  for (const [gameId, builder] of builders) {
    const all = (1 << (GAMES[gameId]?.names.length ?? 0)) - 1;
    const rows = [...builder.rows.values()].map(({ row, mask }): EncounterRow => {
      if (mask === all) return row;
      // Keep the documented key order: k, l, n, x, m, v, c, r, s.
      const { k, l, n, x, m, ...rest } = row;
      return { k, l, n, x, m, v: mask, ...rest };
    });
    // Only areas that kept a row (a group can collapse to nothing).
    const used = new Set(rows.map((row) => row.l));
    const remap = new Map<number, number>();
    const areas: string[] = [];
    builder.areas.forEach((area, index) => {
      if (!used.has(index + 1)) return;
      areas.push(area);
      remap.set(index + 1, areas.length);
    });
    games[gameId] = {
      areas,
      rows: rows.map((row) => ({ ...row, l: remap.get(row.l) ?? 0 })),
    };
  }
  return { pokemonId, games };
}

// ───────────────────────────── Slices ─────────────────────────────

const KIND_ORDER: readonly EncounterKind[] = [
  'wild',
  'surf',
  'fishing',
  'interact',
  'special',
  'outbreak',
  'alpha',
  'den',
  'raid',
  'static',
  'gift',
  'trade',
];

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * One game's slice of the cached data. Location ids are numbered in
 * alphabetical order of their names; rows are sorted by location, kind, method
 * label, level, versions and conditions. Availability is unknown: PokeAPI lists
 * where a Pokémon is found, not whether it exists in the game at all.
 */
export function toGameEncounterSlice(
  data: PokeApiEncounterData,
  gameId: string,
): GameEncounterSlice {
  const game = data.games[gameId] ?? { areas: [], rows: [] };
  const names = game.areas.map(areaDisplayName);
  const order = names
    .map((name, index) => ({ name, index }))
    .sort((a, b) => collator.compare(a.name, b.name) || a.index - b.index);
  const idOfArea = new Map<number, number>();
  const locations: Record<string, string> = {};
  order.forEach(({ name, index }, rank) => {
    idOfArea.set(index + 1, rank + 1);
    locations[String(rank + 1)] = name;
  });

  const rows = game.rows
    .map((row) => ({ ...row, l: idOfArea.get(row.l) ?? 0 }))
    .sort(
      (a, b) =>
        a.l - b.l ||
        KIND_ORDER.indexOf(a.k) - KIND_ORDER.indexOf(b.k) ||
        collator.compare(a.m ?? '', b.m ?? '') ||
        a.n - b.n ||
        a.x - b.x ||
        (a.v ?? 0) - (b.v ?? 0) ||
        collator.compare((a.c ?? []).join('|'), (b.c ?? []).join('|')),
    );

  return {
    gameId,
    source: POKEAPI_ENCOUNTER_SOURCE,
    versions: [...(GAMES[gameId]?.names ?? [])],
    locations,
    pokemon: { rows },
    availabilityKnown: false,
  };
}

// ───────────────────────────── Transport ─────────────────────────────
// Mirrors the PokeAPI client in pokeapi.ts (per-attempt timeout, retries with
// backoff on network errors / 5xx / 429, typed errors, caller AbortSignal),
// which exposes no generic JSON request for this resource.

const DEFAULT_BACKOFF_MS = 400;
const DEFAULT_MAX_BACKOFF_MS = 5_000;

export interface PokeApiEncounterClient {
  /** `GET /pokemon/{id}/encounters`, trimmed. */
  fetchEncounters(pokemonId: number, options?: RequestOptions): Promise<PokeApiEncounterData>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal ? abortReason(signal) : undefined);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorForStatus(response: Response, url: string): PokeApiError {
  const { status } = response;
  if (status === 404) {
    return new PokeApiError('not-found', `PokeAPI has no resource at ${url}`, { url, status });
  }
  if (status === 429) {
    const seconds = Number(response.headers.get('retry-after')?.trim() ?? '');
    return new PokeApiError('rate-limited', 'PokeAPI rate limit reached', {
      url,
      status,
      retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null,
    });
  }
  if (status >= 500) {
    return new PokeApiError('server', `PokeAPI server error (HTTP ${status})`, { url, status });
  }
  return new PokeApiError('http', `PokeAPI request failed (HTTP ${status})`, { url, status });
}

export function createPokeApiEncounterClient(
  options: PokeApiClientOptions = {},
): PokeApiEncounterClient {
  const baseUrl = (options.baseUrl ?? POKEAPI_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRIES));
  const backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_BACKOFF_MS);
  const maxBackoffMs = Math.max(backoffMs, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const isOnline =
    options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);

  async function attempt(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    if (signal?.aborted) throw abortReason(signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const classify = (cause: unknown, fallback: () => PokeApiError): unknown => {
      if (signal?.aborted) return abortReason(signal);
      if (timedOut) {
        return new PokeApiError('timeout', `PokeAPI did not respond within ${timeoutMs} ms`, {
          url,
          cause,
        });
      }
      return fallback();
    };

    try {
      let response: Response;
      try {
        response = await doFetch(url, { signal: controller.signal });
      } catch (cause) {
        throw classify(
          cause,
          () => new PokeApiError('offline', 'Could not reach PokeAPI', { url, cause }),
        );
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw errorForStatus(response, url);
      }
      try {
        return (await response.json()) as unknown;
      } catch (cause) {
        throw classify(cause, () =>
          cause instanceof Error && cause.name === 'SyntaxError'
            ? new PokeApiError('invalid-response', 'PokeAPI returned a body that is not JSON', {
                url,
                status: response.status,
                cause,
              })
            : new PokeApiError('offline', 'The connection to PokeAPI was lost mid-response', {
                url,
                status: response.status,
                cause,
              }),
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function requestJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    if (signal?.aborted) throw abortReason(signal);
    if (!isOnline()) throw new PokeApiError('offline', 'The device is offline', { url });
    let failure: PokeApiError | null = null;
    for (let tries = 0; tries <= retries; tries += 1) {
      if (failure) {
        const backoff = Math.min(maxBackoffMs, backoffMs * 2 ** (tries - 1));
        await delay(Math.min(maxBackoffMs, Math.max(backoff, failure.retryAfterMs ?? 0)), signal);
      }
      try {
        return await attempt(url, signal);
      } catch (error) {
        if (!isPokeApiError(error) || !error.retryable) throw error;
        failure = error;
      }
    }
    throw failure ?? new PokeApiError('offline', 'Could not reach PokeAPI', { url });
  }

  return {
    async fetchEncounters(pokemonId, requestOptions = {}) {
      if (!Number.isInteger(pokemonId) || pokemonId <= 0) {
        throw new PokeApiError('not-found', `"${String(pokemonId)}" is not a valid Pokémon id`, {
          url: `${baseUrl}/pokemon`,
        });
      }
      const url = `${baseUrl}/pokemon/${pokemonId}/encounters`;
      return trimEncounters(await requestJson(url, requestOptions.signal), pokemonId, url);
    },
  };
}

/** The app-wide encounter client (global `fetch`). */
export const pokeApiEncounters: PokeApiEncounterClient = createPokeApiEncounterClient();

/** Fetches and trims where a Pokémon variety is found (`/pokemon/{id}/encounters`). */
export function fetchPokemonEncounters(
  pokemonId: number,
  options?: RequestOptions,
): Promise<PokeApiEncounterData> {
  return pokeApiEncounters.fetchEncounters(pokemonId, options);
}

// ───────────────────────────── Query ─────────────────────────────

/**
 * Version of {@link PokeApiEncounterData} and of the labels baked into it.
 * It is part of the query key, so bumping it makes persisted entries in the
 * old layout unreachable (they expire with the rest of the cache).
 */
export const ENCOUNTER_DATA_VERSION = 2;

export const encounterKeys = {
  all: [POKEAPI_QUERY_ROOT, 'encounters'] as const,
  pokemon: (pokemonId: number) =>
    [POKEAPI_QUERY_ROOT, 'encounters', ENCOUNTER_DATA_VERSION, pokemonId] as const,
};

/** Query options for where one Pokémon variety (PokeAPI `pokemon` id) is found, in every PokeAPI game. */
export function pokemonEncountersQueryOptions(pokemonId: number) {
  return queryOptions({
    queryKey: encounterKeys.pokemon(pokemonId),
    queryFn: ({ signal }): Promise<PokeApiEncounterData> =>
      fetchPokemonEncounters(pokemonId, { signal }),
  });
}

/**
 * Where a Pokémon variety is found in one game, from PokeAPI. Idle (no
 * request, no data) unless `gameId` is in {@link POKEAPI_ENCOUNTER_GAMES} and
 * `pokemonId` is a PokeAPI `pokemon` id. One request serves every game.
 */
export function usePokeApiEncounterSlice(
  gameId: string,
  pokemonId: number | null,
): UseQueryResult<GameEncounterSlice> {
  const enabled =
    POKEAPI_ENCOUNTER_GAMES.has(gameId) &&
    typeof pokemonId === 'number' &&
    Number.isInteger(pokemonId) &&
    pokemonId > 0;
  const select = useCallback(
    (data: PokeApiEncounterData) => toGameEncounterSlice(data, gameId),
    [gameId],
  );
  return useQuery({
    ...pokemonEncountersQueryOptions(enabled ? pokemonId : 0),
    enabled,
    select,
  });
}
