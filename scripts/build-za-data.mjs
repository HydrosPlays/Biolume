#!/usr/bin/env node
/**
 * Builds the bundled Pokémon Legends: Z-A data from the game data shipped with
 * PKHeX (https://github.com/kwsch/PKHeX, GPL-3.0):
 *
 *   src/renderer/data/zaLearnsets.json      level-up learnsets
 *   src/renderer/data/encounters/za.json    availability, Pokédex numbers and
 *                                           every encounter (BundledEncounterFile
 *                                           version 2, see encounterSchema.ts):
 *                                           wild and alpha slots, gifts, statics
 *                                           and trades, with shiny locks
 *
 * PokeAPI lists the `legends-za` version group but has neither learnsets nor
 * encounters for it. Only facts are extracted and re-keyed to the PokeAPI ids
 * and slugs the rest of the app uses.
 *
 *   levelup/lvlmove_za.pkl                 one learnset per personal-table entry
 *   personal/personal_za                   personal table (forms, types, dex)
 *   legality/wild/Gen9/encounter_za.pkl    wild areas of Lumiose City
 *   .../encounter_hyperspace_za.pkl        Hyperspace Lumiose (Mega Dimension)
 *   Legality/Encounters/Data/Gen9/Encounters9a.cs   gifts, statics and trades
 *   Resources/text/locations/gen9a/*.txt   location names
 *
 * Run: node scripts/build-za-data.mjs   (npm run data:za)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEncounterCollector,
  createFormResolver,
  createPersonalTable,
  DATA_DIR,
  download,
  loadLocationNames,
  loadMoveIndex,
  loadSpeciesIndex,
  parseFixedEncounters,
  PKHEX_SOURCE,
  readEntries,
  SHINY,
  templateShinyDefault,
  writeEncounterFile,
} from './pkhex/common.mjs';

const GAME_ID = 'za';
const VERSIONS = ['Legends: Z-A'];

/** PersonalInfo9ZA layout (PKHeX.Core/PersonalInfo/Info/PersonalInfo9ZA.cs). */
const PERSONAL = {
  size: 0x50,
  type1: 0x06,
  type2: 0x07,
  formStatsIndex: 0x18,
  formCount: 0x1a,
  present: 0x1c,
  dexIndex: 0x1e,
};
/** Dex numbers above this belong to the Mega Dimension (Hyperspace) expansion. */
const LUMIOSE_DEX_SIZE = 232;
/** EncounterArea9a.LocationHyperspace: every Hyperspace wild slot is met here. */
const LOCATION_HYPERSPACE = 273;
/** Condition attached to everything that needs the Mega Dimension expansion. */
const MEGA_DIMENSION = 'Mega Dimension';
/** Condition on a slot PKHeX marks Shiny.Always (the other extractors use the same wording). */
const ALWAYS_SHINY = 'Always shiny';
/**
 * `#region Sankaku` in Encounters9a.cs wraps the Mega Dimension encounters
 * ("Sankaku" is the expansion's internal name).
 */
const DLC_REGION = /#region Sankaku[\s\S]*?#endregion/g;

/**
 * One learnset: `count` u16 move ids followed by `count` u8 levels
 * (LearnsetReader.ReadLearnset16). Entries are padded to an even length, so an
 * odd move count leaves one trailing byte.
 */
function readLearnset(entry) {
  if (entry.length % 3 === 2) throw new Error(`Unexpected learnset length ${entry.length}`);
  const count = Math.floor(entry.length / 3);
  return Array.from({ length: count }, (_, i) => ({
    move: entry.readUInt16LE(i * 2),
    level: entry[count * 2 + i],
  }));
}

/**
 * One wild area (EncounterArea9a): u16 location, 2 reserved bytes, then 8-byte
 * slots — u16 species, u8 form, u8 gender, u8 min level, u8 max level,
 * u8 alpha, u8 `Shiny`.
 */
function readArea(entry) {
  const slots = [];
  for (let at = 4; at + 8 <= entry.length; at += 8) {
    slots.push({
      species: entry.readUInt16LE(at),
      form: entry[at + 2],
      min: entry[at + 4],
      max: entry[at + 5],
      alpha: entry[at + 6] === 1,
      shinyLocked: entry[at + 7] === SHINY.Never,
      alwaysShiny: [SHINY.Always, SHINY.AlwaysStar, SHINY.AlwaysSquare].includes(entry[at + 7]),
    });
  }
  return { location: entry.readUInt16LE(0), slots };
}

/**
 * Default `Shiny` of a template: an init property with a default
 * (`Shiny Shiny { get; init; } = Shiny.Never`) or a fixed getter
 * (`Shiny Shiny => Shiny.Never`, EncounterTrade9a).
 */
function shinyDefault(source) {
  return /Shiny Shiny => Shiny\.(\w+);/.exec(source)?.[1] ?? templateShinyDefault(source);
}

const templates = ['Gift', 'Static', 'Trade'];
const [learnsetFile, personalFile, lumioseFile, hyperspaceFile, fixedSource, ...templateSources] =
  await Promise.all([
    download('Resources/byte/levelup/lvlmove_za.pkl'),
    download('Resources/byte/personal/personal_za'),
    download('Resources/legality/wild/Gen9/encounter_za.pkl'),
    download('Resources/legality/wild/Gen9/encounter_hyperspace_za.pkl'),
    download('Legality/Encounters/Data/Gen9/Encounters9a.cs', 'text'),
    ...templates.map((name) =>
      download(`Legality/Encounters/Templates/Gen9a/Encounter${name}9a.cs`, 'text'),
    ),
  ]);
const locationName = await loadLocationNames('gen9a', GAME_ID);

// ───────────────────────────── Personal table & forms ─────────────────────────────

const learnsetEntries = readEntries(learnsetFile);
const personal = createPersonalTable(personalFile, PERSONAL);
if (personal.count !== learnsetEntries.length) {
  throw new Error('The personal table and the learnsets disagree on the entry count');
}

const species = loadSpeciesIndex();
const speciesById = new Map(species.map((entry) => [entry.i, entry]));
const { pokemonIdOf, formMap, unresolved: unresolvedForms } = createFormResolver(personal, species);
const moveSlugById = new Map(Object.entries(loadMoveIndex()).map(([slug, move]) => [move.i, slug]));

// ───────────────────────────── Learnsets & availability ─────────────────────────────

const unknownMoves = new Set();
const learnsets = new Map();
/** pokemon id → personal-table index, for every Pokémon that exists in the game. */
const available = new Map();

function addPokemon(pokemonId, index) {
  if (!personal.get(index).present) return;
  available.set(pokemonId, index);
  const moves = [];
  for (const { move, level } of readLearnset(learnsetEntries[index])) {
    const slug = moveSlugById.get(move);
    if (slug === undefined) unknownMoves.add(move);
    else moves.push([slug, level]);
  }
  if (moves.length > 0) learnsets.set(pokemonId, moves);
}

for (const entry of species) {
  if (entry.i >= personal.count) continue;
  addPokemon(entry.i, entry.i);
  for (const [form, pokemonId] of formMap.get(entry.i) ?? []) {
    addPokemon(pokemonId, personal.tableIndex(entry.i, form));
  }
}

// ───────────────────────────── Wild slots ─────────────────────────────

const collector = createEncounterCollector();
let wildSlots = 0;
for (const file of [lumioseFile, hyperspaceFile]) {
  for (const area of readEntries(file).map(readArea)) {
    const hyperspace = area.location === LOCATION_HYPERSPACE;
    for (const slot of area.slots) {
      if (!speciesById.has(slot.species)) continue;
      wildSlots += 1;
      collector.add(pokemonIdOf(slot.species, slot.form), {
        k: slot.alpha ? 'alpha' : 'wild',
        l: area.location,
        n: slot.min,
        x: slot.max,
        ...(hyperspace || slot.alwaysShiny
          ? {
              c: [
                ...(hyperspace ? [MEGA_DIMENSION] : []),
                ...(slot.alwaysShiny ? [ALWAYS_SHINY] : []),
              ],
            }
          : {}),
        ...(slot.shinyLocked ? { s: 1 } : {}),
      });
    }
  }
}

// ───────────────────────────── Gifts, statics, trades ─────────────────────────────

const defaults = Object.fromEntries(
  templates.map((name, i) => [name.toLowerCase(), shinyDefault(templateSources[i])]),
);
/** Trades are declared `new(TradeNames, index, species, form, level)`; gifts and statics `new(species, form, level, …)`. */
const TRADE_ARGS = ['names', 'index', 'species', 'form', 'level'];
const parseFixed = (source) => [
  ...parseFixedEncounters(source, { defaults }).filter((entry) => entry.kind !== 'trade'),
  ...parseFixedEncounters(source, { defaults, args: TRADE_ARGS }).filter(
    (entry) => entry.kind === 'trade',
  ),
];
const fixedKey = (entry) =>
  JSON.stringify([entry.kind, entry.species, entry.form, entry.level, entry.location, entry.body]);

/** Entries outside the Mega Dimension region, counted, so the remainder is known to be DLC. */
const baseGame = new Map();
for (const entry of parseFixed(fixedSource.replace(DLC_REGION, ''))) {
  const key = fixedKey(entry);
  baseGame.set(key, (baseGame.get(key) ?? 0) + 1);
}

let fixedCount = 0;
for (const entry of parseFixed(fixedSource)) {
  if (!speciesById.has(entry.species)) continue;
  const key = fixedKey(entry);
  const inBase = baseGame.get(key) ?? 0;
  if (inBase > 0) baseGame.set(key, inBase - 1);
  const dlc = inBase === 0 || entry.location === LOCATION_HYPERSPACE;
  // "Sankaku" (the region name) is not a heading anyone would recognise.
  const method = entry.group === '' || entry.group === 'Sankaku' ? undefined : entry.group;
  const conditions = [...(entry.alpha ? ['Alpha'] : []), ...(dlc ? [MEGA_DIMENSION] : [])];
  // Trades all record PKHeX's "a Link Trade" placeholder location: leave it unknown.
  const location = entry.kind === 'trade' ? 0 : entry.location;
  fixedCount += 1;
  collector.add(pokemonIdOf(entry.species, entry.form), {
    k: entry.kind,
    l: location,
    n: entry.level,
    x: entry.level,
    ...(method === undefined ? {} : { m: method }),
    ...(conditions.length > 0 ? { c: conditions } : {}),
    ...(entry.shinyLocked ? { s: 1 } : {}),
  });
}

// ───────────────────────────── Output ─────────────────────────────

const updated = new Date().toISOString().slice(0, 10);
const byId = (a, b) => a - b;

const learnsetIds = [...learnsets.keys()].sort(byId);
writeFileSync(
  join(DATA_DIR, 'zaLearnsets.json'),
  `${JSON.stringify({ version: 1, updated, source: PKHEX_SOURCE, versionGroup: 'legends-za' }).slice(0, -1)},"learnsets":{\n` +
    `${learnsetIds.map((id) => `"${id}":${JSON.stringify(learnsets.get(id))}`).join(',\n')}\n}}\n`,
);

const KIND_ORDER = ['wild', 'alpha', 'static', 'gift', 'trade'];
const rowOrder = (a, b) =>
  KIND_ORDER.indexOf(a.k) - KIND_ORDER.indexOf(b.k) ||
  Number(a.l === LOCATION_HYPERSPACE) - Number(b.l === LOCATION_HYPERSPACE) ||
  a.l - b.l ||
  a.n - b.n;

const pokemon = new Map();
for (const [id, index] of available) {
  const { dex } = personal.get(index);
  pokemon.set(id, {
    dex,
    dlc: dex !== null && dex > LUMIOSE_DEX_SIZE,
    rows: collector.rows(id).sort(rowOrder),
  });
}
const orphans = collector.pokemonIds().filter((id) => !available.has(id));
const written = writeEncounterFile({ gameId: GAME_ID, versions: VERSIONS, locationName, pokemon });
const unnamed = [...collector.usedLocations].filter((id) => id !== 0 && locationName(id) === null);

const note = (label, values) => (values.length > 0 ? `\n  ${label}: ${values.join(', ')}` : '');
console.log(
  `zaLearnsets.json: ${learnsetIds.length} Pokémon, ` +
    `${[...learnsets.values()].reduce((sum, moves) => sum + moves.length, 0)} level-up entries\n` +
    `encounters/za.json: ${written.pokemon} Pokémon in the game, ` +
    `${[...formMap.values()].reduce((n, m) => n + m.size, 0)} regional forms mapped, ` +
    `${wildSlots} wild slots, ${fixedCount} fixed encounters, ${written.locations} named locations` +
    `\n  fixed-encounter shiny defaults: ${JSON.stringify(defaults)}` +
    note('move ids missing from moveIndex.json', [...unknownMoves].sort(byId)) +
    note('regional forms that could not be matched', unresolvedForms) +
    note('encounters for Pokémon not flagged as present', orphans) +
    note('locations without a name', unnamed.sort(byId)),
);
