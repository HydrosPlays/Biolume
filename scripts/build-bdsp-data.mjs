#!/usr/bin/env node
/**
 * Builds src/renderer/data/encounters/bdsp.json — where every Pokémon is found
 * in Brilliant Diamond / Shining Pearl — from the game data shipped with PKHeX
 * (https://github.com/kwsch/PKHeX, GPL-3.0). PokeAPI has no location data for
 * BDSP. Only facts are extracted and re-keyed to PokeAPI ids.
 *
 *   Resources/byte/personal/personal_bdsp               personal table (PersonalInfo8BDSP)
 *   Resources/legality/wild/Gen8/encounter_bd.pkl        overworld areas, Brilliant Diamond
 *   Resources/legality/wild/Gen8/encounter_sp.pkl        overworld areas, Shining Pearl
 *   .../encounter_bd_underground.pkl / _sp_underground   Grand Underground hideaways
 *   Legality/Encounters/Data/Gen8/Encounters8b.cs        gifts, statics, roamers, trades
 *   Legality/Encounters/Templates/Gen8b/Encounter{Static,Trade}8b.cs   default shiny rules
 *   Resources/text/locations/gen8b/*.txt                 location names
 *
 * What PKHeX does NOT encode, and how this script handles it:
 *   - Overworld grass tables merge every slot of a location (morning / day /
 *     night, swarm, Poké Radar) into one deduplicated species-level list, so
 *     time of day is not available. Swarms and the Poké Radar only start after
 *     the National Pokédex. SWARMS names the one swarm Pokémon of each location;
 *     outside the National Pokédex areas every other non-Sinnoh grass Pokémon of
 *     a radar-capable location is a Poké Radar one (checked against Serebii's
 *     BDSP location pages). Inside them, regular tables also hold non-Sinnoh
 *     Pokémon, so POST_GAME_RADAR lists the radar-only ones. Those rows become
 *     `special` "Swarm" / "Poké Radar" rows with a National Pokédex condition.
 *   - Areas that only open with the National Pokédex (NATIONAL_DEX_AREAS, plus
 *     the back of Victory Road) are not marked in the data; every row there
 *     gets the condition.
 *   - The Great Marsh and the Trophy Garden have a second grass table: the
 *     Pokémon that change daily (binoculars / Mr. Backlot).
 *   - Hideaway species unlock at story milestones (Strength, Defog, Icicle Badge,
 *     Waterfall, National Pokédex) that the data does not record, except that
 *     every non-Sinnoh species (and the Sinnoh starters) needs the National
 *     Pokédex — verified for all 18 biomes against Serebii. Those rows get the
 *     condition and the post-Elite Four level bracket (58–63). Rare spawns
 *     (any time) are not marked either; UNDERGROUND_RARE_SPAWNS adds them.
 *   - Encounters8b.cs has no plain-English context (event items, save-data
 *     gifts, story gates). FIXED_DETAILS adds it per species; entries PKHeX adds
 *     later fall back to a generic label and are reported.
 *   - Encounter rates are not recorded.
 *
 * Run: node scripts/build-bdsp-data.mjs   (npm run data:bdsp)
 */
import {
  createEncounterCollector,
  createFormResolver,
  createPersonalTable,
  download,
  loadLocationNames,
  loadSpeciesIndex,
  readEntries,
  writeEncounterFile,
} from './pkhex/common.mjs';

const GAME_ID = 'bdsp';
const VERSIONS = ['Brilliant Diamond', 'Shining Pearl'];
const BD = 1;
const SP = 2;
const BOTH = BD | SP;
/** Legal.MaxSpeciesID_8b: personal entries above it are alternate-form slots. */
const MAX_SPECIES = 493;
/** Locations.Default8bNone: "no location" in BDSP (an egg's met location until it hatches). */
const DEFAULT_8B_NONE = 65535;

/** PersonalInfo8BDSP (PKHeX.Core/PersonalInfo/Info/PersonalInfo8BDSP.cs). */
const PERSONAL = {
  size: 0x44,
  type1: 0x06,
  type2: 0x07,
  formStatsIndex: 0x1e,
  formCount: 0x20,
  dexIndex: 0x42,
};
/** IsPresentInGame is bit 6 of the colour byte (0x21), not a byte of its own. */
const PRESENT_BYTE = 0x21;
const PRESENT_BIT = 6;

/** SlotType8b (EncounterArea8b.cs). 0 and 7 are unused relics. */
const SLOT = { Grass: 1, Surf: 2, OldRod: 3, GoodRod: 4, SuperRod: 5, RockSmash: 6, HoneyTree: 8 };
const ROD_NAME = {
  [SLOT.OldRod]: 'Old Rod',
  [SLOT.GoodRod]: 'Good Rod',
  [SLOT.SuperRod]: 'Super Rod',
};

/** Hideaway level brackets (Serebii): 1 badge 16–20 … 8 badges 50–55, Elite Four defeated 58–63. */
const POST_ELITE_FOUR_MIN_LEVEL = 58;

const NATIONAL_DEX = 'After obtaining the National Pokédex';
const SAFARI = 'Great Marsh Safari Game';

const SPECIES = {
  Feebas: 349,
  Munchlax: 446,
  Shellos: 422,
  Gastrodon: 423,
  Turtwig: 387,
  Chimchar: 390,
  Piplup: 393,
  Manaphy: 490,
};
/** Sinnoh-dex species that hideaways still hold back until the National Pokédex. */
const UNDERGROUND_NATIONAL_DEX_EXTRA = new Set([SPECIES.Turtwig, SPECIES.Chimchar, SPECIES.Piplup]);
const SEA_FORMS = ['West Sea form', 'East Sea form'];
/** The personal table leaves Manaphy unnumbered; it is #151 in the BDSP Sinnoh Pokédex (Serebii). */
const DEX_OVERRIDES = { [SPECIES.Manaphy]: 151 };

/**
 * Hideaway rare spawns, which PKHeX lists together with the regular spawns
 * (Serebii: Grand Underground; Dazzling Cave cross-checked with Gamer Guides).
 * Rare spawns can appear at any point of the story. Each entry is
 * [species, version mask, 1 = also a regular spawn there after the National Pokédex / 0 = rare only].
 */
// prettier-ignore
const UNDERGROUND_RARE_SPAWNS = {
  'Spacious Cave': [[81, 3, 1], [108, 3, 1], [111, 3, 1], [229, 3, 1], [333, 3, 1], [359, 3, 1]],
  'Grassland Cave': [[123, 1, 1], [127, 2, 1], [359, 3, 1]],
  'Fountainspring Cave': [[108, 3, 0], [175, 3, 0], [280, 3, 0], [333, 3, 0]],
  'Rocky Cave': [[111, 3, 1], [207, 1, 1], [216, 2, 0]],
  'Volcanic Cave': [[229, 3, 0], [240, 2, 1]],
  'Swampy Cave': [[108, 3, 0], [207, 1, 0], [220, 3, 0]],
  'Dazzling Cave': [[175, 3, 1], [229, 3, 1], [238, 3, 1], [239, 1, 1], [280, 3, 1], [355, 3, 1], [359, 3, 1]],
  'Whiteout Cave': [[81, 3, 1], [216, 2, 1], [220, 3, 1], [239, 1, 1], [333, 3, 1], [361, 3, 1], [362, 3, 1]],
  'Icy Cave': [[81, 3, 1], [220, 3, 1], [238, 3, 1], [333, 3, 1], [361, 3, 1], [362, 3, 1]],
  'Riverbank Cave': [[108, 3, 0], [123, 1, 1], [127, 2, 1]],
  'Sandsear Cave': [[111, 3, 1], [229, 3, 1], [240, 2, 1]],
  'Still-Water Cavern': [[108, 3, 0], [123, 1, 1], [127, 2, 1]],
  'Sunlit Cavern': [[111, 3, 0], [207, 1, 0], [216, 2, 1]],
  'Big Bluff Cavern': [[123, 1, 0], [127, 2, 0], [359, 3, 0]],
  'Stargleam Cavern': [[175, 3, 1], [229, 3, 1], [238, 3, 1], [239, 1, 1], [280, 3, 1], [355, 3, 1], [359, 3, 1]],
  'Glacial Cavern': [[81, 3, 1], [216, 2, 1], [220, 3, 1], [238, 3, 1], [239, 1, 0], [333, 3, 1], [361, 3, 1], [362, 3, 1]],
  'Bogsunk Cavern': [[108, 3, 0], [207, 1, 0], [220, 3, 0]],
  'Typhlo Cavern': [[111, 3, 0], [229, 3, 0], [240, 2, 1]],
};
const rareSpawns = new Map(
  Object.entries(UNDERGROUND_RARE_SPAWNS).flatMap(([biome, list]) =>
    list.map(([speciesId, mask, regular]) => [
      `${biome}|${speciesId}`,
      { mask, regular: regular === 1, seen: 0 },
    ]),
  ),
);

/**
 * Forms that are separate PokeAPI pokemon (not cosmetic), by game form index.
 * They get their own entry so the UI does not report them as missing.
 */
const DISTINCT_FORMS = {
  386: ['deoxys-attack', 'deoxys-defense', 'deoxys-speed'],
  413: ['wormadam-sandy', 'wormadam-trash'],
  479: ['rotom-heat', 'rotom-wash', 'rotom-frost', 'rotom-fan', 'rotom-mow'],
  487: ['giratina-origin'],
  492: ['shaymin-sky'],
};

/**
 * Sub-areas that share a display name in the game but that PKHeX's own source
 * identifies (EncounterSlot8b.CanUseRadarOverworld, EncounterArea8b honey-tree
 * list). Every other id is merged with the first id of the same name.
 */
const LOCATION_OVERRIDES = {
  206: 'Mount Coronet (outside)',
  207: 'Mount Coronet (outside)',
  259: 'Stark Mountain (outside)',
  359: 'Route 205 (Floaroma side)',
  361: 'Route 205 (Eterna side)',
  368: 'Route 209 (Lost Tower)',
  369: 'Route 209 (Lost Tower)',
  370: 'Route 209 (Lost Tower)',
  371: 'Route 209 (Lost Tower)',
  372: 'Route 209 (Lost Tower)',
  373: 'Route 210 (Solaceon side)',
  375: 'Route 210 (Celestic side)',
  379: 'Route 212 (Hearthome side)',
  383: 'Route 212 (Pastoria side)',
};

/**
 * Areas that only open once the National Pokédex is obtained (Serebii: National
 * Pokédex, Victory Road, Fight Area, Snowpoint Temple, Sendoff Spring pages).
 * Their regular grass tables also hold non-Sinnoh Pokémon. The Fight Area
 * itself opens earlier but has no wild Pokémon.
 */
const NATIONAL_DEX_AREAS = new Set([
  'Route 224',
  'Route 225',
  'Route 226',
  'Route 227',
  'Route 228',
  'Route 229',
  'Route 230',
  'Stark Mountain',
  'Stark Mountain (outside)',
  'Survival Area',
  'Resort Area',
  'Sendoff Spring',
  'Turnback Cave',
  'Snowpoint Temple',
]);
/** Victory Road's back area (Serebii "Nat Dex Area", B1F and exit; levels and Lapras match these ids). */
const NATIONAL_DEX_LOCATION_IDS = new Set([247, 248, 249]);
/** Other story gates of whole locations. */
const LOCATION_CONDITIONS = { 'Maniac Tunnel': ['After catching 26 forms of Unown'] };

/** EncounterSlot8b.CanUseRadarOverworld: grass locations where the Poké Radar cannot be used. */
const NO_RADAR = (location) =>
  [195, 196, 252, 255, 256, 260, 261, 262, 292, 293, 294, 295, 296].includes(location) ||
  (location >= 203 && location <= 215 && location !== 206 && location !== 207) ||
  (location >= 219 && location <= 224) || // Great Marsh (EncounterSlot8b.IsMarsh)
  (location >= 225 && location <= 249) ||
  (location >= 264 && location <= 291 && location !== 285) ||
  (location >= 299 && location <= 314) ||
  (location >= 368 && location <= 372);

/**
 * The swarm Pokémon of each location (Serebii: Swarms — one per location,
 * after the National Pokédex). PKHeX merges its slots into the grass table.
 */
// prettier-ignore
const SWARMS = {
  'Route 201': 84, 'Route 202': 263, 'Route 203': 104, 'Route 206': 299, 'Route 207': 231,
  'Route 208': 206, 'Route 209': 209, 'Route 213': 359, 'Route 214': 325, 'Route 215': 96,
  'Route 216': 225, 'Route 217': 220, 'Route 218': 100, 'Route 221': 83, 'Route 222': 300,
  'Route 224': 177, 'Route 225': 296, 'Route 226': 98, 'Route 227': 327, 'Route 228': 374,
  'Route 229': 16, 'Route 230': 222, 'Valley Windworks': 309, 'Eterna Forest': 287,
  'Fuego Ironworks': 81, 'Lake Verity': 283, 'Lake Valor': 108, 'Lake Acuity': 238,
};
/**
 * Poké Radar-only Pokémon of the National Pokédex areas, where the Sinnoh-dex
 * rule cannot tell them apart (Serebii: PokéRadar tables of these locations).
 */
// prettier-ignore
const POST_GAME_RADAR = {
  'Route 224': [355, 356], 'Route 225': [56, 57], 'Route 226': [56, 57], 'Route 227': [324],
  'Route 228': [328, 329], 'Route 229': [48, 49], 'Route 230': [175],
  'Stark Mountain (outside)': [324],
};
const swarmSeen = new Map(Object.keys(SWARMS).map((name) => [name, 0]));
const postGameRadarSeen = new Set();

/** Locations with a second grass table of Pokémon that change daily. */
const DAILY_TABLES = {
  'Great Marsh': {
    m: 'Daily Pokémon (binoculars)',
    c: [SAFARI, 'Changes daily'],
    nationalDexForNonSinnoh: true,
  },
  'Trophy Garden': { m: 'Daily Pokémon (Mr. Backlot)', c: ['Changes daily', NATIONAL_DEX] },
};

const SPEAR_PILLAR = 'After the Spear Pillar events';
/**
 * The Kanto / Hoenn fossils only turn up in the Grand Underground after Dialga /
 * Palkia at the Spear Pillar (Bulbapedia: Fossil; Serebii: "Beginning: Unavailable").
 */
const FOSSIL = (fossil, extra = {}, gate = [SPEAR_PILLAR]) => ({
  m: `Revived from the ${fossil}`,
  c: [`Dig up the ${fossil} in the Grand Underground`, ...gate],
  ...extra,
});

/**
 * Plain-English context for the entries of Encounters8b.cs, keyed by species
 * (Serebii: Gift Pokémon, Interactable Pokémon, Legendary Pokémon pages).
 * `at` replaces PKHeX's location (eggs have none; roamers carry a placeholder).
 */
const FIXED_DETAILS = {
  387: { m: 'Starter Pokémon (choose one)' },
  390: { m: 'Starter Pokémon (choose one)' },
  393: { m: 'Starter Pokémon (choose one)' },
  133: { m: 'Gift from Bebe', c: [NATIONAL_DEX] },
  440: { at: 'Hearthome City', m: 'Egg from the Traveling Man' },
  447: { at: 'Iron Island', m: 'Egg from Riley', c: ['After helping Riley through Iron Island'] },
  138: FOSSIL('Helix Fossil'),
  140: FOSSIL('Dome Fossil'),
  142: FOSSIL('Old Amber'),
  345: FOSSIL('Root Fossil'),
  347: FOSSIL('Claw Fossil'),
  // The fossils themselves are version exclusives (Serebii: Version Exclusives, Grand Underground items).
  408: FOSSIL('Skull Fossil', { v: BD }, []),
  410: FOSSIL('Armor Fossil', { v: SP }, []),
  151: { m: 'Gift', c: ["Needs Let's Go, Pikachu! or Let's Go, Eevee! save data"] },
  385: { m: 'Gift', c: ['Needs Sword or Shield save data'] },
  425: {
    m: 'Outside the Valley Windworks',
    c: ['Fridays', 'After clearing Team Galactic out of the Valley Windworks'],
  },
  442: {
    m: 'Hallowed Tower',
    c: [
      'Place an Odd Keystone in the Hallowed Tower',
      'Talk to 32 people in the Grand Underground',
    ],
  },
  479: { m: 'TV in the Old Chateau', c: ['Night', NATIONAL_DEX] },
  481: {
    at: 'Lake Verity (Verity Cavern)',
    m: 'Roaming',
    c: [SPEAR_PILLAR, 'Flees from Verity Cavern, then roams Sinnoh'],
  },
  488: {
    at: 'Fullmoon Island',
    m: 'Roaming',
    c: [NATIONAL_DEX, 'Flees from Fullmoon Island, then roams Sinnoh'],
  },
  480: { m: 'Legendary', c: [SPEAR_PILLAR] },
  482: { m: 'Legendary', c: [SPEAR_PILLAR] },
  483: { m: 'Legendary', c: ['Main story'] },
  484: { m: 'Legendary', c: ['Main story'] },
  485: { m: 'Legendary', c: [NATIONAL_DEX, 'After returning the Magma Stone with Buck'] },
  486: { m: 'Legendary', c: [NATIONAL_DEX, 'Bring Regirock, Regice and Registeel'] },
  487: { m: 'Legendary', c: [NATIONAL_DEX] },
  491: { m: 'Mythical', c: ['Needs the Member Card (event item)', NATIONAL_DEX] },
  // Flower Paradise is at the end of Route 224, which opens with the National Pokédex.
  492: { m: 'Mythical', c: ["Needs Oak's Letter (event item)", NATIONAL_DEX] },
  493: {
    m: 'Mythical',
    c: [
      'Needs the Azure Flute (Legends: Arceus save data with its main missions done)',
      NATIONAL_DEX,
    ],
  },
};
/**
 * Ramanas Park legendaries (Pure Space / Strange Space): the slate that
 * summons each one and what unlocks it (Serebii: Ramanas Park). The park opens
 * with the National Pokédex.
 */
const REGIS = 'After catching Regirock, Regice and Registeel';
const TRIO = 'After catching Raikou, Entei and Suicune (BD) or Articuno, Zapdos and Moltres (SP)';
const RAMANAS_SLATES = {
  377: ['Discovery Slate'],
  378: ['Discovery Slate'],
  379: ['Discovery Slate'],
  380: ['Soul Slate', REGIS],
  381: ['Soul Slate', REGIS],
  243: ['Johto Slate', REGIS],
  244: ['Johto Slate', REGIS],
  245: ['Johto Slate', REGIS],
  144: ['Kanto Slate', REGIS],
  145: ['Kanto Slate', REGIS],
  146: ['Kanto Slate', REGIS],
  250: ['Rainbow Slate', 'After catching Raikou, Entei, Suicune, Latias and Latios'],
  249: ['Squall Slate', 'After catching Articuno, Zapdos and Moltres'],
  382: ['Oceanic Slate', TRIO],
  383: ['Tectonic Slate', TRIO],
  384: ['Stratospheric Slate', TRIO],
  150: ['Genome Slate', TRIO.replace('catching', 'beating')],
};
function ramanasPark(speciesId) {
  const [slate, ...gate] = RAMANAS_SLATES[speciesId] ?? [];
  if (slate === undefined) warnings.push(`no RAMANAS_SLATES entry for #${speciesId}`);
  return { m: slate ?? 'Ramanas Park slate', c: [NATIONAL_DEX, ...gate] };
}
/** In-game trades by TradeNames index: where they happen and what they ask for (Serebii: In-Game Trades). */
const TRADE_DETAILS = [
  { at: 'Oreburgh City', wants: 'Machop' },
  { at: 'Eterna City', wants: 'Buizel' },
  { at: 'Snowpoint City', wants: 'Medicham' },
  { at: 'Route 226', wants: 'Finneon' },
];
/** Encounters8b.cs `// group` comments that hold gifts rather than statics. */
const GIFT_GROUPS = /gift|fossil/i;

// ───────────────────────────── Downloads ─────────────────────────────

const WILD = 'Resources/legality/wild/Gen8/';
const [
  personalFile,
  bdFile,
  spFile,
  bdUnderground,
  spUnderground,
  fixedSource,
  staticTemplate,
  tradeTemplate,
] = await Promise.all([
  download('Resources/byte/personal/personal_bdsp'),
  download(`${WILD}encounter_bd.pkl`),
  download(`${WILD}encounter_sp.pkl`),
  download(`${WILD}encounter_bd_underground.pkl`),
  download(`${WILD}encounter_sp_underground.pkl`),
  download('Legality/Encounters/Data/Gen8/Encounters8b.cs', 'text'),
  download('Legality/Encounters/Templates/Gen8b/EncounterStatic8b.cs', 'text'),
  download('Legality/Encounters/Templates/Gen8b/EncounterTrade8b.cs', 'text'),
]);
const gameLocationName = await loadLocationNames('gen8b', 'bdsp');

const warnings = [];

// ───────────────────────────── Personal table & forms ─────────────────────────────

const personal = createPersonalTable(personalFile, PERSONAL);
const isPresent = (index) =>
  ((personalFile[index * PERSONAL.size + PRESENT_BYTE] >> PRESENT_BIT) & 1) === 1;
const species = loadSpeciesIndex().filter((entry) => entry.i <= MAX_SPECIES);
const speciesById = new Map(species.map((entry) => [entry.i, entry]));
if (personal.count <= MAX_SPECIES)
  throw new Error(`Personal table has only ${personal.count} entries`);

/** Explicit (species, form) → PokeAPI id for non-regional forms, confirmed by their types. */
const sameTypes = (a, b) => a.length === b.length && a.every((type) => b.includes(type));
const distinctForms = {};
for (const [speciesId, slugs] of Object.entries(DISTINCT_FORMS)) {
  const entry = speciesById.get(Number(speciesId));
  const { formCount } = personal.get(Number(speciesId));
  slugs.forEach((slug, i) => {
    const form = (entry?.f ?? []).find((candidate) => candidate.s === slug);
    if (form === undefined || i + 1 >= formCount) {
      warnings.push(`form ${slug} not found`);
      return;
    }
    const types = personal.get(personal.tableIndex(Number(speciesId), i + 1)).types;
    if (!sameTypes(types, form.t))
      throw new Error(`${slug}: personal types ${types} ≠ PokeAPI types ${form.t}`);
    (distinctForms[speciesId] ??= {})[i + 1] = form.i;
  });
}
const { pokemonIdOf, formMap, unresolved } = createFormResolver(personal, species, distinctForms);

/** pokemon id → { dex } for every Pokémon that exists in the game. */
const available = new Map();
for (const entry of species) {
  if (!isPresent(entry.i)) continue;
  const dex = personal.get(entry.i).dex || (DEX_OVERRIDES[entry.i] ?? 0);
  available.set(entry.i, { dex });
  for (const [form, pokemonId] of formMap.get(entry.i) ?? []) {
    // A form shares its species' regional Pokédex number.
    if (isPresent(personal.tableIndex(entry.i, form))) available.set(pokemonId, { dex });
  }
}
const inSinnohDex = (speciesId) => personal.get(speciesId).dex !== 0;

// ───────────────────────────── Locations ─────────────────────────────

const displayName = (id) => LOCATION_OVERRIDES[id] ?? gameLocationName(id);
/** Every id → the first id with the same display name (0 is kept for "unknown"). */
const canonicalId = new Map();
const idByName = new Map();
for (let id = 1; id < 1000; id += 1) {
  const name = displayName(id);
  if (name === null) continue;
  if (!idByName.has(name)) idByName.set(name, id);
  canonicalId.set(id, idByName.get(name));
}
function locationOf(id) {
  const canonical = canonicalId.get(id);
  if (canonical === undefined) {
    warnings.push(`location ${id} has no name`);
    return id;
  }
  return canonical;
}
function locationNamed(name) {
  const id = idByName.get(name);
  if (id === undefined) throw new Error(`No location named "${name}"`);
  return id;
}

// ───────────────────────────── Rows ─────────────────────────────

/** Builds an EncounterRow with a fixed key order (the collector compares rows as JSON). */
function makeRow({ k, l, n, x, m, v, c, s }) {
  const row = { k, l, n, x };
  if (m) row.m = m;
  if (v !== undefined && v !== BOTH) row.v = v;
  if (c && c.length > 0) row.c = [...c];
  if (s) row.s = 1;
  return row;
}

const unique = (list) => [...new Set(list)];
const collector = createEncounterCollector();
const counts = { slots: 0, skippedSlots: 0, fixed: 0 };
const add = (pokemonId, fields) => collector.add(pokemonId, makeRow(fields));

/** One area: u16 location, u8 slot type, padding, then 4-byte slots (EncounterArea8b). */
function readArea(entry) {
  const slots = [];
  for (let at = 4; at + 4 <= entry.length; at += 4) {
    const raw = entry.readUInt16LE(at);
    slots.push({ species: raw & 0x3ff, form: raw >> 11, min: entry[at + 2], max: entry[at + 3] });
  }
  return { location: entry.readUInt16LE(0), type: entry[2], slots };
}

function seaForm(slot) {
  return slot.species === SPECIES.Shellos || slot.species === SPECIES.Gastrodon
    ? [SEA_FORMS[slot.form] ?? '']
    : [];
}

function addOverworld(file, version) {
  const areas = readEntries(file)
    .map(readArea)
    .filter((area) => area.slots.length > 0);
  // Group by (location, type) in file order: a second grass table is the "daily" one.
  const byKey = new Map();
  for (const area of areas) {
    const key = `${area.location}:${area.type}`;
    byKey.set(key, [...(byKey.get(key) ?? []), area]);
  }
  for (const [key, group] of byKey) {
    const [location, type] = key.split(':').map(Number);
    const name = displayName(location) ?? '';
    const l = locationOf(location);
    const marsh = name === 'Great Marsh';
    const nationalDexArea = NATIONAL_DEX_AREAS.has(name) || NATIONAL_DEX_LOCATION_IDS.has(location);
    // Conditions of the whole location, put in front of every row there.
    const extra = [
      ...(marsh ? [SAFARI] : []),
      ...(nationalDexArea ? [NATIONAL_DEX] : []),
      ...(LOCATION_CONDITIONS[name] ?? []),
    ];
    group.forEach((area, index) => {
      const daily = type === SLOT.Grass && index === 1 ? DAILY_TABLES[name] : undefined;
      if (
        index > 0 &&
        daily === undefined &&
        !(type === SLOT.SuperRod && area.slots.every((slot) => slot.species === SPECIES.Feebas))
      ) {
        warnings.push(`unexpected extra ${type} table at ${location} ${name}`);
      }
      const regular = new Set(index > 0 ? group[0].slots.map((slot) => slot.species) : []);
      for (const slot of area.slots) {
        if (slot.species === 0 || slot.species > MAX_SPECIES) {
          counts.skippedSlots += 1;
          continue;
        }
        counts.slots += 1;
        const id = pokemonIdOf(slot.species, slot.form);
        const base = { l, n: slot.min, x: slot.max, v: version };
        if (daily !== undefined) {
          if (regular.has(slot.species)) continue; // already listed as a regular encounter here
          const c = [...daily.c];
          if (daily.nationalDexForNonSinnoh && !inSinnohDex(slot.species)) c.push(NATIONAL_DEX);
          add(id, { ...base, k: 'special', m: daily.m, c: [...c, ...seaForm(slot)] });
        } else if (type === SLOT.Grass) {
          const swarm = SWARMS[name] === slot.species;
          if (swarm) swarmSeen.set(name, swarmSeen.get(name) | version);
          let radar = false;
          if (!swarm && nationalDexArea) {
            radar = (POST_GAME_RADAR[name] ?? []).includes(slot.species);
            if (radar) postGameRadarSeen.add(`${name}|${slot.species}`);
          } else if (!swarm && !inSinnohDex(slot.species)) {
            // Before the National Pokédex only Sinnoh Pokédex Pokémon appear in the wild.
            radar = !NO_RADAR(location);
            if (!radar)
              warnings.push(
                `non-Sinnoh #${slot.species} in a no-radar table at ${location} ${name}`,
              );
          }
          if (swarm || radar)
            add(id, {
              ...base,
              k: 'special',
              m: swarm ? 'Swarm' : 'Poké Radar',
              c: unique([...extra, NATIONAL_DEX, ...seaForm(slot)]),
            });
          else add(id, { ...base, k: 'wild', c: [...extra, ...seaForm(slot)] });
        } else if (type === SLOT.Surf) {
          add(id, { ...base, k: 'surf', c: [...extra, ...seaForm(slot)] });
        } else if (ROD_NAME[type] !== undefined) {
          if (slot.species === SPECIES.Feebas) {
            add(id, {
              ...base,
              k: 'fishing',
              m: 'Feebas tiles',
              c: [...extra, 'Only 4 water tiles, which change daily'],
            });
          } else {
            add(id, { ...base, k: 'fishing', m: ROD_NAME[type], c: [...extra, ...seaForm(slot)] });
          }
        } else if (type === SLOT.HoneyTree) {
          const c =
            slot.species === SPECIES.Munchlax
              ? ['Only on 4 special trees, set by your Trainer ID']
              : [];
          add(id, { ...base, k: 'interact', m: 'Honey Tree', c: [...extra, ...c] });
        } else if (type === SLOT.RockSmash) {
          add(id, { ...base, k: 'interact', m: 'Rock Smash', c: extra });
        } else {
          warnings.push(`unknown slot type ${type} at ${location}`);
        }
      }
    });
  }
}

function addUnderground(file, version) {
  for (const area of readEntries(file).map(readArea)) {
    const l = locationOf(area.location);
    const biome = /\(([^)]+)\)$/.exec(displayName(area.location) ?? '')?.[1] ?? '';
    if (UNDERGROUND_RARE_SPAWNS[biome] === undefined)
      warnings.push(`hideaway ${area.location} has no known biome`);
    for (const slot of area.slots) {
      if (slot.species === 0 || slot.species > MAX_SPECIES) {
        counts.skippedSlots += 1;
        continue;
      }
      counts.slots += 1;
      const rare = rareSpawns.get(`${biome}|${slot.species}`);
      if (rare !== undefined && (rare.mask & version) !== 0) {
        rare.seen |= version;
        add(pokemonIdOf(slot.species, slot.form), {
          k: 'den',
          l,
          n: slot.min,
          x: slot.max,
          m: 'Pokémon Hideaway (rare spawn)',
          v: version,
          c: seaForm(slot),
        });
        if (!rare.regular) continue;
      }
      const national =
        !inSinnohDex(slot.species) || UNDERGROUND_NATIONAL_DEX_EXTRA.has(slot.species);
      // National Pokédex Pokémon only appear once the Elite Four is beaten: drop the earlier level brackets.
      if (national && slot.max < POST_ELITE_FOUR_MIN_LEVEL) continue;
      add(pokemonIdOf(slot.species, slot.form), {
        k: 'den',
        l,
        n: national ? Math.max(slot.min, POST_ELITE_FOUR_MIN_LEVEL) : slot.min,
        x: slot.max,
        m: 'Pokémon Hideaway',
        v: version,
        c: [...(national ? [NATIONAL_DEX] : []), ...seaForm(slot)],
      });
    }
  }
}

addOverworld(bdFile, BD);
addOverworld(spFile, SP);
for (const [name, seen] of swarmSeen) {
  if (seen !== BOTH)
    warnings.push(`swarm #${SWARMS[name]} at ${name} not in PKHeX's grass data (seen ${seen})`);
}
for (const [name, list] of Object.entries(POST_GAME_RADAR)) {
  for (const speciesId of list) {
    if (!postGameRadarSeen.has(`${name}|${speciesId}`))
      warnings.push(`Poké Radar #${speciesId} at ${name} not in PKHeX's grass data`);
  }
}
addUnderground(bdUnderground, BD);
addUnderground(spUnderground, SP);
for (const [key, rare] of rareSpawns) {
  if (rare.seen !== rare.mask)
    warnings.push(
      `rare spawn ${key} (versions ${rare.mask}) not in PKHeX's hideaway data (seen ${rare.seen})`,
    );
}

// ───────────────────────────── Gifts, statics, trades ─────────────────────────────

/** Default `Shiny` of a template: `{ get; init; } = Shiny.X`, or expression-bodied `=> Shiny.X`. */
function templateShiny(source) {
  return (
    /Shiny Shiny \{ get; init; \}(?: = Shiny\.(\w+))?/.exec(source)?.[1] ??
    /Shiny Shiny => Shiny\.(\w+);/.exec(source)?.[1] ??
    'Random'
  );
}
const SHINY_DEFAULT = {
  static: templateShiny(staticTemplate),
  trade: templateShiny(tradeTemplate),
};
const VERSION_BITS = { BD, SP, BDSP: BOTH };

/**
 * Encounters8b.cs declares its templates with object initialisers —
 * `new(BDSP) { Species = 387, Level = 05, Location = 323 }, // Turtwig` and
 * `new(TradeNames, 00, BDSP) { Species = 063, ... }` — which the shared
 * parseFixedEncounters (positional `new(species, form, level)`) cannot read.
 */
function parseEncounters8b(source) {
  const result = [];
  let template = null;
  let group = '';
  for (const line of source.split(/\r?\n/)) {
    const array = /static readonly Encounter(Static|Trade)8b\[\]\s+(\w+)/.exec(line);
    if (array) {
      template = array[1].toLowerCase();
      group = '';
      continue;
    }
    const heading = /^\s*\/\/\s*(.+?)\s*$/.exec(line);
    if (heading) {
      group = heading[1];
      continue;
    }
    const entry = /^\s*new\(([^)]*)\)\s*\{(.*)\}\s*,?\s*(?:\/\/\s*(.*))?$/.exec(line);
    if (template === null || entry === null) continue;
    const args = entry[1].split(',').map((part) => part.trim());
    const body = entry[2];
    // Whole-word field names: `Location` must not match `EggLocation`.
    const field = (name) =>
      new RegExp(`(?:^|[\\s{,])${name}\\s*=\\s*([\\w.]+)`).exec(body)?.[1] ?? null;
    const number = (name) => {
      const value = field(name);
      return value !== null && /^\d+$/.test(value) ? Number(value) : null;
    };
    const version = VERSION_BITS[args.at(-1)];
    if (version === undefined) warnings.push(`unknown version ${args.at(-1)} in Encounters8b.cs`);
    result.push({
      template,
      group,
      name: entry[3] ?? '',
      version: version ?? BOTH,
      tradeIndex: template === 'trade' ? Number(args[1]) : null,
      species: number('Species'),
      level: number('Level'),
      location: number('Location'),
      eggLocation: number('EggLocation'),
      roaming: /\bIsRoaming\s*=\s*true/.test(body),
      shiny: (field('Shiny') ?? SHINY_DEFAULT[template]).replace(/^Shiny\./, ''),
    });
  }
  return result;
}

for (const entry of parseEncounters8b(fixedSource)) {
  if (entry.species === null || entry.level === null || !speciesById.has(entry.species)) {
    warnings.push(`unreadable Encounters8b.cs entry ${entry.name}`);
    continue;
  }
  counts.fixed += 1;
  const id = pokemonIdOf(entry.species, 0);
  const s = entry.shiny === 'Never' ? 1 : 0;
  if (entry.template === 'trade') {
    const trade = TRADE_DETAILS[entry.tradeIndex ?? -1];
    if (trade === undefined)
      warnings.push(`no trade details for trade #${entry.tradeIndex} (${entry.name})`);
    add(id, {
      k: 'trade',
      l: trade ? locationNamed(trade.at) : 0,
      n: entry.level,
      x: entry.level,
      m: trade ? `Trade your ${trade.wants}` : 'In-game trade',
      v: entry.version,
      // Route 226 only opens with the National Pokédex.
      c: trade && NATIONAL_DEX_AREAS.has(trade.at) ? [NATIONAL_DEX] : [],
      s,
    });
    continue;
  }
  const isEgg = entry.eggLocation !== null && entry.eggLocation !== DEFAULT_8B_NONE;
  // Version-specific legendaries (StaticBD / StaticSP) carry no group comment: go by the room.
  const ramanas = /^Ramanas Park \((?:Pure|Strange) Space\)$/.test(
    displayName(entry.location ?? 0) ?? '',
  );
  const details = ramanas ? ramanasPark(entry.species) : FIXED_DETAILS[entry.species];
  if (details === undefined)
    warnings.push(`no FIXED_DETAILS for ${entry.name} (#${entry.species}) — generic label used`);
  let l = details?.at
    ? locationNamed(details.at)
    : entry.location !== null
      ? locationOf(entry.location)
      : 0;
  if (entry.roaming && !details?.at) l = 0; // PKHeX stores a placeholder route for roamers
  add(id, {
    k: isEgg || GIFT_GROUPS.test(entry.group) ? 'gift' : 'static',
    l,
    n: entry.level,
    x: entry.level,
    m: details?.m ?? (entry.roaming ? 'Roaming' : entry.group),
    v: details?.v ?? entry.version,
    c: details?.c ?? [],
    s,
  });
}

// ───────────────────────────── Merge versions & write ─────────────────────────────

const KIND_ORDER = [
  'wild',
  'surf',
  'fishing',
  'interact',
  'alpha',
  'outbreak',
  'special',
  'den',
  'raid',
  'static',
  'gift',
  'trade',
];

/** Rows identical apart from the version and level merge into one (v omitted when both versions have it). */
function mergeVersions(rows) {
  const merged = new Map();
  for (const row of rows) {
    const { v = BOTH, n, x, ...rest } = row;
    const key = JSON.stringify(rest);
    const existing = merged.get(key);
    if (existing === undefined) merged.set(key, { row: { ...row }, v });
    else {
      existing.v |= v;
      existing.row.n = Math.min(existing.row.n, n);
      existing.row.x = Math.max(existing.row.x, x);
    }
  }
  return [...merged.values()].map(({ row, v }) => makeRow({ ...row, v }));
}

const nameOf = (id) => (id === 0 ? '' : (displayName(id) ?? ''));
const pokemon = new Map();
const kindCounts = {};
for (const [id, { dex }] of available) {
  const rows = mergeVersions(collector.rows(id)).sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.k) - KIND_ORDER.indexOf(b.k) ||
      a.n - b.n ||
      nameOf(a.l).localeCompare(nameOf(b.l)) ||
      (a.v ?? BOTH) - (b.v ?? BOTH),
  );
  for (const row of rows) kindCounts[row.k] = (kindCounts[row.k] ?? 0) + 1;
  pokemon.set(id, { dex, rows });
}
const orphans = collector.pokemonIds().filter((id) => !available.has(id));

const written = writeEncounterFile({
  gameId: GAME_ID,
  versions: VERSIONS,
  locationName: displayName,
  pokemon,
});

// ───────────────────────────── Summary ─────────────────────────────

const withRows = [...pokemon.values()].filter((entry) => entry.rows.length > 0).length;
const note = (label, values) => (values.length > 0 ? `\n  ${label}: ${values.join(', ')}` : '');
console.log(
  `${written.file}\n` +
    `  ${written.pokemon} Pokémon in the game (${withRows} with encounters), ${written.locations} named locations\n` +
    `  ${counts.slots} wild / hideaway slots read, ${counts.fixed} gifts / statics / trades, ${counts.skippedSlots} slots skipped\n` +
    `  rows per kind: ${KIND_ORDER.filter((k) => kindCounts[k])
      .map((k) => `${k} ${kindCounts[k]}`)
      .join(', ')}\n` +
    `  separate forms: ${[...formMap.values()].reduce((sum, forms) => sum + forms.size, 0)}, ` +
    `shiny defaults: ${JSON.stringify(SHINY_DEFAULT)}` +
    note('regional forms that could not be matched', unresolved) +
    note('encounters for Pokémon not in the game', orphans) +
    note('warnings', warnings),
);

// Spot checks: a few Pokémon of different kinds, for comparing against Serebii / Bulbapedia.
if (process.argv.includes('--spot')) {
  const spot = process.argv[process.argv.indexOf('--spot') + 1]?.split(',').map(Number) ?? [];
  for (const id of spot) {
    const entry = pokemon.get(id);
    console.log(
      `\n#${id} ${speciesById.get(id)?.n ?? ''} dex ${entry?.dex ?? '—'}${entry ? '' : ' (not in game)'}`,
    );
    for (const row of entry?.rows ?? []) {
      const version =
        row.v === undefined
          ? ''
          : ` [${VERSIONS.filter((_, bit) => row.v & (1 << bit)).join('/')}]`;
      console.log(
        `  ${row.k.padEnd(8)} ${nameOf(row.l).padEnd(38)} Lv ${row.n}-${row.x}${row.m ? ` · ${row.m}` : ''}${version}${row.c ? ` · ${row.c.join('; ')}` : ''}${row.s ? ' · SHINY-LOCKED' : ''}`,
      );
    }
  }
}
