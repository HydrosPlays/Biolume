#!/usr/bin/env node
/**
 * Builds the bundled Pokémon indexes from the PokeAPI CSV dumps:
 *
 *   src/renderer/data/speciesIndex.json   every species of Gens 1-9 + its huntable varieties
 *   src/renderer/data/moveIndex.json      every move, keyed by slug
 *
 * Dependency-free (Node >= 20, global fetch). The output is a pure function of
 * the CSV contents — no timestamps, stable ordering — so re-running it against
 * unchanged upstream data produces byte-identical files.
 *
 *   node scripts/build-local-data.mjs                 download + write
 *   node scripts/build-local-data.mjs --cache <dir>   reuse CSVs in <dir>, download the missing ones into it
 *   node scripts/build-local-data.mjs --check         build in memory, exit 1 if the files on disk differ
 *   node scripts/build-local-data.mjs --verbose       list every included / excluded variety
 *
 * The short JSON keys are decoded by src/renderer/lib/species.ts and
 * src/renderer/lib/moveset.ts — keep the three in sync.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/';
const SOURCE_LABEL = 'PokeAPI/pokeapi data/v2/csv';
const CSV_FILES = [
  'pokemon_species',
  'pokemon_species_names',
  'pokemon',
  'pokemon_types',
  'types',
  'pokemon_forms',
  'pokemon_form_names',
  'moves',
  'move_names',
  'move_damage_classes',
];

/** Bump together with the decoders when the JSON layout changes. */
const INDEX_VERSION = 1;
const ENGLISH = '9';
const MAX_GENERATION = 9;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'renderer', 'data');
const SPECIES_FILE = join(OUT_DIR, 'speciesIndex.json');
const MOVES_FILE = join(OUT_DIR, 'moveIndex.json');

// ───────────────────────────── Variety curation ─────────────────────────────

/**
 * Varieties that exist in the data but cannot be shiny hunted as such. Checked
 * after the generic rules in {@link exclusionReason} (mega / gmax / totem /
 * primal / eternamax / battle-only).
 */
const EXCLUDED_VARIETIES = [
  [/^pikachu-.+-cap$/, 'cap Pikachu (event distribution)'],
  [/^pikachu-(rock-star|belle|pop-star|phd|libre|cosplay)$/, 'cosplay Pikachu'],
  [/-starter$/, "Let's Go partner (shiny-locked)"],
  [/^(kyurem-(black|white)|necrozma-(dusk|dawn)|calyrex-(ice|shadow))$/, 'fusion'],
  [
    /^(greninja-battle-bond|rockruff-own-tempo|zygarde-(10|50)-power-construct)$/,
    'ability variant with an identical appearance',
  ],
  [/^(koraidon-.+-build|miraidon-.+-mode)$/, 'ride form'],
  [/^minior-/, 'colour variant only revealed in battle'],
  [/^(floette-eternal|magearna-original|zarude-dada)$/, 'event-only gift'],
];

/** Display names where the PokeAPI `pokemon_name` reads awkwardly. */
const NAME_OVERRIDES = new Map([
  ['darmanitan-galar-standard', 'Galarian Darmanitan'],
  ['dudunsparce-three-segment', 'Three-Segment Dudunsparce'],
  ['tatsugiri-droopy', 'Droopy Tatsugiri'],
  ['tatsugiri-stretchy', 'Stretchy Tatsugiri'],
  ['gimmighoul-roaming', 'Roaming Gimmighoul'],
  ['oricorio-pom-pom', 'Pom-Pom Oricorio'],
  ['zygarde-10', 'Zygarde (10% Forme)'],
]);

function exclusionReason(slug, form) {
  if (form?.is_mega === '1' || /-mega(-[a-z])?$/.test(slug)) return 'Mega Evolution';
  if (/-gmax$/.test(slug)) return 'Gigantamax';
  if (/-totem(-|$)/.test(slug)) return 'Totem';
  if (/-primal$/.test(slug)) return 'Primal Reversion';
  if (/-eternamax$/.test(slug)) return 'Eternamax';
  if (form?.is_battle_only === '1') return 'battle-only form';
  for (const [pattern, reason] of EXCLUDED_VARIETIES) {
    if (pattern.test(slug)) return reason;
  }
  return null;
}

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

async function download(name) {
  const url = `${CSV_BASE_URL}${name}.csv`;
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

async function loadCsv(name, cacheDir) {
  const cachePath = cacheDir ? join(cacheDir, `${name}.csv`) : null;
  if (cachePath) {
    try {
      return parseCsv(await readFile(cachePath, 'utf8'), `${name}.csv`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const text = await download(name);
  if (cachePath) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, text, 'utf8');
  }
  return parseCsv(text, `${name}.csv`);
}

// ───────────────────────────── Helpers ─────────────────────────────

/** `Farfetch’d` → `Farfetch'd`: plain apostrophes keep names easy to type, compare and export. */
function cleanName(name) {
  return name
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function toInt(value, label) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number)) throw new Error(`${label}: "${value}" is not an integer`);
  return number;
}

function optionalInt(value) {
  return value === '' || value === undefined ? null : Number.parseInt(value, 10);
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const bucket = groups.get(row[key]);
    if (bucket) bucket.push(row);
    else groups.set(row[key], [row]);
  }
  return groups;
}

const byNumber = (key) => (a, b) => Number(a[key]) - Number(b[key]);

// ───────────────────────────── Species index ─────────────────────────────

function buildSpeciesIndex(csv, log) {
  requireColumns(csv.pokemon_species, 'pokemon_species.csv', ['id', 'identifier', 'generation_id']);
  requireColumns(csv.pokemon, 'pokemon.csv', ['id', 'identifier', 'species_id', 'is_default']);
  requireColumns(csv.pokemon_forms, 'pokemon_forms.csv', [
    'id',
    'pokemon_id',
    'is_default',
    'is_battle_only',
    'is_mega',
  ]);
  requireColumns(csv.pokemon_form_names, 'pokemon_form_names.csv', [
    'pokemon_form_id',
    'local_language_id',
    'form_name',
    'pokemon_name',
  ]);

  const typeSlugs = new Map(csv.types.map((row) => [row.id, row.identifier]));
  const typesByPokemon = groupBy(csv.pokemon_types, 'pokemon_id');
  const typesOf = (pokemonId, slug) => {
    const rows = [...(typesByPokemon.get(pokemonId) ?? [])].sort(byNumber('slot'));
    const types = rows.map((row) => typeSlugs.get(row.type_id));
    if (types.length === 0 || types.some((type) => !type)) {
      throw new Error(`pokemon_types.csv: no usable types for ${slug} (#${pokemonId})`);
    }
    return types;
  };

  const speciesNames = new Map(
    csv.pokemon_species_names
      .filter((row) => row.local_language_id === ENGLISH)
      .map((row) => [row.pokemon_species_id, cleanName(row.name)]),
  );
  const formNames = new Map(
    csv.pokemon_form_names
      .filter((row) => row.local_language_id === ENGLISH)
      .map((row) => [row.pokemon_form_id, row]),
  );
  // The form that represents a variety: its default one, else the lowest id.
  const formsByPokemon = groupBy(csv.pokemon_forms, 'pokemon_id');
  const primaryForm = (pokemonId) => {
    const forms = [...(formsByPokemon.get(pokemonId) ?? [])].sort(byNumber('id'));
    return forms.find((form) => form.is_default === '1') ?? forms[0] ?? null;
  };
  const varietiesBySpecies = groupBy(csv.pokemon, 'species_id');

  const species = [];
  const excluded = [];
  let formCount = 0;

  for (const row of [...csv.pokemon_species].sort(byNumber('id'))) {
    const id = toInt(row.id, 'pokemon_species.id');
    const gen = toInt(row.generation_id, `generation of ${row.identifier}`);
    if (gen > MAX_GENERATION) continue;

    const name = speciesNames.get(row.id);
    if (!name) throw new Error(`pokemon_species_names.csv: no English name for ${row.identifier}`);

    const varieties = [...(varietiesBySpecies.get(row.id) ?? [])].sort(byNumber('id'));
    const base = varieties.find((variety) => variety.is_default === '1');
    if (!base) throw new Error(`pokemon.csv: ${row.identifier} has no default variety`);
    // sprites.ts and species.ts rely on this identity for every base variety.
    if (base.id !== row.id) {
      throw new Error(`pokemon.csv: default variety of ${row.identifier} has id ${base.id}`);
    }

    const forms = [];
    for (const variety of varieties) {
      if (variety === base) continue;
      const form = primaryForm(variety.id);
      const reason = exclusionReason(variety.identifier, form);
      if (reason) {
        excluded.push({ slug: variety.identifier, reason });
        continue;
      }
      const names = form ? formNames.get(form.id) : undefined;
      const label = names?.form_name ? cleanName(names.form_name) : '';
      const fallbackLabel = titleCase(variety.identifier.slice(row.identifier.length + 1));
      const entry = {
        i: toInt(variety.id, 'pokemon.id'),
        s: variety.identifier,
        n:
          NAME_OVERRIDES.get(variety.identifier) ??
          (names?.pokemon_name
            ? cleanName(names.pokemon_name)
            : `${name} (${label || fallbackLabel})`),
        l: label || fallbackLabel,
        t: typesOf(variety.id, variety.identifier),
      };
      forms.push(entry);
      log(`  + ${entry.s.padEnd(34)} ${entry.n}`);
    }

    const entry = {
      i: id,
      s: row.identifier,
      n: name,
      g: gen,
      t: typesOf(base.id, base.identifier),
    };
    // `/pokemon/{slug}` needs the variety slug, which is not always the species slug (deoxys-normal).
    if (base.identifier !== row.identifier) entry.d = base.identifier;
    if (forms.length > 0) {
      const baseLabel = formNames.get(primaryForm(base.id)?.id ?? '')?.form_name;
      if (baseLabel) entry.l = cleanName(baseLabel);
      entry.f = forms;
      formCount += forms.length;
    }
    species.push(entry);
  }

  if (species.length === 0) throw new Error('pokemon_species.csv: no species matched');
  for (const { slug, reason } of excluded) log(`  - ${slug.padEnd(34)} ${reason}`);

  const lines = species.map((entry) => JSON.stringify(entry));
  const json =
    `{"version":${INDEX_VERSION},"source":${JSON.stringify(SOURCE_LABEL)},"species":[\n` +
    `${lines.join(',\n')}\n]}\n`;
  return { json, species: species.length, forms: formCount, excluded: excluded.length };
}

// ───────────────────────────── Move index ─────────────────────────────

/** Order of `classes` in moveIndex.json; `c` indexes into it. */
const DAMAGE_CLASSES = ['status', 'physical', 'special'];

function buildMoveIndex(csv) {
  requireColumns(csv.moves, 'moves.csv', [
    'id',
    'identifier',
    'generation_id',
    'type_id',
    'power',
    'pp',
    'accuracy',
    'priority',
    'damage_class_id',
  ]);

  const typeSlugs = new Map(csv.types.map((row) => [row.id, row.identifier]));
  const classSlugs = new Map(csv.move_damage_classes.map((row) => [row.id, row.identifier]));
  const names = new Map(
    csv.move_names
      .filter((row) => row.local_language_id === ENGLISH)
      .map((row) => [row.move_id, cleanName(row.name)]),
  );

  const lines = [];
  const seen = new Set();
  for (const row of [...csv.moves].sort(byNumber('id'))) {
    const slug = row.identifier;
    if (seen.has(slug)) throw new Error(`moves.csv: duplicate move "${slug}"`);
    seen.add(slug);

    const type = typeSlugs.get(row.type_id);
    if (!type) throw new Error(`moves.csv: ${slug} has unknown type ${row.type_id}`);
    const damageClass = DAMAGE_CLASSES.indexOf(classSlugs.get(row.damage_class_id));
    if (damageClass < 0) throw new Error(`moves.csv: ${slug} has unknown damage class`);

    // Null stats (status moves have no power, sure-hit moves no accuracy) and
    // a priority of 0 are omitted; the decoder restores them.
    const entry = {
      i: toInt(row.id, 'moves.id'),
      n: names.get(row.id) ?? titleCase(slug),
      t: type,
    };
    entry.c = damageClass;
    const power = optionalInt(row.power);
    const accuracy = optionalInt(row.accuracy);
    const pp = optionalInt(row.pp);
    const priority = optionalInt(row.priority) ?? 0;
    if (power !== null) entry.p = power;
    if (accuracy !== null) entry.a = accuracy;
    if (pp !== null) entry.pp = pp;
    if (priority !== 0) entry.pr = priority;
    entry.g = toInt(row.generation_id, `generation of ${slug}`);
    lines.push(`${JSON.stringify(slug)}:${JSON.stringify(entry)}`);
  }
  if (lines.length === 0) throw new Error('moves.csv: no moves');

  const json =
    `{"version":${INDEX_VERSION},"source":${JSON.stringify(SOURCE_LABEL)},` +
    `"classes":${JSON.stringify(DAMAGE_CLASSES)},"moves":{\n${lines.join(',\n')}\n}}\n`;
  return { json, moves: lines.length };
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

const kilobytes = (text) => `${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} kB`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = options.verbose ? (line) => console.log(line) : () => {};

  console.log(
    options.cacheDir
      ? `Reading PokeAPI CSV dumps (cache: ${options.cacheDir})`
      : 'Downloading PokeAPI CSV dumps',
  );
  const tables = await Promise.all(CSV_FILES.map((name) => loadCsv(name, options.cacheDir)));
  const csv = Object.fromEntries(CSV_FILES.map((name, index) => [name, tables[index]]));

  // Build everything in memory first so a failure never leaves one stale file behind.
  const speciesIndex = buildSpeciesIndex(csv, log);
  const moveIndex = buildMoveIndex(csv);

  const outputs = [
    [
      SPECIES_FILE,
      speciesIndex.json,
      `${speciesIndex.species} species, ${speciesIndex.forms} huntable varieties ` +
        `(${speciesIndex.excluded} varieties excluded)`,
    ],
    [MOVES_FILE, moveIndex.json, `${moveIndex.moves} moves`],
  ];

  if (options.check) {
    let stale = false;
    for (const [file, json] of outputs) {
      // Compare modulo line endings so a CRLF checkout does not read as drift.
      const current = (await readIfPresent(file))?.replace(/\r\n/g, '\n');
      const upToDate = current === json;
      stale ||= !upToDate;
      console.log(`${upToDate ? 'up to date' : 'OUT OF DATE'}  ${file}`);
    }
    if (stale) {
      console.error('Bundled data differs from upstream — run "npm run data:build".');
      process.exitCode = 1;
    }
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  for (const [file, json, summary] of outputs) {
    await writeFile(file, json, 'utf8');
    console.log(`wrote ${file}  (${kilobytes(json)}; ${summary})`);
  }
}

main().catch((error) => {
  if (error instanceof NetworkError) {
    console.error(`Network unavailable — could not download the PokeAPI data.\n  ${error.message}`);
    console.error('Nothing was written. Re-run when online, or pass --cache <dir> with the CSVs.');
  } else if (error instanceof UpstreamError) {
    console.error(
      `PokeAPI data source rejected the request — nothing was written.\n  ${error.message}`,
    );
  } else {
    console.error(`build-local-data failed: ${error?.message ?? error}`);
  }
  process.exitCode = 1;
});
