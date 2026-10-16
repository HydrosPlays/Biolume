import { describe, expect, it } from 'vitest';
import { oddsEngine, sandwichData } from '@renderer/lib/oddsData';
import {
  MEAL_TYPES,
  filterRecipes,
  herbaOfIngredient,
  herbaRequirements,
  powerEffect,
  powerLabel,
  preselectedType,
  sparklingOdds,
  withSparklingLv3,
} from './sandwich';

describe('filterRecipes', () => {
  it('splits a type into its Sparkling and its Herba-free recipes', () => {
    const sparkling = filterRecipes(sandwichData.recipes, 'dragon', 'sparkling');
    expect(sparkling.length).toBeGreaterThan(0);
    expect(sparkling.every((recipe) => recipe.type === 'dragon' && recipe.sparklingLevel > 0)).toBe(
      true,
    );

    const encounter = filterRecipes(sandwichData.recipes, 'dragon', 'encounter');
    expect(encounter.length).toBeGreaterThan(0);
    expect(
      encounter.every((recipe) => recipe.herbaCount === 0 && recipe.sparklingLevel === 0),
    ).toBe(true);
  });

  it('lists every type in the usual type order when no type is picked', () => {
    const all = filterRecipes(sandwichData.recipes, null, 'sparkling');
    const types = [...new Set(all.map((recipe) => recipe.type))];
    expect(MEAL_TYPES).toHaveLength(18);
    expect(types).toEqual([...MEAL_TYPES]);
    expect(filterRecipes(sandwichData.recipes, 'stellar', 'sparkling')).toEqual([]);
  });

  it('puts minimal, cheaper recipes first without touching the source table', () => {
    const base = sandwichData.recipes[0];
    if (!base) throw new Error('the bundled table has recipes');
    const costly = { ...base, id: 'costly', minimal: false, herbaCount: 4 };
    const before = [...sandwichData.recipes];
    const sorted = filterRecipes(
      [costly, base],
      base.type,
      base.sparklingLevel > 0 ? 'sparkling' : 'encounter',
    );
    expect(sorted.map((recipe) => recipe.id)).toEqual([base.id, 'costly']);
    expect(sandwichData.recipes).toEqual(before);
  });
});

describe('preselectedType', () => {
  it('takes the primary type of the hunt target', () => {
    expect(preselectedType({ types: ['psychic', 'fairy'] })).toBe('psychic');
    expect(preselectedType({ types: ['Dragon'] })).toBe('dragon');
    expect(preselectedType({ types: [] })).toBeNull();
    expect(preselectedType({ types: ['shadow'] })).toBeNull();
    expect(preselectedType(null)).toBeNull();
  });
});

describe('labels', () => {
  it('names powers with their type and says what they do for a hunt', () => {
    expect(powerLabel({ power: 'sparkling', type: 'dragon', level: 3 })).toBe(
      'Sparkling Power: Dragon',
    );
    expect(powerLabel({ power: 'egg', type: null, level: 2 })).toBe('Egg Power');
    expect(powerEffect({ power: 'sparkling', type: 'dragon', level: 3 })).toBe('+3 shiny rolls');
    expect(powerEffect({ power: 'encounter', type: 'dragon', level: 2 })).toMatch(/75 %/);
    expect(powerEffect({ power: 'exp', type: 'dark', level: 1 })).toBeNull();
  });

  it('resolves the Herba a recipe costs, in flavour order', () => {
    expect(herbaRequirements({ herba: { spicy: 1, salty: 1 } }, sandwichData.herba)).toEqual([
      { id: 'salty', name: 'Salty Herba Mystica', quantity: 1 },
      { id: 'spicy', name: 'Spicy Herba Mystica', quantity: 1 },
    ]);
    expect(herbaRequirements({ herba: {} }, sandwichData.herba)).toEqual([]);
    expect(herbaOfIngredient('Salty Herba Mystica', sandwichData.herba)).toBe('salty');
    expect(herbaOfIngredient('Salt', sandwichData.herba)).toBeNull();
  });

  it('every recipe in the bundled table declares the Herba it lists as condiments', () => {
    for (const recipe of sandwichData.recipes) {
      const total = herbaRequirements(recipe, sandwichData.herba).reduce(
        (sum, entry) => sum + entry.quantity,
        0,
      );
      expect(total, recipe.id).toBe(recipe.herbaCount);
    }
  });
});

describe('odds link', () => {
  it('computes what Sparkling Power Lv. 3 does from the odds engine', () => {
    const odds = sparklingOdds(oddsEngine);
    expect(odds).not.toBeNull();
    expect(odds?.extraRolls).toBe(3);
    expect(1 / (odds?.base ?? 1)).toBeCloseTo(4096, 6);
    expect(1 / (odds?.sparkling ?? 1)).toBeCloseTo(1024.4, 1);
    expect(1 / (odds?.sparklingCharm ?? 1)).toBeCloseTo(683.1, 1);
  });

  it('offers Sparkling Lv. 3 only for SV methods that take it and do not have it yet', () => {
    const outbreak = oddsEngine.defaultSelection('sv', 'mass-outbreak');
    const patched = withSparklingLv3(oddsEngine, outbreak);
    expect(patched?.inputs).toEqual({ ...outbreak.inputs, sparkling: 'lv3' });
    expect(patched && withSparklingLv3(oddsEngine, patched)).toBeNull();
    expect(
      withSparklingLv3(oddsEngine, oddsEngine.defaultSelection('sv', 'masuda-method')),
    ).toBeNull();
    expect(withSparklingLv3(oddsEngine, oddsEngine.defaultSelection('swsh'))).toBeNull();
  });
});
