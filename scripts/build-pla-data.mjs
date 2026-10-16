#!/usr/bin/env node
/**
 * Builds `src/renderer/data/encounters/pla.json` — where every Pokémon is found
 * in Pokémon Legends: Arceus — from the game data shipped with PKHeX
 * (https://github.com/kwsch/PKHeX, GPL-3.0). PokeAPI has no encounter data for
 * this game. Only facts are extracted and re-keyed to PokeAPI ids.
 *
 *   Resources/byte/personal/personal_la                personal table (PersonalInfo8LA): forms, types,
 *                                                       present-in-game flag, Hisui Pokédex number
 *   Resources/legality/wild/Gen8/encounter_la.pkl       wild spawners (EncounterArea8a / EncounterSlot8a)
 *   Legality/Encounters/Data/Gen8/Encounters8a.cs       gifts and static encounters (EncounterStatic8a)
 *   Legality/Encounters/Templates/Gen8a/EncounterStatic8a.cs   default `Shiny` of a static encounter
 *   Resources/text/locations/gen8a/text_la_*_en.txt     location names
 *
 * Every wild spawner lists a region (Obsidian Fieldlands …) followed by the
 * named sub-areas it covers. Rows are emitted per sub-area and location names
 * are qualified with their region ("Obsidian Fieldlands: Horseshoe Plains").
 * Massive mass outbreaks cover a whole region, so they are listed once per region.
 *
 * Run: node scripts/build-pla-data.mjs   (npm run data:pla)
 */
import {
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

const GAME_ID = 'pla';
const VERSIONS = ['Legends: Arceus'];

/** PersonalInfo8LA layout (PKHeX.Core/PersonalInfo/Info/PersonalInfo8LA.cs). */
const PERSONAL = {
  size: 0xb0,
  type1: 0x06,
  type2: 0x07,
  formStatsIndex: 0x1e,
  formCount: 0x20,
  dexIndex: 0x60, // DexIndexHisui
};
/** `IsPresentInGame` is bit 6 of byte 0x21 (bits 0-5 are the colour), so it is read here, not by createPersonalTable. */
const PRESENT_BYTE = 0x21;
const PRESENT_BIT = 6;
/** Legal.MaxSpeciesID_8a — personal entries above this are alternate forms, not species. */
const MAX_SPECIES = 905;

/** SlotType8a (EncounterArea8a.cs). */
const SLOT_TYPE = {
  Standard: 0,
  Distortion: 1,
  Landmark: 2,
  MassOutbreakRegular: 3,
  MassOutbreakMassive: 4,
};
/** EncounterSlot8a.AlphaType: 0 = never, 1 = random (the alpha variant of a spawner slot), 2 = guaranteed. */
const ALPHA = { Never: 0, Random: 1, Guaranteed: 2 };
/** PKHeX `Gender` enum as stored in a slot. */
const GENDER = { 0: 'Male only', 1: 'Female only' };

/** The five explorable regions; every wild spawner lists one of them first. */
const REGIONS = new Set([7, 8, 9, 10, 11]);
/**
 * Region of locations that no wild spawner lists as a sub-area (so the region
 * cannot be read from the spawner data): the lake caverns, Firespit Island's
 * Lava Dome Sanctum, Seaside Hollow, Snowpoint Temple, Turnback Cave (Cobalt
 * Coastlands), Wayward Cave and the Temple of Sinnoh (Coronet Highlands), as
 * Serebii's Hisui location list places them.
 */
const EXTRA_PARENT = {
  64: 9,
  67: 9,
  68: 9,
  86: 10,
  95: 11,
  104: 7,
  105: 8,
  109: 10,
  111: 11,
};

/**
 * Non-regional forms that PokeAPI lists as separate Pokémon. createFormResolver
 * only matches regional forms; these are mapped explicitly (form index as in
 * PKHeX) and confirmed by their types below.
 */
const NAMED_FORMS = {
  'wormadam-sandy': 1,
  'wormadam-trash': 2,
  'rotom-heat': 1,
  'rotom-wash': 2,
  'rotom-frost': 3,
  'rotom-fan': 4,
  'rotom-mow': 5,
  'dialga-origin': 1,
  'palkia-origin': 1,
  'giratina-origin': 1,
  'shaymin-sky': 1,
  'basculin-blue-striped': 1,
  'basculin-white-striped': 2,
  'tornadus-therian': 1,
  'thundurus-therian': 1,
  'landorus-therian': 1,
  'enamorus-therian': 1,
  'basculegion-female': 1,
  'ursaluna-bloodmoon': 1,
};

/** Fixed encounters whose PKHeX group is "Gifts" but which are battled and caught. */
const BATTLED_GIFTS = new Set([483, 484, 493]); // Dialga, Palkia (Origin Ball), Arceus
const STARTERS = new Set([722, 155, 501]);
const UNOWN = 201;
const UNOWN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!?';

/**
 * Unlock conditions of fixed encounters, by species. PKHeX does not encode
 * these; each was checked against Serebii's Legends: Arceus pages (legendary.shtml,
 * requests.shtml, requests/incarnateforcesofhisui.shtml) and request guides.
 * Avoid weather words ("snow", "rain", "sun" …) in non-weather conditions: the
 * locations panel picks a weather icon by matching them.
 */
const POST_GAME = 'After the main story';
/** Volo is fought at the Temple of Sinnoh after the plate missions of the post-game. */
const AFTER_VOLO = 'After defeating Volo (post-game)';
const STATIC_CONDITIONS = {
  37: ['Request 83 (Keaka’s Alolan Vulpix)'], // Alolan Vulpix gift
  77: ['Request 19: A Peculiar Ponyta'], // the always-shiny Ponyta
  442: ['After collecting all 107 wisps'], // Spiritomb
  480: [POST_GAME], // Uxie
  481: [POST_GAME], // Mesprit
  482: [POST_GAME], // Azelf
  483: ['Main story climax'], // Dialga — one is caught, the other auto-caught in the Origin Ball
  484: ['Main story climax'], // Palkia
  485: [POST_GAME], // Heatran
  486: [POST_GAME], // Regigigas
  487: [AFTER_VOLO, 'Request 91: On the Trail of Giratina'], // Giratina
  488: [POST_GAME], // Cresselia
  489: ['Request 66: The Sea’s Legend'], // Phione — with Manaphy, then it can reappear
  490: ['Request 66: The Sea’s Legend', 'Buizel, Mantyke and Overqwil in your party', 'Evening'], // Manaphy
  491: [
    POST_GAME,
    'Requires Brilliant Diamond / Shining Pearl save data',
    'Request 93: The Darksome Nightmare',
    'Night',
  ], // Darkrai
  492: [POST_GAME, 'Requires Sword / Shield save data'], // Shaymin
  493: [AFTER_VOLO, 'Catch every other non-Mythical Pokémon in the Pokédex'], // Arceus
  570: [POST_GAME, 'Request 95: A New Anomaly (Daybreak update)'], // Hisuian Zorua horde on Ramanas Island
  571: ['Main story: the trial of Lake Acuity'], // alpha Hisuian Zoroark in Acuity Cavern (Mission 16)
  706: ['Main story: the trial of Lake Verity'], // alpha Hisuian Goodra in Verity Cavern (Mission 14)
  904: ['Main story: the trial of Lake Valor'], // alpha Overqwil in Valor Cavern (Mission 15)
  641: [AFTER_VOLO, 'Request 94: Incarnate Forces of Hisui', 'Snowstorm'], // Tornadus
  642: [AFTER_VOLO, 'Request 94: Incarnate Forces of Hisui', 'Thunderstorm'], // Thundurus
  645: [AFTER_VOLO, 'Request 94: Incarnate Forces of Hisui'], // Landorus
  905: [AFTER_VOLO, 'Complete the Pokédex entries of Tornadus, Thundurus and Landorus'], // Enamorus
};
/**
 * Massive mass outbreaks arrived with the Daybreak update (v1.1): they start after the main
 * story once the request "Daybreak" is done, region by region through Mai's requests 96–101.
 */
const MASSIVE_OUTBREAK_CONDITIONS = ['After the main story and the Daybreak requests'];
/** Wild Unown spawn in and around the Solaceon Ruins only once all 28 Unown notes are caught (Serebii unownlocations.shtml). */
const WILD_UNOWN_CONDITION = 'After catching all 28 Unown';
/** Space-time distortions start once the Crimson Mirelands are reached; the starter lines appear in them only after the main story. */
const DISTORTION_CONDITIONS = ['After reaching the Crimson Mirelands'];
const STARTER_LINES = new Set([722, 723, 724, 155, 156, 157, 501, 502, 503]);

// ───────────────────────────── Download ─────────────────────────────

const [personalFile, wildFile, fixedSource, staticTemplate, locationName] = await Promise.all([
  download('Resources/byte/personal/personal_la'),
  download('Resources/legality/wild/Gen8/encounter_la.pkl'),
  download('Legality/Encounters/Data/Gen8/Encounters8a.cs', 'text'),
  download('Legality/Encounters/Templates/Gen8a/EncounterStatic8a.cs', 'text'),
  loadLocationNames('gen8a', 'la'),
]);

// ───────────────────────────── Personal table & forms ─────────────────────────────

const personal = createPersonalTable(personalFile, PERSONAL);
const presentAt = (index) =>
  ((personalFile[index * PERSONAL.size + PRESENT_BYTE] >> PRESENT_BIT) & 1) === 1;

const species = loadSpeciesIndex().filter((entry) => entry.i <= MAX_SPECIES);
const speciesById = new Map(species.map((entry) => [entry.i, entry]));
const sameTypes = (a, b) => a.length === b.length && a.every((type) => b.includes(type));

/** Whether a (species, form) has its own present-in-game personal entry. */
const formPresent = (speciesId, form) => {
  const index = personal.tableIndex(speciesId, form);
  return (form === 0 || index !== speciesId) && presentAt(index);
};

/** speciesId → { form index → PokeAPI id } for the named (non-regional) forms. */
const extra = {};
const formTypeMismatches = [];
for (const entry of species) {
  for (const form of entry.f ?? []) {
    const index = NAMED_FORMS[form.s];
    if (index === undefined || !formPresent(entry.i, index)) continue;
    if (!sameTypes(personal.get(personal.tableIndex(entry.i, index)).types, form.t)) {
      formTypeMismatches.push(form.s);
      continue;
    }
    (extra[entry.i] ??= {})[index] = form.i;
  }
}
const resolver = createFormResolver(personal, species, extra);

/**
 * Forms with no PokeAPI Pokémon of their own collapse onto the species — unless
 * the species' base form is not in the game (Hisuian-only lines: the noble
 * "Lord" forms of Arcanine, Electrode, Lilligant and Avalugg are form 2). Those
 * collapse onto the mapped form with the same types instead, so that e.g.
 * Kantonian Arcanine is not reported as present.
 */
const collapsedOnto = new Map();
const uncollapsible = [];
function pokemonIdOf(speciesId, form) {
  const id = resolver.pokemonIdOf(speciesId, form);
  if (
    id !== speciesId ||
    form === 0 ||
    form >= personal.get(speciesId).formCount ||
    formPresent(speciesId, 0)
  )
    return id;
  const key = `${speciesId}-${form}`;
  if (!collapsedOnto.has(key)) {
    const types = personal.get(personal.tableIndex(speciesId, form)).types;
    const twins = [...(resolver.formMap.get(speciesId) ?? [])].filter(([other]) =>
      sameTypes(personal.get(personal.tableIndex(speciesId, other)).types, types),
    );
    if (twins.length !== 1) uncollapsible.push(key);
    collapsedOnto.set(key, twins.length === 1 ? twins[0][1] : speciesId);
  }
  return collapsedOnto.get(key);
}

/** PokeAPI id → { dex } for every Pokémon (species or distinct form) present in the game. */
const available = new Map();
for (const entry of species) {
  const { formCount } = personal.get(entry.i);
  for (let form = 0; form < Math.max(1, formCount); form += 1) {
    if (!formPresent(entry.i, form)) continue;
    const id = pokemonIdOf(entry.i, form);
    if (available.has(id)) continue;
    const dex =
      personal.get(personal.tableIndex(entry.i, form)).dex || personal.get(entry.i).dex || null;
    available.set(id, { dex });
  }
}

// ───────────────────────────── Wild spawners ─────────────────────────────

/** One spawner (EncounterArea8a): location count, locations, even padding, slot type, slot count, 8-byte slots. */
function readArea(entry) {
  const locationCount = entry[0];
  const locations = [...entry.subarray(1, 1 + locationCount)];
  let at = locationCount + 1;
  at += at & 1;
  const type = entry[at];
  const count = entry[at + 1];
  if (at + 2 + count * 8 > entry.length)
    throw new Error('Spawner slots run past the end of the entry');
  const slots = Array.from({ length: count }, (_, i) => {
    const slot = entry.subarray(at + 2 + i * 8, at + 10 + i * 8);
    return {
      species: slot.readUInt16LE(0),
      form: slot[2],
      alpha: slot[3],
      min: slot[4],
      max: slot[5],
      gender: slot[6],
    };
  });
  return { locations, type, slots };
}

const areas = readEntries(wildFile).map(readArea);

/** Sub-area → region, read from the spawners (the region is always listed first). */
const parentOf = new Map(Object.entries(EXTRA_PARENT).map(([id, region]) => [Number(id), region]));
for (const { locations } of areas) {
  const [region, ...subAreas] = locations;
  if (!REGIONS.has(region)) continue;
  for (const id of subAreas) if (!REGIONS.has(id)) parentOf.set(id, region);
}
const qualifiedName = (id) => {
  const name = locationName(id);
  const region = parentOf.get(id);
  if (name === null || region === undefined) return name;
  const regionName = locationName(region);
  return regionName === null ? name : `${regionName}: ${name}`;
};

const collector = createEncounterCollector();
const orphans = new Set();
const unknownTypes = new Set();
let wildSlots = 0;

function add(speciesId, form, row) {
  if (!speciesById.has(speciesId)) return;
  const id = pokemonIdOf(speciesId, form);
  if (!available.has(id)) orphans.add(`${speciesId}-${form}`);
  collector.add(id, row);
}

for (const area of areas) {
  const [region, ...subAreas] = area.locations;
  const massive = area.type === SLOT_TYPE.MassOutbreakMassive;
  const targets = massive || subAreas.length === 0 ? [region] : subAreas;
  for (const slot of area.slots) {
    wildSlots += 1;
    const alpha = slot.alpha !== ALPHA.Never;
    let row;
    switch (area.type) {
      case SLOT_TYPE.Standard:
        row = alpha
          ? { k: 'alpha', ...(slot.alpha === ALPHA.Guaranteed ? { m: 'Guaranteed spawn' } : {}) }
          : { k: 'wild' };
        break;
      case SLOT_TYPE.Distortion:
        row = {
          k: alpha ? 'alpha' : 'special',
          m: 'Space-time distortion',
          c: STARTER_LINES.has(slot.species) ? [POST_GAME] : DISTORTION_CONDITIONS,
        };
        break;
      case SLOT_TYPE.Landmark:
        row = { k: alpha ? 'alpha' : 'interact', m: 'Shaking tree, ore deposit or crate' };
        break;
      case SLOT_TYPE.MassOutbreakRegular:
        row = { k: alpha ? 'alpha' : 'outbreak', m: 'Mass outbreak' };
        break;
      case SLOT_TYPE.MassOutbreakMassive:
        row = {
          k: alpha ? 'alpha' : 'outbreak',
          m: 'Massive mass outbreak',
          c: MASSIVE_OUTBREAK_CONDITIONS,
        };
        break;
      default:
        unknownTypes.add(area.type);
        continue;
    }
    const conditions = [
      ...(row.c ?? []),
      ...(area.type === SLOT_TYPE.Standard && slot.species === UNOWN ? [WILD_UNOWN_CONDITION] : []),
      ...(GENDER[slot.gender] ? [GENDER[slot.gender]] : []),
    ];
    for (const l of targets) {
      add(slot.species, slot.form, {
        k: row.k,
        l,
        n: slot.min,
        x: slot.max,
        ...(row.m === undefined ? {} : { m: row.m }),
        ...(conditions.length > 0 ? { c: conditions } : {}),
      });
    }
  }
}

// ───────────────────────────── Gifts & statics ─────────────────────────────

const shinyDefault = templateShinyDefault(staticTemplate);
if (shinyDefault !== 'Never')
  throw new Error(`Unexpected EncounterStatic8a shiny default: ${shinyDefault}`);
// new(species, form, level, heightScalar, weightScalar) { Location = …, LevelMax = …, Shiny = …, IsAlpha = … }
const fixed = parseFixedEncounters(fixedSource, { defaults: { static: shinyDefault } });
/**
 * PKHeX lists some encounters a second time under "crossovers": the same
 * Pokémon may record a neighbouring area as its met location. They are not
 * separate places to find it, so they are skipped when the primary entry exists.
 */
const isCrossover = (encounter) => /crossover/i.test(encounter.group);
const fixedKey = (encounter) => `${encounter.species}-${encounter.form}`;
const primaryKeys = new Set(fixed.filter((encounter) => !isCrossover(encounter)).map(fixedKey));
const fixedCounts = {};
let crossoversSkipped = 0;
for (const encounter of fixed) {
  if (isCrossover(encounter) && primaryKeys.has(fixedKey(encounter))) {
    crossoversSkipped += 1;
    continue;
  }
  const levelMax = Number(/LevelMax\s*=\s*(\d+)/.exec(encounter.body)?.[1] ?? encounter.level);
  const alwaysShiny = /Shiny\s*=\s*(?:Shiny\.)?Always\b/.test(encounter.body);
  const gift = /^Gifts?\b/i.test(encounter.group) && !BATTLED_GIFTS.has(encounter.species);
  const kind = gift ? 'gift' : 'static';
  const conditions = [
    ...(STARTERS.has(encounter.species) ? ['Choose one of three starters'] : []),
    ...(STATIC_CONDITIONS[encounter.species] ?? []),
    ...(alwaysShiny ? ['Always shiny'] : []),
  ];
  fixedCounts[kind] = (fixedCounts[kind] ?? 0) + 1;
  add(encounter.species, encounter.form, {
    k: kind,
    l: encounter.location,
    n: encounter.level,
    x: Math.max(encounter.level, levelMax),
    ...(encounter.alpha
      ? { m: 'Alpha' }
      : encounter.species === UNOWN
        ? { m: `Unown ${UNOWN_LETTERS[encounter.form]}` }
        : {}),
    ...(conditions.length > 0 ? { c: conditions } : {}),
    ...(encounter.shinyLocked ? { s: 1 } : {}),
  });
}

// ───────────────────────────── Output ─────────────────────────────

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
const pokemon = new Map();
for (const [id, { dex }] of available) {
  const rows = collector
    .rows(id)
    .sort((a, b) => KIND_ORDER.indexOf(a.k) - KIND_ORDER.indexOf(b.k) || a.l - b.l || a.n - b.n);
  pokemon.set(id, { dex, rows });
}
const result = writeEncounterFile({
  gameId: GAME_ID,
  versions: VERSIONS,
  locationName: qualifiedName,
  pokemon,
});

// ───────────────────────────── Summary ─────────────────────────────

const rowsPerKind = {};
let rowCount = 0;
let withRows = 0;
for (const { rows } of pokemon.values()) {
  if (rows.length > 0) withRows += 1;
  for (const row of rows) {
    rowsPerKind[row.k] = (rowsPerKind[row.k] ?? 0) + 1;
    rowCount += 1;
  }
}
/** Regional forms the resolver could not place, limited to species that have such a form in this game. */
const unresolved = resolver.unresolved.filter((slug) => {
  const entry = species.find((candidate) => candidate.f?.some((form) => form.s === slug));
  if (entry === undefined) return true;
  const { formCount } = personal.get(entry.i);
  return Array.from({ length: formCount }, (_, form) => form).some(
    (form) => form > 0 && formPresent(entry.i, form) && pokemonIdOf(entry.i, form) === entry.i,
  );
});
const unnamed = [...collector.usedLocations].filter((id) => id !== 0 && locationName(id) === null);
const note = (label, values) => (values.length > 0 ? `\n  ${label}: ${values.join(', ')}` : '');
console.log(
  `${result.file}\n` +
    `  ${result.pokemon} Pokémon in the game (${withRows} with encounters), ${rowCount} rows, ${result.locations} named locations\n` +
    `  ${areas.length} spawners, ${wildSlots} wild slots, ${fixed.length} fixed encounters ${JSON.stringify(fixedCounts)}, ${crossoversSkipped} crossover duplicates skipped\n` +
    `  rows per kind: ${JSON.stringify(rowsPerKind)}\n` +
    `  named forms mapped: ${Object.values(extra).reduce((n, forms) => n + Object.keys(forms).length, 0)}` +
    note('regional forms that could not be matched', unresolved) +
    note('named forms whose types did not match', formTypeMismatches) +
    note('forms of absent base species that matched no other form', uncollapsible) +
    note('encounters dropped: (species-form) not flagged present', [...orphans]) +
    note('unknown spawner types skipped', [...unknownTypes]) +
    note('location ids without a name', unnamed),
);
