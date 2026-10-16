/**
 * Shared helpers for turning PKHeX's bundled game data
 * (https://github.com/kwsch/PKHeX, GPL-3.0) into Biolume's data files.
 *
 * Only facts are extracted (which Pokémon, where, at what level, shiny-locked
 * or not) and re-keyed to the PokeAPI ids and slugs the rest of the app uses.
 * Each `scripts/build-<game>-data.mjs` uses these helpers and writes
 * `src/renderer/data/encounters/<gameId>.json` (see encounterSchema.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKHEX_CORE = 'https://raw.githubusercontent.com/kwsch/PKHeX/master/PKHeX.Core/';
export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'data');
export const PKHEX_SOURCE = 'PKHeX (github.com/kwsch/PKHeX) game data';

/** PKHeX type ids, in order. */
export const TYPES = [
  'normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel',
  'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark', 'fairy',
];

/** PKHeX `Shiny` enum values (Legality/Encounters/Templates/Enums/Shiny.cs). */
export const SHINY = { Random: 0, Never: 1, Always: 2, AlwaysStar: 3, AlwaysSquare: 4, FixedValue: 5 };

/** Form values at or above this mean "any form" (EncounterUtil.FormDynamic / FormRandom). */
export const FORM_DYNAMIC = 0xfe;

/** Downloads a file below PKHeX.Core/ (e.g. `Resources/byte/personal/personal_sv`). */
export async function download(path, as = 'buffer') {
  const response = await fetch(PKHEX_CORE + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return as === 'text' ? response.text() : Buffer.from(await response.arrayBuffer());
}

/**
 * PKHeX "BinLinker" containers: a 2-byte tag, a u16 entry count, then count + 1
 * offsets — u16 in the "16" variant, u32 in the original. Offsets are either
 * absolute or relative to the end of the header depending on the packer
 * version. The variant and base are detected and validated.
 */
export function readEntries(file) {
  const count = file.readUInt16LE(2);
  for (const width of [2, 4]) {
    const headerEnd = 4 + (count + 1) * width;
    if (headerEnd > file.length) continue;
    const read = (i) => (width === 2 ? file.readUInt16LE(4 + i * 2) : file.readUInt32LE(4 + i * 4));
    const offsets = Array.from({ length: count + 1 }, (_, i) => read(i));
    const base = offsets[0] === headerEnd ? 0 : offsets[0] === 0 ? headerEnd : null;
    if (base === null || base + offsets[count] !== file.length) continue;
    if (offsets.some((offset, i) => i > 0 && offset < offsets[i - 1])) continue;
    return offsets.slice(0, count).map((start, i) => file.subarray(base + start, base + offsets[i + 1]));
  }
  throw new Error(`Unrecognised BinLinker container (tag ${JSON.stringify(file.subarray(0, 2).toString('latin1'))})`);
}

/**
 * A game's personal table. `layout` gives byte offsets inside one entry, read
 * from that game's PersonalInfo*.cs in PKHeX:
 *   { size, type1, type2, formStatsIndex, formCount, present?, dexIndex? }
 * `present` / `dexIndex` may be omitted for games whose table has no such field.
 */
export function createPersonalTable(file, layout) {
  if (file.length % layout.size !== 0) throw new Error('Personal table size is not a multiple of the entry size');
  const count = file.length / layout.size;
  const get = (index) => {
    const at = index * layout.size;
    const types = [file[at + layout.type1], file[at + layout.type2]].map((t) => TYPES[t]);
    return {
      types: [...new Set(types)],
      formStatsIndex: file.readUInt16LE(at + layout.formStatsIndex),
      formCount: file[at + layout.formCount],
      present: layout.present === undefined ? true : file[at + layout.present] !== 0,
      dex: layout.dexIndex === undefined ? null : file.readUInt16LE(at + layout.dexIndex),
    };
  };
  /** Personal-table index of a species' form (PersonalTable.GetFormIndex). */
  const tableIndex = (speciesId, form) => {
    if (form === 0 || speciesId >= count) return speciesId;
    const base = get(speciesId);
    if (base.formStatsIndex === 0 || form >= base.formCount) return speciesId;
    return base.formStatsIndex + form - 1;
  };
  return { count, get, tableIndex };
}

export function loadSpeciesIndex() {
  return JSON.parse(readFileSync(join(DATA_DIR, 'speciesIndex.json'), 'utf8')).species;
}

export function loadMoveIndex() {
  return JSON.parse(readFileSync(join(DATA_DIR, 'moveIndex.json'), 'utf8')).moves;
}

const REGIONS = ['alola', 'galar', 'hisui', 'paldea'];
const regionOf = (slug) => REGIONS.find((region) => new RegExp(`-${region}(-|$)`).test(slug));

/**
 * Regional forms normally take form index 1, 2, … in the order their regions
 * were introduced. These species break the pattern.
 */
export const FORM_INDEX_EXCEPTIONS = {
  'slowbro-galar': 2, // 1 is Mega Slowbro
  'darmanitan-galar-standard': 2, // 1 is Zen Mode
  'darmanitan-galar': 2,
  'tauros-paldea-combat-breed': 1,
  'tauros-paldea-blaze-breed': 2,
  'tauros-paldea-aqua-breed': 3,
};

const sameTypes = (a, b) => a.length === b.length && a.every((type) => b.includes(type));

/**
 * Maps a game's (species, form) to a PokeAPI pokemon id. Regional forms are
 * matched by their expected form index and confirmed by their types (falling
 * back to a unique type match); cosmetic and unmatched forms collapse onto the
 * species. `extra` may add explicit `{ [speciesId]: { [form]: pokemonId } }`.
 */
export function createFormResolver(personal, species, extra = {}) {
  const formMap = new Map();
  const unresolved = [];
  for (const entry of species) {
    if (entry.i >= personal.count) continue;
    const forms = new Map(Object.entries(extra[entry.i] ?? {}).map(([form, id]) => [Number(form), id]));
    const regional = (entry.f ?? [])
      .filter((form) => regionOf(form.s) !== undefined)
      .sort((a, b) => REGIONS.indexOf(regionOf(a.s)) - REGIONS.indexOf(regionOf(b.s)));
    const { formCount } = personal.get(entry.i);
    const typesAt = (index) => personal.get(personal.tableIndex(entry.i, index)).types;
    regional.forEach((form, position) => {
      const expected = FORM_INDEX_EXCEPTIONS[form.s] ?? position + 1;
      let index = expected < formCount && sameTypes(typesAt(expected), form.t) ? expected : null;
      if (index === null) {
        const matches = [];
        for (let candidate = 1; candidate < formCount; candidate += 1) {
          if (sameTypes(typesAt(candidate), form.t)) matches.push(candidate);
        }
        if (matches.length === 1) index = matches[0];
      }
      if (index === null || forms.has(index)) {
        if (formCount > 1) unresolved.push(form.s);
        return;
      }
      forms.set(index, form.i);
    });
    if (forms.size > 0) formMap.set(entry.i, forms);
  }
  const pokemonIdOf = (speciesId, form) => {
    if (form === 0 || form >= FORM_DYNAMIC) return speciesId;
    return formMap.get(speciesId)?.get(form) ?? speciesId;
  };
  return { pokemonIdOf, formMap, unresolved };
}

/**
 * Location names for a game: `folder` / `prefix` as in PKHeX's
 * Resources/text/locations (e.g. `gen9`, `sv`). Ids are split into banks
 * (0, 30000, 40000, 60000); the line number is the id within its bank.
 * Missing bank files are tolerated.
 */
export async function loadLocationNames(folder, prefix, banks = ['00000', '30000', '40000', '60000']) {
  const loaded = await Promise.all(
    banks.map((bank) =>
      download(`Resources/text/locations/${folder}/text_${prefix}_${bank}_en.txt`, 'text').then(
        (text) => text.split(/\r?\n/),
        () => [],
      ),
    ),
  );
  const starts = banks.map(Number);
  return (id) => {
    const bank = starts.findLastIndex((start) => id >= start);
    const name = loaded[bank]?.[id - starts[bank]];
    return name !== undefined && name.trim() !== '' && !/^—+$/.test(name) ? name.trim() : null;
  };
}

/**
 * Reads gifts / statics / trades declared in a PKHeX `Encounters*.cs` file:
 * lines like `new(0152,0,05,128) { Location = 30026, Shiny = Never, ... }, // Name`
 * inside `static readonly Encounter<Kind><suffix>[] Name =` arrays.
 *
 * - `defaults` maps a template kind ('gift' | 'static' | 'trade') to the default
 *   `Shiny` value of its PKHeX template (read it from Encounter<Kind><suffix>.cs);
 * - the most recent `// comment` or `#region` above an entry becomes its group.
 * Constructor argument order differs between games: `args` names the meaning of
 * the leading numeric arguments (default `['species', 'form', 'level']`).
 */
export function parseFixedEncounters(source, { defaults, args = ['species', 'form', 'level'] }) {
  const lines = [];
  for (const line of source.split(/\r?\n/)) {
    const previous = lines.at(-1);
    const isEntry = previous !== undefined && /^\s*new\(/.test(previous);
    const unclosed = isEntry && previous.includes('{') && !previous.includes('}');
    const bodyFollows = isEntry && !previous.includes('{') && /^\s*\{/.test(line);
    if (unclosed || bodyFollows) lines[lines.length - 1] = `${previous} ${line.trim()}`;
    else lines.push(line);
  }

  const result = [];
  let kind = null;
  let group = '';
  for (const line of lines) {
    const array = /static readonly Encounter(Gift|Static|Trade)\w*\[\]/.exec(line);
    if (array) {
      kind = array[1].toLowerCase();
      group = '';
      continue;
    }
    const heading = /^\s*(?:\/\/|#region)\s*(.+?)\s*$/.exec(line);
    if (heading && !line.includes('new(')) {
      group = heading[1];
      continue;
    }
    const row = /^\s*new\(([^)]*)\)\s*(?:\{([^}]*)\})?/.exec(line);
    if (kind === null || row === null) continue;
    const numbers = row[1].split(',').map((part) => part.trim());
    const values = Object.fromEntries(args.map((name, i) => [name, Number(numbers[i])]));
    if (!Number.isFinite(values.species)) continue;
    const body = row[2] ?? '';
    const shiny = /Shiny\s*=\s*(?:Shiny\.)?(\w+)/.exec(body)?.[1] ?? defaults[kind] ?? 'Random';
    const level = values.level ?? Number(/Level\s*=\s*(\d+)/.exec(body)?.[1] ?? 0);
    result.push({
      kind,
      species: values.species,
      form: Number.isFinite(values.form) ? values.form : Number(/Form\s*=\s*(\d+)/.exec(body)?.[1] ?? 0),
      level,
      location: Number(/Location\s*=\s*(\d+)/.exec(body)?.[1] ?? 0),
      shinyLocked: shiny === 'Never',
      alpha: /IsAlpha\s*=\s*true/.test(body),
      group,
      body,
    });
  }
  return result;
}

/** Reads the default `Shiny` of a PKHeX encounter template class (`Shiny Shiny { get; init; } = Shiny.Never`). */
export function templateShinyDefault(source) {
  return /Shiny Shiny \{ get; init; \}(?: = Shiny\.(\w+))?/.exec(source)?.[1] ?? 'Random';
}

/**
 * Collects encounter rows per Pokémon, merging duplicates (cosmetic forms
 * produce identical rows) and widening level ranges of otherwise identical rows.
 */
export function createEncounterCollector() {
  const byPokemon = new Map();
  const usedLocations = new Set();
  return {
    add(pokemonId, row) {
      usedLocations.add(row.l);
      let rows = byPokemon.get(pokemonId);
      if (rows === undefined) byPokemon.set(pokemonId, (rows = new Map()));
      const key = JSON.stringify({ ...row, n: undefined, x: undefined });
      const existing = rows.get(key);
      if (existing === undefined) rows.set(key, { ...row });
      else {
        existing.n = Math.min(existing.n, row.n);
        existing.x = Math.max(existing.x, row.x);
      }
    },
    rows(pokemonId) {
      return [...(byPokemon.get(pokemonId)?.values() ?? [])];
    },
    pokemonIds: () => [...byPokemon.keys()],
    usedLocations,
  };
}

/**
 * Writes `src/renderer/data/encounters/<gameId>.json` (BundledEncounterFile,
 * version 2) with one Pokémon per line. `pokemon` is a Map or object of
 * pokemonId → { dex?, dlc?, rows }. Location names are limited to the ids used.
 */
export function writeEncounterFile({ gameId, versions, locationName, pokemon }) {
  const entries = (pokemon instanceof Map ? [...pokemon.entries()] : Object.entries(pokemon))
    .map(([id, value]) => [Number(id), value])
    .sort((a, b) => a[0] - b[0]);
  const used = new Set();
  for (const [, value] of entries) for (const row of value.rows) used.add(row.l);
  const locations = {};
  for (const id of [...used].sort((a, b) => a - b)) {
    const name = id === 0 ? null : locationName(id);
    if (name !== null) locations[id] = name;
  }
  const clean = (value) => {
    const out = {};
    if (value.dex !== undefined && value.dex !== null && value.dex > 0) out.dex = value.dex;
    if (value.dlc) out.dlc = 1;
    out.rows = value.rows;
    return out;
  };
  const header = {
    version: 2,
    gameId,
    updated: new Date().toISOString().slice(0, 10),
    source: PKHEX_SOURCE,
    versions,
    locations,
  };
  const dir = join(DATA_DIR, 'encounters');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${gameId}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(header).slice(0, -1)},"pokemon":{\n` +
      `${entries.map(([id, value]) => `"${id}":${JSON.stringify(clean(value))}`).join(',\n')}\n}}\n`,
  );
  return { file, pokemon: entries.length, locations: Object.keys(locations).length };
}
