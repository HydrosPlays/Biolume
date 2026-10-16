/**
 * The odds engine: evaluates the declarative models of `oddsMethods.json`
 * (see `src/renderer/data/schema.ts`) against an {@link OddsSelection}.
 *
 * The engine is data-driven — it knows nothing about individual games. The one
 * exception is `custom` models, which name a formula looked up in a registry
 * ({@link registerFormula} or `createOddsEngine(data, { formulas })`).
 *
 * Nothing here throws on bad *selections*: unknown ids, missing inputs and
 * out-of-range numbers are normalised, and a model that cannot be evaluated
 * yields `valid: false` plus a warning, with the game's base odds as a stand-in.
 */
import { DEFAULT_GAME_ID, FULL_ODDS_METHOD_ID } from '@shared/defaults';
import type { OddsInputValue, OddsSelection } from '@shared/types';
import type {
  CustomModel,
  FixedModel,
  GameDef,
  MethodDef,
  MethodInput,
  NumberInput,
  Odds,
  OddsCheckpoint,
  OddsData,
  RollBonus,
  RollsModel,
  SelectInput,
  TableModel,
} from '@renderer/data/schema';
import {
  cumulativeProbability,
  expectedEncounters,
  milestones,
  type Milestone,
} from './probability';

// ───────────────────────────── Public types ─────────────────────────────

/** Reserved key: the Shiny Charm lives on `OddsSelection`, never in a method's inputs. */
export const SHINY_CHARM_KEY = 'shinyCharm';
export const BASE_ROLL_LABEL = 'Base roll';
export const SHINY_CHARM_LABEL = 'Shiny Charm';
/** Relative error allowed on a checkpoint that does not set its own `tolerance`. */
export const DEFAULT_CHECKPOINT_TOLERANCE = 0.01;
/** Step of a number input that declares none: chains and counts are whole numbers. */
export const DEFAULT_NUMBER_STEP = 1;
/** Longest array {@link OddsEngine.chainProbabilities} will build. */
export const MAX_CHAIN_LENGTH = 100_000;

export type OddsInputs = Record<string, OddsInputValue>;

/** One line of the roll breakdown shown next to the result. */
export interface OddsBreakdownRow {
  kind: 'base' | 'charm' | 'bonus';
  label: string;
  /** Shiny rolls this row contributes while it is active. */
  rolls: number;
  /** Probability (0–1) that the row is active on a given encounter; absent when it always is. */
  chance?: number;
  /** Id of the method input that drives the row, when one does. */
  input?: string;
  /**
   * What `rolls` counts when it is not a shiny roll at 1/denominator — a
   * singular noun such as `check` (DexNav's forced-Shiny checks). Default: a roll.
   */
  unit?: string;
  /** Success chance (0–1) of one roll of this row, when it differs from 1/denominator. */
  perRoll?: number;
}

export interface OddsResult {
  /**
   * False when the method's model could not be evaluated (custom formula not
   * registered or failing, malformed model data). The odds are then the game's
   * base odds and `warnings` says why.
   */
  valid: boolean;
  game: GameDef;
  method: MethodDef;
  /** The normalised selection the result was computed from. */
  selection: OddsSelection;
  /** Resolved value of every input the method declares (same object as `selection.inputs`). */
  inputs: OddsInputs;
  /** Probability that a single Pokémon is shiny. */
  perPokemon: number;
  /** Probability that a counted encounter holds at least one shiny: `1 − (1 − perPokemon)^pokemonPerEncounter`. */
  perEncounter: number;
  /** `1 / perEncounter` — the "1 in N" per counted encounter. `Infinity` when the odds are zero. */
  oneIn: number;
  /** `1 / perPokemon` — the figure the data's checkpoints are expressed in. */
  oneInPerPokemon: number;
  pokemonPerEncounter: number;
  /**
   * Total shiny rolls for roll-based models — the expected count when
   * chance-gated bonuses are in play. Null for fixed / table models.
   */
  rolls: number | null;
  /** Denominator of a single roll for roll-based models, else null. */
  denominator: number | null;
  /** Roll contributions in display order; empty for fixed / table models. */
  breakdown: OddsBreakdownRow[];
  /** The Shiny Charm is on, the method honours it and the game has one. */
  charmApplied: boolean;
  /** The game has a Shiny Charm at all. */
  charmAvailable: boolean;
  /** Human-readable problems: substituted game / method, missing formula, … */
  warnings: string[];
}

/** What a custom formula receives. */
export interface FormulaContext {
  game: GameDef;
  method: MethodDef;
  /** `model.params`, or an empty object. */
  params: Readonly<Record<string, number>>;
  /** Resolved (normalised) input values. */
  inputs: Readonly<OddsInputs>;
  charmApplied: boolean;
  /** `game.shinyCharmRolls` while the charm applies, else 0. */
  charmRolls: number;
  /** `game.baseDenominator`. */
  denominator: number;
  /** Value of a number input (`fallback` when it is missing or not numeric). */
  number(id: string, fallback?: number): number;
  /** True when a toggle input is on. */
  toggle(id: string): boolean;
  /** Selected option id of a select input, or `''`. */
  select(id: string): string;
  /** `params[name]`, or `fallback` (default 0). */
  param(name: string, fallback?: number): number;
  /** `1 − (1 − 1/denominator)^rolls`; the denominator defaults to the game's. */
  rollsToProbability(rolls: number, denominator?: number): number;
}

/** A bare probability, or a richer result with roll details for the breakdown. */
export type FormulaResult =
  | number
  | {
      /** Probability (0–1) that a single Pokémon is shiny. */
      perPokemon: number;
      rolls?: number | null;
      breakdown?: OddsBreakdownRow[];
      warnings?: string[];
    };

export type OddsFormula = (context: FormulaContext) => FormulaResult;

export interface OddsEngineOptions {
  /** Formulas for `custom` models, by formula id. They take precedence over {@link registerFormula}. */
  formulas?: Readonly<Record<string, OddsFormula>>;
}

export interface GenerationGroup {
  generation: number;
  games: GameDef[];
}

export interface SelectionPatch {
  gameId?: string;
  methodId?: string;
  shinyCharm?: boolean;
  /** Merged over the current inputs. */
  inputs?: OddsInputs;
}

export interface BestCaseOptions {
  /** Leave the Shiny Charm as selected instead of switching it on. */
  keepCharm?: boolean;
}

export interface OddsDescription {
  result: OddsResult;
  /** The game's plain base odds, `1 / baseDenominator`. */
  baseProbability: number;
  /** `result.perPokemon / baseProbability` — "3× better than full odds". */
  multiplier: number;
  /** Average counted encounters per shiny, `1 / perEncounter`. */
  expectedEncounters: number;
  /** Encounters to reach 25 / 50 / 75 / 90 / 95 / 99 % at the current (constant) odds. */
  milestones: Milestone[];
  /** The method with every boosting input maxed and the charm on. */
  best: OddsResult;
  /** True when the selection already achieves `best`. */
  atBest: boolean;
  /** The method's chain input (`chain: true`), or null. */
  chainInput: NumberInput | null;
}

export interface MissingFormula {
  gameId: string;
  methodId: string;
  formula: string;
}

export interface CheckpointReport {
  gameId: string;
  methodId: string;
  checkpoint: OddsCheckpoint;
  /** False when the method could not be evaluated (see {@link OddsResult.valid}) — never a pass. */
  evaluated: boolean;
  expectedOneIn: number;
  /** Computed "1 in N" per Pokémon. */
  actualOneIn: number;
  /** `|actual − expected| / expected`. */
  relativeError: number;
  tolerance: number;
  pass: boolean;
  result: OddsResult;
}

export interface OddsEngine {
  readonly data: OddsData;
  /** Every game that has at least one method, in data order. Never empty. */
  readonly games: readonly GameDef[];
  /** `DEFAULT_GAME_ID` when the data has it, else the first game. */
  readonly defaultGame: GameDef;

  getGame(id: string): GameDef | undefined;
  getMethod(gameId: string, methodId: string): MethodDef | undefined;
  /** Games grouped for a dropdown: newest generation first, newest release first within one. */
  gamesByGeneration(): GenerationGroup[];

  /** A normalised selection for a game / method with every input at its default. */
  defaultSelection(gameId?: string, methodId?: string): OddsSelection;
  /**
   * Makes any selection safe to evaluate: unknown game → the default game,
   * unknown method → `full-odds`, inputs pruned to the method's declared ones
   * with defaults filled in, numbers clamped and snapped to their step, select
   * values checked, `shinyCharm` false when the game has no charm. A method
   * that had to be substituted starts from its defaults: the inputs of the
   * method that could not be found are discarded. Idempotent.
   */
  normalizeSelection(selection: OddsSelection): OddsSelection;
  /** Applies a patch (inputs are merged) and normalises the outcome. */
  updateSelection(selection: OddsSelection, patch: SelectionPatch): OddsSelection;

  compute(selection: OddsSelection): OddsResult;
  /** The selected method's first `chain: true` number input, or null. */
  chainInput(selection: OddsSelection): NumberInput | null;
  /**
   * Per-encounter odds while a number input grows by one each encounter:
   * element `i` uses `start + i`, held at the input's max. `start` defaults to
   * the selection's current value. Feed the array to `cumulativeVarying` /
   * `buildVaryingCurve`. An id that is not a number input gives a flat array.
   */
  chainProbabilities(
    selection: OddsSelection,
    inputId: string,
    length: number,
    start?: number,
  ): number[];
  /** The best odds the selected method can reach: every boosting input maxed, charm on. */
  bestCase(selection: OddsSelection, options?: BestCaseOptions): OddsResult;
  describeOdds(selection: OddsSelection): OddsDescription;

  /** Registers a formula for this engine only. */
  registerFormula(id: string, formula: OddsFormula): void;
  /** Whether a formula id resolves (engine-local or global). */
  hasFormula(id: string): boolean;
  /** Custom-model methods whose formula is not registered yet. */
  missingFormulas(): MissingFormula[];

  evaluateCheckpoint(
    gameId: string,
    methodId: string,
    checkpoint: OddsCheckpoint,
  ): CheckpointReport;
  /** Every checkpoint of every method, evaluated. */
  checkCheckpoints(): CheckpointReport[];
}

// ───────────────────────────── Formula registry ─────────────────────────────

const globalFormulas = new Map<string, OddsFormula>();

/** Registers a `custom`-model formula for every engine. Re-registering an id replaces it. */
export function registerFormula(id: string, formula: OddsFormula): void {
  globalFormulas.set(id, formula);
}

export function unregisterFormula(id: string): boolean {
  return globalFormulas.delete(id);
}

/** Whether a formula is registered globally. */
export function hasFormula(id: string): boolean {
  return globalFormulas.has(id);
}

// ───────────────────────────── Pure helpers ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Accepts finite numbers and numeric strings (form fields hand over strings). */
function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Slack when counting how many steps fit in a range, absorbing binary noise such as 0.3 / 0.1 = 2.9999999999999996. */
const STEP_GRID_EPSILON = 1e-9;

function decimalPlaces(value: number): number {
  const text = String(value);
  if (text.includes('e')) return 12;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(12, text.length - dot - 1);
}

/** Probability of an exact fraction; null when the fraction is malformed. */
function fractionToProbability(odds: Odds | undefined): number | null {
  if (!Array.isArray(odds)) return null;
  const [numerator, denominator] = odds;
  if (typeof numerator !== 'number' || typeof denominator !== 'number') return null;
  if (!(numerator >= 0) || !(denominator > 0) || !Number.isFinite(numerator)) return null;
  return Math.min(1, numerator / denominator);
}

/** `numerator / denominator` of an {@link Odds} fraction, clamped to 0–1 (0 when malformed). */
export function oddsToProbability(odds: Odds): number {
  return fractionToProbability(odds) ?? 0;
}

/** "1 in N" for a probability; `Infinity` when the probability is zero or invalid. */
export function probabilityToOneIn(probability: number): number {
  return probability > 0 ? 1 / Math.min(1, probability) : Infinity;
}

/**
 * Chance that at least one of `rolls` shiny rolls hits: `1 − (1 − 1/denominator)^rolls`.
 * Fractional roll counts are allowed; invalid arguments give 0.
 */
export function rollsToProbability(rolls: number, denominator: number): number {
  if (!(rolls > 0) || !(denominator > 0)) return 0;
  return cumulativeProbability(1 / denominator, rolls);
}

/**
 * The value a number input actually takes for a raw entry: coerced, clamped to
 * `min … max`, then snapped to the step grid anchored at `min` (the largest
 * grid value within range when `max` itself is off the grid).
 */
export function normalizeNumberInput(input: NumberInput, raw: unknown): number {
  const min = Math.min(input.min, input.max);
  const max = Math.max(input.min, input.max);
  const value = clamp(coerceNumber(raw) ?? coerceNumber(input.default) ?? min, min, max);
  const step = input.step !== undefined && input.step > 0 ? input.step : DEFAULT_NUMBER_STEP;
  // Work in whole grid steps and only then turn the result back into a value.
  // Comparing the floating-point value with `max` instead would reject a max
  // that is on the grid: 3 × 0.1 is 0.30000000000000004, "above" a max of 0.3.
  const lastStep = Math.max(0, Math.floor((max - min) / step + STEP_GRID_EPSILON));
  const steps = clamp(Math.round((value - min) / step), 0, lastStep);
  return Number((min + steps * step).toFixed(Math.max(decimalPlaces(step), decimalPlaces(min))));
}

function normalizeSelectInput(input: SelectInput, raw: unknown): string {
  const isOption = (value: unknown): value is string =>
    typeof value === 'string' && input.options.some((option) => option.id === value);
  if (isOption(raw)) return raw;
  if (isOption(input.default)) return input.default;
  return input.options[0]?.id ?? '';
}

/** The value a declared input takes for a raw (possibly missing or mistyped) entry. */
export function normalizeInputValue(input: MethodInput, raw: unknown): OddsInputValue {
  switch (input.kind) {
    case 'toggle':
      return typeof raw === 'boolean' ? raw : input.default === true;
    case 'select':
      return normalizeSelectInput(input, raw);
    case 'number':
      return normalizeNumberInput(input, raw);
  }
}

function numberOf(inputs: Readonly<OddsInputs>, id: string, fallback = 0): number {
  const value = inputs[id];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function charmIsAvailable(game: GameDef): boolean {
  return typeof game.shinyCharmRolls === 'number';
}

function baseProbabilityOf(game: GameDef): number {
  return game.baseDenominator >= 1 ? 1 / game.baseDenominator : 0;
}

function pokemonPerEncounterOf(method: MethodDef): number {
  const count = method.pokemonPerEncounter;
  return typeof count === 'number' && Number.isFinite(count) && count >= 1 ? count : 1;
}

// ───────────────────────────── Model evaluation ─────────────────────────────

interface Evaluation {
  valid: boolean;
  perPokemon: number;
  rolls: number | null;
  denominator: number | null;
  breakdown: OddsBreakdownRow[];
  warnings: string[];
}

type FormulaLookup = (id: string) => OddsFormula | undefined;

/** Stand-in used when a model cannot be evaluated: the game's base odds, flagged invalid. */
function fallbackEvaluation(game: GameDef, warning: string): Evaluation {
  return {
    valid: false,
    perPokemon: baseProbabilityOf(game),
    rolls: null,
    denominator: null,
    breakdown: [],
    warnings: [warning],
  };
}

function bonusRolls(bonus: RollBonus, inputs: Readonly<OddsInputs>): number {
  switch (bonus.kind) {
    case 'constant':
      return finiteOr(bonus.rolls, 0);
    case 'toggle':
      return inputs[bonus.input] === true ? finiteOr(bonus.rolls, 0) : 0;
    case 'select': {
      const selected = inputs[bonus.input];
      if (typeof selected !== 'string' || !Object.hasOwn(bonus.rolls, selected)) return 0;
      return finiteOr(bonus.rolls[selected], 0);
    }
    case 'tiers': {
      const value = numberOf(inputs, bonus.input);
      let reached: { min: number; rolls: number } | undefined;
      for (const tier of bonus.tiers) {
        if (tier.min <= value && (reached === undefined || tier.min >= reached.min)) reached = tier;
      }
      return reached ? finiteOr(reached.rolls, 0) : 0;
    }
    case 'linear': {
      const value = Math.max(0, numberOf(inputs, bonus.input));
      const units = typeof bonus.maxUnits === 'number' ? Math.min(value, bonus.maxUnits) : value;
      return finiteOr(bonus.perUnit, 0) * units;
    }
  }
}

function evaluateRolls(
  game: GameDef,
  model: RollsModel,
  inputs: Readonly<OddsInputs>,
  charmApplied: boolean,
): Evaluation {
  const denominator = model.denominator ?? game.baseDenominator;
  if (typeof denominator !== 'number' || !(denominator >= 1) || !Number.isFinite(denominator)) {
    return fallbackEvaluation(game, `Invalid roll denominator (${String(denominator)}).`);
  }
  // ln of one roll missing; −Infinity when every roll hits (denominator 1).
  const logMiss = Math.log1p(-1 / denominator);
  const logMissOf = (rolls: number): number => (rolls === 0 ? 0 : rolls * logMiss);

  const baseRolls = Math.max(0, finiteOr(model.baseRolls, 0));
  const breakdown: OddsBreakdownRow[] = [
    { kind: 'base', label: BASE_ROLL_LABEL, rolls: baseRolls },
  ];
  // Rolls that always happen, and the log-survival contributed by chance-gated ones.
  let certainRolls = baseRolls;
  let expectedRolls = baseRolls;
  let gatedLogSurvival = 0;

  const charmRolls = charmApplied ? finiteOr(game.shinyCharmRolls, 0) : 0;
  if (charmRolls !== 0) {
    certainRolls += charmRolls;
    expectedRolls += charmRolls;
    breakdown.push({ kind: 'charm', label: SHINY_CHARM_LABEL, rolls: charmRolls });
  }

  for (const bonus of model.bonuses ?? []) {
    const rolls = bonusRolls(bonus, inputs);
    if (rolls === 0) continue;
    const chance = bonus.chance;
    const row: OddsBreakdownRow = { kind: 'bonus', label: bonus.label, rolls };
    if (bonus.kind !== 'constant') row.input = bonus.input;

    if (chance === undefined || chance >= 1) {
      certainRolls += rolls;
      expectedRolls += rolls;
    } else if (chance > 0) {
      // Gates are independent, so the mixture over every on/off combination
      // factorises: E[miss^(Σ rolls)] = Π (1 − chance·(1 − miss^rolls)).
      gatedLogSurvival += Math.log1p(chance * Math.expm1(logMissOf(rolls)));
      expectedRolls += chance * rolls;
      row.chance = chance;
    } else {
      continue; // a chance of 0 (or NaN) never applies
    }
    breakdown.push(row);
  }

  certainRolls = Math.max(0, certainRolls);
  const perPokemon =
    gatedLogSurvival === 0
      ? rollsToProbability(certainRolls, denominator)
      : clamp(-Math.expm1(logMissOf(certainRolls) + gatedLogSurvival), 0, 1);
  return {
    valid: true,
    perPokemon,
    rolls: Math.max(0, expectedRolls),
    denominator,
    breakdown,
    warnings: [],
  };
}

function caseMatches(
  when: Readonly<Record<string, boolean | string>>,
  inputs: Readonly<OddsInputs>,
  charmApplied: boolean,
): boolean {
  return Object.entries(when).every(([key, required]) =>
    key === SHINY_CHARM_KEY ? charmApplied === required : inputs[key] === required,
  );
}

function evaluateFixed(
  game: GameDef,
  model: FixedModel,
  inputs: Readonly<OddsInputs>,
  charmApplied: boolean,
): Evaluation {
  const matched = (model.cases ?? []).find((entry) =>
    caseMatches(entry.when, inputs, charmApplied),
  );
  const perPokemon = fractionToProbability(matched ? matched.odds : model.odds);
  if (perPokemon === null) {
    return fallbackEvaluation(game, 'The method lists malformed fixed odds.');
  }
  return { valid: true, perPokemon, rolls: null, denominator: null, breakdown: [], warnings: [] };
}

function evaluateTable(
  game: GameDef,
  model: TableModel,
  inputs: Readonly<OddsInputs>,
  charmApplied: boolean,
): Evaluation {
  const useCharmTable =
    charmApplied && Array.isArray(model.charmTable) && model.charmTable.length > 0;
  const table = useCharmTable ? (model.charmTable ?? []) : (model.table ?? []);
  const index = clamp(Math.round(numberOf(inputs, model.input)), 0, table.length - 1);
  const perPokemon = fractionToProbability(table[index]);
  if (perPokemon === null) {
    return fallbackEvaluation(game, 'The method lists a malformed odds table.');
  }
  return { valid: true, perPokemon, rolls: null, denominator: null, breakdown: [], warnings: [] };
}

function evaluateCustom(
  game: GameDef,
  method: MethodDef,
  model: CustomModel,
  inputs: Readonly<OddsInputs>,
  charmApplied: boolean,
  lookup: FormulaLookup,
): Evaluation {
  const formula = lookup(model.formula);
  if (!formula) {
    return fallbackEvaluation(
      game,
      `The "${model.formula}" formula is not implemented yet — showing ${game.shortName} base odds instead.`,
    );
  }

  const params = model.params ?? {};
  const context: FormulaContext = {
    game,
    method,
    params,
    inputs,
    charmApplied,
    charmRolls: charmApplied ? finiteOr(game.shinyCharmRolls, 0) : 0,
    denominator: game.baseDenominator,
    number: (id, fallback = 0) => numberOf(inputs, id, fallback),
    toggle: (id) => inputs[id] === true,
    select: (id) => {
      const value = inputs[id];
      return typeof value === 'string' ? value : '';
    },
    param: (name, fallback = 0) =>
      Object.hasOwn(params, name) ? finiteOr(params[name], fallback) : fallback,
    rollsToProbability: (rolls, denominator = game.baseDenominator) =>
      rollsToProbability(rolls, denominator),
  };

  let outcome: FormulaResult;
  try {
    outcome = formula(context);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fallbackEvaluation(game, `The "${model.formula}" formula failed: ${reason}`);
  }

  const detailed: Exclude<FormulaResult, number> =
    typeof outcome === 'number' ? { perPokemon: outcome } : outcome;
  // A formula may hand back anything at runtime; trust nothing but a 0–1 number.
  const perPokemon: unknown = isRecord(detailed) ? detailed.perPokemon : undefined;
  if (typeof perPokemon !== 'number' || !(perPokemon >= 0) || !(perPokemon <= 1)) {
    return fallbackEvaluation(
      game,
      `The "${model.formula}" formula returned an invalid probability (${String(perPokemon)}).`,
    );
  }
  const rolls =
    typeof detailed.rolls === 'number' && Number.isFinite(detailed.rolls) ? detailed.rolls : null;
  return {
    valid: true,
    perPokemon,
    rolls,
    // A denominator only means something next to a roll count.
    denominator: rolls === null ? null : game.baseDenominator,
    breakdown: Array.isArray(detailed.breakdown) ? [...detailed.breakdown] : [],
    warnings: Array.isArray(detailed.warnings) ? [...detailed.warnings] : [],
  };
}

function evaluateModel(
  game: GameDef,
  method: MethodDef,
  inputs: Readonly<OddsInputs>,
  charmApplied: boolean,
  lookup: FormulaLookup,
): Evaluation {
  const model = method.model;
  switch (model.kind) {
    case 'rolls':
      return evaluateRolls(game, model, inputs, charmApplied);
    case 'fixed':
      return evaluateFixed(game, model, inputs, charmApplied);
    case 'table':
      return evaluateTable(game, model, inputs, charmApplied);
    case 'custom':
      return evaluateCustom(game, method, model, inputs, charmApplied, lookup);
    default:
      // Reachable only with data that bypassed the schema.
      return fallbackEvaluation(
        game,
        `Unknown odds model "${String((model as { kind?: unknown }).kind)}".`,
      );
  }
}

// ───────────────────────────── Best-case search ─────────────────────────────

/** One searched dimension; `id: null` is the Shiny Charm. */
interface Dimension {
  id: string | null;
  /** Candidate values, the currently selected one first. */
  values: OddsInputValue[];
  /** Index of the value most likely to boost the odds (toggle on, number maxed). */
  boosted: number;
}

/** Exhaustive search is used up to this many combinations, coordinate ascent beyond. */
const EXHAUSTIVE_SEARCH_LIMIT = 4_096;
const TABLE_CANDIDATE_LIMIT = 2_048;
/** Relative gain a candidate needs to replace the incumbent (keeps ties on the current values). */
const IMPROVEMENT = 1e-12;

/** Values worth trying for an input, the current value first. */
function inputDimension(method: MethodDef, input: MethodInput, current: OddsInputValue): Dimension {
  const candidates = new Set<OddsInputValue>([current]);
  let boosted: OddsInputValue;
  if (input.kind === 'toggle') {
    candidates.add(true).add(false);
    boosted = true;
  } else if (input.kind === 'select') {
    for (const option of input.options) candidates.add(option.id);
    boosted = input.options[input.options.length - 1]?.id ?? current;
  } else {
    boosted = normalizeNumberInput(input, input.max);
    const numbers = [input.max, input.min, input.default];
    const model = method.model;
    // Where the odds can change: tier thresholds, linear caps, every table row.
    if (model.kind === 'rolls') {
      for (const bonus of model.bonuses ?? []) {
        if (bonus.kind === 'tiers' && bonus.input === input.id) {
          numbers.push(...bonus.tiers.map((tier) => tier.min));
        } else if (
          bonus.kind === 'linear' &&
          bonus.input === input.id &&
          bonus.maxUnits !== undefined
        ) {
          numbers.push(bonus.maxUnits);
        }
      }
    } else if (model.kind === 'table' && model.input === input.id) {
      const rows = Math.max(model.table?.length ?? 0, model.charmTable?.length ?? 0);
      const probed = Math.min(rows, TABLE_CANDIDATE_LIMIT);
      for (let index = 0; index < probed; index++) numbers.push(index);
    }
    for (const value of numbers) candidates.add(normalizeNumberInput(input, value));
  }
  const values = [...candidates];
  return { id: input.id, values, boosted: Math.max(0, values.indexOf(boosted)) };
}

// ───────────────────────────── Engine ─────────────────────────────

interface Resolved {
  game: GameDef;
  method: MethodDef;
  selection: OddsSelection;
  /** Substitutions made while normalising, surfaced as warnings by `compute`. */
  notes: string[];
}

/**
 * Builds an engine over a data set.
 * @throws when the data contains no game with at least one method — the bundled
 * data is validated by the test-suite, so this only fires on a broken build.
 */
export function createOddsEngine(data: OddsData, options: OddsEngineOptions = {}): OddsEngine {
  const games = (Array.isArray(data?.games) ? data.games : []).filter(
    (game) => Array.isArray(game?.methods) && game.methods.length > 0,
  );
  const firstGame = games[0];
  if (!firstGame) throw new Error('Odds data contains no game with a hunting method.');

  const gamesById = new Map<string, GameDef>();
  /** Each game's `full-odds` method (its first method should the id be missing). */
  const fallbackMethods = new Map<GameDef, MethodDef>();
  for (const game of games) {
    // First occurrence wins should the data ever repeat an id.
    if (!gamesById.has(game.id)) gamesById.set(game.id, game);
    const fallback =
      game.methods.find((method) => method.id === FULL_ODDS_METHOD_ID) ?? game.methods[0];
    if (fallback) fallbackMethods.set(game, fallback);
  }
  const defaultGame = gamesById.get(DEFAULT_GAME_ID) ?? firstGame;

  const localFormulas = new Map<string, OddsFormula>(Object.entries(options.formulas ?? {}));
  const lookupFormula: FormulaLookup = (id) => localFormulas.get(id) ?? globalFormulas.get(id);

  function getGame(id: string): GameDef | undefined {
    return gamesById.get(id);
  }

  function getMethod(gameId: string, methodId: string): MethodDef | undefined {
    return gamesById.get(gameId)?.methods.find((method) => method.id === methodId);
  }

  function gamesByGeneration(): GenerationGroup[] {
    const groups = new Map<number, GameDef[]>();
    for (const game of games) {
      const group = groups.get(game.generation);
      if (group) group.push(game);
      else groups.set(game.generation, [game]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => b - a)
      .map(([generation, members]) => ({
        generation,
        // Array.prototype.sort is stable: equal release years keep data order.
        games: members.sort((a, b) => b.releaseYear - a.releaseYear),
      }));
  }

  function resolve(selection: OddsSelection): Resolved {
    const source: Record<string, unknown> = isRecord(selection) ? selection : {};
    const notes: string[] = [];

    let game = typeof source.gameId === 'string' ? gamesById.get(source.gameId) : undefined;
    const gameKnown = game !== undefined;
    if (!game) {
      game = defaultGame;
      notes.push(`Unknown game "${String(source.gameId)}" — using ${game.name}.`);
    }

    // A selection for an unknown game lands on plain full odds, whatever its method id.
    let method = gameKnown ? game.methods.find((entry) => entry.id === source.methodId) : undefined;
    const methodKnown = method !== undefined;
    if (!method) {
      method = fallbackMethods.get(game);
      // Unreachable: every game the engine keeps has at least one method.
      if (!method) throw new Error(`Game "${game.id}" has no hunting method.`);
      if (gameKnown) {
        notes.push(`Unknown method "${String(source.methodId)}" — using ${method.name}.`);
      }
    }

    // Inputs entered for a method that could not be found say nothing about its
    // stand-in, even where an id happens to coincide (a stale `sparkling: 'lv3'`
    // must not turn the fallback into boosted odds): the stand-in gets defaults.
    const rawInputs = methodKnown && isRecord(source.inputs) ? source.inputs : {};
    const inputs: OddsInputs = {};
    for (const input of method.inputs ?? []) {
      const raw = Object.hasOwn(rawInputs, input.id) ? rawInputs[input.id] : undefined;
      inputs[input.id] = normalizeInputValue(input, raw);
    }

    return {
      game,
      method,
      notes,
      selection: {
        gameId: game.id,
        methodId: method.id,
        shinyCharm: source.shinyCharm === true && charmIsAvailable(game),
        inputs,
      },
    };
  }

  /** Evaluates an already-normalised selection. */
  function evaluate(
    game: GameDef,
    method: MethodDef,
    selection: OddsSelection,
    notes: string[],
  ): OddsResult {
    const charmAvailable = charmIsAvailable(game);
    const charmApplied = charmAvailable && method.charmApplies === true && selection.shinyCharm;
    const evaluation = evaluateModel(game, method, selection.inputs, charmApplied, lookupFormula);
    const pokemonPerEncounter = pokemonPerEncounterOf(method);
    const perEncounter = cumulativeProbability(evaluation.perPokemon, pokemonPerEncounter);
    return {
      valid: evaluation.valid,
      game,
      method,
      selection,
      inputs: selection.inputs,
      perPokemon: evaluation.perPokemon,
      perEncounter,
      oneIn: probabilityToOneIn(perEncounter),
      oneInPerPokemon: probabilityToOneIn(evaluation.perPokemon),
      pokemonPerEncounter,
      rolls: evaluation.rolls,
      denominator: evaluation.denominator,
      breakdown: evaluation.breakdown,
      charmApplied,
      charmAvailable,
      warnings: [...notes, ...evaluation.warnings],
    };
  }

  function compute(selection: OddsSelection): OddsResult {
    const { game, method, selection: normalized, notes } = resolve(selection);
    return evaluate(game, method, normalized, notes);
  }

  function normalizeSelection(selection: OddsSelection): OddsSelection {
    return resolve(selection).selection;
  }

  function updateSelection(selection: OddsSelection, patch: SelectionPatch): OddsSelection {
    const current = isRecord(selection) ? selection : defaultSelection();
    return normalizeSelection({
      gameId: patch.gameId ?? current.gameId,
      methodId: patch.methodId ?? current.methodId,
      shinyCharm: patch.shinyCharm ?? current.shinyCharm,
      inputs: { ...(isRecord(current.inputs) ? current.inputs : {}), ...patch.inputs },
    });
  }

  function defaultSelection(gameId?: string, methodId?: string): OddsSelection {
    return normalizeSelection({
      gameId: gameId ?? defaultGame.id,
      methodId: methodId ?? FULL_ODDS_METHOD_ID,
      shinyCharm: false,
      inputs: {},
    });
  }

  function findChainInput(method: MethodDef): NumberInput | null {
    for (const input of method.inputs ?? []) {
      if (input.kind === 'number' && input.chain === true) return input;
    }
    return null;
  }

  function chainInput(selection: OddsSelection): NumberInput | null {
    return findChainInput(resolve(selection).method);
  }

  function chainProbabilities(
    selection: OddsSelection,
    inputId: string,
    length: number,
    start?: number,
  ): number[] {
    const count = Number.isNaN(length) ? 0 : clamp(Math.floor(length), 0, MAX_CHAIN_LENGTH);
    if (count === 0) return [];
    const { game, method, selection: normalized } = resolve(selection);
    const input = (method.inputs ?? []).find((entry) => entry.id === inputId);
    if (!input || input.kind !== 'number') {
      return new Array<number>(count).fill(evaluate(game, method, normalized, []).perEncounter);
    }

    const min = Math.min(input.min, input.max);
    const max = Math.max(input.min, input.max);
    const first = clamp(coerceNumber(start) ?? numberOf(normalized.inputs, inputId, min), min, max);
    const probabilities: number[] = [];
    let capped: number | undefined;
    for (let i = 0; i < count; i++) {
      if (capped !== undefined) {
        probabilities.push(capped);
        continue;
      }
      // The chain grows by exactly one per encounter, whatever the input's step.
      const value = Math.min(first + i, max);
      const stepped = { ...normalized, inputs: { ...normalized.inputs, [inputId]: value } };
      const probability = evaluate(game, method, stepped, []).perEncounter;
      probabilities.push(probability);
      if (value === max) capped = probability;
    }
    return probabilities;
  }

  function bestCase(selection: OddsSelection, bestOptions: BestCaseOptions = {}): OddsResult {
    const { game, method, selection: base, notes } = resolve(selection);
    const charmMatters = charmIsAvailable(game) && method.charmApplies === true;

    const dimensions: Dimension[] = [];
    if (charmMatters && !base.shinyCharm && bestOptions.keepCharm !== true) {
      dimensions.push({ id: null, values: [false, true], boosted: 1 });
    }
    for (const input of method.inputs ?? []) {
      const current = base.inputs[input.id] ?? normalizeInputValue(input, undefined);
      const dimension = inputDimension(method, input, current);
      if (dimension.values.length > 1) dimensions.push(dimension);
    }

    const build = (choice: readonly number[]): OddsSelection => {
      const inputs: OddsInputs = { ...base.inputs };
      let shinyCharm = base.shinyCharm;
      dimensions.forEach((dimension, index) => {
        const value = dimension.values[choice[index] ?? 0];
        if (value === undefined) return;
        if (dimension.id === null) shinyCharm = value === true;
        else inputs[dimension.id] = value;
      });
      return { ...base, shinyCharm, inputs };
    };
    const score = (candidate: OddsSelection): number =>
      evaluate(game, method, candidate, []).perPokemon;
    const improves = (candidate: number, incumbent: number): boolean =>
      candidate > incumbent * (1 + IMPROVEMENT);

    const origin = dimensions.map(() => 0);
    let best = build(origin);
    let bestScore = score(best);
    const consider = (choice: readonly number[]): boolean => {
      const candidate = build(choice);
      const candidateScore = score(candidate);
      if (!improves(candidateScore, bestScore)) return false;
      best = candidate;
      bestScore = candidateScore;
      return true;
    };

    const combinations = dimensions.reduce(
      (total, dimension) => total * dimension.values.length,
      1,
    );
    if (combinations <= EXHAUSTIVE_SEARCH_LIMIT) {
      // Odometer over every combination; index 0 of each dimension is the current value.
      const choice = [...origin];
      for (let n = 1; n < combinations; n++) {
        for (let d = dimensions.length - 1; d >= 0; d--) {
          const next = (choice[d] ?? 0) + 1;
          if (next < (dimensions[d]?.values.length ?? 0)) {
            choice[d] = next;
            break;
          }
          choice[d] = 0;
        }
        consider(choice);
      }
    } else {
      // Too many combinations: climb one input at a time, once from the current
      // selection and once from "everything boosted" (toggles on, numbers maxed).
      const starts = [origin, dimensions.map((dimension) => dimension.boosted)];
      for (const start of starts) {
        const choice = [...start];
        consider(choice);
        for (let pass = 0, improved = true; improved && pass < 8; pass++) {
          improved = false;
          for (let d = 0; d < dimensions.length; d++) {
            const kept = choice[d] ?? 0;
            let chosen = kept;
            let chosenScore = score(build(choice));
            for (let v = 0; v < (dimensions[d]?.values.length ?? 0); v++) {
              choice[d] = v;
              const candidateScore = score(build(choice));
              if (improves(candidateScore, chosenScore)) {
                chosen = v;
                chosenScore = candidateScore;
              }
            }
            choice[d] = chosen;
            if (chosen !== kept) improved = true;
          }
          consider(choice);
        }
      }
    }
    return evaluate(game, method, best, notes);
  }

  function describeOdds(selection: OddsSelection): OddsDescription {
    const result = compute(selection);
    const best = bestCase(result.selection);
    const baseProbability = baseProbabilityOf(result.game);
    return {
      result,
      baseProbability,
      multiplier: baseProbability > 0 ? result.perPokemon / baseProbability : 0,
      expectedEncounters: expectedEncounters(result.perEncounter),
      milestones: milestones(result.perEncounter),
      best,
      atBest: result.perPokemon >= best.perPokemon * (1 - 1e-9),
      chainInput: findChainInput(result.method),
    };
  }

  function missingFormulas(): MissingFormula[] {
    const missing: MissingFormula[] = [];
    for (const game of games) {
      for (const method of game.methods) {
        if (method.model.kind === 'custom' && !lookupFormula(method.model.formula)) {
          missing.push({ gameId: game.id, methodId: method.id, formula: method.model.formula });
        }
      }
    }
    return missing;
  }

  function evaluateCheckpoint(
    gameId: string,
    methodId: string,
    checkpoint: OddsCheckpoint,
  ): CheckpointReport {
    const result = compute({
      gameId,
      methodId,
      shinyCharm: checkpoint.shinyCharm === true,
      inputs: isRecord(checkpoint.inputs) ? checkpoint.inputs : {},
    });
    const evaluated = result.valid && result.game.id === gameId && result.method.id === methodId;
    const expectedOneIn = checkpoint.oneIn;
    const actualOneIn = result.oneInPerPokemon;
    const relativeError =
      expectedOneIn > 0 && Number.isFinite(actualOneIn)
        ? Math.abs(actualOneIn - expectedOneIn) / expectedOneIn
        : Infinity;
    const tolerance =
      typeof checkpoint.tolerance === 'number' && checkpoint.tolerance >= 0
        ? checkpoint.tolerance
        : DEFAULT_CHECKPOINT_TOLERANCE;
    return {
      gameId,
      methodId,
      checkpoint,
      evaluated,
      expectedOneIn,
      actualOneIn,
      relativeError,
      tolerance,
      pass: evaluated && relativeError <= tolerance,
      result,
    };
  }

  function checkCheckpoints(): CheckpointReport[] {
    return games.flatMap((game) =>
      game.methods.flatMap((method) =>
        (method.checkpoints ?? []).map((checkpoint) =>
          evaluateCheckpoint(game.id, method.id, checkpoint),
        ),
      ),
    );
  }

  return {
    data,
    games,
    defaultGame,
    getGame,
    getMethod,
    gamesByGeneration,
    defaultSelection,
    normalizeSelection,
    updateSelection,
    compute,
    chainInput,
    chainProbabilities,
    bestCase,
    describeOdds,
    registerFormula: (id, formula) => {
      localFormulas.set(id, formula);
    },
    hasFormula: (id) => lookupFormula(id) !== undefined,
    missingFormulas,
    evaluateCheckpoint,
    checkCheckpoints,
  };
}
