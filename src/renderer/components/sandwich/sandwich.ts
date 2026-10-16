/**
 * Pure helpers for the sandwich helper: filtering the recipe table, naming
 * meal powers, and the odds a Sparkling Power sandwich leads to.
 */
import type { OddsSelection, TargetRef } from '@shared/types';
import type {
  HerbaId,
  MealPower,
  MealPowerId,
  SandwichData,
  SandwichRecipe,
} from '@renderer/data/schema';
import { POKEMON_TYPES, type PokemonType } from '@renderer/components/ui';
import { titleCase } from '@renderer/lib/format';
import type { OddsEngine } from '@renderer/lib/odds';

/** What the hunter wants from the sandwich. */
export type SandwichGoal = 'sparkling' | 'encounter';

/** Herba Mystica in the game's own flavour order. */
export const HERBA_ORDER: readonly HerbaId[] = ['sweet', 'salty', 'sour', 'bitter', 'spicy'];

export const POWER_NAMES: Record<MealPowerId, string> = {
  sparkling: 'Sparkling Power',
  title: 'Title Power',
  encounter: 'Encounter Power',
  catching: 'Catching Power',
  raid: 'Raid Power',
  exp: 'Exp. Point Power',
  'item-drop': 'Item Drop Power',
  humungo: 'Humungo Power',
  teensy: 'Teensy Power',
  egg: 'Egg Power',
};

/** A type a sandwich can target: the 18 regular types (Stellar is a Tera type, not a species type). */
export type MealType = Exclude<PokemonType, 'stellar'>;

export const MEAL_TYPES: readonly MealType[] = POKEMON_TYPES.filter(
  (type): type is MealType => type !== 'stellar',
);

export function isMealType(value: string): value is MealType {
  return (MEAL_TYPES as readonly string[]).includes(value);
}

/** The type to preselect for a hunt target: its primary type, when it is one of the 18. */
export function preselectedType(
  target: Pick<TargetRef, 'types'> | null | undefined,
): MealType | null {
  const primary = target?.types[0]?.toLowerCase();
  return primary !== undefined && isMealType(primary) ? primary : null;
}

function typeRank(type: string): number {
  const index = (MEAL_TYPES as readonly string[]).indexOf(type);
  return index < 0 ? MEAL_TYPES.length : index;
}

/**
 * Recipes for a goal, optionally narrowed to one type. `sparkling` keeps the
 * recipes that grant Sparkling Power, `encounter` the Herba-free ones. Sorted
 * by type, then cheapest first (minimal recipes, fewest Herba).
 */
export function filterRecipes(
  recipes: readonly SandwichRecipe[],
  type: string | null,
  goal: SandwichGoal,
): SandwichRecipe[] {
  return recipes
    .filter((recipe) =>
      goal === 'sparkling' ? recipe.sparklingLevel > 0 : recipe.sparklingLevel === 0,
    )
    .filter((recipe) => type === null || recipe.type === type)
    .sort(
      (a, b) =>
        typeRank(a.type) - typeRank(b.type) ||
        Number(b.minimal) - Number(a.minimal) ||
        a.herbaCount - b.herbaCount ||
        b.sparklingLevel - a.sparklingLevel,
    );
}

/** `Sparkling Power: Dragon`, or just `Egg Power` for untyped powers. */
export function powerLabel(power: MealPower): string {
  const name = POWER_NAMES[power.power] ?? titleCase(power.power);
  return power.type ? `${name}: ${titleCase(power.type)}` : name;
}

/** What a power does for a shiny hunt, where the bundled data says so; null otherwise. */
export function powerEffect(power: MealPower): string | null {
  switch (power.power) {
    case 'sparkling':
      return `+${power.level} shiny roll${power.level === 1 ? '' : 's'}`;
    case 'title':
      return 'extra mark rolls';
    case 'encounter':
      if (power.level === 3) return 'every possible spawn is this type';
      if (power.level === 2) return '75 % of spawns forced to this type';
      return 'more spawns of this type';
    default:
      return null;
  }
}

export interface HerbaRequirement {
  id: HerbaId;
  name: string;
  quantity: number;
}

/** The Herba Mystica a recipe consumes, in flavour order. */
export function herbaRequirements(
  recipe: Pick<SandwichRecipe, 'herba'>,
  herba: SandwichData['herba'],
): HerbaRequirement[] {
  return HERBA_ORDER.flatMap((id) => {
    const quantity = recipe.herba[id] ?? 0;
    if (quantity <= 0) return [];
    const name = herba.find((entry) => entry.id === id)?.name ?? `${titleCase(id)} Herba Mystica`;
    return [{ id, name, quantity }];
  });
}

/** The Herba flavour a condiment line stands for (`Salty Herba Mystica` → `salty`), or null. */
export function herbaOfIngredient(name: string, herba: SandwichData['herba']): HerbaId | null {
  return herba.find((entry) => entry.name === name)?.id ?? null;
}

const SV_GAME_ID = 'sv';
const SPARKLING_INPUT_ID = 'sparkling';
const SPARKLING_LV3 = 'lv3';

function sparklingOptionOf(
  engine: OddsEngine,
  selection: Pick<OddsSelection, 'gameId' | 'methodId'>,
): boolean {
  if (selection.gameId !== SV_GAME_ID) return false;
  const input = engine
    .getMethod(selection.gameId, selection.methodId)
    ?.inputs.find((entry) => entry.id === SPARKLING_INPUT_ID);
  return input?.kind === 'select' && input.options.some((option) => option.id === SPARKLING_LV3);
}

export interface SparklingOdds {
  /** Per-Pokémon odds of an ordinary SV wild encounter. */
  base: number;
  /** With Sparkling Power Lv. 3. */
  sparkling: number;
  /** With Sparkling Power Lv. 3 and the Shiny Charm. */
  sparklingCharm: number;
  /** Shiny rolls Sparkling Power Lv. 3 adds. */
  extraRolls: number | null;
}

/** What Sparkling Power Lv. 3 does to SV's wild-encounter odds, computed by the odds engine; null if the data lacks the input. */
export function sparklingOdds(engine: OddsEngine): SparklingOdds | null {
  const selection = engine.defaultSelection(SV_GAME_ID);
  if (!sparklingOptionOf(engine, selection)) return null;
  const withSandwich = engine.updateSelection(selection, {
    inputs: { [SPARKLING_INPUT_ID]: SPARKLING_LV3 },
  });
  const base = engine.compute(selection);
  const sparkling = engine.compute(withSandwich);
  const sparklingCharm = engine.compute({ ...withSandwich, shinyCharm: true });
  return {
    base: base.perPokemon,
    sparkling: sparkling.perPokemon,
    sparklingCharm: sparklingCharm.perPokemon,
    extraRolls:
      base.rolls !== null && sparkling.rolls !== null ? sparkling.rolls - base.rolls : null,
  };
}

/**
 * The hunt's odds selection with Sparkling Power Lv. 3 switched on, or null
 * when that does not apply (not an SV method with a Sparkling input, or it is
 * already set).
 */
export function withSparklingLv3(
  engine: OddsEngine,
  selection: OddsSelection,
): OddsSelection | null {
  const current = engine.normalizeSelection(selection);
  if (!sparklingOptionOf(engine, current)) return null;
  if (current.inputs[SPARKLING_INPUT_ID] === SPARKLING_LV3) return null;
  return engine.updateSelection(current, { inputs: { [SPARKLING_INPUT_ID]: SPARKLING_LV3 } });
}
