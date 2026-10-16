/**
 * Shapes of the bundled utility data:
 *   - `oddsMethods.json` → {@link OddsData}   (games, hunting methods, SV sandwich tables)
 *   - `riskMoves.json`   → {@link RiskMoveData}
 *
 * The odds data is declarative: `src/renderer/lib/odds.ts` evaluates an
 * {@link OddsModel} against an `OddsSelection` without per-method code, except
 * for `custom` models which name a formula implemented in the engine.
 */
import type { OddsInputValue } from '@shared/types';

/** Exact fraction `[numerator, denominator]` — `[1, 4096]` is "1 in 4096". */
export type Odds = [number, number];

// ───────────────────────────── Method inputs ─────────────────────────────

interface InputBase {
  /** Unique within the method. `shinyCharm` is reserved (it lives on `OddsSelection`). */
  id: string;
  label: string;
  description?: string;
}

export interface ToggleInput extends InputBase {
  kind: 'toggle';
  default: boolean;
}

export interface SelectOption {
  id: string;
  label: string;
  description?: string;
}

export interface SelectInput extends InputBase {
  kind: 'select';
  options: SelectOption[];
  /** An option id. */
  default: string;
}

export interface NumberInput extends InputBase {
  kind: 'number';
  min: number;
  max: number;
  step?: number;
  default: number;
  unit?: string;
  /** True when the value is a chain / streak that normally grows by one per encounter. */
  chain?: boolean;
}

export type MethodInput = ToggleInput | SelectInput | NumberInput;

// ───────────────────────────── Odds models ─────────────────────────────

interface RollBonusBase {
  /** Shown in the roll breakdown, e.g. `Sparkling Power Lv. 3`. */
  label: string;
  /**
   * Probability (0–1) that the bonus is applied on a given encounter. Omit for
   * "always". The engine mixes over every chance-gated bonus.
   */
  chance?: number;
}

/** Adds `rolls` while a toggle input is on. */
export interface ToggleRollBonus extends RollBonusBase {
  kind: 'toggle';
  input: string;
  rolls: number;
}

/** Adds the rolls mapped to the selected option id (missing ids add 0). */
export interface SelectRollBonus extends RollBonusBase {
  kind: 'select';
  input: string;
  rolls: Record<string, number>;
}

/** Number input → the `rolls` of the highest tier whose `min` ≤ value. */
export interface TierRollBonus extends RollBonusBase {
  kind: 'tiers';
  input: string;
  tiers: { min: number; rolls: number }[];
}

/** Number input → `perUnit × min(value, maxUnits)`. */
export interface LinearRollBonus extends RollBonusBase {
  kind: 'linear';
  input: string;
  perUnit: number;
  maxUnits?: number;
}

/** Always-on bonus inherent to the method (e.g. Masuda Method's extra rolls). */
export interface ConstantRollBonus extends RollBonusBase {
  kind: 'constant';
  rolls: number;
}

export type RollBonus =
  ToggleRollBonus | SelectRollBonus | TierRollBonus | LinearRollBonus | ConstantRollBonus;

/**
 * The game re-rolls the shiny check `rolls` times; each roll succeeds with
 * probability 1/D. `p = 1 − (1 − 1/D)^rolls`, where
 * `rolls = baseRolls + Σ bonuses (+ game.shinyCharmRolls when the charm applies)`.
 */
export interface RollsModel {
  kind: 'rolls';
  /** Rolls before any bonus — normally 1. */
  baseRolls: number;
  bonuses: RollBonus[];
  /** Per-roll denominator override; defaults to `game.baseDenominator`. */
  denominator?: number;
}

export interface FixedCase {
  /** Input id → required value. Use the reserved key `shinyCharm` to branch on the charm. */
  when: Record<string, boolean | string>;
  odds: Odds;
}

/** A flat probability, optionally switched by toggles / selects. The first matching case wins. */
export interface FixedModel {
  kind: 'fixed';
  odds: Odds;
  cases?: FixedCase[];
}

/** Odds looked up by a number input (chain length): `table[clamp(value, 0, table.length − 1)]`. */
export interface TableModel {
  kind: 'table';
  input: string;
  table: Odds[];
  /** Table used instead when the Shiny Charm is on and applies. */
  charmTable?: Odds[];
}

/** A formula too irregular for the declarative models, implemented by name in the engine. */
export interface CustomModel {
  kind: 'custom';
  /** Engine formula id, kebab-case, e.g. `oras-dexnav`. */
  formula: string;
  /** Precise pseudo-code of the formula, with every constant, so it can be implemented from this text alone. */
  spec: string;
  params?: Record<string, number>;
}

export type OddsModel = RollsModel | FixedModel | TableModel | CustomModel;

// ───────────────────────────── Games & methods ─────────────────────────────

/** A published reference value the test-suite pins the engine against. */
export interface OddsCheckpoint {
  label: string;
  shinyCharm: boolean;
  inputs: Record<string, OddsInputValue>;
  /** Expected odds as "1 in N" per Pokémon (before `pokemonPerEncounter`). */
  oneIn: number;
  /** Allowed relative error, default 0.01. */
  tolerance?: number;
}

export interface MethodDef {
  /** Unique within the game, kebab-case. Each game's first method is `full-odds`. */
  id: string;
  name: string;
  /** One line shown in the method dropdown. */
  summary: string;
  /** How the method works and how to run it, plain prose. */
  details?: string;
  /** Whether the Shiny Charm affects this method. */
  charmApplies: boolean;
  inputs: MethodInput[];
  model: OddsModel;
  /** Pokémon generated per counted encounter (5 for Horde Encounters). Default 1. */
  pokemonPerEncounter?: number;
  checkpoints: OddsCheckpoint[];
  /** Caveats worth surfacing in the UI. */
  notes?: string[];
  /** Source URLs backing the numbers. */
  sources: string[];
}

export interface GameDef {
  /** Stable kebab-case id, e.g. `sv`, `pla`, `usum`. */
  id: string;
  /** e.g. `Scarlet / Violet`. */
  name: string;
  /** e.g. `SV`. */
  shortName: string;
  generation: number;
  platform: string;
  releaseYear: number;
  /** Denominator of one shiny roll: 8192 through Gen 5, 4096 from Gen 6. */
  baseDenominator: number;
  /** PokeAPI `version-group` slugs used to resolve level-up movesets, most relevant first. */
  versionGroups: string[];
  /** Extra rolls granted by the Shiny Charm; null when the game has none. */
  shinyCharmRolls: number | null;
  methods: MethodDef[];
}

// ───────────────────────────── SV sandwiches ─────────────────────────────

export type HerbaId = 'sweet' | 'salty' | 'sour' | 'bitter' | 'spicy';

export type MealPowerId =
  | 'sparkling'
  | 'title'
  | 'encounter'
  | 'catching'
  | 'raid'
  | 'exp'
  | 'item-drop'
  | 'humungo'
  | 'teensy'
  | 'egg';

export interface MealPower {
  power: MealPowerId;
  /** PokeAPI type slug, or null for untyped powers such as Egg Power. */
  type: string | null;
  level: 1 | 2 | 3;
}

export interface SandwichItem {
  name: string;
  quantity: number;
}

export interface SandwichRecipe {
  id: string;
  /** PokeAPI type slug this recipe targets, e.g. `dragon`. */
  type: string;
  name: string;
  /** Sparkling Power level delivered; 0 for encounter-only recipes. */
  sparklingLevel: 0 | 1 | 2 | 3;
  /** Total Herba Mystica consumed. */
  herbaCount: number;
  herba: Partial<Record<HerbaId, number>>;
  fillings: SandwichItem[];
  /** Condiments, including the Herba Mystica entries. */
  condiments: SandwichItem[];
  powers: MealPower[];
  /** Players needed to build it (1 = solo). */
  players: number;
  /** True when this is the cheapest known recipe (fewest Herba) for its type at its sparkling level. */
  minimal: boolean;
  notes?: string;
}

export interface SandwichData {
  /** Short explanation of how Sparkling / Encounter / Title Power interact. */
  summary: string;
  herba: { id: HerbaId; name: string; source: string }[];
  recipes: SandwichRecipe[];
  notes: string[];
  sources: string[];
}

export interface OddsData {
  version: number;
  /** ISO date the data was last reviewed. */
  updated: string;
  games: GameDef[];
  sandwiches: SandwichData;
}

// ───────────────────────────── Risk moves ─────────────────────────────

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface RiskCategory {
  /** kebab-case, e.g. `self-ko`, `recoil`, `flee`. */
  id: string;
  label: string;
  description: string;
  /** Default severity for moves in the category. */
  severity: RiskSeverity;
}

export interface RiskMove {
  /** PokeAPI move slug, e.g. `self-destruct`. */
  slug: string;
  name: string;
  /** A {@link RiskCategory} id. */
  category: string;
  severity: RiskSeverity;
  /** One sentence: why this endangers a shiny encounter. */
  reason: string;
  /** Mechanical detail, e.g. `Recoil: 1/3 of damage dealt`. */
  detail?: string;
  /** Practical countermeasure, e.g. `Lead with a Damp ability or a Ghost-type`. */
  counter?: string;
  /** The move is only risky when the wild Pokémon has this type (e.g. Curse → `ghost`). */
  requiresUserType?: string;
  /** Generations in which the risky behaviour exists (inclusive). Omit for all. */
  minGeneration?: number;
  maxGeneration?: number;
}

export interface RiskMoveData {
  version: number;
  updated: string;
  categories: RiskCategory[];
  moves: RiskMove[];
  sources: string[];
}
