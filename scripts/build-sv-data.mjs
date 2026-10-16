#!/usr/bin/env node
/**
 * Builds src/renderer/data/encounters/sv.json — where every Pokémon is found in
 * Pokémon Scarlet / Violet, The Teal Mask (Kitakami) and The Indigo Disk
 * (Blueberry Academy) — from the game data shipped with PKHeX
 * (https://github.com/kwsch/PKHeX, GPL-3.0). PokeAPI has no SV locations.
 * Only facts are extracted and re-keyed to PokeAPI ids (see encounterSchema.ts).
 *
 *   Resources/byte/personal/personal_sv               personal table (PersonalInfo9SV): forms,
 *                                                      present-in-game, Paldea / Kitakami / Blueberry dex
 *   legality/wild/Gen9/encounter_wild_paldea.pkl      wild spawns (EncounterArea9 / EncounterSlot9)
 *   legality/wild/Gen9/encounter_fixed_paldea.pkl     fixed overworld spawns (EncounterFixed9)
 *   legality/wild/Gen9/encounter_gem_*.pkl            Tera Raids: Paldea, Kitakami, Blueberry (EncounterTera9)
 *   legality/wild/Gen9/encounter_dist_paldea.pkl      event Tera Raids (EncounterDist9)
 *   legality/wild/Gen9/encounter_might_paldea.pkl     7★ event raids (EncounterMight9)
 *   legality/wild/Gen9/encounter_outbreak_paldea.pkl  event mass outbreaks (EncounterOutbreak9)
 *   Legality/Encounters/Data/Gen9/Encounters9.cs      gifts, story / legendary statics, in-game trades
 *   Resources/text/locations/gen9/text_sv_*_en.txt    location names
 *
 * Things PKHeX's data does not carry, added here from Serebii / Bulbapedia:
 *   - wild version exclusives (PKHeX keeps every wild slot as "SV" because a guest in
 *     a Union Circle can catch the host's exclusives): {@link EXCLUSIVES};
 *   - what each gift / static / trade is and when it becomes available:
 *     {@link describeStatic}, {@link TRADE_INFO}, Snacksworth's solo / group pools
 *     ({@link snacksworthVariants});
 *   - spawn conditions: Kitakami's before / after-the-main-story level bands
 *     ({@link levelBand}) and the Terarium starters' League Club upgrade.
 *
 * Run: node scripts/build-sv-data.mjs   (npm run data:sv)
 */
import {
  TYPES,
  createEncounterCollector,
  createFormResolver,
  createPersonalTable,
  download,
  loadLocationNames,
  loadSpeciesIndex,
  parseFixedEncounters,
  readEntries,
  templateShinyDefault,
  writeEncounterFile,
} from './pkhex/common.mjs';

const GAME_ID = 'sv';
const VERSIONS = ['Scarlet', 'Violet'];
const SCARLET = 1;
const VIOLET = 2;
const BOTH = SCARLET | VIOLET;

/** PersonalInfo9SV layout (PKHeX.Core/PersonalInfo/Info/PersonalInfo9SV.cs). */
const PERSONAL = {
  size: 0x50,
  type1: 0x06,
  type2: 0x07,
  formStatsIndex: 0x18,
  formCount: 0x1a,
  present: 0x1c,
  dexIndex: 0x1e, // DexPaldea (u16)
};
const DEX_KITAKAMI = 0x4a; // u8
const DEX_BLUEBERRY = 0x4b; // u8

/** EncounterUtil.FormDynamic / FormVivillon (30) and FormRandom (31): "any form". */
const FORM_DYNAMIC = 30;

// ───────────────────────────── Regions & synthetic locations ─────────────────────────────

/** Locations9.cs: Kitakami 132–170, Blueberry Academy 172–194 (+ 200 Terarium), Area Zero Underdepths 196 / 198. */
const regionOf = (location) =>
  location >= 132 && location <= 170
    ? 'kitakami'
    : (location >= 172 && location <= 194) || location === 200
      ? 'blueberry'
      : 'paldea';
const DLC_CONDITION = { kitakami: 'The Teal Mask', blueberry: 'The Indigo Disk' };
/** DLC needed to reach a location, or null for the base game. */
const dlcOf = (location) =>
  location === 196 || location === 198
    ? 'The Indigo Disk'
    : (DLC_CONDITION[regionOf(location)] ?? null);

/**
 * Raids and event outbreaks are spread over a whole region, so they get a
 * region-wide location. Blueberry's raids are all in the Terarium (a real id);
 * the others are synthetic ids (above every PKHeX location bank).
 */
const LOCATION_EVENT = 65000;
const REGION_LOCATION = { paldea: 65001, kitakami: 65002, blueberry: 200 };
const SYNTHETIC_LOCATIONS = {
  [LOCATION_EVENT]: 'Event Tera Raid (Poké Portal News)',
  [REGION_LOCATION.paldea]: 'Paldea',
  [REGION_LOCATION.kitakami]: 'Kitakami',
};

// ───────────────────────────── Version exclusives ─────────────────────────────

/**
 * Wild / fixed-spawn version exclusives (Serebii "Version Exclusives", Bulbapedia).
 * `[version, what, keys]`; a key is `species` or `species-form` (form-specific only). Raids,
 * statics and event raids carry their own version data and are not affected.
 */
const EXCLUSIVES = [
  // Base game
  [SCARLET, 'Larvitar line', [246, 247, 248]],
  [SCARLET, 'Drifloon, Drifblim', [425, 426]],
  [SCARLET, 'Stunky, Skuntank', [434, 435]],
  [SCARLET, 'Deino line', [633, 634, 635]],
  [SCARLET, 'Skrelp, Dragalge', [690, 691]],
  [SCARLET, 'Oranguru, Stonjourner, Armarouge', [765, 874, 936]],
  [SCARLET, 'Ancient Paradox Pokémon', [984, 985, 986, 987, 988, 989, 1005]],
  [SCARLET, 'Paldean Tauros (Blaze Breed)', ['128-2']],
  [VIOLET, 'Bagon line', [371, 372, 373]],
  [VIOLET, 'Misdreavus, Mismagius', [200, 429]],
  [VIOLET, 'Gulpin, Swalot', [316, 317]],
  [VIOLET, 'Dreepy line', [885, 886, 887]],
  [VIOLET, 'Clauncher, Clawitzer', [692, 693]],
  [VIOLET, 'Passimian, Eiscue, Ceruledge', [766, 875, 937]],
  [VIOLET, 'Future Paradox Pokémon', [990, 991, 992, 993, 994, 995, 1006]],
  [VIOLET, 'Paldean Tauros (Aqua Breed)', ['128-3']],
  // The Teal Mask
  [SCARLET, 'Gligar, Gliscor, Cramorant', [207, 472, 845]],
  [VIOLET, 'Aipom, Ambipom, Morpeko', [190, 424, 877]],
  // The Indigo Disk
  [SCARLET, 'Alolan Vulpix, Alolan Ninetales', ['37-1', '38-1']],
  [SCARLET, 'Cranidos, Rampardos', [408, 409]],
  [VIOLET, 'Alolan Sandshrew, Alolan Sandslash', ['27-1', '28-1']],
  [VIOLET, 'Shieldon, Bastiodon', [410, 411]],
];
const exclusiveMask = new Map();
for (const [mask, , keys] of EXCLUSIVES)
  for (const key of keys) exclusiveMask.set(String(key), mask);
/** Version mask of a wild / fixed spawn: BOTH unless the species (or that form) is exclusive. */
const versionOf = (species, form) =>
  exclusiveMask.get(`${species}-${form}`) ?? exclusiveMask.get(String(species)) ?? BOTH;

// ───────────────────────────── Non-regional forms ─────────────────────────────

/**
 * Forms with their own PokeAPI id that are not regional forms (createFormResolver
 * matches those itself): `{ species: { gameForm: pokeapiSlug } }`, form order from
 * PKHeX's FormConverter. Forms not listed collapse onto the species.
 */
const EXTRA_FORM_SLUGS = {
  386: { 1: 'deoxys-attack', 2: 'deoxys-defense', 3: 'deoxys-speed' },
  413: { 1: 'wormadam-sandy', 2: 'wormadam-trash' },
  479: { 1: 'rotom-heat', 2: 'rotom-wash', 3: 'rotom-frost', 4: 'rotom-fan', 5: 'rotom-mow' },
  483: { 1: 'dialga-origin' },
  484: { 1: 'palkia-origin' },
  487: { 1: 'giratina-origin' },
  492: { 1: 'shaymin-sky' },
  550: { 1: 'basculin-blue-striped', 2: 'basculin-white-striped' },
  641: { 1: 'tornadus-therian' },
  642: { 1: 'thundurus-therian' },
  645: { 1: 'landorus-therian' },
  647: { 1: 'keldeo-resolute' },
  678: { 1: 'meowstic-female' },
  710: { 1: 'pumpkaboo-small', 2: 'pumpkaboo-large', 3: 'pumpkaboo-super' },
  711: { 1: 'gourgeist-small', 2: 'gourgeist-large', 3: 'gourgeist-super' },
  718: { 1: 'zygarde-10', 2: 'zygarde-10' },
  720: { 1: 'hoopa-unbound' },
  741: { 1: 'oricorio-pom-pom', 2: 'oricorio-pau', 3: 'oricorio-sensu' },
  745: { 1: 'lycanroc-midnight', 2: 'lycanroc-dusk' },
  849: { 1: 'toxtricity-low-key' },
  876: { 1: 'indeedee-female' },
  892: { 1: 'urshifu-rapid-strike' },
  901: { 1: 'ursaluna-bloodmoon' },
  902: { 1: 'basculegion-female' },
  905: { 1: 'enamorus-therian' },
  916: { 1: 'oinkologne-female' },
  931: {
    1: 'squawkabilly-blue-plumage',
    2: 'squawkabilly-yellow-plumage',
    3: 'squawkabilly-white-plumage',
  },
  978: { 1: 'tatsugiri-droopy', 2: 'tatsugiri-stretchy' },
  982: { 1: 'dudunsparce-three-segment' },
  999: { 1: 'gimmighoul-roaming' },
  1017: {
    1: 'ogerpon-wellspring-mask',
    2: 'ogerpon-hearthflame-mask',
    3: 'ogerpon-cornerstone-mask',
  },
};
/** Maushold: game form 0 is the Family of Three (PokeAPI 10257), form 1 the Family of Four (PokeAPI default 925). */
const MAUSHOLD = 925;

// ───────────────────────────── Gifts, statics, trades ─────────────────────────────

const AFTER_STORY = 'After the main story';
const TEAL_MASK = 'The Teal Mask';
const INDIGO_DISK = 'The Indigo Disk';
const AFTER_INDIGO_DISK = 'After the Indigo Disk story';

/**
 * Snacksworth's legendaries (Indigo Disk post-game): each needs its snack from
 * Snacksworth, earned with Blueberry Quests. Most are in one version's solo pool
 * and need group Blueberry Quests in the other; three are group-only (Bulbapedia
 * "Snacksworth", Nintendo Life / Prima Games guides).
 */
const SNACKSWORTH_SOLO = {
  [SCARLET]: [243, 244, 245, 250, 381, 383, 643, 791, 896],
  [VIOLET]: [249, 380, 382, 638, 639, 640, 644, 792, 897],
};
const SNACKSWORTH_GROUP_ONLY = [384, 646, 800];
const SNACK = 'Snack from Snacksworth (Blueberry Quests)';
const SNACK_GROUP = 'Snack from Snacksworth (group Blueberry Quests only)';

/**
 * Snacksworth rows of one legendary: `[version mask, extra condition]`. Solo-pool
 * legendaries get one row per version, since the other version needs group quests.
 */
function snacksworthVariants(species) {
  if (SNACKSWORTH_GROUP_ONLY.includes(species)) return [[BOTH, SNACK_GROUP]];
  for (const version of [SCARLET, VIOLET]) {
    if (SNACKSWORTH_SOLO[version].includes(species))
      return [
        [version, SNACK],
        [BOTH & ~version, SNACK_GROUP],
      ];
  }
  return [[BOTH, SNACK]]; // Articuno, Zapdos, Moltres, Kubfu: solo in both versions
}

/**
 * What a static from Encounters9.cs is: kind, method text and conditions, from
 * its #region / comment group and species (Serebii "Gift Pokémon", Bulbapedia).
 */
function describeStatic({ species, group, region, isTitan, fixedBall, eggLocation }) {
  const dlc = region === 'Sudachi 1' ? [TEAL_MASK] : region === 'Sudachi 2' ? [INDIGO_DISK] : [];
  // Each former Titan waits near its den once it has been beaten as a Titan
  // (Path of Legends); Dondozo is the exception and is not catchable.
  if (isTitan)
    return {
      kind: 'static',
      m: 'Former Titan',
      c: ['After defeating it as a Titan (Path of Legends)'],
    };
  if (eggLocation !== 0)
    return { kind: 'gift', m: 'Egg from Jacq at a picnic', c: [...dlc, 'Random Sinnoh starter'] };
  switch (species) {
    case 906:
    case 909:
    case 912:
      return { kind: 'gift', m: 'Starter Pokémon', c: ['Choose one of three starters'] };
    case 734:
      return { kind: 'static', m: 'Story encounter', c: [] };
    case 1007:
    case 1008:
      return fixedBall
        ? { kind: 'gift', m: 'Ride legendary', c: [] }
        : { kind: 'static', m: 'Battle form legendary at Zero Lab', c: [AFTER_STORY] };
    case 52:
      return {
        kind: 'gift',
        m: 'Gift from Mr. Salvatore',
        c: ["After all of Salvatore's classes"],
      };
    case 446:
      return {
        kind: 'gift',
        m: "Ogre Oustin' prize",
        c: [...dlc, 'Clear Hard difficulty', 'Always shiny'],
      };
    case 58:
      return {
        kind: 'gift',
        m: 'Gift from Perrin',
        c: [...dlc, 'After photographing Bloodmoon Ursaluna'],
      };
    case 978:
      return { kind: 'static', m: 'Decoy Tatsugiri', c: [] };
    case 999:
      return { kind: 'static', m: 'Chest form (in a treasure chest)', c: [] };
    case 1001:
    case 1002:
    case 1003:
    case 1004:
      return { kind: 'static', m: 'Treasure of Ruin', c: ['Pull the shrine’s 8 stakes'] };
    case 901:
      return {
        kind: 'static',
        m: 'Bloodmoon Ursaluna (Perrin’s quest)',
        c: [...dlc, '150 Pokémon registered in the Kitakami Pokédex'],
      };
    case 1014:
    case 1015:
    case 1016:
      return { kind: 'static', m: 'Loyal Three', c: [...dlc, 'After the Teal Mask story'] };
    case 1017:
      return { kind: 'static', m: 'Story encounter', c: [...dlc] };
    case 1024:
      return { kind: 'static', m: 'Story encounter', c: [INDIGO_DISK] };
    case 648:
      // No story requirement: it appears in the Coastal Biome once the Terarium is open
      // (Serebii: "Spin in middle of cyclone and turn camera on to Sepia Filter").
      return {
        kind: 'static',
        m: 'Mythical Pokémon',
        c: [INDIGO_DISK, 'Spin in the leaf cyclone, then use the sepia camera filter'],
      };
    case 1025:
      return {
        kind: 'static',
        m: 'Mythical Pokémon (Mochi Mayhem)',
        c: [TEAL_MASK, INDIGO_DISK, AFTER_INDIGO_DISK],
      };
    case 1020:
    case 1021:
    case 1022:
    case 1023:
      // Gouging Fire, Raging Bolt (Scarlet) / Iron Boulder, Iron Crown (Violet) in Area Zero,
      // revealed by Perrin once 200 Pokémon of the Blueberry Pokédex are caught.
      return {
        kind: 'static',
        m: 'Paradox Pokémon (Perrin’s request)',
        c: [INDIGO_DISK, '200 Pokémon caught for the Blueberry Pokédex'],
      };
    default:
      if (group === 'Legendary Pokémon')
        return { kind: 'static', m: 'Snacksworth legendary', c: [INDIGO_DISK, AFTER_INDIGO_DISK] };
      return {
        kind: fixedBall ? 'gift' : 'static',
        m: fixedBall ? 'Gift' : 'Static encounter',
        c: [...dlc],
      };
  }
}

/**
 * In-game trades (Serebii "In-Game Trades" / "League Club Trades"). Keyed by
 * `species-form`; every other Encounters9.cs trade is a League Club coach's trade.
 */
const TRADE_INFO = {
  '194-0': { l: 76, m: 'In-game trade', c: ['Trade a Paldean Wooper'] }, // Cascarrafa
  '93-0': { l: 78, m: 'In-game trade', c: ['Trade a Pincurchin'] }, // Levincia; evolves on arrival
  '872-0': { l: 84, m: 'In-game trade', c: ['Trade a Flabébé'] }, // Cortondo
  // Cyrano joins the League Club only after every other coach has been invited.
  '522-0': {
    l: 172,
    m: 'League Club trade',
    c: [INDIGO_DISK, 'Invite Cyrano (after every other coach)'],
  },
};
const LEAGUE_CLUB_TRADE = {
  l: 172,
  m: 'League Club trade',
  c: [INDIGO_DISK, 'Invite the coach to the League Club'],
};

// ───────────────────────────── Download ─────────────────────────────

const WILD = 'Resources/legality/wild/Gen9/';
const [
  personalFile,
  wildFile,
  fixedFile,
  gemPaldea,
  gemKitakami,
  gemBlueberry,
  distFile,
  mightFile,
  outbreakFile,
  encountersSource,
  staticTemplate,
  tradeTemplate,
  locationName9,
] = await Promise.all([
  download('Resources/byte/personal/personal_sv'),
  download(`${WILD}encounter_wild_paldea.pkl`),
  download(`${WILD}encounter_fixed_paldea.pkl`),
  download(`${WILD}encounter_gem_paldea.pkl`),
  download(`${WILD}encounter_gem_kitakami.pkl`),
  download(`${WILD}encounter_gem_blueberry.pkl`),
  download(`${WILD}encounter_dist_paldea.pkl`),
  download(`${WILD}encounter_might_paldea.pkl`),
  download(`${WILD}encounter_outbreak_paldea.pkl`),
  download('Legality/Encounters/Data/Gen9/Encounters9.cs', 'text'),
  download('Legality/Encounters/Templates/Gen9/EncounterStatic9.cs', 'text'),
  download('Legality/Encounters/Templates/Gen9/EncounterTrade9.cs', 'text'),
  loadLocationNames('gen9', 'sv'),
]);

// ───────────────────────────── Personal table & forms ─────────────────────────────

const personal = createPersonalTable(personalFile, PERSONAL);
const species = loadSpeciesIndex().filter((entry) => entry.i < personal.count);
const slugToId = new Map();
for (const entry of species) {
  slugToId.set(entry.s, entry.i);
  for (const form of entry.f ?? []) slugToId.set(form.s, form.i);
}
const missingSlugs = [];
const extra = {};
for (const [speciesId, forms] of Object.entries(EXTRA_FORM_SLUGS)) {
  for (const [form, slug] of Object.entries(forms)) {
    const id = slugToId.get(slug);
    if (id === undefined) missingSlugs.push(slug);
    else (extra[speciesId] ??= {})[form] = id;
  }
}
const resolver = createFormResolver(personal, species, extra);
const familyOfThree = slugToId.get('maushold-family-of-three');

/** PokeAPI pokemon id of a game (species, form). */
function pokemonIdOf(speciesId, form) {
  if (form >= FORM_DYNAMIC) return speciesId;
  if (speciesId === MAUSHOLD && familyOfThree !== undefined)
    return form === 0 ? familyOfThree : MAUSHOLD;
  return resolver.pokemonIdOf(speciesId, form);
}

/** Dex numbers of one personal-table entry. */
function dexOf(index) {
  const at = index * PERSONAL.size;
  return {
    paldea: personalFile.readUInt16LE(at + PERSONAL.dexIndex),
    kitakami: personalFile[at + DEX_KITAKAMI],
    blueberry: personalFile[at + DEX_BLUEBERRY],
  };
}

/** pokemon id → dex numbers, for every Pokémon present in the game (any of its forms). */
const available = new Map();
for (const entry of species) {
  const { formCount } = personal.get(entry.i);
  for (let form = 0; form < Math.max(formCount, 1); form += 1) {
    const index = personal.tableIndex(entry.i, form);
    if (!personal.get(index).present) continue;
    const id = pokemonIdOf(entry.i, form);
    if (!available.has(id)) available.set(id, dexOf(index));
  }
}

// ───────────────────────────── Encounters ─────────────────────────────

const collector = createEncounterCollector();
const counts = {};
const unknownSpecies = new Set();
const knownSpecies = new Set(species.map((entry) => entry.i));
/** Pokémon id → number of base-game rows (no DLC needed, not an event), for the `dlc` flag. */
const baseGameRows = new Map();

function add(speciesId, form, row, { event = false } = {}) {
  if (!knownSpecies.has(speciesId)) {
    unknownSpecies.add(speciesId);
    return;
  }
  const clean = { k: row.k, l: row.l, n: row.n, x: row.x };
  if (row.m) clean.m = row.m;
  if (row.v !== undefined && row.v !== BOTH) clean.v = row.v;
  if (row.c && row.c.length > 0) clean.c = row.c;
  if (row.s) clean.s = 1;
  const id = pokemonIdOf(speciesId, form);
  collector.add(id, clean);
  counts[row.k] = (counts[row.k] ?? 0) + 1;
  if (
    !event &&
    !(row.c ?? []).some((condition) => condition === TEAL_MASK || condition === INDIGO_DISK)
  ) {
    baseGameRows.set(id, (baseGameRows.get(id) ?? 0) + 1);
  }
}

const TIMES = [
  ['morning', 3],
  ['day', 0],
  ['evening', 2],
  ['night', 1],
];
const TIME_LABEL = { morning: 'Morning', day: 'Day', evening: 'Evening', night: 'Night' };
const NOT_TIME = {
  morning: 'Not in the morning',
  day: 'Not during the day',
  evening: 'Not in the evening',
  night: 'Not at night',
};
const ALL_TIMES = 0b1111;
/**
 * EncounterSlot9.Time: bit set = cannot spawn then (bit 0 Lunchtime/day, 1 Sleepy-Time/night,
 * 2 Dusk/evening, 3 Dawn/morning — see CanSpawnAtTime). Takes the mask of times it CAN spawn.
 */
function timeCondition(allowedMask) {
  const allowed = TIMES.filter(([, bit]) => (allowedMask & (1 << bit)) !== 0).map(([name]) => name);
  if (allowed.length === 0 || allowed.length === TIMES.length) return null;
  if (allowed.length === TIMES.length - 1)
    return NOT_TIME[TIMES.find(([name]) => !allowed.includes(name))[0]];
  const labels = allowed.map((name, i) =>
    i === 0 ? TIME_LABEL[name] : TIME_LABEL[name].toLowerCase(),
  );
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} & ${labels.at(-1)}`;
}

// Wild spawns. EncounterArea9: u8 location, u8, u8 CrossFrom, u8, then 8-byte slots
// (u16 species, form, gender, min, max, time, weather). Areas with CrossFrom set repeat
// another area's slots for Pokémon that wander over a border; they are skipped (every one of
// their slots exists, with levels inside the same range, in the source area).
// Weather is the weather the spawn points can have (for weather marks), not a condition.
// The slots of one Pokémon in one location (and, in Kitakami, one level band — see
// levelBand) are merged: levels widened, times of day united (a day-only and a night-only
// slot make an any-time spawn), genders united.
const GENDER_RANDOM = 255;

/**
 * Kitakami's spawns come in two disjoint level bands (every slot is either ≤ Lv 45 or
 * ≥ Lv 48): wild Pokémon there scale to the player until the Paldea main story is
 * beaten, and start around Lv 55 afterwards. Widening both bands into one range
 * (e.g. Lv 9–57) would invent levels that never occur, so they are kept apart.
 */
const KITAKAMI_LOW_MAX = 45;
const KITAKAMI_HIGH_MIN = 46;
const KITAKAMI_BAND_CONDITION = {
  low: 'Before beating the Paldea main story',
  high: 'After beating the Paldea main story',
};
function levelBand(location, min, max) {
  if (regionOf(location) !== 'kitakami') return null;
  if (max <= KITAKAMI_LOW_MAX) return 'low';
  if (min >= KITAKAMI_HIGH_MIN) return 'high';
  return null;
}

/**
 * Kanto–Galar starters only spawn in the Terarium once the League Club's biome upgrade
 * for them has been bought with BP (Dittobase / GameSpot Indigo Disk starter guides).
 */
const TERARIUM_STARTERS = new Set([
  1, 4, 7, 152, 155, 158, 252, 255, 258, 387, 390, 393, 495, 498, 501, 650, 653, 656, 722, 725, 728,
  810, 813, 816,
]);
const TERARIUM_STARTER_CONDITION = 'After buying the biome’s starter upgrade (League Club, BP)';
/** Extra conditions of a wild / fixed spawn of `speciesId` at `location` with levels `min`–`max`. */
function spawnConditions(speciesId, location, min, max) {
  const c = [];
  const dlc = dlcOf(location);
  if (dlc) c.push(dlc);
  const band = levelBand(location, min, max);
  if (band) c.push(KITAKAMI_BAND_CONDITION[band]);
  if (regionOf(location) === 'blueberry' && TERARIUM_STARTERS.has(speciesId))
    c.push(TERARIUM_STARTER_CONDITION);
  return c;
}

const wildGroups = new Map();
let crossAreas = 0;
for (const area of readEntries(wildFile)) {
  const location = area[0];
  if (area[2] !== 0) {
    crossAreas += 1;
    continue;
  }
  for (let at = 4; at + 8 <= area.length; at += 8) {
    const speciesId = area.readUInt16LE(at);
    const form = area[at + 2];
    const band = levelBand(location, area[at + 4], area[at + 5]) ?? 'any';
    const key = `${speciesId}/${pokemonIdOf(speciesId, form)}/${location}/${band}`;
    let group = wildGroups.get(key);
    if (group === undefined) {
      group = {
        speciesId,
        form,
        location,
        times: 0,
        n: area[at + 4],
        x: area[at + 5],
        genders: new Set(),
      };
      wildGroups.set(key, group);
    }
    group.n = Math.min(group.n, area[at + 4]);
    group.x = Math.max(group.x, area[at + 5]);
    group.times |= ~area[at + 6] & ALL_TIMES;
    group.genders.add(area[at + 3]);
  }
}
for (const group of wildGroups.values()) {
  const c = spawnConditions(group.speciesId, group.location, group.n, group.x);
  const time = timeCondition(group.times);
  if (time) c.push(time);
  if (!group.genders.has(GENDER_RANDOM) && group.genders.size === 1)
    c.push(group.genders.has(0) ? 'Male only' : 'Female only');
  add(group.speciesId, group.form, {
    k: 'wild',
    l: group.location,
    n: group.n,
    x: group.x,
    v: versionOf(group.speciesId, group.form),
    c,
  });
}

// Fixed overworld spawns (EncounterFixed9, 0x14 bytes): u16 species, form, level, flawless IVs,
// Tera type (GemType: 0 default, 2–19 a type, 101 Stellar), gender, ability, 4 × u16 moves,
// 4 × u8 location (the first is where it stands; the others are border crossings). Shiny => Random.
for (let at = 0; at + 0x14 <= fixedFile.length; at += 0x14) {
  const speciesId = fixedFile.readUInt16LE(at);
  const form = fixedFile[at + 2];
  const level = fixedFile[at + 3];
  const tera = fixedFile[at + 5];
  const location = fixedFile[at + 0x10];
  const teraName =
    tera === 101 ? 'Stellar' : tera >= 2 && tera < 2 + TYPES.length ? TYPES[tera - 2] : null;
  add(speciesId, form, {
    k: 'static',
    l: location,
    n: level,
    x: level,
    m: teraName
      ? `Fixed Tera ${teraName[0].toUpperCase()}${teraName.slice(1)} Pokémon`
      : 'Fixed spawn',
    v: versionOf(speciesId, form),
    c: spawnConditions(speciesId, location, level, level),
  });
}

/** PKHeX raid `Shiny` byte: 0 Random, 1 Never, 2 Always. */
const raidShiny = (value) => ({ s: value === 1, always: value === 2 });

// Tera Raids (EncounterTera9, 0x18 bytes): u16 species, form, gender, ability, flawless IVs,
// shiny, level, 4 × u16 moves, Tera type, index (0 = base game), stars, rate,
// s16 RandRateMinScarlet / RandRateMinViolet (-1 = not in that version).
let raidEvents = 0;
for (const [file, region] of [
  [gemPaldea, 'paldea'],
  [gemKitakami, 'kitakami'],
  [gemBlueberry, 'blueberry'],
]) {
  for (let at = 0; at + 0x18 <= file.length; at += 0x18) {
    const speciesId = file.readUInt16LE(at);
    const form = file[at + 2];
    const shiny = raidShiny(file[at + 6]);
    const level = file[at + 7];
    const index = file[at + 0x11];
    const stars = file[at + 0x12];
    const v =
      (file.readInt16LE(at + 0x14) !== -1 ? SCARLET : 0) |
      (file.readInt16LE(at + 0x16) !== -1 ? VIOLET : 0);
    if (v === 0) continue;
    if (index !== 0) raidEvents += 1;
    const c = [];
    if (DLC_CONDITION[region]) c.push(DLC_CONDITION[region]);
    if (shiny.always) c.push('Always shiny');
    add(
      speciesId,
      form,
      {
        k: 'raid',
        l: REGION_LOCATION[region],
        n: level,
        x: level,
        m: `Tera Raid ★${stars}`,
        v,
        c,
        s: shiny.s,
      },
      { event: index !== 0 },
    );
  }
}

// Event raids (EncounterDist9 / EncounterMight9, 0x3E bytes): same head as EncounterTera9 up to
// stars / rate, then per progress stage (4) u16 RandRateMin and RandRateTotal for Scarlet and Violet
// (total 0 = not offered in that version at that stage).
function readEventRaids(file, label) {
  const size = 0x3e;
  for (let at = 0; at + size <= file.length; at += size) {
    const speciesId = file.readUInt16LE(at);
    const form = file[at + 2];
    const shiny = raidShiny(file[at + 6]);
    const level = file[at + 7];
    const stars = file[at + 0x12];
    let v = 0;
    for (let stage = 0; stage < 4; stage += 1) {
      if (file.readUInt16LE(at + 0x14 + stage * 8 + 4) !== 0) v |= SCARLET;
      if (file.readUInt16LE(at + 0x14 + stage * 8 + 6) !== 0) v |= VIOLET;
    }
    if (v === 0) continue;
    const c = ['Limited-time event'];
    if (shiny.always) c.push('Always shiny');
    add(
      speciesId,
      form,
      { k: 'raid', l: LOCATION_EVENT, n: level, x: level, m: label(stars), v, c, s: shiny.s },
      { event: true },
    );
  }
}
readEventRaids(distFile, (stars) => `Event Tera Raid ★${stars}`);
readEventRaids(mightFile, (stars) => `Tera Raid ★${stars} (Mightiest Mark)`);

// Event mass outbreaks (EncounterOutbreak9, 0x1C bytes): u16 species, form, gender, min, max,
// ribbon, weather, forced scale, scale min / max, shiny, u8 MetBase, then 120 bit flags: met
// location MetBase + i is possible when bit i is set. They span dozens of areas, so one row per
// region is kept.
const OUTBREAK_SIZE = 0x1c;
for (let at = 0; at + OUTBREAK_SIZE <= outbreakFile.length; at += OUTBREAK_SIZE) {
  const speciesId = outbreakFile.readUInt16LE(at);
  const form = outbreakFile[at + 2];
  const min = outbreakFile[at + 4];
  const max = outbreakFile[at + 5];
  const alwaysShiny = outbreakFile[at + 0x0b] !== 0;
  const base = outbreakFile[at + 0x0c];
  const regions = new Set();
  for (let bit = 0; bit < 120; bit += 1) {
    const byte = outbreakFile[at + 0x0d + (bit >> 3)];
    if ((byte >> (bit & 7)) & 1) regions.add(regionOf(base + bit));
  }
  for (const region of regions) {
    const c = ['Limited-time event'];
    if (DLC_CONDITION[region]) c.unshift(DLC_CONDITION[region]);
    if (alwaysShiny) c.push('Always shiny');
    add(
      speciesId,
      form,
      { k: 'outbreak', l: REGION_LOCATION[region], n: min, x: max, m: 'Event mass outbreak', c },
      { event: true },
    );
  }
}

// Gifts and statics: `new(SV|SL|VL) { Species = …, Level = …, Location = …, Shiny = … }` entries of
// the EncounterStatic9 arrays. The shared parseFixedEncounters expects positional
// (species, form, level) arguments, which Gen 9 statics do not use, so they are read here.
const staticShinyDefault = templateShinyDefault(staticTemplate);
const VERSION_MASK = { SV: BOTH, SL: SCARLET, VL: VIOLET };
function joinEntryLines(source) {
  const lines = [];
  for (const line of source.split(/\r?\n/)) {
    const previous = lines.at(-1);
    const isEntry = previous !== undefined && /^\s*new\(/.test(previous);
    const unclosed = isEntry && previous.includes('{') && !previous.includes('}');
    if (unclosed) lines[lines.length - 1] = `${previous} ${line.trim()}`;
    else lines.push(line);
  }
  return lines;
}
const statics = [];
{
  let inStatics = false;
  let region = '';
  let group = '';
  for (const line of joinEntryLines(encountersSource)) {
    const array = /static readonly Encounter(\w+?)9\[\]/.exec(line);
    if (array) {
      inStatics = array[1] === 'Static';
      region = '';
      group = '';
      continue;
    }
    if (!inStatics) continue;
    const regionStart = /^\s*#region\s+(.+?)\s*$/.exec(line);
    if (regionStart) {
      region = regionStart[1];
      group = region;
      continue;
    }
    if (/^\s*#endregion/.test(line)) {
      region = '';
      continue;
    }
    const heading = /^\s*\/\/\s*(.+?)\s*$/.exec(line);
    if (heading) {
      group = heading[1];
      continue;
    }
    const entry = /^\s*new\((SV|SL|VL)\)\s*\{(.*)\}/.exec(line);
    if (entry === null) continue;
    const body = entry[2];
    const number = (name) => {
      const match = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(body);
      return match ? Number(match[1]) : 0;
    };
    const shiny = /\bShiny\s*=\s*(?:Shiny\.)?(\w+)/.exec(body)?.[1] ?? staticShinyDefault;
    statics.push({
      version: VERSION_MASK[entry[1]],
      species: number('Species'),
      form: number('Form'),
      level: number('Level'),
      location: number('Location'),
      eggLocation: number('EggLocation'),
      shiny,
      fixedBall: /\bFixedBall\s*=/.test(body),
      isTitan: /\bIsTitan\s*=\s*true/.test(body),
      region,
      group,
    });
  }
}
for (const entry of statics) {
  const { kind, m, c } = describeStatic(entry);
  // Jacq's Sinnoh starter Eggs have no met location: he hands them out at Reveler's Road.
  const location = entry.eggLocation !== 0 && entry.location === 0 ? 140 : entry.location;
  const conditions = [...c];
  if (entry.shiny === 'Always' && !conditions.includes('Always shiny'))
    conditions.push('Always shiny');
  const variants =
    m === 'Snacksworth legendary' ? snacksworthVariants(entry.species) : [[entry.version, null]];
  for (const [version, extra] of variants) {
    add(entry.species, entry.form, {
      k: kind,
      l: location,
      n: entry.level,
      x: entry.level,
      m,
      v: version & entry.version,
      c: extra ? [...conditions, extra] : conditions,
      s: entry.shiny === 'Never',
    });
  }
}

// In-game trades: `new(TradeNames, index, SV, species, level) { … }` (EncounterTrade9).
const trades = parseFixedEncounters(encountersSource, {
  defaults: { trade: templateShinyDefault(tradeTemplate) },
  args: ['names', 'index', 'version', 'species', 'level'],
}).filter((entry) => entry.kind === 'trade');
for (const trade of trades) {
  const info = TRADE_INFO[`${trade.species}-${trade.form}`] ?? LEAGUE_CLUB_TRADE;
  const c = [...info.c];
  if (/\bShiny\s*=\s*(?:Shiny\.)?Always/.test(trade.body)) c.push('Always shiny');
  // EvolveOnTrade: the received Pokémon evolves on arrival (PKHeX rejects the unevolved species).
  const evolves = /\bEvolveOnTrade\s*=\s*true/.test(trade.body);
  add(evolves ? trade.species + 1 : trade.species, trade.form, {
    k: 'trade',
    l: info.l,
    n: trade.level,
    x: trade.level,
    m: evolves ? `${info.m} (evolves on arrival)` : info.m,
    c,
    s: trade.shinyLocked,
  });
}

// ───────────────────────────── Output ─────────────────────────────

const KIND_ORDER = [
  'wild',
  'surf',
  'fishing',
  'interact',
  'special',
  'outbreak',
  'den',
  'static',
  'gift',
  'trade',
  'raid',
];
/** Base game first, then Kitakami, then Blueberry / Area Zero Underdepths, then events. */
const placeRank = (location) => {
  if (location === LOCATION_EVENT) return 3;
  if (location === REGION_LOCATION.paldea) return 0;
  if (location === REGION_LOCATION.kitakami) return 1;
  const dlc = dlcOf(location);
  return dlc === null ? 0 : dlc === TEAL_MASK ? 1 : 2;
};
const rowOrder = (a, b) =>
  KIND_ORDER.indexOf(a.k) - KIND_ORDER.indexOf(b.k) ||
  placeRank(a.l) - placeRank(b.l) ||
  a.n - b.n ||
  a.l - b.l ||
  (a.m ?? '').localeCompare(b.m ?? '');

/**
 * Rows that differ only in their version mask are one row available in the union of
 * those versions (e.g. the West / East Sea Shellos raids once both forms collapse onto Shellos).
 */
function mergeVersions(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = JSON.stringify({ ...row, v: undefined });
    const existing = merged.get(key);
    if (existing === undefined) merged.set(key, { ...row });
    else {
      const v = (existing.v ?? BOTH) | (row.v ?? BOTH);
      if (v === BOTH) delete existing.v;
      else existing.v = v;
    }
  }
  return [...merged.values()].map(({ k, l, n, x, m, v, c, s }) => {
    const row = { k, l, n, x };
    if (m !== undefined) row.m = m;
    if (v !== undefined) row.v = v;
    if (c !== undefined) row.c = c;
    if (s !== undefined) row.s = s;
    return row;
  });
}

const pokemon = new Map();
for (const [id, dex] of available) {
  const rows = mergeVersions(collector.rows(id)).sort(rowOrder);
  // DLC-only: not in the Paldea Pokédex and no base-game encounter (events aside), but in a
  // DLC Pokédex or met through the DLC.
  const dlcOnly =
    dex.paldea === 0 &&
    (baseGameRows.get(id) ?? 0) === 0 &&
    (dex.kitakami > 0 ||
      dex.blueberry > 0 ||
      rows.some((row) => !row.c?.includes('Limited-time event')));
  // `dex` is the Paldea number; DLC-only Pokémon carry their Kitakami number, else their
  // Blueberry number. Others outside the Paldea Pokédex get none (it would read as Paldea's).
  const number = dex.paldea || (dlcOnly ? dex.kitakami || dex.blueberry : 0) || null;
  pokemon.set(id, { dex: number, dlc: dlcOnly ? 1 : undefined, rows });
}
const orphans = collector.pokemonIds().filter((id) => !available.has(id));

const locationName = (id) => SYNTHETIC_LOCATIONS[id] ?? locationName9(id);
const result = writeEncounterFile({ gameId: GAME_ID, versions: VERSIONS, locationName, pokemon });

// ───────────────────────────── Summary ─────────────────────────────

const unnamed = [...collector.usedLocations].filter((id) => id !== 0 && locationName(id) === null);
const totalRows = [...pokemon.values()].reduce((sum, entry) => sum + entry.rows.length, 0);
const rowsPerKind = {};
for (const entry of pokemon.values())
  for (const row of entry.rows) rowsPerKind[row.k] = (rowsPerKind[row.k] ?? 0) + 1;
const note = (label, values) => (values.length > 0 ? `\n  ${label}: ${values.join(', ')}` : '');
console.log(
  `${result.file}\n` +
    `  ${result.pokemon} Pokémon in the game (${[...pokemon.values()].filter((entry) => entry.rows.length > 0).length} with encounters, ` +
    `${[...pokemon.values()].filter((entry) => entry.dlc).length} DLC-only), ${result.locations} named locations\n` +
    `  source records per kind: ${JSON.stringify(counts)}\n` +
    `  rows after merging: ${totalRows} ${JSON.stringify(rowsPerKind)}\n` +
    `  ${statics.length} gifts / statics, ${trades.length} trades, ${crossAreas} border-crossing wild areas skipped` +
    (raidEvents > 0 ? `, ${raidEvents} distribution entries inside the base raid tables` : '') +
    `\n  shiny defaults: static ${staticShinyDefault}, trade ${templateShinyDefault(tradeTemplate)}` +
    note('regional forms that could not be matched', resolver.unresolved) +
    note('form slugs missing from speciesIndex.json', missingSlugs) +
    note('species ids missing from speciesIndex.json', [...unknownSpecies]) +
    note('encounters for Pokémon not flagged as present', orphans) +
    note('location ids without a name', unnamed),
);
