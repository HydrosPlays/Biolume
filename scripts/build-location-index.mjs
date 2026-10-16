#!/usr/bin/env node
/**
 * Builds src/renderer/data/locationIndex.json from the PokeAPI CSV dumps: the
 * English display name of every location AREA, keyed by the area slug that
 * PokeAPI's `/pokemon/{id}/encounters` reports (`location_area.name`).
 *
 *   "johto-route-32-area"        → "Route 32"
 *   "sprout-tower-2f"            → "Sprout Tower — 2F"
 *   "mt-coronet-1f-route-207"    → "Mt. Coronet — 1F Route 207"
 *   "hoenn-route-119-weather-institute" → "Route 119 — Weather Institute"
 *
 * PokeAPI builds an area slug as `<location identifier>-<area identifier>`, or
 * `<location identifier>-area` when the area has no identifier (see
 * PokeAPI/pokeapi data/v2/build.py, `_build_locations`). The location part of
 * the name comes from location_names.csv; the area part is the area's English
 * prose (location_area_prose.csv) when it spells the same words as the area
 * identifier — the prose is better punctuated but sometimes uses Japanese-style
 * names ("Road 207") or describes something else entirely — and the
 * title-cased identifier otherwise. Read by src/renderer/api/encounters.ts,
 * which falls back to a title-cased slug for areas missing here.
 *
 * A few names PokeAPI gets wrong are overridden (AREA_NAME_OVERRIDES).
 *
 * The file also carries `shiny`: the shiny rules of the gifts, statics and
 * in-game trades of the games whose locations come from PokeAPI, read from
 * PKHeX's encounter tables (see "Shiny locks" below) because PokeAPI flags
 * only some shiny-locked encounters; and `weathers`: the weathers an area can
 * have, for the Sword / Shield areas that do not have all nine (see "Weathers
 * per area" below).
 *
 * Layout: { version, source, shinySource,
 *           shiny: { <gameId>: { fixed | trade: { <speciesId>: { never?|always?|random?: levels[] } } } },
 *           weathers: { <area slug>: <weather condition values>[] },
 *           areas: { <area slug>: <display name> } }
 *
 * Dependency-free (Node >= 20, global fetch). The output is a pure function of
 * the downloaded files — no timestamps, stable ordering — so re-running it
 * against unchanged upstream data produces a byte-identical file.
 *
 *   node scripts/build-location-index.mjs                 download + write
 *   node scripts/build-location-index.mjs --cache <dir>   reuse files in <dir>, download the missing ones into it
 *   node scripts/build-location-index.mjs --check         build in memory, exit 1 if the file on disk differs
 *   node scripts/build-location-index.mjs --verbose       print every area name and every shiny rule
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/';
const SOURCE_LABEL = 'PokeAPI/pokeapi data/v2/csv';
const CSV_FILES = [
  'locations',
  'location_names',
  'location_areas',
  'location_area_prose',
  'encounters',
  'encounter_condition_value_map',
  'encounter_condition_values',
];

/** Bump together with the decoder in src/renderer/api/encounters.ts when the layout changes. */
const INDEX_VERSION = 2;

/** Every weather PokeAPI knows (Sword / Shield), in the order encounters.ts lists them. */
const WEATHER_VALUES = [
  'weather-normal',
  'weather-overcast',
  'weather-raining',
  'weather-thunderstorm',
  'weather-snowing',
  'weather-snowstorm',
  'weather-sandstorm',
  'weather-intense-sun',
  'weather-fog',
];
const ENGLISH = '9';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'src', 'renderer', 'data', 'locationIndex.json');

// ───────────────────────────── CSV plumbing ─────────────────────────────

/** RFC 4180 parser: quoted fields, doubled quotes, embedded commas / newlines, LF or CRLF. */
function parseCsv(text, fileName) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header || header.length < 2) throw new Error(`${fileName}: missing CSV header`);
  return rows
    .filter((cells) => cells.length > 1 || cells[0] !== '')
    .map((cells, index) => {
      if (cells.length !== header.length) {
        throw new Error(
          `${fileName}: row ${index + 2} has ${cells.length} cells, expected ${header.length}`,
        );
      }
      return Object.fromEntries(header.map((key, column) => [key, cells[column]]));
    });
}

function requireColumns(rows, fileName, columns) {
  const first = rows[0];
  if (!first) throw new Error(`${fileName}: no rows`);
  for (const column of columns) {
    if (!(column in first)) throw new Error(`${fileName}: column "${column}" is missing`);
  }
}

/** The request never produced a usable response (offline, DNS, timeout, 5xx after retries). */
class NetworkError extends Error {}
/** The server answered, but with an error retrying cannot fix (e.g. a renamed file → 404). */
class UpstreamError extends Error {}

async function download(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (response.ok) return await response.text();
      const status = `HTTP ${response.status} ${response.statusText}`.trim();
      if (response.status < 500 && response.status !== 429) {
        throw new UpstreamError(`${url}: ${status}`);
      }
      throw new Error(status);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await new Promise((done) => setTimeout(done, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  const cause = lastError?.cause?.code ?? lastError?.cause?.message ?? lastError?.message;
  throw new NetworkError(`${url}: ${cause ?? 'request failed'}`);
}

/** Downloads `url`, or reads it from `<cacheDir>/<fileName>` (downloading into the cache when missing). */
async function loadText(url, fileName, cacheDir) {
  const cachePath = cacheDir ? join(cacheDir, fileName) : null;
  if (cachePath) {
    try {
      return await readFile(cachePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const text = await download(url);
  if (cachePath) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, text, 'utf8');
  }
  return text;
}

async function loadCsv(name, cacheDir) {
  const fileName = `${name}.csv`;
  return parseCsv(await loadText(`${CSV_BASE_URL}${fileName}`, fileName, cacheDir), fileName);
}

// ───────────────────────────── Naming ─────────────────────────────

/** Curly quotes → plain ones, collapsed whitespace, and the official spelling of "Pokémon". */
function cleanName(name) {
  return name
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\bPokemon\b/g, 'Pokémon')
    .replace(/\bPoke Mart\b/g, 'Poké Mart')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Comparison key: case, accents, punctuation and spacing ignored, and the
 * spellings the prose mixes up unified ("Mount" / "Mt.", "Road" / "Route").
 */
function canon(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, '')
    .replace(/&/g, 'and')
    .replace(/\+/g, 'plus')
    .replace(/\bmount\b/g, 'mt')
    .replace(/\broad\b/g, 'route')
    .replace(/[^a-z0-9]/g, '');
}

const SMALL_WORDS = new Set([
  'of',
  'the',
  'and',
  'in',
  'to',
  'a',
  'an',
  'on',
  'at',
  'for',
  'from',
  'by',
]);

/** Words slugs flatten that title-casing cannot restore. */
const WORD_SPELLINGS = new Map([
  ['mt', 'Mt.'],
  ['ss', 'S.S.'],
  ['pokemon', 'Pokémon'],
  ['poke', 'Poké'],
  ['hq', 'HQ'],
  ['pwt', 'PWT'],
  ['onbs', 'ONBS'],
  ['hauoli', "Hau'oli"],
  ['ulaula', "Ula'ula"],
  ['totems', "Totem's"],
  ['trainers', "Trainers'"],
  ['ns', "N's"],
  ['pokemart', 'Poké Mart'],
  ['pokecenter', 'Pokémon Center'],
]);

/** `1f-route-207` → `1F Route 207`, `b1f-3f` → `B1F–3F`, `bf2` → `B2F`. */
function formatSlugWords(slug) {
  const floors = /^(b?\d+f)-(b?\d+f)$/.exec(slug);
  if (floors) return `${floors[1].toUpperCase()}–${floors[2].toUpperCase()}`;
  return slug
    .split('-')
    .filter((word) => word !== '')
    .map((word, index) => {
      if (/^b?\d+f$/.test(word)) return word.toUpperCase();
      if (/^bf\d+$/.test(word)) return `B${word.slice(2)}F`;
      const spelling = WORD_SPELLINGS.get(word);
      if (spelling) return spelling;
      if (index > 0 && SMALL_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Display names PokeAPI gets wrong. Location 1044 (`thrifty-megamart`, Ula'ula
 * Island) carries the English name "Royal Avenue" — a different place on
 * Akala Island — so its only area would send hunters to the wrong island.
 */
const AREA_NAME_OVERRIDES = new Map([
  ['thrifty-megamart-abandoned-site', 'Abandoned Thrifty Megamart'],
]);

/** Area identifiers with a typo that keeps the (correct) prose from matching. */
const IDENTIFIER_TYPOS = new Map([['groundon-room', 'groudon-room']]);

/** Small words lower-cased inside an area label ("West Of Route 104" → "West of Route 104"). */
const LOWER_IN_LABEL = new Set(['of', 'the', 'and', 'in', 'to', 'on', 'at', 'for', 'from', 'by']);

/** Final touches on an area label taken from prose or a slug. */
function tidyLabel(label) {
  return label
    .split(' ')
    .map((word, index) => {
      if (/^b?\d+f$/i.test(word)) return word.toUpperCase();
      if (index > 0 && LOWER_IN_LABEL.has(word.toLowerCase())) return word.toLowerCase();
      return word;
    })
    .join(' ')
    .replace(/\bteam rocket\b/gi, 'Team Rocket');
}

/** Removes a leading copy of the location name: `Mount Moon Square` in Mt. Moon → `Square`. */
function stripLocationPrefix(label, locationName) {
  const target = canon(locationName);
  const words = label.split(' ');
  for (let count = 1; count < words.length; count += 1) {
    const head = canon(words.slice(0, count).join(' '));
    if (head === target) return words.slice(count).join(' ');
    if (!target.startsWith(head)) break;
  }
  return label;
}

/**
 * The part of an area's name that tells it apart from the rest of its
 * location, or '' when the area is the whole location.
 */
function areaLabel(locationName, rawIdentifier, prose) {
  // `hoenn-route-104-north-oras` only differs from the Gen 3 area by its version tag.
  const identifier = (IDENTIFIER_TYPOS.get(rawIdentifier) ?? rawIdentifier).replace(/-oras$/, '');
  if (identifier === '' || identifier === 'area') return '';
  const key = canon(identifier);
  // Slugs drop the possessive: "Embedded Tower (Kyogre's room)" is `kyogre-room`.
  const matches = (candidate) =>
    canon(candidate) === key || canon(candidate.replace(/['\u2019]s\b/g, '')) === key;
  const bracket = prose ? /^(.*?)\s*\((.+)\)\s*$/.exec(prose) : null;

  let label = null;
  if (prose) {
    const words = prose.split(/\s+/);
    const candidates = [
      ...(bracket ? [bracket[2], bracket[1]] : []),
      prose,
      ...words.slice(1).map((_, index) => words.slice(index + 1).join(' ')),
    ];
    label = candidates.find(matches) ?? null;
  }
  if (label === null && identifier === 'main') {
    // "Slumbering Weald (Entrance)" names the main area better than "main" does.
    label = bracket && canon(bracket[1]) === canon(locationName) ? bracket[2] : '';
  }
  label ??= formatSlugWords(identifier);

  label = cleanName(label).replace(/\bRoad (\d+)/g, 'Route $1');
  label = stripLocationPrefix(label, locationName);
  // The main area of a location is just the location ("Route 8 (Main)" → "Route 8").
  if (['', 'main', 'mainarea', canon(locationName)].includes(canon(label))) return '';
  label = tidyLabel(label);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function buildAreaNames(csv, log) {
  requireColumns(csv.locations, 'locations.csv', ['id', 'identifier']);
  requireColumns(csv.location_names, 'location_names.csv', [
    'location_id',
    'local_language_id',
    'name',
  ]);
  requireColumns(csv.location_areas, 'location_areas.csv', ['id', 'location_id', 'identifier']);
  requireColumns(csv.location_area_prose, 'location_area_prose.csv', [
    'location_area_id',
    'local_language_id',
    'name',
  ]);

  const locations = new Map(csv.locations.map((row) => [row.id, row.identifier]));
  const locationNames = new Map(
    csv.location_names
      .filter((row) => row.local_language_id === ENGLISH && row.name.trim() !== '')
      .map((row) => [row.location_id, cleanName(row.name)]),
  );
  const areaProse = new Map(
    csv.location_area_prose
      .filter((row) => row.local_language_id === ENGLISH && row.name.trim() !== '')
      .map((row) => [row.location_area_id, cleanName(row.name)]),
  );

  const areas = new Map();
  const slugById = new Map();
  let fallbacks = 0;
  for (const row of csv.location_areas) {
    const location = locations.get(row.location_id);
    if (location === undefined) {
      throw new Error(`location_areas.csv: area ${row.id} has unknown location ${row.location_id}`);
    }
    const slug = row.identifier ? `${location}-${row.identifier}` : `${location}-area`;
    if (areas.has(slug)) throw new Error(`location_areas.csv: duplicate area slug "${slug}"`);
    slugById.set(row.id, slug);
    let locationName = locationNames.get(row.location_id);
    if (locationName === undefined) {
      locationName = formatSlugWords(location);
      fallbacks += 1;
    }
    const label = areaLabel(locationName, row.identifier, areaProse.get(row.id) ?? null);
    const name =
      AREA_NAME_OVERRIDES.get(slug) ?? (label ? `${locationName} — ${label}` : locationName);
    areas.set(slug, name);
    log(`  ${slug.padEnd(52)} ${name}`);
  }
  if (areas.size === 0) throw new Error('location_areas.csv: no areas');
  return { areas, slugById, fallbacks };
}

// ───────────────────────────── Weathers per area ─────────────────────────────
//
// Sword / Shield spawns depend on the weather, and not every area has every
// weather: the Isle of Armor never snows, the Crown Tundra never has a
// sandstorm, and its mountain areas never rain. encounters.ts names a
// weather condition against the weathers the area actually has, so a Pokémon
// found in all of them gets no condition and "Any weather except …" never
// lists a weather that cannot happen there. Only areas with a partial set are
// listed; any other area can have all nine.

function buildAreaWeathers(csv, slugById, log) {
  requireColumns(csv.encounters, 'encounters.csv', ['id', 'location_area_id']);
  requireColumns(csv.encounter_condition_value_map, 'encounter_condition_value_map.csv', [
    'encounter_id',
    'encounter_condition_value_id',
  ]);
  requireColumns(csv.encounter_condition_values, 'encounter_condition_values.csv', [
    'id',
    'identifier',
  ]);
  const weatherOfValue = new Map(
    csv.encounter_condition_values
      .filter((row) => row.identifier.startsWith('weather-'))
      .map((row) => [row.id, row.identifier]),
  );
  for (const weather of weatherOfValue.values()) {
    if (!WEATHER_VALUES.includes(weather)) {
      throw new Error(`encounter_condition_values.csv: unknown weather "${weather}"`);
    }
  }
  const areaOfEncounter = new Map(csv.encounters.map((row) => [row.id, row.location_area_id]));
  const sets = new Map();
  for (const row of csv.encounter_condition_value_map) {
    const weather = weatherOfValue.get(row.encounter_condition_value_id);
    if (!weather) continue;
    const slug = slugById.get(areaOfEncounter.get(row.encounter_id));
    if (slug === undefined) {
      throw new Error(
        `encounter_condition_value_map.csv: encounter ${row.encounter_id} has no area`,
      );
    }
    let set = sets.get(slug);
    if (!set) sets.set(slug, (set = new Set()));
    set.add(weather);
  }
  if (sets.size === 0) throw new Error('encounter_condition_value_map.csv: no weather conditions');
  const weathers = new Map();
  for (const slug of [...sets.keys()].sort()) {
    const set = sets.get(slug);
    if (set.size === WEATHER_VALUES.length) continue;
    const list = WEATHER_VALUES.filter((weather) => set.has(weather));
    weathers.set(slug, list);
    log(`  ${slug.padEnd(52)} ${list.map((weather) => weather.slice(8)).join(', ')}`);
  }
  return weathers;
}

// ───────────────────────────── Shiny locks (PKHeX) ─────────────────────────────
//
// PokeAPI flags only some shiny-locked encounters (`pokemon_details.never_shiny`).
// PKHeX's legality data lists every gift, static and in-game trade of every
// game together with its level and `Shiny` rule, so those of the games whose
// locations come from PokeAPI are read from there. Per game, category (`fixed`
// = gift or static, `trade`) and species, the levels of the entries are listed
// under their rule — "never" (shiny-locked, or a fixed non-shiny PID),
// "always", "random" — for every species with at least one non-random entry.
// encounters.ts matches a PokeAPI gift / static / trade row to the entries
// whose level falls in the row's level range and applies their rule when they
// agree. Only these facts are extracted (PKHeX is GPL-3.0).

const PKHEX_DATA_URL =
  'https://raw.githubusercontent.com/kwsch/PKHeX/master/PKHeX.Core/Legality/Encounters/Data/';
const PKHEX_LABEL = 'PKHeX (github.com/kwsch/PKHeX) Encounters*.cs';

/** Biolume game id → PKHeX encounter table holding its gifts, statics and trades. */
const PKHEX_FILES = {
  gsc: 'Gen2/Encounters2',
  rse: 'Gen3/Encounters3RSE',
  frlg: 'Gen3/Encounters3FRLG',
  dppt: 'Gen4/Encounters4DPPt',
  hgss: 'Gen4/Encounters4HGSS',
  bw: 'Gen5/Encounters5BW',
  b2w2: 'Gen5/Encounters5B2W2',
  xy: 'Gen6/Encounters6XY',
  oras: 'Gen6/Encounters6AO',
  sm: 'Gen7/Encounters7SM',
  usum: 'Gen7/Encounters7USUM',
  lgpe: 'Gen7/Encounters7GG',
  swsh: 'Gen8/Encounters8',
};

/**
 * How each PKHeX template class is read: `kind` (`fixed` = gift or static,
 * `trade`), where a positional constructor puts the species and the level when
 * there is no `Species =` / `Level =` initializer, and the `Shiny` rule an
 * entry has when it sets none.
 * Defaults come from PKHeX.Core/Legality/Encounters/Templates/Gen*: e.g.
 * EncounterTrade3 `Shiny => Shiny.FixedValue` (a fixed, non-shiny PID),
 * EncounterTrade6 `Shiny => Shiny.Never`, EncounterTrade7b `Shiny => Shiny.Random`,
 * EncounterStatic6 `Shiny { get; init; }` (Random unless set). EncounterTrade8
 * has two constructors: nicknamed trades (`TradeNames`) are `Never`, the
 * Isle of Armor trades are `Random`.
 */
const PKHEX_CLASSES = {
  EncounterStatic2: { kind: 'fixed', species: 0, level: 1, shiny: 'Random' },
  EncounterTrade2: { kind: 'trade', species: 2, level: 3, shiny: 'Never' },
  EncounterStatic3: { kind: 'fixed', species: 0, level: 1, shiny: 'Random' },
  EncounterTrade3: { kind: 'trade', species: 4, level: 5, shiny: 'FixedValue' },
  EncounterStatic4: { kind: 'fixed', shiny: 'Random' },
  EncounterTrade4PID: { kind: 'trade', species: 4, level: 5, shiny: 'FixedValue' },
  EncounterStatic5: { kind: 'fixed', shiny: 'Random' },
  EncounterStatic5N: { kind: 'fixed', shiny: 'FixedValue' },
  EncounterTrade5BW: { kind: 'trade', shiny: 'Never' },
  EncounterTrade5B2W2: { kind: 'trade', shiny: 'Never' },
  EncounterStatic6: { kind: 'fixed', shiny: 'Random' },
  EncounterTrade6: { kind: 'trade', shiny: 'Never' },
  EncounterStatic7: { kind: 'fixed', shiny: 'Random' },
  EncounterTrade7: { kind: 'trade', shiny: 'Never' },
  EncounterStatic7b: { kind: 'fixed', shiny: 'Random' },
  EncounterTrade7b: { kind: 'trade', shiny: 'Random' },
  EncounterStatic8: { kind: 'fixed', shiny: 'Random' },
  EncounterTrade8: {
    kind: 'trade',
    species: (args) => (args[0] === 'TradeNames' ? 3 : 2),
    level: (args) => (args[0] === 'TradeNames' ? 4 : 3),
    shiny: (args) => (args[0] === 'TradeNames' ? 'Never' : 'Random'),
  },
};

/**
 * Arrays that are not in-game encounters of the game itself and are skipped:
 * Entree Forest (Dream World), My Pokémon Ranch, the Colosseum bonus disc,
 * Pokéwalker courses.
 */
const PKHEX_SKIPPED_CLASSES = new Set([
  'EncounterStatic5Entree',
  'EncounterTrade4RanchGift',
  'EncounterGift3Colo',
  'EncounterStatic4Pokewalker',
]);

/** Removes C# comments and preprocessor lines (`#region`), keeping string and char literals intact. */
function stripCsComments(source) {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '#' && /(^|\n)[ \t]*$/.test(out)) {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < source.length && source[end] !== char && source[end] !== '\n') {
        end += source[end] === '\\' ? 2 : 1;
      }
      out += source.slice(i, end + 1);
      i = end;
    } else if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

const CLOSERS = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket closing the one at `open` (string literals are skipped). */
function matchClose(text, open) {
  const stack = [];
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (char in CLOSERS) {
      stack.push(CLOSERS[char]);
    } else if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) throw new Error(`unbalanced "${char}" at ${i}`);
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`unclosed bracket at ${open}`);
}

/** Splits on commas outside brackets and string literals. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (char in CLOSERS) depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** `new(args) { body }` → its parts. */
function parseNew(text) {
  const open = text.indexOf('(');
  const close = matchClose(text, open);
  const rest = text.slice(close + 1).trim();
  return {
    args: splitTopLevel(text.slice(open + 1, close)),
    body: rest.startsWith('{') ? rest.slice(1, matchClose(rest, 0)) : '',
  };
}

/** Last value assigned to `name` in an object initializer (later `with` overrides win). */
function initializerValue(body, name) {
  let value = null;
  for (const match of body.matchAll(new RegExp(`\\b${name}\\s*=\\s*([^,}\\s]+)`, 'g'))) {
    value = match[1];
  }
  return value;
}

/**
 * Every gift, static and trade of one PKHeX encounter table:
 * `{ kind, species, form, shiny }`.
 */
function parsePkhexEncounters(source, fileName) {
  const text = stripCsComments(source);
  const declaration = /static\s+readonly\s+(Encounter\w+?)(\[\])?\s+(\w+)\s*=\s*/g;

  // Single templates referenced from arrays, e.g. `BaseCosplay with { Form = 1 }`.
  const singles = new Map();
  const arrays = [];
  for (const match of text.matchAll(declaration)) {
    const [whole, className, isArray, name] = match;
    const start = match.index + whole.length;
    if (isArray) {
      if (text[start] === '[') arrays.push({ className, name, start });
    } else if (text.startsWith('new', start)) {
      const open = text.indexOf('(', start);
      let end = matchClose(text, open);
      const after = text.slice(end + 1).trimStart();
      if (after.startsWith('{')) end = matchClose(text, text.indexOf('{', end));
      singles.set(name, { className, ...parseNew(text.slice(start, end + 1)) });
    }
  }

  const result = [];
  for (const { className, name, start } of arrays) {
    if (PKHEX_SKIPPED_CLASSES.has(className)) continue;
    const rule = PKHEX_CLASSES[className];
    if (!rule) throw new Error(`${fileName}: unknown encounter class ${className} (${name})`);
    const body = text.slice(start + 1, matchClose(text, start));
    for (const entry of splitTopLevel(body)) {
      let parsed;
      if (entry.startsWith('..')) continue; // spread of another array, read on its own
      if (/^new\s*\(/.test(entry)) {
        parsed = parseNew(entry);
      } else {
        const reference = /^(\w+)\s*(?:with\s*\{([\s\S]*)\})?$/.exec(entry);
        const single = reference ? singles.get(reference[1]) : undefined;
        if (!single)
          throw new Error(`${fileName}: cannot read entry "${entry.slice(0, 60)}" of ${name}`);
        parsed = { args: single.args, body: `${single.body},${reference[2] ?? ''}` };
      }
      const position =
        typeof rule.species === 'function' ? rule.species(parsed.args) : rule.species;
      const speciesText =
        initializerValue(parsed.body, 'Species') ??
        (position === undefined ? null : parsed.args[position]);
      const species = Number(speciesText);
      if (!Number.isInteger(species) || species <= 0) {
        throw new Error(`${fileName}: no species in "${entry.slice(0, 80)}" of ${name}`);
      }
      const levelAt = typeof rule.level === 'function' ? rule.level(parsed.args) : rule.level;
      const levelText =
        initializerValue(parsed.body, 'Level') ??
        (levelAt === undefined ? null : parsed.args[levelAt]);
      // 0 = unknown level, which matches any PokeAPI level range.
      const level = levelText === null ? 0 : Number(levelText);
      if (!Number.isInteger(level) || level < 0 || level > 100) {
        throw new Error(`${fileName}: bad level in "${entry.slice(0, 80)}" of ${name}`);
      }
      const explicit = initializerValue(parsed.body, 'Shiny')?.replace(/^Shiny\./, '');
      const shiny =
        explicit ?? (typeof rule.shiny === 'function' ? rule.shiny(parsed.args) : rule.shiny);
      result.push({ kind: rule.kind, species, level, shiny });
    }
  }
  if (result.length === 0) throw new Error(`${fileName}: no gifts, statics or trades found`);
  return result;
}

const SHINY_RULES = ['never', 'always', 'random'];

/**
 * `{ fixed: { species: { never?: levels, always?: levels, random?: levels } }, trade: { … } }`
 * for one game, listing only species with at least one non-random entry.
 */
function summariseShiny(encounters) {
  const table = { fixed: new Map(), trade: new Map() };
  for (const { kind, species, level, shiny } of encounters) {
    // A fixed PID (Gen 3–5 trades, N's Pokémon) is a non-shiny one.
    const rule =
      shiny === 'Never' || shiny === 'FixedValue'
        ? 'never'
        : shiny === 'Always'
          ? 'always'
          : 'random';
    let levels = table[kind].get(species);
    if (!levels) table[kind].set(species, (levels = new Map()));
    if (!levels.has(rule)) levels.set(rule, new Set());
    levels.get(rule).add(level);
  }
  const pick = (map) =>
    Object.fromEntries(
      [...map]
        .filter(([, levels]) => levels.has('never') || levels.has('always'))
        .sort((a, b) => a[0] - b[0])
        .map(([species, levels]) => [
          species,
          Object.fromEntries(
            SHINY_RULES.filter((rule) => levels.has(rule)).map((rule) => [
              rule,
              [...levels.get(rule)].sort((a, b) => a - b),
            ]),
          ),
        ]),
    );
  return { fixed: pick(table.fixed), trade: pick(table.trade) };
}

async function buildShinyTable(cacheDir, log) {
  const games = Object.entries(PKHEX_FILES);
  const sources = await Promise.all(
    games.map(([, path]) => {
      const fileName = `${path.split('/').pop()}.cs`;
      return loadText(`${PKHEX_DATA_URL}${path}.cs`, `pkhex-${fileName}`, cacheDir);
    }),
  );
  const table = {};
  games.forEach(([gameId, path], index) => {
    const summary = summariseShiny(parsePkhexEncounters(sources[index], path));
    table[gameId] = summary;
    const list = (map, rule) =>
      Object.entries(map)
        .filter(([, levels]) => levels[rule])
        .map(([species, levels]) => `${species}@${levels[rule].join('/')}`)
        .join(' ');
    for (const rule of ['never', 'always']) {
      log(
        `  ${gameId.padEnd(5)} ${rule}: fixed [${list(summary.fixed, rule)}] trade [${list(summary.trade, rule)}]`,
      );
    }
  });
  return table;
}

// ───────────────────────────── Output ─────────────────────────────

function serialise(areas, shiny, weathers) {
  const shinyLines = Object.entries(shiny).map(
    ([gameId, summary]) => `${JSON.stringify(gameId)}:${JSON.stringify(summary)}`,
  );
  const weatherLines = [...weathers].map(
    ([slug, list]) => `${JSON.stringify(slug)}:${JSON.stringify(list)}`,
  );
  const areaLines = [...areas.keys()]
    .sort()
    .map((slug) => `${JSON.stringify(slug)}:${JSON.stringify(areas.get(slug))}`);
  return (
    `{"version":${INDEX_VERSION},"source":${JSON.stringify(SOURCE_LABEL)},` +
    `"shinySource":${JSON.stringify(PKHEX_LABEL)},"shiny":{\n${shinyLines.join(',\n')}\n},` +
    `"weathers":{\n${weatherLines.join(',\n')}\n},` +
    `"areas":{\n${areaLines.join(',\n')}\n}}\n`
  );
}

// ───────────────────────────── CLI ─────────────────────────────

function parseArgs(argv) {
  const options = { cacheDir: null, check: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--cache') {
      const dir = argv[i + 1];
      if (!dir || dir.startsWith('--')) throw new Error('--cache needs a directory');
      options.cacheDir = resolve(dir);
      i += 1;
    } else {
      throw new Error(`Unknown argument "${arg}" (expected --cache <dir>, --check or --verbose)`);
    }
  }
  return options;
}

async function readIfPresent(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = options.verbose ? (line) => console.log(line) : () => undefined;
  console.log(
    options.cacheDir
      ? `Loading PokeAPI location CSVs and PKHeX encounter tables (cache: ${options.cacheDir})`
      : 'Downloading PokeAPI location CSVs and PKHeX encounter tables',
  );
  const [tables, shiny] = await Promise.all([
    Promise.all(CSV_FILES.map((name) => loadCsv(name, options.cacheDir))),
    buildShinyTable(options.cacheDir, log),
  ]);
  const csv = Object.fromEntries(CSV_FILES.map((name, index) => [name, tables[index]]));
  const { areas, slugById, fallbacks } = buildAreaNames(csv, log);
  const weathers = buildAreaWeathers(csv, slugById, log);
  const json = serialise(areas, shiny, weathers);

  if (options.check) {
    const current = (await readIfPresent(OUT_FILE))?.replace(/\r\n/g, '\n');
    const upToDate = current === json;
    console.log(`${upToDate ? 'up to date' : 'OUT OF DATE'}  ${OUT_FILE}`);
    if (!upToDate) {
      console.error('Location index differs from upstream — run "npm run data:locations".');
      process.exitCode = 1;
    }
    return;
  }

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, json, 'utf8');
  const size = `${(Buffer.byteLength(json) / 1024).toFixed(1)} kB`;
  const locked = Object.values(shiny).reduce(
    (sum, game) =>
      sum +
      [...Object.values(game.fixed), ...Object.values(game.trade)].filter((rules) => rules.never)
        .length,
    0,
  );
  console.log(
    `wrote ${OUT_FILE}  (${size}; ${areas.size} areas` +
      `${fallbacks > 0 ? `, ${fallbacks} without an English location name` : ''}` +
      `; ${weathers.size} areas with only some weathers` +
      `; ${locked} species with shiny-locked gifts / statics / trades across ${Object.keys(shiny).length} games)`,
  );
}

main().catch((error) => {
  if (error instanceof NetworkError) {
    console.error(`Network unavailable — could not download the source data.\n  ${error.message}`);
    console.error('Nothing was written. Re-run when online, or pass --cache <dir> with the files.');
  } else if (error instanceof UpstreamError) {
    console.error(`A data source rejected the request — nothing was written.\n  ${error.message}`);
  } else {
    console.error(`build-location-index failed: ${error?.message ?? error}`);
  }
  process.exitCode = 1;
});
