#!/usr/bin/env node
/**
 * Validates the bundled reference data against the contract in
 * `src/renderer/data/schema.ts`:
 *
 *   src/renderer/data/oddsMethods.json   games, hunting methods, SV sandwich tables
 *   src/renderer/data/riskMoves.json     self-faint / recoil / flee move lookup
 *
 * Three layers, all dependency-free (Node >= 20):
 *
 *   1. structure  — required fields, types, no unknown keys;
 *   2. semantics  — unique ids, references between a model and its method's inputs, defaults that
 *                   are real values, sorted tiers, sane odds, sandwich and risk-move invariants;
 *   3. numbers    — every checkpoint is evaluated with the model semantics documented in
 *                   schema.ts and compared with its published "1 in N".
 *
 * Layer 3 is deliberately a second, independent implementation: it shares no code with
 * `src/renderer/lib/odds.ts`, so a checkpoint that passes here and in the app's test-suite has
 * been computed twice. `custom` models name a formula; the ones known here (CUSTOM_FORMULAS,
 * re-implemented from each model's `spec`) are evaluated like any other model, and the checkpoints
 * of a formula this script does not know are reported as "skipped (custom formula <id>)" and
 * never count as failures.
 *
 *   node scripts/validate-data.mjs                 summary, exit 1 on any failure
 *   node scripts/validate-data.mjs --verbose       also list every checkpoint
 *   node scripts/validate-data.mjs --odds <file>   validate a draft instead of oddsMethods.json
 *   node scripts/validate-data.mjs --risk <file>   validate a draft instead of riskMoves.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'src', 'renderer', 'data');

/** Value of a `--name <value>` command-line option, if given. */
function option(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

const ODDS_FILE = resolve(option('--odds') ?? join(DATA_DIR, 'oddsMethods.json'));
const RISK_FILE = resolve(option('--risk') ?? join(DATA_DIR, 'riskMoves.json'));
/** Optional cross-check: when the PokeAPI move index is present, risk-move slugs must exist in it. */
const MOVE_INDEX_FILE = join(DATA_DIR, 'moveIndex.json');

const VERBOSE = process.argv.includes('--verbose');

// ───────────────────────────── Contract constants ─────────────────────────────

const FULL_ODDS_METHOD_ID = 'full-odds';
/** Reserved key: the Shiny Charm lives on the selection, never in a method's inputs. */
const SHINY_CHARM_KEY = 'shinyCharm';
const DEFAULT_TOLERANCE = 0.01;
/** A summary is one line of a dropdown; longer ones only draw a warning. */
const SUMMARY_SOFT_LIMIT = 100;
/** Mixing over chance-gated bonuses enumerates 2^n combinations. */
const MAX_GATED_BONUSES = 16;

const POKEMON_TYPES = [
  'normal',
  'fire',
  'water',
  'electric',
  'grass',
  'ice',
  'fighting',
  'poison',
  'ground',
  'flying',
  'psychic',
  'bug',
  'rock',
  'ghost',
  'dragon',
  'dark',
  'steel',
  'fairy',
];
const HERBA_IDS = ['sweet', 'salty', 'sour', 'bitter', 'spicy'];
const MEAL_POWER_IDS = [
  'sparkling',
  'title',
  'encounter',
  'catching',
  'raid',
  'exp',
  'item-drop',
  'humungo',
  'teensy',
  'egg',
];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTP_URL = /^https?:\/\/\S+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;

// ───────────────────────────── Reporting ─────────────────────────────

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

/**
 * Records an error. Returns false so that a check can `return fail(…)`.
 * @param {string} path @param {string} message @returns {false}
 */
function fail(path, message) {
  errors.push(`${path}: ${message}`);
  return false;
}

/** @param {string} path @param {string} message */
function warn(path, message) {
  warnings.push(`${path}: ${message}`);
}

/** @param {unknown} value */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string')
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  if (typeof value === 'object') return 'an object';
  return String(value);
}

// ───────────────────────────── Structural primitives ─────────────────────────────

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A field check: reports problems under `path` and returns whether the value is usable.
 * @typedef {(value: unknown, path: string) => boolean} Check
 */

/** @type {Check} */
function text(value, path) {
  if (typeof value !== 'string') return fail(path, `must be a string, found ${describe(value)}`);
  if (value.trim() === '') return fail(path, 'must not be empty');
  if (value !== value.trim()) warn(path, 'has leading or trailing whitespace');
  return true;
}

/** A string that may be empty. @type {Check} */
function anyText(value, path) {
  if (typeof value !== 'string') return fail(path, `must be a string, found ${describe(value)}`);
  return true;
}

/** @type {Check} */
function kebab(value, path) {
  if (!text(value, path)) return false;
  if (!KEBAB_CASE.test(/** @type {string} */ (value))) {
    return fail(
      path,
      `${describe(value)} must be kebab-case (lowercase letters, digits, single hyphens)`,
    );
  }
  return true;
}

/** @type {Check} */
function bool(value, path) {
  if (typeof value !== 'boolean')
    return fail(path, `must be true or false, found ${describe(value)}`);
  return true;
}

/** @type {Check} */
function url(value, path) {
  if (typeof value !== 'string' || !HTTP_URL.test(value)) {
    return fail(path, `must be an http(s) URL, found ${describe(value)}`);
  }
  return true;
}

/**
 * @param {{ min?: number, max?: number, integer?: boolean, exclusiveMin?: number }} [bounds]
 * @returns {Check}
 */
function num(bounds = {}) {
  return (value, path) => {
    if (!isNumber(value)) return fail(path, `must be a finite number, found ${describe(value)}`);
    if (bounds.integer && !Number.isInteger(value))
      return fail(path, `must be a whole number, found ${value}`);
    if (bounds.min !== undefined && value < bounds.min)
      return fail(path, `must be at least ${bounds.min}, found ${value}`);
    if (bounds.exclusiveMin !== undefined && value <= bounds.exclusiveMin) {
      return fail(path, `must be greater than ${bounds.exclusiveMin}, found ${value}`);
    }
    if (bounds.max !== undefined && value > bounds.max)
      return fail(path, `must be at most ${bounds.max}, found ${value}`);
    return true;
  };
}

/** @param {readonly unknown[]} allowed @returns {Check} */
function oneOf(allowed) {
  return (value, path) => {
    if (!allowed.includes(value)) {
      return fail(
        path,
        `must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}; found ${describe(value)}`,
      );
    }
    return true;
  };
}

/** @param {Check} check @returns {Check} */
function nullable(check) {
  return (value, path) => value === null || check(value, path);
}

/**
 * @param {Check} item
 * @param {{ nonEmpty?: boolean, label?: (entry: unknown, index: number) => string }} [options]
 * @returns {Check}
 */
function list(item, options = {}) {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, `must be an array, found ${describe(value)}`);
    if (options.nonEmpty && value.length === 0) return fail(path, 'must not be empty');
    let ok = true;
    value.forEach((entry, index) => {
      const key = options.label ? options.label(entry, index) : String(index);
      if (!item(entry, `${path}[${key}]`)) ok = false;
    });
    return ok;
  };
}

/** Names an array item by its `id` (or `slug`) when it has one, so paths stay readable. */
function byId(entry, index) {
  if (isRecord(entry)) {
    if (typeof entry.id === 'string' && entry.id !== '') return entry.id;
    if (typeof entry.slug === 'string' && entry.slug !== '') return entry.slug;
  }
  return String(index);
}

/** @param {Check} valueCheck @returns {Check} */
function record(valueCheck) {
  return (value, path) => {
    if (!isRecord(value)) return fail(path, `must be an object, found ${describe(value)}`);
    let ok = true;
    for (const [key, entry] of Object.entries(value)) {
      if (!valueCheck(entry, `${path}.${key}`)) ok = false;
    }
    return ok;
  };
}

/**
 * A strict object: every `required` key present, nothing beyond `required` + `optional`.
 * An unknown key is almost always a typo that would silently drop a bonus or a charm table.
 * @param {Record<string, Check>} required
 * @param {Record<string, Check>} [optional]
 * @returns {Check}
 */
function object(required, optional = {}) {
  return (value, path) => {
    if (!isRecord(value)) return fail(path, `must be an object, found ${describe(value)}`);
    let ok = true;
    for (const [key, check] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) {
        fail(path, `is missing the required field "${key}"`);
        ok = false;
      } else if (!check(value[key], `${path}.${key}`)) ok = false;
    }
    for (const [key, check] of Object.entries(optional)) {
      if (Object.hasOwn(value, key) && !check(value[key], `${path}.${key}`)) ok = false;
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) {
        fail(path, `has an unknown field "${key}"`);
        ok = false;
      }
    }
    return ok;
  };
}

/**
 * Picks the object shape from a `kind` discriminator.
 * @param {Record<string, Check>} variants
 * @returns {Check}
 */
function union(variants) {
  return (value, path) => {
    if (!isRecord(value)) return fail(path, `must be an object, found ${describe(value)}`);
    const kind = value.kind;
    if (typeof kind !== 'string' || !Object.hasOwn(variants, kind)) {
      return fail(
        `${path}.kind`,
        `must be one of ${Object.keys(variants).join(', ')}; found ${describe(kind)}`,
      );
    }
    return variants[kind](value, path);
  };
}

/** Exact fraction `[numerator, denominator]`: positive whole numbers, at most 1. @type {Check} */
function odds(value, path) {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, `must be a [numerator, denominator] pair, found ${describe(value)}`);
  }
  const [numerator, denominator] = value;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    return fail(
      path,
      `must hold two whole numbers, found [${String(numerator)}, ${String(denominator)}]`,
    );
  }
  if (numerator <= 0 || denominator <= 0)
    return fail(path, `odds ${numerator}/${denominator} must be positive`);
  if (numerator > denominator) return fail(path, `odds ${numerator}/${denominator} exceed 1`);
  return true;
}

// ───────────────────────────── Shapes (mirror of schema.ts) ─────────────────────────────

const rollCount = num({ min: 0 });
const inputBase = { id: text, label: text };
const inputBaseOptional = { description: anyText };

const methodInputShape = union({
  toggle: object({ ...inputBase, kind: oneOf(['toggle']), default: bool }, inputBaseOptional),
  select: object(
    {
      ...inputBase,
      kind: oneOf(['select']),
      options: list(object({ id: text, label: text }, { description: anyText }), {
        nonEmpty: true,
        label: byId,
      }),
      default: text,
    },
    inputBaseOptional,
  ),
  number: object(
    { ...inputBase, kind: oneOf(['number']), min: num(), max: num(), default: num() },
    { ...inputBaseOptional, step: num({ exclusiveMin: 0 }), unit: anyText, chain: bool },
  ),
});

const bonusBase = { label: text };
const bonusOptional = { chance: num({ min: 0, max: 1 }) };

const rollBonusShape = union({
  toggle: object(
    { ...bonusBase, kind: oneOf(['toggle']), input: text, rolls: rollCount },
    bonusOptional,
  ),
  select: object(
    { ...bonusBase, kind: oneOf(['select']), input: text, rolls: record(rollCount) },
    bonusOptional,
  ),
  tiers: object(
    {
      ...bonusBase,
      kind: oneOf(['tiers']),
      input: text,
      tiers: list(object({ min: num(), rolls: rollCount }), { nonEmpty: true }),
    },
    bonusOptional,
  ),
  linear: object(
    { ...bonusBase, kind: oneOf(['linear']), input: text, perUnit: rollCount },
    { ...bonusOptional, maxUnits: num({ min: 0 }) },
  ),
  constant: object({ ...bonusBase, kind: oneOf(['constant']), rolls: rollCount }, bonusOptional),
});

/** `when` values: booleans for toggles and the charm, option ids for selects. @type {Check} */
function whenValue(value, path) {
  if (typeof value !== 'boolean' && typeof value !== 'string') {
    return fail(path, `must be a boolean or an option id, found ${describe(value)}`);
  }
  return true;
}

const oddsModelShape = union({
  rolls: object(
    { kind: oneOf(['rolls']), baseRolls: rollCount, bonuses: list(rollBonusShape) },
    { denominator: num({ min: 1 }) },
  ),
  fixed: object(
    { kind: oneOf(['fixed']), odds },
    { cases: list(object({ when: record(whenValue), odds })) },
  ),
  table: object(
    { kind: oneOf(['table']), input: text, table: list(odds, { nonEmpty: true }) },
    { charmTable: list(odds, { nonEmpty: true }) },
  ),
  custom: object(
    { kind: oneOf(['custom']), formula: kebab, spec: text },
    { params: record(num()) },
  ),
});

/** @type {Check} */
function inputValue(value, path) {
  if (typeof value !== 'boolean' && typeof value !== 'string' && !isNumber(value)) {
    return fail(path, `must be a boolean, a number or a string, found ${describe(value)}`);
  }
  return true;
}

const checkpointShape = object(
  { label: text, shinyCharm: bool, inputs: record(inputValue), oneIn: num({ min: 1 }) },
  { tolerance: num({ exclusiveMin: 0, max: 0.5 }) },
);

const methodShape = object(
  {
    id: kebab,
    name: text,
    summary: text,
    charmApplies: bool,
    inputs: list(methodInputShape, { label: byId }),
    model: oddsModelShape,
    checkpoints: list(checkpointShape),
    sources: list(url),
  },
  { details: anyText, pokemonPerEncounter: num({ min: 1, integer: true }), notes: list(text) },
);

/** @type {Check} */
function nonEmptyArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) return fail(path, 'must be a non-empty array');
  return true;
}

/**
 * A game's own fields. Its methods are only required to be a non-empty array here: each one is
 * validated on its own with {@link methodShape}, so a malformed method does not hide the
 * checkpoint results of its siblings.
 */
const gameShape = object({
  id: kebab,
  name: text,
  shortName: text,
  generation: num({ min: 1, integer: true }),
  platform: text,
  releaseYear: num({ min: 1996, max: 2100, integer: true }),
  baseDenominator: num({ min: 1 }),
  versionGroups: list(kebab, { nonEmpty: true }),
  shinyCharmRolls: nullable(num({ min: 0 })),
  methods: nonEmptyArray,
});

const sandwichItemShape = object({ name: text, quantity: num({ min: 1, integer: true }) });

const sandwichRecipeShape = object(
  {
    id: text,
    type: oneOf(POKEMON_TYPES),
    name: text,
    sparklingLevel: oneOf([0, 1, 2, 3]),
    herbaCount: num({ min: 0, integer: true }),
    herba: (value, path) => {
      if (!record(num({ min: 0, integer: true }))(value, path)) return false;
      let ok = true;
      for (const key of Object.keys(/** @type {object} */ (value))) {
        if (!HERBA_IDS.includes(key)) {
          fail(`${path}.${key}`, `is not a Herba Mystica id (${HERBA_IDS.join(', ')})`);
          ok = false;
        }
      }
      return ok;
    },
    fillings: list(sandwichItemShape),
    condiments: list(sandwichItemShape),
    powers: list(
      object({
        power: oneOf(MEAL_POWER_IDS),
        type: nullable(oneOf(POKEMON_TYPES)),
        level: oneOf([1, 2, 3]),
      }),
    ),
    players: num({ min: 1, integer: true }),
    minimal: bool,
  },
  { notes: text },
);

const sandwichDataShape = object({
  summary: text,
  herba: list(object({ id: oneOf(HERBA_IDS), name: text, source: anyText }), { label: byId }),
  recipes: list(sandwichRecipeShape, { label: byId }),
  notes: list(text),
  sources: list(url),
});

/** @type {Check} */
function isoDate(value, path) {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    return fail(path, `must be an ISO date, found ${describe(value)}`);
  }
  return true;
}

const riskCategoryShape = object({
  id: kebab,
  label: text,
  description: text,
  severity: oneOf(SEVERITIES),
});

const generationBound = num({ min: 1, integer: true });

const riskMoveShape = object(
  { slug: kebab, name: text, category: text, severity: oneOf(SEVERITIES), reason: text },
  {
    detail: text,
    counter: text,
    requiresUserType: oneOf(POKEMON_TYPES),
    minGeneration: generationBound,
    maxGeneration: generationBound,
  },
);

// ───────────────────────────── Helpers ─────────────────────────────

/** @param {readonly string[]} values @returns {string[]} the values that occur more than once */
function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/** Whether `value` sits on the grid `min, min + step, …` (binary noise tolerated). */
function onStepGrid(value, min, step) {
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/** @param {number} oneIn */
function formatOneIn(oneIn) {
  if (!Number.isFinite(oneIn)) return '1 in ∞';
  return `1 in ${Number(oneIn.toFixed(oneIn >= 100 ? 2 : 4))}`;
}

// ───────────────────────────── Model semantics ─────────────────────────────
//
// Written from the documentation alone — nothing here is shared with src/renderer/lib/odds.ts.
// schema.ts, in short:
//   rolls   p = 1 − (1 − 1/D)^rolls, rolls = baseRolls + Σ bonuses (+ game.shinyCharmRolls when
//           the charm applies); a bonus with a `chance` applies with that probability and the
//           result is the mixture over every chance-gated bonus.
//   fixed   the odds of the first case whose `when` matches (reserved key `shinyCharm` = the
//           charm applies), else the model's own odds.
//   table   table[clamp(value, 0, length − 1)], or charmTable when the charm applies.
//   custom  a named formula; CUSTOM_FORMULAS below re-implements the known ones from their `spec`
//           text. An unknown formula id is not evaluated here.

/** Rolls a bonus contributes for the given input values. */
function bonusRolls(bonus, values) {
  switch (bonus.kind) {
    case 'constant':
      return bonus.rolls;
    case 'toggle':
      return values[bonus.input] === true ? bonus.rolls : 0;
    case 'select': {
      const selected = values[bonus.input];
      return typeof selected === 'string' && Object.hasOwn(bonus.rolls, selected)
        ? bonus.rolls[selected]
        : 0;
    }
    case 'tiers': {
      // The highest tier whose `min` ≤ value; none reached → no rolls.
      const value = Number(values[bonus.input]);
      let reached = null;
      for (const tier of bonus.tiers) {
        if (tier.min <= value && (reached === null || tier.min > reached.min)) reached = tier;
      }
      return reached === null ? 0 : reached.rolls;
    }
    case 'linear': {
      const value = Math.max(0, Number(values[bonus.input]));
      return (
        bonus.perUnit * (bonus.maxUnits === undefined ? value : Math.min(value, bonus.maxUnits))
      );
    }
    default:
      throw new Error(`unknown bonus kind "${bonus.kind}"`);
  }
}

function evaluateRolls(game, model, values, charmApplies) {
  const denominator = model.denominator ?? game.baseDenominator;
  const miss = 1 - 1 / denominator;
  let certain = model.baseRolls + (charmApplies ? game.shinyCharmRolls : 0);
  /** @type {{ chance: number, rolls: number }[]} */
  const gated = [];
  for (const bonus of model.bonuses) {
    const rolls = bonusRolls(bonus, values);
    if (rolls === 0) continue;
    const chance = bonus.chance ?? 1;
    if (chance >= 1) certain += rolls;
    else if (chance > 0) gated.push({ chance, rolls });
  }
  if (gated.length > MAX_GATED_BONUSES)
    throw new Error(`${gated.length} chance-gated bonuses are active at once`);

  // Mixture over every on/off combination of the chance-gated bonuses, written out in full.
  let probability = 0;
  for (let mask = 0; mask < 2 ** gated.length; mask++) {
    let weight = 1;
    let rolls = certain;
    for (let index = 0; index < gated.length; index++) {
      const bonus = gated[index];
      if (mask & (1 << index)) {
        weight *= bonus.chance;
        rolls += bonus.rolls;
      } else {
        weight *= 1 - bonus.chance;
      }
    }
    probability += weight * (1 - miss ** rolls);
  }
  return probability;
}

function evaluateFixed(model, values, charmApplies) {
  for (const entry of model.cases ?? []) {
    const matches = Object.entries(entry.when).every(([key, required]) =>
      key === SHINY_CHARM_KEY ? charmApplies === required : values[key] === required,
    );
    if (matches) return entry.odds[0] / entry.odds[1];
  }
  return model.odds[0] / model.odds[1];
}

function evaluateTable(model, values, charmApplies) {
  const table = charmApplies && model.charmTable ? model.charmTable : model.table;
  const index = Math.min(Math.max(Math.round(Number(values[model.input])), 0), table.length - 1);
  return table[index][0] / table[index][1];
}

/** P(at least one of `rolls` independent 1/denominator rolls hits). */
function anyRoll(rolls, denominator) {
  return 1 - Math.pow((denominator - 1) / denominator, rolls);
}

/**
 * Custom formulas, written from the `spec` pseudo-code on each model (independently of
 * src/renderer/lib/oddsFormulas.ts). Signature: (game, model, values, charmApplies) → probability.
 */
const CUSTOM_FORMULAS = {
  'oras-dexnav'(_game, model, values, charmApplies) {
    const searchLevel = Number(values.searchLevel);
    const c = Number(values.chain) % 100;
    let target;
    if (searchLevel > 200) target = searchLevel + 600;
    else if (searchLevel > 100) target = 2 * searchLevel + 400;
    else target = 6 * searchLevel;
    const pCheck = Math.ceil(target / 100) / 10000;
    let n = 1;
    if (charmApplies) n += 2;
    if (c === 49) n += 5;
    else if (c === 99) n += 10;
    const forced = (k) => 1 - Math.pow(1 - pCheck, k);
    const pForced =
      c > 0 && (c + 1) % 5 === 0 ? forced(n + 4) : 0.04 * forced(n + 4) + 0.96 * forced(n);
    const pNatural = 1 - Math.pow(4095 / 4096, charmApplies ? 3 : 1);
    return pForced + (1 - pForced) * pNatural;
  },

  'swsh-brilliant-fishing'(_game, model, values, charmApplies) {
    const D = model.params.denominator;
    const defeated = Number(values.defeated);
    const chain = Number(values.chain);
    let brilliantPermille = 0;
    let bonusRolls = 0;
    if (defeated >= 500) [brilliantPermille, bonusRolls] = [30, 6];
    else if (defeated >= 300) [brilliantPermille, bonusRolls] = [30, 5];
    else if (defeated >= 200) [brilliantPermille, bonusRolls] = [30, 4];
    else if (defeated >= 100) [brilliantPermille, bonusRolls] = [30, 3];
    else if (defeated >= 50) [brilliantPermille, bonusRolls] = [25, 2];
    else if (defeated >= 20) [brilliantPermille, bonusRolls] = [20, 1];
    else if (defeated >= 1) [brilliantPermille, bonusRolls] = [15, 1];
    const chainPermille =
      chain >= 25 ? 250 : chain >= 15 ? 100 : chain >= 7 ? 50 : chain >= 3 ? 20 : 0;
    const brilliantChance = defeated >= 1 ? (brilliantPermille + chainPermille) / 1000 : 0;
    const baseRolls = 1 + (charmApplies ? model.params.charmRolls : 0);
    return (
      (1 - brilliantChance) * anyRoll(baseRolls, D) +
      brilliantChance * anyRoll(baseRolls + bonusRolls, D)
    );
  },

  'sv-event-outbreak'(game, model, values, charmApplies) {
    const defeated = Number(values.defeated);
    const outbreakRolls = defeated >= 60 ? 2 : defeated >= 30 ? 1 : 0;
    const sparklingRolls = { none: 0, lv1: 1, lv2: 2, lv3: 3 }[values.sparkling] ?? 0;
    const rolls = 1 + outbreakRolls + sparklingRolls + (charmApplies ? game.shinyCharmRolls : 0);
    const eventChance = model.params.eventChance;
    return eventChance + (1 - eventChance) * anyRoll(rolls, game.baseDenominator);
  },
};

/**
 * Probability that one Pokémon is Shiny, or null for a `custom` model whose formula is unknown.
 * @param {object} game @param {object} method
 * @param {Record<string, unknown>} given input values; missing ones take the input's default
 * @param {boolean} shinyCharm whether the hunter has the charm switched on
 */
function evaluateMethod(game, method, given, shinyCharm) {
  const values = {};
  for (const input of method.inputs) {
    values[input.id] = Object.hasOwn(given, input.id) ? given[input.id] : input.default;
  }
  const charmApplies = shinyCharm && method.charmApplies && game.shinyCharmRolls !== null;
  const model = method.model;
  switch (model.kind) {
    case 'rolls':
      return evaluateRolls(game, model, values, charmApplies);
    case 'fixed':
      return evaluateFixed(model, values, charmApplies);
    case 'table':
      return evaluateTable(model, values, charmApplies);
    case 'custom':
      return Object.hasOwn(CUSTOM_FORMULAS, model.formula)
        ? CUSTOM_FORMULAS[model.formula](game, model, values, charmApplies)
        : null;
    default:
      return null;
  }
}

// ───────────────────────────── Odds data: semantic checks ─────────────────────────────

/** A declared input of `kind`, reporting a missing or wrongly typed reference. */
function requireInput(method, id, kind, path) {
  const input = method.inputs.find((entry) => entry.id === id);
  if (!input) {
    fail(path, `references input "${id}", which the method does not declare`);
    return null;
  }
  if (input.kind !== kind) {
    fail(path, `needs a ${kind} input, but "${id}" is a ${input.kind} input`);
    return null;
  }
  return input;
}

function checkInputs(method, path) {
  for (const id of duplicates(method.inputs.map((input) => input.id))) {
    fail(`${path}.inputs`, `duplicate input id "${id}"`);
  }
  const chainFlagged = method.inputs.filter(
    (input) => input.kind === 'number' && input.chain === true,
  );
  if (chainFlagged.length > 1) {
    fail(
      `${path}.inputs`,
      `only one input can be the chain, but ${chainFlagged.map((input) => `"${input.id}"`).join(' and ')} are flagged chain: true`,
    );
  }

  for (const input of method.inputs) {
    const inputPath = `${path}.inputs[${input.id}]`;
    if (input.id === SHINY_CHARM_KEY) {
      fail(
        inputPath,
        `"${SHINY_CHARM_KEY}" is reserved — the charm is part of the selection, not a method input`,
      );
    }
    if (input.kind === 'select') {
      const optionIds = input.options.map((option) => option.id);
      for (const id of duplicates(optionIds))
        fail(`${inputPath}.options`, `duplicate option id "${id}"`);
      if (!optionIds.includes(input.default)) {
        fail(
          `${inputPath}.default`,
          `"${input.default}" is not one of the options (${optionIds.join(', ')})`,
        );
      }
    } else if (input.kind === 'number') {
      const step = input.step ?? 1;
      if (input.min > input.max) {
        fail(inputPath, `min (${input.min}) is greater than max (${input.max})`);
      } else if (input.default < input.min || input.default > input.max) {
        fail(`${inputPath}.default`, `${input.default} is outside ${input.min}–${input.max}`);
      } else if (!onStepGrid(input.default, input.min, step)) {
        fail(
          `${inputPath}.default`,
          `${input.default} is not on the step grid (min ${input.min}, step ${step})`,
        );
      }
      if (input.id === 'chain' && input.chain !== true) {
        fail(inputPath, 'an input named "chain" must be flagged chain: true');
      }
    }
  }
}

function checkBonus(method, bonus, path) {
  switch (bonus.kind) {
    case 'constant':
      return;
    case 'toggle':
      requireInput(method, bonus.input, 'toggle', path);
      return;
    case 'select': {
      const input = requireInput(method, bonus.input, 'select', path);
      if (!input) return;
      const optionIds = input.options.map((option) => option.id);
      for (const key of Object.keys(bonus.rolls)) {
        if (!optionIds.includes(key))
          fail(`${path}.rolls.${key}`, `"${key}" is not an option of the "${input.id}" input`);
      }
      return;
    }
    case 'tiers': {
      requireInput(method, bonus.input, 'number', path);
      for (let index = 1; index < bonus.tiers.length; index++) {
        if (bonus.tiers[index].min <= bonus.tiers[index - 1].min) {
          fail(
            `${path}.tiers[${index}]`,
            `tiers must be sorted by ascending min (${bonus.tiers[index].min} follows ${bonus.tiers[index - 1].min})`,
          );
        }
      }
      return;
    }
    case 'linear':
      requireInput(method, bonus.input, 'number', path);
      return;
  }
}

function checkModel(game, method, path) {
  const model = method.model;
  // Why the Shiny Charm can never take effect for this method, if it cannot.
  const charmBlocked =
    game.shinyCharmRolls === null
      ? `${game.shortName} has no Shiny Charm (shinyCharmRolls is null)`
      : method.charmApplies
        ? null
        : 'the method sets charmApplies: false';

  switch (model.kind) {
    case 'rolls':
      model.bonuses.forEach((bonus, index) =>
        checkBonus(method, bonus, `${path}.bonuses[${index}]`),
      );
      return;

    case 'fixed':
      (model.cases ?? []).forEach((entry, index) => {
        const casePath = `${path}.cases[${index}]`;
        const keys = Object.keys(entry.when);
        if (keys.length === 0)
          fail(
            `${casePath}.when`,
            "is empty and would match everything — use the model's own odds instead",
          );
        for (const key of keys) {
          const required = entry.when[key];
          const whenPath = `${casePath}.when.${key}`;
          if (key === SHINY_CHARM_KEY) {
            if (typeof required !== 'boolean') fail(whenPath, 'must be true or false');
            else if (required && charmBlocked) fail(whenPath, `can never match: ${charmBlocked}`);
            continue;
          }
          const input = method.inputs.find((candidate) => candidate.id === key);
          if (!input) {
            fail(whenPath, `references input "${key}", which the method does not declare`);
          } else if (input.kind === 'toggle') {
            if (typeof required !== 'boolean')
              fail(whenPath, `"${key}" is a toggle, so the value must be true or false`);
          } else if (input.kind === 'select') {
            if (!input.options.some((option) => option.id === required)) {
              fail(whenPath, `${JSON.stringify(required)} is not an option of the "${key}" input`);
            }
          } else {
            fail(
              whenPath,
              `cases can only branch on toggle or select inputs, and "${key}" is a number input`,
            );
          }
        }
      });
      return;

    case 'table': {
      const input = requireInput(method, model.input, 'number', `${path}.input`);
      if (input && input.min < 0)
        fail(
          `${path}.input`,
          `"${input.id}" can go below 0 (min ${input.min}), which is not a table index`,
        );
      if (model.charmTable && charmBlocked)
        fail(`${path}.charmTable`, `is never used: ${charmBlocked}`);
      return;
    }

    case 'custom':
      return;
  }
}

/** Checks a checkpoint's inputs; returns whether it can be evaluated as written. */
function checkCheckpointInputs(method, checkpoint, path) {
  let ok = true;
  const bad = (valuePath, message) => {
    fail(valuePath, message);
    ok = false;
  };
  for (const [key, value] of Object.entries(checkpoint.inputs)) {
    const valuePath = `${path}.inputs.${key}`;
    const input = method.inputs.find((candidate) => candidate.id === key);
    if (!input) {
      bad(valuePath, `sets input "${key}", which the method does not declare`);
    } else if (input.kind === 'toggle') {
      if (typeof value !== 'boolean') bad(valuePath, 'a toggle input needs true or false');
    } else if (input.kind === 'select') {
      if (!input.options.some((option) => option.id === value)) {
        bad(valuePath, `${JSON.stringify(value)} is not an option of the "${key}" input`);
      }
    } else if (typeof value !== 'number') {
      bad(valuePath, 'a number input needs a number');
    } else if (
      value < input.min ||
      value > input.max ||
      !onStepGrid(value, input.min, input.step ?? 1)
    ) {
      // The app would silently evaluate a different value than the checkpoint states.
      bad(
        valuePath,
        `${value} is not a value the input can take (min ${input.min}, max ${input.max}, step ${input.step ?? 1})`,
      );
    }
  }
  return ok;
}

/**
 * @typedef {{ passed: number, failed: number, skipped: number }} Tally
 * @typedef {{ id: string, formula: string, checkpoints: number }} SkippedMethod
 */

/**
 * Semantic checks and checkpoint evaluation for one structurally sound method.
 * @param {Tally} tally @param {SkippedMethod[]} skippedMethods @param {string[]} log
 */
function checkMethod(game, method, path, tally, skippedMethods, log) {
  const id = `${game.id}/${method.id}`;
  const before = errors.length;

  if (/[\r\n]/.test(method.summary)) fail(`${path}.summary`, 'must be a single line');
  else if (method.summary.length > SUMMARY_SOFT_LIMIT) {
    warn(
      `${path}.summary`,
      `is ${method.summary.length} characters — long for one line of a dropdown`,
    );
  }
  if (method.charmApplies && game.shinyCharmRolls === null) {
    fail(
      `${path}.charmApplies`,
      `is true, but ${game.shortName} has no Shiny Charm (shinyCharmRolls is null)`,
    );
  }
  for (const source of duplicates(method.sources)) warn(`${path}.sources`, `lists ${source} twice`);

  checkInputs(method, path);
  checkModel(game, method, `${path}.model`);
  const sound = errors.length === before;

  if (method.model.kind === 'custom') {
    if (method.id === FULL_ODDS_METHOD_ID)
      fail(
        `${path}.model`,
        `"${FULL_ODDS_METHOD_ID}" must be a declarative model, not a custom formula`,
      );
  }
  if (method.model.kind === 'custom' && !Object.hasOwn(CUSTOM_FORMULAS, method.model.formula)) {
    method.checkpoints.forEach((checkpoint, index) => {
      checkCheckpointInputs(method, checkpoint, `${path}.checkpoints[${index}]`);
      log.push(
        `  skip  ${id} — ${checkpoint.label}: skipped (custom formula ${method.model.formula})`,
      );
    });
    tally.skipped += method.checkpoints.length;
    skippedMethods.push({
      id,
      formula: method.model.formula,
      checkpoints: method.checkpoints.length,
    });
    return;
  }
  if (method.checkpoints.length === 0) warn(path, 'has no checkpoint pinning its numbers');
  if (!sound) {
    // The model cannot be trusted to evaluate; its checkpoints count as failed, not as passed.
    tally.failed += method.checkpoints.length;
    return;
  }

  /** "1 in N" for the given inputs; reports (and returns null) when the model cannot be evaluated. */
  const oneIn = (inputs, shinyCharm, where) => {
    try {
      const probability = evaluateMethod(game, method, inputs, shinyCharm);
      return probability > 0 ? 1 / probability : Infinity;
    } catch (error) {
      fail(where, `could not be evaluated: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  };

  if (method.id === FULL_ODDS_METHOD_ID) {
    // A brand-new hunt lands here with default inputs and no charm: that must be plain base odds.
    const base = oneIn({}, false, path);
    if (
      base !== null &&
      Math.abs(base - game.baseDenominator) / game.baseDenominator > DEFAULT_TOLERANCE
    ) {
      fail(
        path,
        `at its default inputs gives ${formatOneIn(base)}, not the game's base odds of 1 in ${game.baseDenominator}`,
      );
    }
  }

  method.checkpoints.forEach((checkpoint, index) => {
    const checkpointPath = `${path}.checkpoints[${index}]`;
    if (!checkCheckpointInputs(method, checkpoint, checkpointPath)) {
      tally.failed++;
      return;
    }
    const computed = oneIn(checkpoint.inputs, checkpoint.shinyCharm, checkpointPath);
    if (computed === null) {
      tally.failed++;
      return;
    }
    const tolerance = checkpoint.tolerance ?? DEFAULT_TOLERANCE;
    const relativeError = Math.abs(computed - checkpoint.oneIn) / checkpoint.oneIn;
    const verdict = `expected ${formatOneIn(checkpoint.oneIn)}, computed ${formatOneIn(computed)}`;
    if (relativeError <= tolerance) {
      tally.passed++;
      log.push(`  ok    ${id} — ${checkpoint.label}: ${verdict}`);
    } else {
      tally.failed++;
      log.push(`  FAIL  ${id} — ${checkpoint.label}: ${verdict}`);
      fail(
        checkpointPath,
        `"${checkpoint.label}" ${verdict} — off by ${(relativeError * 100).toFixed(2)}% (tolerance ${(tolerance * 100).toFixed(2)}%)`,
      );
    }
  });
}

function checkSandwiches(sandwiches) {
  const path = 'sandwiches';
  for (const id of duplicates(sandwiches.herba.map((herba) => herba.id)))
    fail(`${path}.herba`, `duplicate herba id "${id}"`);
  for (const id of duplicates(sandwiches.recipes.map((recipe) => recipe.id)))
    fail(`${path}.recipes`, `duplicate recipe id "${id}"`);
  for (const source of duplicates(sandwiches.sources))
    warn(`${path}.sources`, `lists ${source} twice`);
  const herbaNames = new Map(sandwiches.herba.map((herba) => [herba.id, herba.name]));

  for (const recipe of sandwiches.recipes) {
    const recipePath = `${path}.recipes[${recipe.id}]`;

    const listed = Object.values(recipe.herba).reduce((total, count) => total + count, 0);
    if (listed !== recipe.herbaCount) {
      fail(
        `${recipePath}.herbaCount`,
        `is ${recipe.herbaCount}, but the herba map adds up to ${listed}`,
      );
    }
    // "Condiments, including the Herba Mystica entries."
    for (const [herbaId, count] of Object.entries(recipe.herba)) {
      if (count === 0) continue;
      const name = herbaNames.get(herbaId);
      if (name === undefined) {
        fail(
          `${recipePath}.herba.${herbaId}`,
          'is used here but not described in sandwiches.herba',
        );
        continue;
      }
      const condiment = recipe.condiments.find((item) => item.name === name);
      if (!condiment)
        fail(`${recipePath}.condiments`, `must list "${name}" ×${count} (the herba map uses it)`);
      else if (condiment.quantity !== count) {
        fail(
          `${recipePath}.condiments`,
          `lists "${name}" ×${condiment.quantity}, but the herba map says ${count}`,
        );
      }
    }
    for (const item of recipe.condiments) {
      const herbaId = [...herbaNames].find(([, name]) => name === item.name)?.[0];
      if (herbaId !== undefined && !(recipe.herba[herbaId] > 0)) {
        fail(
          `${recipePath}.herba`,
          `is missing "${herbaId}", although the condiments list "${item.name}"`,
        );
      }
    }
    for (const group of ['fillings', 'condiments']) {
      for (const name of duplicates(recipe[group].map((item) => item.name))) {
        fail(`${recipePath}.${group}`, `lists "${name}" twice — merge the quantities`);
      }
    }
    if (recipe.fillings.length === 0)
      fail(`${recipePath}.fillings`, 'a sandwich needs at least one filling');
    if (recipe.condiments.length === 0)
      fail(`${recipePath}.condiments`, 'a sandwich needs at least one condiment');

    // sparklingLevel restates the Sparkling Power among `powers`.
    const sparkling = recipe.powers.filter((power) => power.power === 'sparkling');
    if (recipe.sparklingLevel === 0) {
      if (sparkling.length > 0)
        fail(`${recipePath}.sparklingLevel`, 'is 0, but the powers include Sparkling Power');
    } else if (
      !sparkling.some(
        (power) => power.level === recipe.sparklingLevel && power.type === recipe.type,
      )
    ) {
      fail(
        `${recipePath}.powers`,
        `must include Sparkling Power: ${recipe.type} Lv. ${recipe.sparklingLevel} to match sparklingLevel`,
      );
    }
    if (!recipe.powers.some((power) => power.type === recipe.type)) {
      fail(
        `${recipePath}.powers`,
        `none of the powers is ${recipe.type}-type, the type this recipe targets`,
      );
    }
    for (const power of recipe.powers) {
      if (power.power === 'egg' ? power.type !== null : power.type === null) {
        fail(
          `${recipePath}.powers`,
          `${power.power} power ${power.power === 'egg' ? 'is untyped (type must be null)' : 'needs a type'}`,
        );
      }
    }
  }

  // "minimal": the fewest Herba for its type at its sparkling level.
  const groups = new Map();
  for (const recipe of sandwiches.recipes) {
    const key = `${recipe.type} / Sparkling Lv. ${recipe.sparklingLevel}`;
    groups.set(key, [...(groups.get(key) ?? []), recipe]);
  }
  for (const [key, recipes] of groups) {
    const fewest = Math.min(...recipes.map((recipe) => recipe.herbaCount));
    for (const recipe of recipes) {
      if (recipe.minimal && recipe.herbaCount > fewest) {
        fail(
          `${path}.recipes[${recipe.id}].minimal`,
          `is true, but another ${key} recipe needs only ${fewest} Herba Mystica`,
        );
      }
    }
    if (!recipes.some((recipe) => recipe.minimal))
      warn(`${path}.recipes`, `no ${key} recipe is flagged minimal`);
  }

  const covered = new Set(
    sandwiches.recipes.filter((recipe) => recipe.sparklingLevel === 3).map((recipe) => recipe.type),
  );
  const missing = POKEMON_TYPES.filter((type) => !covered.has(type));
  if (missing.length > 0)
    fail(`${path}.recipes`, `no Sparkling Power Lv. 3 recipe for: ${missing.join(', ')}`);
  return { covered: covered.size };
}

/**
 * @returns {{
 *   data: any, tally: Tally, skippedMethods: SkippedMethod[], log: string[],
 *   rows: { game: any, methods: number, tally: Tally }[], sparklingTypes: number,
 * } | null}
 */
function validateOddsData(json) {
  const tally = { passed: 0, failed: 0, skipped: 0 };
  /** @type {SkippedMethod[]} */
  const skippedMethods = [];
  /** @type {string[]} */
  const log = [];
  const rows = [];
  let sparklingTypes = 0;

  const top = object({
    version: num({ min: 0, integer: true }),
    updated: isoDate,
    // Only the containers here: games, methods and the sandwich block are validated one by one
    // below, so that a problem in one does not hide the results of the others.
    games: (value, path) =>
      Array.isArray(value) || fail(path, `must be an array, found ${describe(value)}`),
    sandwiches: (value, path) =>
      isRecord(value) || fail(path, `must be an object, found ${describe(value)}`),
  });
  if (!top(json, '(root)')) return null;
  if (json.games.length === 0) fail('games', 'must not be empty');

  const gameIds = json.games
    .map((game) => (isRecord(game) ? game.id : undefined))
    .filter((id) => typeof id === 'string');
  for (const id of duplicates(gameIds)) fail('games', `duplicate game id "${id}"`);

  let previous = null;
  json.games.forEach((game, index) => {
    const gamePath = `games[${byId(game, index)}]`;
    const gameTally = { passed: 0, failed: 0, skipped: 0 };
    if (!gameShape(game, gamePath)) {
      // Without sound game fields (denominator, charm rolls) nothing can be evaluated; still
      // report what is wrong inside its methods.
      const broken = isRecord(game) && Array.isArray(game.methods) ? game.methods : [];
      broken.forEach((method, methodIndex) =>
        methodShape(method, `${gamePath}.methods[${byId(method, methodIndex)}]`),
      );
      return;
    }
    const methods = game.methods;

    if (game.generation <= 5 ? game.baseDenominator !== 8192 : game.baseDenominator !== 4096) {
      fail(
        `${gamePath}.baseDenominator`,
        `is ${game.baseDenominator}; one Shiny roll is 1/8192 through Gen 5 and 1/4096 from Gen 6`,
      );
    }
    for (const slug of duplicates(game.versionGroups))
      fail(`${gamePath}.versionGroups`, `lists "${slug}" twice`);
    if (
      previous &&
      (game.releaseYear < previous.releaseYear || game.generation < previous.generation)
    ) {
      fail(
        gamePath,
        `is out of release order: ${game.name} (Gen ${game.generation}, ${game.releaseYear}) follows ${previous.name} (Gen ${previous.generation}, ${previous.releaseYear})`,
      );
    }
    previous = game;

    const first = methods[0];
    if (!isRecord(first) || first.id !== FULL_ODDS_METHOD_ID) {
      fail(
        `${gamePath}.methods[0]`,
        `the first method must be "${FULL_ODDS_METHOD_ID}", found ${describe(isRecord(first) ? first.id : first)}`,
      );
    }
    const methodIds = methods
      .map((method) => (isRecord(method) ? method.id : undefined))
      .filter((id) => typeof id === 'string');
    for (const id of duplicates(methodIds))
      fail(`${gamePath}.methods`, `duplicate method id "${id}"`);

    methods.forEach((method, methodIndex) => {
      const methodPath = `${gamePath}.methods[${byId(method, methodIndex)}]`;
      if (methodShape(method, methodPath))
        checkMethod(game, method, methodPath, gameTally, skippedMethods, log);
      else if (isRecord(method) && Array.isArray(method.checkpoints))
        gameTally.failed += method.checkpoints.length;
    });

    rows.push({ game, methods: methods.length, tally: gameTally });
    tally.passed += gameTally.passed;
    tally.failed += gameTally.failed;
    tally.skipped += gameTally.skipped;
  });

  if (sandwichDataShape(json.sandwiches, 'sandwiches'))
    sparklingTypes = checkSandwiches(json.sandwiches).covered;

  return { data: json, tally, skippedMethods, log, rows, sparklingTypes };
}

// ───────────────────────────── Risk moves ─────────────────────────────

/** Inclusive generation range of a risk entry. */
function generationRange(move) {
  return [move.minGeneration ?? 1, move.maxGeneration ?? Infinity];
}

function validateRiskData(json, moveIndex) {
  const top = object({
    version: num({ min: 0, integer: true }),
    updated: isoDate,
    categories: list(riskCategoryShape, { nonEmpty: true, label: byId }),
    moves: list(riskMoveShape, { nonEmpty: true, label: byId }),
    sources: list(url),
  });
  if (!top(json, '(root)')) return null;

  for (const id of duplicates(json.categories.map((category) => category.id))) {
    fail('categories', `duplicate category id "${id}"`);
  }
  for (const source of duplicates(json.sources)) warn('sources', `lists ${source} twice`);
  const categoryIds = new Set(json.categories.map((category) => category.id));
  const used = new Set();

  /** @type {Map<string, any[]>} */
  const bySlug = new Map();
  for (const move of json.moves) {
    const path = `moves[${move.slug}]`;
    used.add(move.category);
    if (!categoryIds.has(move.category)) {
      fail(
        `${path}.category`,
        `"${move.category}" is not a declared category (${[...categoryIds].join(', ')})`,
      );
    }
    const [from, to] = generationRange(move);
    if (from > to) fail(path, `minGeneration (${from}) is greater than maxGeneration (${to})`);
    if (moveIndex) {
      const known = moveIndex[move.slug];
      if (!known) fail(`${path}.slug`, 'is not a PokeAPI move slug (not found in moveIndex.json)');
      else if (typeof known.n === 'string' && known.n !== move.name) {
        warn(`${path}.name`, `is "${move.name}", but moveIndex.json calls the move "${known.n}"`);
      }
    }
    bySlug.set(move.slug, [...(bySlug.get(move.slug) ?? []), move]);
  }

  // A slug may be listed again only for a different situation: another required type, or a
  // generation range that does not overlap. Anything else is a duplicate.
  for (const [slug, entries] of bySlug) {
    for (let a = 0; a < entries.length; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        if ((entries[a].requiresUserType ?? null) !== (entries[b].requiresUserType ?? null))
          continue;
        const [fromA, toA] = generationRange(entries[a]);
        const [fromB, toB] = generationRange(entries[b]);
        if (fromA <= toB && fromB <= toA)
          fail(
            `moves[${slug}]`,
            'duplicate move slug (same type condition, overlapping generations)',
          );
      }
    }
  }
  for (const category of json.categories) {
    if (!used.has(category.id)) warn(`categories[${category.id}]`, 'no move uses this category');
  }

  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const move of json.moves) bySeverity[move.severity]++;
  return { data: json, bySeverity };
}

// ───────────────────────────── Main ─────────────────────────────

/** @param {string} file @returns {unknown | undefined} undefined when the file cannot be used */
function load(file) {
  const name = relative(ROOT, file).replaceAll('\\', '/');
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    fail(name, `cannot be read (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(name, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

/** Runs `validate` and prefixes whatever it reports with the file name. */
function scoped(file, validate) {
  const name = relative(ROOT, file).replaceAll('\\', '/');
  const errorsBefore = errors.length;
  const warningsBefore = warnings.length;
  const result = validate();
  for (let index = errorsBefore; index < errors.length; index++)
    errors[index] = `${name} › ${errors[index]}`;
  for (let index = warningsBefore; index < warnings.length; index++)
    warnings[index] = `${name} › ${warnings[index]}`;
  return result;
}

function main() {
  const out = [];
  const print = (line = '') => out.push(line);
  const name = (file) => relative(ROOT, file).replaceAll('\\', '/');

  print('Biolume data validation');
  print('=======================');

  // ── oddsMethods.json ──
  const oddsJson = load(ODDS_FILE);
  const oddsReport =
    oddsJson === undefined ? null : scoped(ODDS_FILE, () => validateOddsData(oddsJson));
  print();
  if (oddsReport) {
    const { data, rows, tally, skippedMethods, log, sparklingTypes } = oddsReport;
    print(`${name(ODDS_FILE)}  (version ${data.version}, updated ${data.updated})`);
    print();
    print('  game   gen  methods  checkpoints');
    for (const { game, methods, tally: gameTally } of rows) {
      const parts = [`${gameTally.passed} passed`];
      if (gameTally.failed > 0) parts.push(`${gameTally.failed} FAILED`);
      if (gameTally.skipped > 0) parts.push(`${gameTally.skipped} skipped`);
      print(
        `  ${game.id.padEnd(6)} ${String(game.generation).padStart(3)}  ${String(methods).padStart(7)}  ${parts.join(', ')}`,
      );
    }
    if (skippedMethods.length > 0) {
      print();
      print('  Not evaluated here (custom formulas this script does not implement):');
      for (const method of skippedMethods) {
        const count = `${method.checkpoints} checkpoint${method.checkpoints === 1 ? '' : 's'}`;
        print(`    ${method.id}: ${count} skipped (custom formula ${method.formula})`);
      }
    }
    if (VERBOSE) {
      print();
      print('  Checkpoints:');
      for (const line of log) print(`  ${line}`);
    }
    const recipes = Array.isArray(data.sandwiches.recipes) ? data.sandwiches.recipes : [];
    const sparkling = recipes.filter(
      (recipe) => isRecord(recipe) && recipe.sparklingLevel > 0,
    ).length;
    print();
    print(
      `  Sandwiches: ${recipes.length} recipes (${sparkling} with Sparkling Power, ${recipes.length - sparkling} encounter-only); ` +
        `${sparklingTypes}/${POKEMON_TYPES.length} types have a Sparkling Lv. 3 recipe`,
    );
    print();
    print(
      `  Totals: ${rows.length} games, ${rows.reduce((total, row) => total + row.methods, 0)} methods, ` +
        `${tally.passed + tally.failed + tally.skipped} checkpoints — ${tally.passed} passed, ${tally.failed} failed, ${tally.skipped} skipped`,
    );
  } else {
    print(`${name(ODDS_FILE)}  — not validated (see errors)`);
  }

  // ── riskMoves.json ──
  const riskJson = load(RISK_FILE);
  let moveIndex = null;
  if (existsSync(MOVE_INDEX_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(MOVE_INDEX_FILE, 'utf8'));
      if (isRecord(parsed) && isRecord(parsed.moves)) moveIndex = parsed.moves;
    } catch {
      warnings.push(
        `${name(MOVE_INDEX_FILE)}: could not be parsed — move slugs were not cross-checked`,
      );
    }
  }
  const riskReport =
    riskJson === undefined ? null : scoped(RISK_FILE, () => validateRiskData(riskJson, moveIndex));
  print();
  if (riskReport) {
    const { data, bySeverity } = riskReport;
    print(`${name(RISK_FILE)}  (version ${data.version}, updated ${data.updated})`);
    print();
    print(
      `  Risk moves: ${data.moves.length} in ${data.categories.length} categories — ` +
        SEVERITIES.map((severity) => `${bySeverity[severity]} ${severity}`).join(', '),
    );
    print(
      `  Move slugs ${moveIndex ? 'checked against moveIndex.json' : 'not cross-checked (moveIndex.json is missing)'}`,
    );
  } else {
    print(`${name(RISK_FILE)}  — not validated (see errors)`);
  }

  // ── Verdict ──
  if (warnings.length > 0) {
    print();
    print(`Warnings (${warnings.length}):`);
    for (const warning of warnings) print(`  - ${warning}`);
  }
  if (errors.length > 0) {
    print();
    print(`Errors (${errors.length}):`);
    for (const error of errors) print(`  - ${error}`);
  }
  print();
  print(
    errors.length === 0
      ? `RESULT: PASS${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`
      : `RESULT: FAIL (${errors.length} error${errors.length === 1 ? '' : 's'})`,
  );

  console.log(out.join('\n'));
  process.exitCode = errors.length === 0 ? 0 : 1;
}

main();
