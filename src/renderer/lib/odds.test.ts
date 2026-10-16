import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OddsInputValue, OddsSelection } from '@shared/types';
import type {
  GameDef,
  MethodDef,
  NumberInput,
  OddsData,
  RollBonus,
  SelectInput,
} from '@renderer/data/schema';
import {
  BASE_ROLL_LABEL,
  DEFAULT_CHECKPOINT_TOLERANCE,
  MAX_CHAIN_LENGTH,
  SHINY_CHARM_LABEL,
  createOddsEngine,
  hasFormula,
  normalizeInputValue,
  normalizeNumberInput,
  oddsToProbability,
  probabilityToOneIn,
  registerFormula,
  rollsToProbability,
  unregisterFormula,
  type FormulaContext,
  type OddsFormula,
} from './odds';
import { validateOddsData } from './oddsSchema';
import { cumulativeProbability, cumulativeVarying, encountersForProbability } from './probability';

// ───────────────────────────── Fixture ─────────────────────────────

const SOURCE = ['https://bulbapedia.bulbagarden.net/wiki/Shiny_Pok%C3%A9mon'];

function fullOdds(denominator: number, charmOneIn?: number): MethodDef {
  return {
    id: 'full-odds',
    name: 'Full odds',
    summary: 'Plain random encounters.',
    charmApplies: true,
    inputs: [],
    model: { kind: 'rolls', baseRolls: 1, bonuses: [] },
    checkpoints: [
      { label: 'Base', shinyCharm: false, inputs: {}, oneIn: denominator },
      ...(charmOneIn === undefined
        ? []
        : [{ label: 'Shiny Charm', shinyCharm: true, inputs: {}, oneIn: charmOneIn }]),
    ],
    sources: SOURCE,
  };
}

const levelOptions = (prefix: string, count: number): SelectInput['options'] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    label: `Level ${index}`,
  }));

/**
 * A synthetic data set shaped like the real one. Every model kind and bonus
 * kind appears at least once; the numbers are chosen to be easy to verify by
 * hand, not to match any game.
 */
const FIXTURE: OddsData = {
  version: 1,
  updated: '2026-10-13',
  games: [
    {
      id: 'sv',
      name: 'Scarlet / Violet',
      shortName: 'SV',
      generation: 9,
      platform: 'Switch',
      releaseYear: 2022,
      baseDenominator: 4096,
      versionGroups: ['scarlet-violet'],
      shinyCharmRolls: 2,
      methods: [
        fullOdds(4096, 1365.67),
        {
          id: 'masuda',
          name: 'Masuda Method',
          summary: 'Breed parents from different language games.',
          charmApplies: true,
          inputs: [],
          model: {
            kind: 'rolls',
            baseRolls: 1,
            bonuses: [{ kind: 'constant', label: 'Masuda Method', rolls: 5 }],
          },
          checkpoints: [
            { label: 'No charm', shinyCharm: false, inputs: {}, oneIn: 683.08 },
            { label: 'Charm', shinyCharm: true, inputs: {}, oneIn: 512.44 },
          ],
          sources: SOURCE,
        },
        {
          id: 'outbreak',
          name: 'Mass Outbreak',
          summary: 'Clear Pokémon from an outbreak, optionally with a sandwich.',
          charmApplies: true,
          inputs: [
            {
              id: 'cleared',
              kind: 'number',
              label: 'Pokémon cleared',
              min: 0,
              max: 100,
              default: 0,
              chain: true,
            },
            {
              id: 'sparkling',
              kind: 'select',
              label: 'Sparkling Power',
              options: [
                { id: 'none', label: 'None' },
                { id: 'lv1', label: 'Lv. 1' },
                { id: 'lv2', label: 'Lv. 2' },
                { id: 'lv3', label: 'Lv. 3' },
              ],
              default: 'none',
            },
          ],
          model: {
            kind: 'rolls',
            baseRolls: 1,
            bonuses: [
              // Tiers listed out of order on purpose: the highest reached one must win.
              {
                kind: 'tiers',
                label: 'Outbreak',
                input: 'cleared',
                tiers: [
                  { min: 60, rolls: 2 },
                  { min: 30, rolls: 1 },
                ],
              },
              {
                kind: 'select',
                label: 'Sparkling Power',
                input: 'sparkling',
                rolls: { lv1: 1, lv2: 2, lv3: 3 },
              },
            ],
          },
          checkpoints: [
            { label: 'Fresh outbreak', shinyCharm: false, inputs: {}, oneIn: 4096 },
            { label: '60 cleared', shinyCharm: false, inputs: { cleared: 60 }, oneIn: 1365.67 },
            {
              label: '60 cleared, Lv. 3, charm',
              shinyCharm: true,
              inputs: { cleared: 60, sparkling: 'lv3' },
              oneIn: 512.44,
            },
          ],
          sources: SOURCE,
        },
        {
          id: 'gated',
          name: 'Gated bonuses',
          summary: 'Bonuses that only apply on some encounters.',
          charmApplies: true,
          inputs: [
            { id: 'lure', kind: 'toggle', label: 'Lure', default: false },
            { id: 'aura', kind: 'toggle', label: 'Aura', default: true },
            { id: 'combo', kind: 'number', label: 'Combo', min: 0, max: 50, step: 5, default: 0 },
          ],
          model: {
            kind: 'rolls',
            baseRolls: 1,
            bonuses: [
              { kind: 'toggle', label: 'Lure', input: 'lure', rolls: 3, chance: 0.5 },
              { kind: 'toggle', label: 'Aura', input: 'aura', rolls: 2, chance: 0.25 },
              { kind: 'linear', label: 'Combo', input: 'combo', perUnit: 1, maxUnits: 10 },
              { kind: 'constant', label: 'Lucky break', rolls: 4, chance: 0.1 },
            ],
          },
          checkpoints: [],
          sources: SOURCE,
        },
        {
          id: 'static',
          name: 'Static event',
          summary: 'An event with its own denominator that ignores the charm.',
          charmApplies: false,
          inputs: [],
          model: {
            kind: 'rolls',
            baseRolls: 1,
            denominator: 100,
            bonuses: [{ kind: 'constant', label: 'Event boost', rolls: 1 }],
          },
          checkpoints: [
            { label: 'No charm', shinyCharm: false, inputs: {}, oneIn: 50.25 },
            { label: 'Charm has no effect', shinyCharm: true, inputs: {}, oneIn: 50.25 },
          ],
          sources: SOURCE,
        },
        {
          id: 'mega',
          name: 'Kitchen sink',
          summary: 'Enough inputs to defeat an exhaustive best-case search.',
          charmApplies: true,
          inputs: [
            {
              id: 'streak',
              kind: 'number',
              label: 'Streak',
              min: 0,
              max: 500,
              default: 0,
              chain: true,
            },
            {
              id: 'power',
              kind: 'select',
              label: 'Power',
              options: levelOptions('p', 6),
              default: 'p0',
            },
            {
              id: 'aura',
              kind: 'select',
              label: 'Aura',
              options: levelOptions('a', 6),
              default: 'a0',
            },
            { id: 'x', kind: 'toggle', label: 'X', default: false },
            { id: 'y', kind: 'toggle', label: 'Y', default: false },
            { id: 'z', kind: 'toggle', label: 'Z', default: false },
          ],
          model: {
            kind: 'rolls',
            baseRolls: 1,
            bonuses: [
              {
                kind: 'tiers',
                label: 'Streak',
                input: 'streak',
                tiers: Array.from({ length: 12 }, (_, index) => ({
                  min: (index + 1) * 10,
                  rolls: index + 1,
                })),
              },
              {
                kind: 'select',
                label: 'Power',
                input: 'power',
                rolls: { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5 },
              },
              // Not monotonic: the best option is neither the first nor the last.
              { kind: 'select', label: 'Aura', input: 'aura', rolls: { a1: 1, a3: 7, a5: 2 } },
              { kind: 'toggle', label: 'X', input: 'x', rolls: 1 },
              { kind: 'toggle', label: 'Y', input: 'y', rolls: 2 },
              { kind: 'toggle', label: 'Z', input: 'z', rolls: 2, chance: 0.5 },
            ],
          },
          checkpoints: [{ label: 'Nothing active', shinyCharm: false, inputs: {}, oneIn: 4096 }],
          sources: SOURCE,
        },
      ],
    },
    {
      id: 'swsh',
      name: 'Sword / Shield',
      shortName: 'SwSh',
      generation: 8,
      platform: 'Switch',
      releaseYear: 2019,
      baseDenominator: 4096,
      versionGroups: ['sword-shield'],
      shinyCharmRolls: 2,
      methods: [
        fullOdds(4096, 1365.67),
        {
          id: 'dynamax-adventure',
          name: 'Dynamax Adventure',
          summary: 'Flat odds that the charm improves.',
          charmApplies: true,
          inputs: [],
          model: {
            kind: 'fixed',
            odds: [1, 300],
            cases: [{ when: { shinyCharm: true }, odds: [1, 100] }],
          },
          checkpoints: [
            { label: 'No charm', shinyCharm: false, inputs: {}, oneIn: 300 },
            { label: 'Charm', shinyCharm: true, inputs: {}, oneIn: 100 },
          ],
          sources: SOURCE,
        },
        {
          id: 'fixed-switch',
          name: 'Switched odds',
          summary: 'Flat odds selected by a mode, a toggle and the charm.',
          charmApplies: true,
          inputs: [
            {
              id: 'mode',
              kind: 'select',
              label: 'Mode',
              options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
                { id: 'c', label: 'C' },
              ],
              default: 'a',
            },
            { id: 'boost', kind: 'toggle', label: 'Boost', default: false },
          ],
          model: {
            kind: 'fixed',
            odds: [1, 1000],
            cases: [
              { when: { mode: 'b', boost: true }, odds: [1, 50] },
              { when: { mode: 'b' }, odds: [1, 200] },
              { when: { boost: true, shinyCharm: true }, odds: [1, 20] },
            ],
          },
          checkpoints: [
            { label: 'Default', shinyCharm: false, inputs: {}, oneIn: 1000 },
            { label: 'Mode B', shinyCharm: true, inputs: { mode: 'b' }, oneIn: 200 },
            { label: 'Boost and charm', shinyCharm: true, inputs: { boost: true }, oneIn: 20 },
          ],
          sources: SOURCE,
        },
      ],
    },
    {
      id: 'bdsp',
      name: 'Brilliant Diamond / Shining Pearl',
      shortName: 'BDSP',
      generation: 8,
      platform: 'Switch',
      releaseYear: 2021,
      baseDenominator: 4096,
      versionGroups: ['brilliant-diamond-shining-pearl'],
      shinyCharmRolls: 2,
      methods: [
        fullOdds(4096, 1365.67),
        {
          id: 'poke-radar',
          name: 'Poké Radar',
          summary: 'Odds read from a chain table; the charm does nothing.',
          charmApplies: false,
          inputs: [
            {
              id: 'chain',
              kind: 'number',
              label: 'Chain',
              min: 0,
              max: 40,
              default: 0,
              unit: 'chain',
              chain: true,
            },
          ],
          // table[i] = (i + 1) / 4096.
          model: {
            kind: 'table',
            input: 'chain',
            table: Array.from({ length: 41 }, (_, index): [number, number] => [index + 1, 4096]),
          },
          checkpoints: [
            { label: 'Chain 0', shinyCharm: false, inputs: { chain: 0 }, oneIn: 4096 },
            {
              label: 'Chain 40',
              shinyCharm: false,
              inputs: { chain: 40 },
              oneIn: 99.9,
              tolerance: 0.002,
            },
            {
              label: 'Chain 40 with charm',
              shinyCharm: true,
              inputs: { chain: 40 },
              oneIn: 99.9,
              tolerance: 0.002,
            },
          ],
          sources: SOURCE,
        },
      ],
    },
    {
      id: 'lgpe',
      name: "Let's Go, Pikachu! / Eevee!",
      shortName: 'LGPE',
      generation: 7,
      platform: 'Switch',
      releaseYear: 2018,
      baseDenominator: 4096,
      versionGroups: ['lets-go-pikachu-lets-go-eevee'],
      shinyCharmRolls: 2,
      methods: [
        fullOdds(4096, 1365.67),
        {
          id: 'catch-combo',
          name: 'Catch Combo',
          summary: 'A short table with a separate charm table.',
          charmApplies: true,
          inputs: [
            {
              id: 'combo',
              kind: 'number',
              label: 'Combo',
              min: 0,
              max: 31,
              step: 0.5,
              default: 0,
              chain: true,
            },
          ],
          model: {
            kind: 'table',
            input: 'combo',
            table: [
              [1, 4096],
              [1, 1024],
              [1, 512],
            ],
            charmTable: [
              [3, 4096],
              [1, 512],
              [1, 256],
            ],
          },
          checkpoints: [
            { label: 'Combo 0', shinyCharm: false, inputs: { combo: 0 }, oneIn: 4096 },
            { label: 'Combo 31', shinyCharm: false, inputs: { combo: 31 }, oneIn: 512 },
            { label: 'Combo 31, charm', shinyCharm: true, inputs: { combo: 31 }, oneIn: 256 },
          ],
          sources: SOURCE,
        },
      ],
    },
    {
      id: 'oras',
      name: 'Omega Ruby / Alpha Sapphire',
      shortName: 'ORAS',
      generation: 6,
      platform: '3DS',
      releaseYear: 2014,
      baseDenominator: 4096,
      versionGroups: ['omega-ruby-alpha-sapphire'],
      shinyCharmRolls: 2,
      methods: [
        fullOdds(4096, 1365.67),
        {
          id: 'horde',
          name: 'Horde Encounter',
          summary: 'Five Pokémon per encounter.',
          charmApplies: true,
          inputs: [],
          model: { kind: 'rolls', baseRolls: 1, bonuses: [] },
          pokemonPerEncounter: 5,
          checkpoints: [{ label: 'Per Pokémon', shinyCharm: false, inputs: {}, oneIn: 4096 }],
          sources: SOURCE,
        },
        {
          id: 'dexnav',
          name: 'DexNav',
          summary: 'A formula the declarative models cannot express.',
          charmApplies: true,
          inputs: [
            {
              id: 'searchLevel',
              kind: 'number',
              label: 'Search level',
              min: 0,
              max: 999,
              default: 0,
            },
            { id: 'bonus', kind: 'toggle', label: 'Bonus', default: false },
            {
              id: 'flavour',
              kind: 'select',
              label: 'Flavour',
              options: [
                { id: 'plain', label: 'Plain' },
                { id: 'spicy', label: 'Spicy' },
              ],
              default: 'plain',
            },
          ],
          model: {
            kind: 'custom',
            formula: 'fixture-dexnav',
            spec: 'rolls = 1 + charmRolls + scale * floor(searchLevel / 100) + (bonus ? 4 : 0); p = 1 - (1 - 1/4096)^rolls',
            params: { scale: 3 },
          },
          checkpoints: [
            {
              label: 'Search level 200',
              shinyCharm: false,
              inputs: { searchLevel: 200 },
              oneIn: 585.57,
            },
          ],
          sources: SOURCE,
        },
        {
          id: 'grid',
          name: 'Stepped inputs',
          summary: 'Number inputs with coarse and fractional steps.',
          charmApplies: true,
          inputs: [
            {
              id: 'level',
              kind: 'number',
              label: 'Level',
              min: 10,
              max: 95,
              step: 10,
              default: 10,
            },
            {
              id: 'ratio',
              kind: 'number',
              label: 'Ratio',
              min: 0,
              max: 1,
              step: 0.25,
              default: 0.5,
            },
          ],
          model: {
            kind: 'rolls',
            baseRolls: 1,
            bonuses: [{ kind: 'linear', label: 'Level', input: 'level', perUnit: 0.1 }],
          },
          checkpoints: [
            { label: 'Level 90', shinyCharm: false, inputs: { level: 90 }, oneIn: 410.05 },
          ],
          sources: SOURCE,
        },
      ],
    },
    {
      id: 'dppt',
      name: 'Diamond / Pearl / Platinum',
      shortName: 'DPPt',
      generation: 4,
      platform: 'DS',
      releaseYear: 2006,
      baseDenominator: 8192,
      versionGroups: ['diamond-pearl', 'platinum'],
      shinyCharmRolls: null,
      methods: [
        fullOdds(8192),
        {
          id: 'mystery',
          name: 'Mystery method',
          summary: 'Uses a formula nobody has implemented.',
          charmApplies: false,
          inputs: [],
          model: { kind: 'custom', formula: 'fixture-unregistered', spec: 'unknown' },
          checkpoints: [{ label: 'Unknown', shinyCharm: false, inputs: {}, oneIn: 200 }],
          sources: SOURCE,
        },
      ],
    },
  ],
  sandwiches: { summary: '', herba: [], recipes: [], notes: [], sources: [] },
};

const dexnavFormula: OddsFormula = (context) =>
  context.rollsToProbability(
    1 +
      context.charmRolls +
      context.param('scale') * Math.floor(context.number('searchLevel') / 100) +
      (context.toggle('bonus') ? 4 : 0),
  );

function sel(
  gameId: string,
  methodId: string,
  inputs: Record<string, OddsInputValue> = {},
  shinyCharm = false,
): OddsSelection {
  return { gameId, methodId, shinyCharm, inputs };
}

/** `1 − (1 − 1/d)^rolls`, written the naive way so it is independent of the engine. */
function rollsP(rolls: number, denominator = 4096): number {
  return 1 - Math.pow(1 - 1 / denominator, rolls);
}

function expectRelative(actual: number, expected: number, tolerance = 1e-10): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * tolerance);
}

/** Digits after the decimal point of a short decimal literal such as 0.05. */
function decimalsOf(value: number): number {
  return (String(value).split('.')[1] ?? '').length;
}

/** Small deterministic generator, so a failing randomised case reproduces. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const engine = createOddsEngine(FIXTURE, { formulas: { 'fixture-dexnav': dexnavFormula } });

afterEach(() => {
  unregisterFormula('fixture-unregistered');
  unregisterFormula('fixture-dexnav');
});

// ───────────────────────────── Tests ─────────────────────────────

describe('fixture', () => {
  it('is a valid odds data document', () => {
    expect(validateOddsData(FIXTURE)).toEqual([]);
  });

  it('is never mutated by the engine', () => {
    const snapshot = structuredClone(FIXTURE);
    const scratch = createOddsEngine(FIXTURE);
    for (const game of scratch.games) {
      for (const method of game.methods) {
        const selection = sel(game.id, method.id, {}, true);
        scratch.compute(selection);
        scratch.bestCase(selection);
        scratch.describeOdds(selection);
        scratch.chainProbabilities(selection, method.inputs[0]?.id ?? 'none', 5);
      }
    }
    scratch.gamesByGeneration();
    scratch.checkCheckpoints();
    expect(FIXTURE).toEqual(snapshot);
  });
});

describe('createOddsEngine', () => {
  it('exposes games and lookups', () => {
    expect(engine.data).toBe(FIXTURE);
    expect(engine.games.map((game) => game.id)).toEqual([
      'sv',
      'swsh',
      'bdsp',
      'lgpe',
      'oras',
      'dppt',
    ]);
    expect(engine.defaultGame.id).toBe('sv');
    expect(engine.getGame('oras')?.shortName).toBe('ORAS');
    expect(engine.getGame('nope')).toBeUndefined();
    expect(engine.getMethod('sv', 'masuda')?.name).toBe('Masuda Method');
    expect(engine.getMethod('sv', 'nope')).toBeUndefined();
    expect(engine.getMethod('nope', 'masuda')).toBeUndefined();
  });

  it('groups games by generation, newest first', () => {
    const groups = engine.gamesByGeneration();
    expect(groups.map((group) => group.generation)).toEqual([9, 8, 7, 6, 4]);
    // Within a generation the newest release leads, regardless of data order.
    expect(groups[1]?.games.map((game) => game.id)).toEqual(['bdsp', 'swsh']);
    expect(groups.flatMap((group) => group.games)).toHaveLength(engine.games.length);
  });

  it('falls back to the first game when the default game id is absent', () => {
    const withoutDefault = createOddsEngine({ ...FIXTURE, games: FIXTURE.games.slice(1) });
    expect(withoutDefault.defaultGame.id).toBe('swsh');
    expect(withoutDefault.normalizeSelection(sel('sv', 'masuda'))).toEqual(
      sel('swsh', 'full-odds'),
    );
  });

  it('drops games without methods and rejects data without any usable game', () => {
    const empty: GameDef = { ...(FIXTURE.games[0] as GameDef), id: 'empty', methods: [] };
    const sparse = createOddsEngine({ ...FIXTURE, games: [empty, ...FIXTURE.games] });
    expect(sparse.getGame('empty')).toBeUndefined();
    expect(sparse.games).toHaveLength(FIXTURE.games.length);

    expect(() => createOddsEngine({ ...FIXTURE, games: [] })).toThrow(/no game/i);
    expect(() => createOddsEngine({ ...FIXTURE, games: [empty] })).toThrow(/no game/i);
    expect(() => createOddsEngine({} as OddsData)).toThrow(/no game/i);
  });

  it("uses a game's first method when it has no full-odds entry", () => {
    const game = FIXTURE.games[0] as GameDef;
    const odd = createOddsEngine({
      ...FIXTURE,
      games: [{ ...game, methods: game.methods.slice(1) }],
    });
    expect(odd.normalizeSelection(sel('sv', 'nope')).methodId).toBe('masuda');
  });
});

describe('normalizeSelection', () => {
  it('replaces an unknown game with the default game at full odds', () => {
    expect(engine.normalizeSelection(sel('atlantis', 'masuda', { cleared: 5 }, true))).toEqual(
      sel('sv', 'full-odds', {}, true),
    );
  });

  it('replaces an unknown method with full-odds', () => {
    expect(engine.normalizeSelection(sel('swsh', 'masuda'))).toEqual(sel('swsh', 'full-odds'));
  });

  it('gives a substituted method its defaults, not the inputs of the method it replaces', () => {
    // As in the real data: full-odds itself declares an input, and other methods share its id.
    const game = FIXTURE.games[0] as GameDef;
    const sparkling = (game.methods[2] as MethodDef).inputs[1] as SelectInput;
    const boostable: MethodDef = {
      ...fullOdds(4096),
      inputs: [sparkling],
      model: {
        kind: 'rolls',
        baseRolls: 1,
        bonuses: [
          {
            kind: 'select',
            label: 'Sparkling Power',
            input: 'sparkling',
            rolls: { lv1: 1, lv2: 2, lv3: 3 },
          },
        ],
      },
    };
    const local = createOddsEngine({
      ...FIXTURE,
      games: [
        { ...game, methods: [boostable, ...game.methods.slice(1)] },
        ...FIXTURE.games.slice(1),
      ],
    });
    const plain = sel('sv', 'full-odds', { sparkling: 'none' });

    // Known method: the value is the player's own and is kept.
    expect(local.normalizeSelection(sel('sv', 'full-odds', { sparkling: 'lv3' }))).toEqual(
      sel('sv', 'full-odds', { sparkling: 'lv3' }),
    );
    // Unknown method / unknown game: the stale value must not boost the stand-in.
    expect(local.normalizeSelection(sel('sv', 'retired-method', { sparkling: 'lv3' }))).toEqual(
      plain,
    );
    expect(local.normalizeSelection(sel('atlantis', 'outbreak', { sparkling: 'lv3' }))).toEqual(
      plain,
    );
    const result = local.compute(sel('atlantis', 'full-odds', { sparkling: 'lv3' }));
    expect(result.perPokemon).toBe(1 / 4096);
    expect(result.warnings).toHaveLength(1);
    // A patch that leaves the method unresolvable ends on plain full odds as well…
    expect(
      local.updateSelection(sel('sv', 'outbreak', { sparkling: 'lv3' }), { methodId: 'nope' }),
    ).toEqual(plain);
    // …whereas moving between two real methods carries a shared input across.
    expect(
      local.updateSelection(sel('sv', 'outbreak', { sparkling: 'lv3' }), { methodId: 'full-odds' }),
    ).toEqual(sel('sv', 'full-odds', { sparkling: 'lv3' }));
  });

  it('fills defaults and prunes undeclared inputs', () => {
    expect(engine.normalizeSelection(sel('sv', 'outbreak'))).toEqual(
      sel('sv', 'outbreak', { cleared: 0, sparkling: 'none' }),
    );
    expect(
      engine.normalizeSelection(
        sel('sv', 'outbreak', { cleared: 45, chain: 12, shinyCharm: true, lure: true }),
      ),
    ).toEqual(sel('sv', 'outbreak', { cleared: 45, sparkling: 'none' }));
    expect(engine.normalizeSelection(sel('sv', 'gated'))).toEqual(
      sel('sv', 'gated', { lure: false, aura: true, combo: 0 }),
    );
  });

  it('clamps numbers to their range', () => {
    const normalize = (cleared: OddsInputValue): OddsInputValue | undefined =>
      engine.normalizeSelection(sel('sv', 'outbreak', { cleared })).inputs.cleared;
    expect(normalize(-20)).toBe(0);
    expect(normalize(100)).toBe(100);
    expect(normalize(5000)).toBe(100);
    expect(normalize(Infinity)).toBe(0); // not a usable number → default
    expect(normalize(NaN)).toBe(0);
    expect(normalize('61')).toBe(61);
    expect(normalize('sixty')).toBe(0);
    expect(normalize(true)).toBe(0);
  });

  it('snaps numbers to the step grid anchored at min', () => {
    const level = (value: OddsInputValue): OddsInputValue | undefined =>
      engine.normalizeSelection(sel('oras', 'grid', { level: value })).inputs.level;
    expect(level(10)).toBe(10);
    expect(level(14)).toBe(10);
    expect(level(15)).toBe(20);
    expect(level(37)).toBe(40);
    expect(level(2)).toBe(10);
    expect(level(94)).toBe(90);
    expect(level(95)).toBe(90); // max is off the grid: the largest grid value wins
    expect(level(400)).toBe(90);

    const ratio = (value: OddsInputValue): OddsInputValue | undefined =>
      engine.normalizeSelection(sel('oras', 'grid', { ratio: value })).inputs.ratio;
    expect(ratio(0.6)).toBe(0.5);
    expect(ratio(0.63)).toBe(0.75);
    expect(ratio(0.1)).toBe(0);
    expect(ratio(7)).toBe(1);
    expect(engine.normalizeSelection(sel('oras', 'grid')).inputs).toEqual({
      level: 10,
      ratio: 0.5,
    });

    // No declared step means whole numbers.
    expect(engine.normalizeSelection(sel('sv', 'outbreak', { cleared: 12.6 })).inputs.cleared).toBe(
      13,
    );
  });

  it('reaches a maximum that sits on a decimal step grid', () => {
    // 3 × 0.1 is 0.30000000000000004 in binary: the top of the range must not
    // be mistaken for an overshoot and pushed down a step.
    const game = FIXTURE.games[0] as GameDef;
    const decimal = (min: number, max: number, step: number): MethodDef => ({
      ...fullOdds(4096),
      inputs: [{ id: 'ratio', kind: 'number', label: 'Ratio', min, max, step, default: min }],
      model: {
        kind: 'rolls',
        baseRolls: 1,
        bonuses: [{ kind: 'linear', label: 'Ratio', input: 'ratio', perUnit: 10 }],
      },
    });
    const normalize = (min: number, max: number, step: number, value: OddsInputValue) =>
      createOddsEngine({
        ...FIXTURE,
        games: [{ ...game, methods: [decimal(min, max, step)] }],
      }).compute(sel('sv', 'full-odds', { ratio: value }));

    expect(normalize(0, 0.3, 0.1, 0.3).inputs.ratio).toBe(0.3);
    expect(normalize(0, 0.3, 0.1, 99).inputs.ratio).toBe(0.3);
    expect(normalize(0, 0.6, 0.1, 0.6).inputs.ratio).toBe(0.6);
    expect(normalize(0, 0.7, 0.1, '0.7').inputs.ratio).toBe(0.7);
    expect(normalize(0.1, 0.3, 0.1, 0.3).inputs.ratio).toBe(0.3);
    expect(normalize(0, 1.7, 0.1, 1.7).inputs.ratio).toBe(1.7);
    // …and the odds follow the value actually selected (1 base roll + 10 × 0.3).
    expectRelative(normalize(0, 0.3, 0.1, 0.3).perPokemon, rollsP(4));
    // A maximum that really is off the grid still falls back to the last grid value.
    expect(normalize(0, 0.35, 0.1, 0.35).inputs.ratio).toBe(0.3);
    expect(normalize(0, 0.35, 0.1, 9).inputs.ratio).toBe(0.3);
  });

  it('validates select and toggle values', () => {
    const outbreak = (sparkling: OddsInputValue): OddsInputValue | undefined =>
      engine.normalizeSelection(sel('sv', 'outbreak', { sparkling })).inputs.sparkling;
    expect(outbreak('lv2')).toBe('lv2');
    expect(outbreak('lv9')).toBe('none');
    expect(outbreak(3)).toBe('none');
    expect(outbreak('toString')).toBe('none');

    const gated = engine.normalizeSelection(sel('sv', 'gated', { lure: 'yes', aura: 0 })).inputs;
    expect(gated).toEqual({ lure: false, aura: true, combo: 0 });
    expect(
      engine.normalizeSelection(sel('sv', 'gated', { lure: true, aura: false })).inputs,
    ).toMatchObject({
      lure: true,
      aura: false,
    });
  });

  it('forces the charm off only when the game has none', () => {
    expect(engine.normalizeSelection(sel('dppt', 'full-odds', {}, true)).shinyCharm).toBe(false);
    // The method ignores the charm, but the player still owns it.
    expect(engine.normalizeSelection(sel('sv', 'static', {}, true)).shinyCharm).toBe(true);
    expect(engine.normalizeSelection(sel('bdsp', 'poke-radar', {}, true)).shinyCharm).toBe(true);
    const truthy = { ...sel('sv', 'full-odds'), shinyCharm: 'yes' } as unknown as OddsSelection;
    expect(engine.normalizeSelection(truthy).shinyCharm).toBe(false);
  });

  it('is idempotent and leaves its argument alone', () => {
    const raw = sel('oras', 'grid', { level: 37, ratio: 0.9, junk: 'x' }, true);
    const frozen = structuredClone(raw);
    const once = engine.normalizeSelection(raw);
    expect(raw).toEqual(frozen);
    expect(once).not.toBe(raw);
    expect(once.inputs).not.toBe(raw.inputs);
    expect(engine.normalizeSelection(once)).toEqual(once);
  });

  it('survives malformed selections', () => {
    const fallback = sel('sv', 'full-odds');
    for (const junk of [
      null,
      undefined,
      42,
      'sv',
      [],
      {},
      { gameId: 7, methodId: null, inputs: 'x' },
    ]) {
      expect(engine.normalizeSelection(junk as unknown as OddsSelection)).toEqual(fallback);
    }
    const partial = {
      gameId: 'sv',
      methodId: 'outbreak',
      inputs: null,
    } as unknown as OddsSelection;
    expect(engine.normalizeSelection(partial)).toEqual(
      sel('sv', 'outbreak', { cleared: 0, sparkling: 'none' }),
    );
  });
});

describe('defaultSelection / updateSelection / chainInput', () => {
  it('builds default selections', () => {
    expect(engine.defaultSelection()).toEqual(sel('sv', 'full-odds'));
    expect(engine.defaultSelection('oras')).toEqual(sel('oras', 'full-odds'));
    expect(engine.defaultSelection('oras', 'grid')).toEqual(
      sel('oras', 'grid', { level: 10, ratio: 0.5 }),
    );
    expect(engine.defaultSelection('nope', 'grid')).toEqual(sel('sv', 'full-odds'));
  });

  it('patches and renormalises', () => {
    const start = engine.defaultSelection('sv', 'outbreak');
    const withInput = engine.updateSelection(start, { inputs: { cleared: 70 } });
    expect(withInput).toEqual(sel('sv', 'outbreak', { cleared: 70, sparkling: 'none' }));
    expect(start.inputs.cleared).toBe(0);

    const withCharm = engine.updateSelection(withInput, {
      shinyCharm: true,
      inputs: { sparkling: 'lv3' },
    });
    expect(withCharm).toEqual(sel('sv', 'outbreak', { cleared: 70, sparkling: 'lv3' }, true));

    // Switching method drops the old inputs; switching game keeps a method both games share.
    expect(engine.updateSelection(withCharm, { methodId: 'masuda' })).toEqual(
      sel('sv', 'masuda', {}, true),
    );
    expect(engine.updateSelection(sel('sv', 'full-odds', {}, true), { gameId: 'swsh' })).toEqual(
      sel('swsh', 'full-odds', {}, true),
    );
    expect(engine.updateSelection(withCharm, { gameId: 'swsh' })).toEqual(
      sel('swsh', 'full-odds', {}, true),
    );
    expect(engine.updateSelection(withCharm, { gameId: 'dppt' })).toEqual(sel('dppt', 'full-odds'));
  });

  it("finds a method's chain input", () => {
    expect(engine.chainInput(sel('bdsp', 'poke-radar'))?.id).toBe('chain');
    expect(engine.chainInput(sel('sv', 'outbreak'))?.id).toBe('cleared');
    expect(engine.chainInput(sel('sv', 'gated'))).toBeNull();
    expect(engine.chainInput(sel('sv', 'full-odds'))).toBeNull();
  });
});

describe('compute — rolls model', () => {
  it('computes base odds', () => {
    const result = engine.compute(sel('sv', 'full-odds'));
    expect(result.valid).toBe(true);
    expect(result.game.id).toBe('sv');
    expect(result.method.id).toBe('full-odds');
    expect(result.perPokemon).toBe(1 / 4096);
    expect(result.perEncounter).toBe(1 / 4096);
    expect(result.oneIn).toBe(4096);
    expect(result.oneInPerPokemon).toBe(4096);
    expect(result.pokemonPerEncounter).toBe(1);
    expect(result.rolls).toBe(1);
    expect(result.denominator).toBe(4096);
    expect(result.breakdown).toEqual([{ kind: 'base', label: BASE_ROLL_LABEL, rolls: 1 }]);
    expect(result.charmApplied).toBe(false);
    expect(result.charmAvailable).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.selection).toEqual(sel('sv', 'full-odds'));
    expect(result.inputs).toBe(result.selection.inputs);
  });

  it('adds the Shiny Charm rolls', () => {
    const result = engine.compute(sel('sv', 'full-odds', {}, true));
    expectRelative(result.perPokemon, rollsP(3));
    expectRelative(result.oneIn, 1365.6667, 1e-6);
    expect(result.rolls).toBe(3);
    expect(result.charmApplied).toBe(true);
    expect(result.breakdown).toEqual([
      { kind: 'base', label: BASE_ROLL_LABEL, rolls: 1 },
      { kind: 'charm', label: SHINY_CHARM_LABEL, rolls: 2 },
    ]);
  });

  it('adds constant bonuses', () => {
    const plain = engine.compute(sel('sv', 'masuda'));
    expectRelative(plain.perPokemon, rollsP(6));
    expectRelative(plain.oneIn, 683.0835, 1e-6);
    expect(plain.rolls).toBe(6);

    const charm = engine.compute(sel('sv', 'masuda', {}, true));
    expectRelative(charm.oneIn, 512.4377, 1e-6);
    expect(charm.breakdown).toEqual([
      { kind: 'base', label: BASE_ROLL_LABEL, rolls: 1 },
      { kind: 'charm', label: SHINY_CHARM_LABEL, rolls: 2 },
      { kind: 'bonus', label: 'Masuda Method', rolls: 5 },
    ]);
  });

  it('picks the highest tier reached', () => {
    const rollsAt = (cleared: number): number | null =>
      engine.compute(sel('sv', 'outbreak', { cleared })).rolls;
    expect(rollsAt(0)).toBe(1);
    expect(rollsAt(29)).toBe(1);
    expect(rollsAt(30)).toBe(2);
    expect(rollsAt(59)).toBe(2);
    expect(rollsAt(60)).toBe(3);
    expect(rollsAt(100)).toBe(3);
    expectRelative(engine.compute(sel('sv', 'outbreak', { cleared: 60 })).perPokemon, rollsP(3));
  });

  it('maps select options to rolls, missing ids adding none', () => {
    const rollsFor = (sparkling: string): number | null =>
      engine.compute(sel('sv', 'outbreak', { sparkling })).rolls;
    expect(rollsFor('none')).toBe(1);
    expect(rollsFor('lv1')).toBe(2);
    expect(rollsFor('lv2')).toBe(3);
    expect(rollsFor('lv3')).toBe(4);

    const stacked = engine.compute(sel('sv', 'outbreak', { cleared: 75, sparkling: 'lv3' }, true));
    expect(stacked.rolls).toBe(8);
    expectRelative(stacked.perPokemon, rollsP(8));
    expect(stacked.breakdown).toEqual([
      { kind: 'base', label: BASE_ROLL_LABEL, rolls: 1 },
      { kind: 'charm', label: SHINY_CHARM_LABEL, rolls: 2 },
      { kind: 'bonus', label: 'Outbreak', rolls: 2, input: 'cleared' },
      { kind: 'bonus', label: 'Sparkling Power', rolls: 3, input: 'sparkling' },
    ]);
    // Inactive bonuses are left out of the breakdown.
    expect(engine.compute(sel('sv', 'outbreak')).breakdown).toHaveLength(1);
  });

  it('scales linear bonuses up to their cap', () => {
    // Aura off so that only certain rolls remain besides the "Lucky break" gate.
    const certainRolls = (combo: number): number => {
      const result = engine.compute(sel('sv', 'gated', { aura: false, combo }));
      return (result.rolls ?? NaN) - 0.4;
    };
    expect(certainRolls(0)).toBeCloseTo(1, 12);
    expect(certainRolls(5)).toBeCloseTo(6, 12);
    expect(certainRolls(10)).toBeCloseTo(11, 12);
    expect(certainRolls(50)).toBeCloseTo(11, 12);

    const fractional = engine.compute(sel('oras', 'grid', { level: 90 }));
    expect(fractional.rolls).toBeCloseTo(10, 12);
    expectRelative(fractional.perPokemon, rollsP(10));
    expectRelative(engine.compute(sel('oras', 'grid', { level: 30 })).perPokemon, rollsP(4));
  });

  it('mixes chance-gated bonuses over every on/off combination', () => {
    const result = engine.compute(sel('sv', 'gated', { lure: true, aura: true, combo: 5 }));

    // Hand-computed mixture: 6 certain rolls, plus gates (rolls, chance).
    const gates: [number, number][] = [
      [3, 0.5],
      [2, 0.25],
      [4, 0.1],
    ];
    let expected = 0;
    let weightTotal = 0;
    for (let mask = 0; mask < 1 << gates.length; mask++) {
      let weight = 1;
      let rolls = 6;
      gates.forEach(([gateRolls, chance], index) => {
        const active = (mask & (1 << index)) !== 0;
        weight *= active ? chance : 1 - chance;
        if (active) rolls += gateRolls;
      });
      weightTotal += weight;
      expected += weight * rollsP(rolls);
    }
    expect(weightTotal).toBeCloseTo(1, 14);

    expectRelative(result.perPokemon, expected);
    expect(result.rolls).toBeCloseTo(6 + 1.5 + 0.5 + 0.4, 12);
    // The mixture is not the same as using the expected roll count.
    expect(Math.abs(result.perPokemon - rollsP(8.4))).toBeGreaterThan(1e-9);
    expect(result.breakdown).toEqual([
      { kind: 'base', label: BASE_ROLL_LABEL, rolls: 1 },
      { kind: 'bonus', label: 'Lure', rolls: 3, chance: 0.5, input: 'lure' },
      { kind: 'bonus', label: 'Aura', rolls: 2, chance: 0.25, input: 'aura' },
      { kind: 'bonus', label: 'Combo', rolls: 5, input: 'combo' },
      { kind: 'bonus', label: 'Lucky break', rolls: 4, chance: 0.1 },
    ]);
  });

  it('mixes a single gate exactly', () => {
    const result = engine.compute(sel('sv', 'gated', { aura: false }, true));
    // Base 1 + charm 2, and a 10 % chance of 4 more.
    expectRelative(result.perPokemon, 0.9 * rollsP(3) + 0.1 * rollsP(7));
    expect(result.rolls).toBeCloseTo(3.4, 12);
  });

  it('treats a chance of 1 as certain and a chance of 0 as never', () => {
    const game = FIXTURE.games[0] as GameDef;
    const method = (chance: number): MethodDef => ({
      ...fullOdds(4096),
      model: {
        kind: 'rolls',
        baseRolls: 1,
        bonuses: [{ kind: 'constant', label: 'Gate', rolls: 3, chance }],
      },
    });
    const withChance = (chance: number) =>
      createOddsEngine({ ...FIXTURE, games: [{ ...game, methods: [method(chance)] }] }).compute(
        sel('sv', 'full-odds'),
      );

    const certain = withChance(1);
    expectRelative(certain.perPokemon, rollsP(4));
    expect(certain.breakdown[1]).toEqual({ kind: 'bonus', label: 'Gate', rolls: 3 });

    const never = withChance(0);
    expect(never.perPokemon).toBe(1 / 4096);
    expect(never.rolls).toBe(1);
    expect(never.breakdown).toHaveLength(1);
  });

  it('ignores the charm for methods it does not apply to', () => {
    const off = engine.compute(sel('sv', 'static'));
    const on = engine.compute(sel('sv', 'static', {}, true));
    expect(on.perPokemon).toBe(off.perPokemon);
    expect(on.charmApplied).toBe(false);
    expect(on.charmAvailable).toBe(true);
    expect(on.selection.shinyCharm).toBe(true);
    expect(on.breakdown.some((row) => row.kind === 'charm')).toBe(false);
  });

  it('honours a per-method denominator', () => {
    const result = engine.compute(sel('sv', 'static'));
    expectRelative(result.perPokemon, 1 - 0.99 ** 2);
    expect(result.denominator).toBe(100);
    expect(result.rolls).toBe(2);
  });

  it('never applies a charm the game does not have', () => {
    const result = engine.compute(sel('dppt', 'full-odds', {}, true));
    expect(result.perPokemon).toBe(1 / 8192);
    expect(result.oneIn).toBe(8192);
    expect(result.charmAvailable).toBe(false);
    expect(result.charmApplied).toBe(false);
    expect(result.selection.shinyCharm).toBe(false);
  });

  it('combines several Pokémon per encounter', () => {
    const result = engine.compute(sel('oras', 'horde'));
    expect(result.pokemonPerEncounter).toBe(5);
    expect(result.perPokemon).toBe(1 / 4096);
    expect(result.oneInPerPokemon).toBe(4096);
    expectRelative(result.perEncounter, 1 - Math.pow(4095 / 4096, 5));
    expectRelative(result.oneIn, 819.6001, 1e-6);

    const charm = engine.compute(sel('oras', 'horde', {}, true));
    expectRelative(charm.perEncounter, 1 - Math.pow(4095 / 4096, 15));
  });

  it('survives degenerate roll data', () => {
    const game = FIXTURE.games[0] as GameDef;
    const build = (model: MethodDef['model'], baseDenominator = 4096) =>
      createOddsEngine({
        ...FIXTURE,
        games: [{ ...game, baseDenominator, methods: [{ ...fullOdds(4096), model }] }],
      }).compute(sel('sv', 'full-odds', {}, true));

    // A denominator of 1 makes every roll a hit.
    expect(build({ kind: 'rolls', baseRolls: 1, bonuses: [], denominator: 1 }).perPokemon).toBe(1);
    // No rolls at all: impossible.
    const none = build({ kind: 'rolls', baseRolls: 0, bonuses: [] }, 4096);
    expectRelative(none.perPokemon, rollsP(2)); // only the charm rolls remain
    const invalid = build({ kind: 'rolls', baseRolls: 1, bonuses: [], denominator: 0 });
    expect(invalid.valid).toBe(false);
    expect(invalid.warnings).toHaveLength(1);
    expect(invalid.perPokemon).toBe(1 / 4096);
  });
});

describe('compute — rolls model against brute force', () => {
  it('matches an explicit enumeration of every on/off combination', () => {
    const random = seededRandom(20261013);
    const int = (bound: number): number => Math.floor(random() * bound);
    const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
    const maybeChance = (): { chance?: number } => {
      const roll = random();
      if (roll < 0.35) return {};
      if (roll < 0.45) return { chance: 0 };
      if (roll < 0.55) return { chance: 1 };
      return { chance: Math.round(random() * 100) / 100 };
    };
    const inputs: MethodDef['inputs'] = [
      { id: 'first', kind: 'toggle', label: 'First', default: false },
      { id: 'second', kind: 'toggle', label: 'Second', default: false },
      {
        id: 'mode',
        kind: 'select',
        label: 'Mode',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
        ],
        default: 'a',
      },
      { id: 'count', kind: 'number', label: 'Count', min: 0, max: 50, default: 0 },
    ];
    const template = FIXTURE.games[0] as GameDef;

    for (let round = 0; round < 500; round++) {
      const baseDenominator = pick([8192, 4096, 65536, 100, 2, 1]);
      const shinyCharmRolls = random() < 0.25 ? null : int(4);
      const charmApplies = random() < 0.7;
      const baseRolls = int(3);
      const denominator = random() < 0.2 ? pick([100, 4096, 3]) : undefined;
      const bonuses: RollBonus[] = Array.from({ length: int(7) }, (_, index): RollBonus => {
        const label = `Bonus ${index}`;
        switch (int(5)) {
          case 0:
            return { kind: 'constant', label, rolls: int(5), ...maybeChance() };
          case 1:
            return {
              kind: 'toggle',
              label,
              input: pick(['first', 'second']),
              rolls: int(5),
              ...maybeChance(),
            };
          case 2:
            return {
              kind: 'select',
              label,
              input: 'mode',
              rolls: { b: int(4), c: int(6) },
              ...maybeChance(),
            };
          case 3:
            return {
              kind: 'tiers',
              label,
              input: 'count',
              // Deliberately unsorted; the last one may reset the bonus to nothing.
              tiers: [
                { min: 30, rolls: 3 },
                { min: 10, rolls: 1 },
                { min: 20, rolls: 2 },
                { min: 40, rolls: 0 },
              ].slice(0, 1 + int(4)),
              ...maybeChance(),
            };
          default:
            return {
              kind: 'linear',
              label,
              input: 'count',
              perUnit: pick([1, 0.5, 0.1]),
              ...(random() < 0.5 ? { maxUnits: int(40) } : {}),
              ...maybeChance(),
            };
        }
      });
      const method: MethodDef = {
        ...fullOdds(4096),
        id: 'random',
        charmApplies,
        inputs,
        model: {
          kind: 'rolls',
          baseRolls,
          bonuses,
          ...(denominator === undefined ? {} : { denominator }),
        },
        checkpoints: [],
      };
      const local = createOddsEngine({
        ...FIXTURE,
        games: [
          { ...template, baseDenominator, shinyCharmRolls, methods: [fullOdds(4096), method] },
        ],
      });
      const toggles: Record<string, boolean> = { first: random() < 0.5, second: random() < 0.5 };
      const chosen = { ...toggles, mode: pick(['a', 'b', 'c']), count: int(51) };
      const shinyCharm = random() < 0.5;
      const result = local.compute(sel('sv', 'random', chosen, shinyCharm));

      // The same model, evaluated the long way round.
      const perRoll = 1 / (denominator ?? baseDenominator);
      const charmOn = shinyCharm && charmApplies && shinyCharmRolls !== null;
      let certain = baseRolls + (charmOn ? (shinyCharmRolls ?? 0) : 0);
      const gates: [rolls: number, chance: number][] = [];
      for (const bonus of bonuses) {
        let rolls = 0;
        if (bonus.kind === 'constant') rolls = bonus.rolls;
        else if (bonus.kind === 'toggle') rolls = toggles[bonus.input] === true ? bonus.rolls : 0;
        else if (bonus.kind === 'select') rolls = bonus.rolls[chosen.mode] ?? 0;
        else if (bonus.kind === 'tiers') {
          let highest = -Infinity;
          for (const tier of bonus.tiers) {
            if (tier.min <= chosen.count && tier.min > highest) {
              highest = tier.min;
              rolls = tier.rolls;
            }
          }
        } else rolls = bonus.perUnit * Math.min(chosen.count, bonus.maxUnits ?? Infinity);
        if (bonus.chance === undefined) certain += rolls;
        else gates.push([rolls, bonus.chance]);
      }
      let expected = 0;
      for (let mask = 0; mask < 1 << gates.length; mask++) {
        let weight = 1;
        let rolls = certain;
        gates.forEach(([gateRolls, chance], index) => {
          if ((mask & (1 << index)) !== 0) {
            weight *= chance;
            rolls += gateRolls;
          } else weight *= 1 - chance;
        });
        expected += weight * (1 - Math.pow(1 - perRoll, rolls));
      }
      const expectedRolls = gates.reduce(
        (total, [rolls, chance]) => total + rolls * chance,
        certain,
      );

      const context = `round ${round}: ${JSON.stringify({ baseDenominator, denominator, shinyCharmRolls, charmApplies, baseRolls, bonuses, chosen, shinyCharm })}`;
      expect(result.valid, context).toBe(true);
      expect(result.charmApplied, context).toBe(charmOn);
      expect(Math.abs(result.perPokemon - expected), context).toBeLessThanOrEqual(expected * 1e-9);
      expect(result.rolls, context).toBeCloseTo(expectedRolls, 9);
      // The breakdown accounts for every roll: Σ rolls × chance is the expected count.
      const listed = result.breakdown.reduce(
        (total, row) => total + row.rolls * (row.chance ?? 1),
        0,
      );
      expect(listed, context).toBeCloseTo(expectedRolls, 9);
      expect(result.perEncounter, context).toBe(result.perPokemon);
    }
  });
});

describe('compute — fixed model', () => {
  it('uses the default odds when no case matches', () => {
    const result = engine.compute(sel('swsh', 'dynamax-adventure'));
    expect(result.valid).toBe(true);
    expect(result.perPokemon).toBe(1 / 300);
    expect(result.oneIn).toBeCloseTo(300, 9);
    expect(result.rolls).toBeNull();
    expect(result.denominator).toBeNull();
    expect(result.breakdown).toEqual([]);
  });

  it('branches on the reserved shinyCharm key', () => {
    const result = engine.compute(sel('swsh', 'dynamax-adventure', {}, true));
    expect(result.perPokemon).toBe(1 / 100);
    expect(result.charmApplied).toBe(true);
  });

  it('takes the first case whose keys all match', () => {
    const odds = (inputs: Record<string, OddsInputValue>, charm = false): number =>
      engine.compute(sel('swsh', 'fixed-switch', inputs, charm)).oneIn;
    expect(odds({})).toBeCloseTo(1000, 6);
    expect(odds({ mode: 'c' })).toBeCloseTo(1000, 6);
    expect(odds({ mode: 'b' })).toBeCloseTo(200, 6);
    expect(odds({ mode: 'b', boost: true })).toBeCloseTo(50, 6);
    // Both the first and the third case match here: the first one wins.
    expect(odds({ mode: 'b', boost: true }, true)).toBeCloseTo(50, 6);
    expect(odds({ boost: true }, true)).toBeCloseTo(20, 6);
    expect(odds({ boost: true })).toBeCloseTo(1000, 6);
    expect(odds({}, true)).toBeCloseTo(1000, 6);
  });

  it('only matches shinyCharm when the charm actually applies', () => {
    const game = FIXTURE.games[1] as GameDef;
    const method = game.methods[1] as MethodDef;
    const build = (overrides: Partial<GameDef>, methodOverrides: Partial<MethodDef>) =>
      createOddsEngine({
        ...FIXTURE,
        games: [
          { ...game, ...overrides, methods: [fullOdds(4096), { ...method, ...methodOverrides }] },
        ],
      }).compute(sel('swsh', 'dynamax-adventure', {}, true));

    expect(build({}, {}).perPokemon).toBe(1 / 100);
    expect(build({}, { charmApplies: false }).perPokemon).toBe(1 / 300);
    expect(build({ shinyCharmRolls: null }, {}).perPokemon).toBe(1 / 300);
  });

  it('flags malformed odds instead of throwing', () => {
    const game = FIXTURE.games[1] as GameDef;
    const broken = createOddsEngine({
      ...FIXTURE,
      games: [
        {
          ...game,
          methods: [
            fullOdds(4096),
            { ...(game.methods[1] as MethodDef), model: { kind: 'fixed', odds: [1, 0] } },
          ],
        },
      ],
    }).compute(sel('swsh', 'dynamax-adventure'));
    expect(broken.valid).toBe(false);
    expect(broken.perPokemon).toBe(1 / 4096);
    expect(broken.warnings[0]).toMatch(/malformed/i);
  });
});

describe('compute — table model', () => {
  it('looks the odds up by the input value', () => {
    const at = (chain: number): number =>
      engine.compute(sel('bdsp', 'poke-radar', { chain })).perPokemon;
    expect(at(0)).toBe(1 / 4096);
    expect(at(1)).toBe(2 / 4096);
    expect(at(17)).toBe(18 / 4096);
    expect(at(40)).toBe(41 / 4096);
    const result = engine.compute(sel('bdsp', 'poke-radar', { chain: 40 }));
    expect(result.rolls).toBeNull();
    expect(result.breakdown).toEqual([]);
    expectRelative(result.oneIn, 4096 / 41);
  });

  it('clamps the index to the table', () => {
    // The input allows 0–31 but the table has three rows.
    const at = (combo: number, charm = false): number =>
      engine.compute(sel('lgpe', 'catch-combo', { combo }, charm)).oneIn;
    expect(at(0)).toBeCloseTo(4096, 6);
    expect(at(1)).toBeCloseTo(1024, 6);
    expect(at(2)).toBeCloseTo(512, 6);
    expect(at(3)).toBeCloseTo(512, 6);
    expect(at(31)).toBeCloseTo(512, 6);
    expect(at(-9)).toBeCloseTo(4096, 6);
  });

  it('rounds fractional values to the nearest row', () => {
    const at = (combo: number): number =>
      engine.compute(sel('lgpe', 'catch-combo', { combo })).oneIn;
    expect(at(0.5)).toBeCloseTo(1024, 6); // Math.round(0.5) = 1
    expect(at(1.5)).toBeCloseTo(512, 6);
  });

  it('switches to the charm table when the charm applies', () => {
    const at = (combo: number): number =>
      engine.compute(sel('lgpe', 'catch-combo', { combo }, true)).oneIn;
    expectRelative(at(0), 4096 / 3);
    expect(at(1)).toBeCloseTo(512, 6);
    expect(at(31)).toBeCloseTo(256, 6);

    // No charm table, charm not applicable: the charm changes nothing.
    const radar = engine.compute(sel('bdsp', 'poke-radar', { chain: 40 }, true));
    expect(radar.perPokemon).toBe(41 / 4096);
    expect(radar.charmApplied).toBe(false);
  });
});

describe('compute — custom model', () => {
  it('falls back to base odds when the formula is not registered', () => {
    const result = engine.compute(sel('dppt', 'mystery'));
    expect(result.valid).toBe(false);
    expect(result.perPokemon).toBe(1 / 8192);
    expect(result.oneIn).toBe(8192);
    expect(result.rolls).toBeNull();
    expect(result.breakdown).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('fixture-unregistered');
    expect(result.method.id).toBe('mystery');
  });

  it('evaluates formulas passed in the options', () => {
    const result = engine.compute(sel('oras', 'dexnav', { searchLevel: 250, bonus: true }, true));
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    // 1 base + 2 charm + 3 × floor(250 / 100) + 4.
    expectRelative(result.perPokemon, rollsP(13));
    expect(result.rolls).toBeNull();
  });

  it('hands the formula a complete context', () => {
    const spy = vi.fn((context: FormulaContext) => {
      void context;
      return 0.25;
    });
    const local = createOddsEngine(FIXTURE, { formulas: { 'fixture-dexnav': spy } });
    const result = local.compute(
      sel('oras', 'dexnav', { searchLevel: 321, flavour: 'spicy' }, true),
    );
    expect(result.perPokemon).toBe(0.25);
    expect(spy).toHaveBeenCalledTimes(1);

    const context = spy.mock.calls[0]?.[0] as FormulaContext;
    expect(context.game.id).toBe('oras');
    expect(context.method.id).toBe('dexnav');
    expect(context.params).toEqual({ scale: 3 });
    expect(context.inputs).toEqual({ searchLevel: 321, bonus: false, flavour: 'spicy' });
    expect(context.charmApplied).toBe(true);
    expect(context.charmRolls).toBe(2);
    expect(context.denominator).toBe(4096);
    expect(context.number('searchLevel')).toBe(321);
    expect(context.number('missing')).toBe(0);
    expect(context.number('missing', 9)).toBe(9);
    expect(context.number('flavour', 9)).toBe(9);
    expect(context.toggle('bonus')).toBe(false);
    expect(context.toggle('missing')).toBe(false);
    expect(context.select('flavour')).toBe('spicy');
    expect(context.select('searchLevel')).toBe('');
    expect(context.param('scale')).toBe(3);
    expect(context.param('missing')).toBe(0);
    expect(context.param('toString', 5)).toBe(5);
    expectRelative(context.rollsToProbability(3), rollsP(3));
    expectRelative(context.rollsToProbability(2, 100), 1 - 0.99 ** 2);

    local.compute(sel('oras', 'dexnav'));
    expect(spy.mock.calls[1]?.[0].charmApplied).toBe(false);
    expect(spy.mock.calls[1]?.[0].charmRolls).toBe(0);
  });

  it('accepts a detailed formula result', () => {
    const local = createOddsEngine(FIXTURE, {
      formulas: {
        'fixture-dexnav': () => ({
          perPokemon: 0.01,
          rolls: 7,
          breakdown: [{ kind: 'bonus', label: 'Search level', rolls: 6 }],
          warnings: ['Approximation'],
        }),
      },
    });
    const result = local.compute(sel('oras', 'dexnav'));
    expect(result.valid).toBe(true);
    expect(result.perPokemon).toBe(0.01);
    expect(result.rolls).toBe(7);
    expect(result.denominator).toBe(4096);
    expect(result.breakdown).toEqual([{ kind: 'bonus', label: 'Search level', rolls: 6 }]);
    expect(result.warnings).toEqual(['Approximation']);
  });

  it('reports a denominator only alongside a usable roll count', () => {
    const withRolls = (rolls: number | null | undefined) =>
      createOddsEngine(FIXTURE, {
        formulas: { 'fixture-dexnav': () => ({ perPokemon: 0.01, rolls }) },
      }).compute(sel('oras', 'dexnav'));
    expect(withRolls(4)).toMatchObject({ valid: true, rolls: 4, denominator: 4096 });
    for (const unusable of [NaN, Infinity, null, undefined]) {
      expect(withRolls(unusable)).toMatchObject({ valid: true, rolls: null, denominator: null });
    }
  });

  it('contains formulas that throw or return nonsense', () => {
    const outcomes: [string, OddsFormula][] = [
      [
        'throws',
        () => {
          throw new Error('boom');
        },
      ],
      ['NaN', () => NaN],
      ['negative', () => -0.1],
      ['above one', () => 1.5],
      ['object without odds', () => ({ perPokemon: Number.NaN })],
      ['undefined', (() => undefined) as unknown as OddsFormula],
      ['null', (() => null) as unknown as OddsFormula],
    ];
    for (const [label, formula] of outcomes) {
      const local = createOddsEngine(FIXTURE, { formulas: { 'fixture-dexnav': formula } });
      const result = local.compute(sel('oras', 'dexnav'));
      expect(result.valid, label).toBe(false);
      expect(result.perPokemon, label).toBe(1 / 4096);
      expect(result.warnings, label).toHaveLength(1);
      expect(result.warnings[0], label).toContain('fixture-dexnav');
    }
    const thrown = createOddsEngine(FIXTURE, {
      formulas: {
        'fixture-dexnav': () => {
          throw new Error('boom');
        },
      },
    }).compute(sel('oras', 'dexnav'));
    expect(thrown.warnings[0]).toContain('boom');
  });

  it('accepts the probability bounds 0 and 1', () => {
    const at = (value: number) =>
      createOddsEngine(FIXTURE, { formulas: { 'fixture-dexnav': () => value } }).compute(
        sel('oras', 'dexnav'),
      );
    expect(at(0)).toMatchObject({ valid: true, perPokemon: 0, perEncounter: 0, oneIn: Infinity });
    expect(at(1)).toMatchObject({ valid: true, perPokemon: 1, oneIn: 1 });
  });

  it('resolves formulas from the global registry, engine-local ones first', () => {
    const fresh = createOddsEngine(FIXTURE);
    expect(fresh.hasFormula('fixture-unregistered')).toBe(false);
    expect(fresh.missingFormulas()).toEqual([
      { gameId: 'oras', methodId: 'dexnav', formula: 'fixture-dexnav' },
      { gameId: 'dppt', methodId: 'mystery', formula: 'fixture-unregistered' },
    ]);
    expect(engine.missingFormulas()).toEqual([
      { gameId: 'dppt', methodId: 'mystery', formula: 'fixture-unregistered' },
    ]);

    // Registered after the engine was built: lookups happen at compute time.
    registerFormula('fixture-unregistered', () => 1 / 200);
    expect(hasFormula('fixture-unregistered')).toBe(true);
    expect(fresh.hasFormula('fixture-unregistered')).toBe(true);
    const viaGlobal = fresh.compute(sel('dppt', 'mystery'));
    expect(viaGlobal.valid).toBe(true);
    expect(viaGlobal.oneIn).toBeCloseTo(200, 9);

    fresh.registerFormula('fixture-unregistered', () => 1 / 50);
    expect(fresh.compute(sel('dppt', 'mystery')).oneIn).toBeCloseTo(50, 9);
    // …but only for that engine.
    expect(engine.compute(sel('dppt', 'mystery')).oneIn).toBeCloseTo(200, 9);

    expect(unregisterFormula('fixture-unregistered')).toBe(true);
    expect(unregisterFormula('fixture-unregistered')).toBe(false);
    expect(engine.compute(sel('dppt', 'mystery')).valid).toBe(false);
    expect(fresh.compute(sel('dppt', 'mystery')).valid).toBe(true);
  });
});

describe('compute — normalisation', () => {
  it('reports substituted games and methods as warnings', () => {
    const unknownGame = engine.compute(sel('atlantis', 'masuda', {}, true));
    expect(unknownGame.valid).toBe(true);
    expect(unknownGame.game.id).toBe('sv');
    expect(unknownGame.method.id).toBe('full-odds');
    expect(unknownGame.warnings).toHaveLength(1);
    expect(unknownGame.warnings[0]).toContain('atlantis');

    const unknownMethod = engine.compute(sel('swsh', 'masuda'));
    expect(unknownMethod.method.id).toBe('full-odds');
    expect(unknownMethod.perPokemon).toBe(1 / 4096);
    expect(unknownMethod.warnings).toHaveLength(1);
    expect(unknownMethod.warnings[0]).toContain('masuda');
  });

  it('evaluates the normalised inputs', () => {
    const result = engine.compute(
      sel('sv', 'outbreak', { cleared: 9999, sparkling: 'bogus', extra: 1 }),
    );
    expect(result.inputs).toEqual({ cleared: 100, sparkling: 'none' });
    expect(result.rolls).toBe(3);
    expect(result.warnings).toEqual([]);
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, 0, 'x', [], { inputs: { a: { b: 1 } } }]) {
      const result = engine.compute(junk as unknown as OddsSelection);
      expect(result.perPokemon).toBe(1 / 4096);
      expect(result.game.id).toBe('sv');
    }
  });
});

describe('chainProbabilities', () => {
  it('grows the chain by one per encounter and holds at the cap', () => {
    const chain = engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', 45);
    expect(chain).toHaveLength(45);
    expect(chain.slice(0, 41)).toEqual(
      Array.from({ length: 41 }, (_, index) => (index + 1) / 4096),
    );
    expect(chain.slice(41)).toEqual([41 / 4096, 41 / 4096, 41 / 4096, 41 / 4096]);
  });

  it('starts at the current value unless told otherwise', () => {
    expect(engine.chainProbabilities(sel('bdsp', 'poke-radar', { chain: 38 }), 'chain', 4)).toEqual(
      [39, 40, 41, 41].map((numerator) => numerator / 4096),
    );
    expect(
      engine.chainProbabilities(sel('bdsp', 'poke-radar', { chain: 38 }), 'chain', 3, 0),
    ).toEqual([1, 2, 3].map((numerator) => numerator / 4096));
    expect(engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', 2, 999)).toEqual([
      41 / 4096,
      41 / 4096,
    ]);
    expect(engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', 2, -5)).toEqual([
      1 / 4096,
      2 / 4096,
    ]);
    expect(
      engine.chainProbabilities(sel('bdsp', 'poke-radar', { chain: 3 }), 'chain', 1, NaN),
    ).toEqual([4 / 4096]);
  });

  it('works for tiered roll bonuses and keeps the other inputs', () => {
    const chain = engine.chainProbabilities(
      sel('sv', 'outbreak', { cleared: 28, sparkling: 'lv1' }, true),
      'cleared',
      4,
    );
    // Charm 2 + base 1 + Lv. 1; the outbreak tier kicks in at 30.
    expectRelative(chain[0] ?? NaN, rollsP(4));
    expectRelative(chain[1] ?? NaN, rollsP(4));
    expectRelative(chain[2] ?? NaN, rollsP(5));
    expectRelative(chain[3] ?? NaN, rollsP(5));
  });

  it('advances by one even when the input has a coarser step', () => {
    const chain = engine.chainProbabilities(sel('oras', 'grid', { level: 10 }), 'level', 3);
    expectRelative(chain[0] ?? NaN, rollsP(2));
    expectRelative(chain[1] ?? NaN, rollsP(2.1));
    expectRelative(chain[2] ?? NaN, rollsP(2.2));
  });

  it('returns per-encounter odds for multi-Pokémon encounters', () => {
    const [first] = engine.chainProbabilities(sel('oras', 'horde'), 'anything', 1);
    expectRelative(first ?? NaN, 1 - Math.pow(4095 / 4096, 5));
  });

  it('is flat for anything that is not a number input', () => {
    const flat = rollsP(1);
    expect(engine.chainProbabilities(sel('sv', 'outbreak'), 'sparkling', 3)).toEqual([
      flat,
      flat,
      flat,
    ]);
    expect(engine.chainProbabilities(sel('sv', 'outbreak'), 'missing', 2)).toEqual([flat, flat]);
    expect(engine.chainProbabilities(sel('sv', 'full-odds'), 'chain', 2)).toEqual([flat, flat]);
  });

  it('clamps the requested length', () => {
    expect(engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', 0)).toEqual([]);
    expect(engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', -3)).toEqual([]);
    expect(engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', NaN)).toEqual([]);
    expect(engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', 2.9)).toHaveLength(2);
    expect(engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', Infinity)).toHaveLength(
      MAX_CHAIN_LENGTH,
    );
  });

  it('feeds a ramping cumulative curve', () => {
    const chain = engine.chainProbabilities(sel('bdsp', 'poke-radar'), 'chain', 41);
    const ramping = cumulativeVarying(chain, 300);
    const flatWorst = cumulativeProbability(1 / 4096, 300);
    const flatBest = cumulativeProbability(41 / 4096, 300);
    expect(ramping).toBeGreaterThan(flatWorst);
    expect(ramping).toBeLessThan(flatBest);
    // Past the array the capped odds repeat: 259 encounters at 41/4096 after the ramp.
    let miss = 1;
    for (let index = 0; index < 41; index++) miss *= 1 - (index + 1) / 4096;
    expectRelative(ramping, 1 - miss * Math.pow(1 - 41 / 4096, 259));
  });
});

describe('bestCase', () => {
  it('turns the charm on for a method without inputs', () => {
    const best = engine.bestCase(sel('sv', 'masuda'));
    expect(best.selection).toEqual(sel('sv', 'masuda', {}, true));
    expect(best.rolls).toBe(8);
  });

  it('maxes every boosting input', () => {
    const best = engine.bestCase(sel('sv', 'outbreak'));
    expect(best.rolls).toBe(8);
    expect(best.selection.shinyCharm).toBe(true);
    expect(best.selection.inputs.sparkling).toBe('lv3');
    expect(best.selection.inputs.cleared).toBeGreaterThanOrEqual(60);
    expectRelative(best.perPokemon, rollsP(8));
  });

  it('can leave the charm as selected', () => {
    const best = engine.bestCase(sel('sv', 'outbreak'), { keepCharm: true });
    expect(best.selection.shinyCharm).toBe(false);
    expect(best.rolls).toBe(6);
    expect(engine.bestCase(sel('sv', 'outbreak', {}, true), { keepCharm: true }).rolls).toBe(8);
  });

  it('keeps inputs that are already optimal', () => {
    const already = sel('sv', 'outbreak', { cleared: 73, sparkling: 'lv3' }, true);
    expect(engine.bestCase(already).selection).toEqual(already);
  });

  it('switches gated toggles on', () => {
    const best = engine.bestCase(sel('sv', 'gated', { aura: false }));
    expect(best.selection).toEqual(sel('sv', 'gated', { lure: true, aura: true, combo: 50 }, true));
    expect(best.rolls).toBeCloseTo(1 + 2 + 10 + 1.5 + 0.5 + 0.4, 12);
  });

  it('finds interacting optima in fixed models', () => {
    // Mode B looks better on its own (1/200) but blocks the boost + charm case (1/20).
    const best = engine.bestCase(sel('swsh', 'fixed-switch', { mode: 'b' }));
    expect(best.oneIn).toBeCloseTo(20, 6);
    expect(best.selection.inputs.boost).toBe(true);
    expect(best.selection.inputs.mode).not.toBe('b');
    expect(best.selection.shinyCharm).toBe(true);
    expect(engine.bestCase(sel('swsh', 'fixed-switch'), { keepCharm: true }).oneIn).toBeCloseTo(
      50,
      6,
    );
  });

  it('searches table rows', () => {
    expect(engine.bestCase(sel('bdsp', 'poke-radar')).perPokemon).toBe(41 / 4096);
    expect(engine.bestCase(sel('lgpe', 'catch-combo')).oneIn).toBeCloseTo(256, 6);
    expect(engine.bestCase(sel('lgpe', 'catch-combo'), { keepCharm: true }).oneIn).toBeCloseTo(
      512,
      6,
    );
  });

  it('does not turn on a charm that cannot help', () => {
    expect(engine.bestCase(sel('sv', 'static')).selection.shinyCharm).toBe(false);
    expect(engine.bestCase(sel('sv', 'static', {}, true)).selection.shinyCharm).toBe(true);
    expect(engine.bestCase(sel('dppt', 'full-odds')).oneIn).toBe(8192);
  });

  it('climbs coordinate-wise when the search space is too large', () => {
    for (const start of [
      sel('sv', 'mega'),
      sel('sv', 'mega', { aura: 'a5', streak: 500, x: true }, true),
    ]) {
      const best = engine.bestCase(start);
      // 1 base + 2 charm + 12 streak + 5 power + 7 aura + 1 + 2, and a 50 % chance of 2 more.
      expect(best.rolls).toBeCloseTo(31, 12);
      expectRelative(best.perPokemon, 0.5 * rollsP(30) + 0.5 * rollsP(32));
      expect(best.selection.inputs).toMatchObject({
        power: 'p5',
        aura: 'a3',
        x: true,
        y: true,
        z: true,
      });
      expect(best.selection.inputs.streak).toBeGreaterThanOrEqual(120);
    }
  });

  it('works with custom formulas and reports missing ones as invalid', () => {
    const best = engine.bestCase(sel('oras', 'dexnav'));
    // Search level 999 → 3 × 9, plus charm, base and the bonus toggle.
    expectRelative(best.perPokemon, rollsP(1 + 2 + 27 + 4));
    const missing = engine.bestCase(sel('dppt', 'mystery'));
    expect(missing.valid).toBe(false);
    expect(missing.perPokemon).toBe(1 / 8192);
  });
});

describe('describeOdds', () => {
  it('summarises a selection for the UI', () => {
    const description = engine.describeOdds(sel('sv', 'outbreak', { cleared: 60 }));
    expect(description.result.rolls).toBe(3);
    expect(description.baseProbability).toBe(1 / 4096);
    expectRelative(description.multiplier, rollsP(3) * 4096);
    expectRelative(description.expectedEncounters, 1 / rollsP(3));
    expect(description.milestones.map((milestone) => milestone.probability)).toEqual([
      0.25, 0.5, 0.75, 0.9, 0.95, 0.99,
    ]);
    expect(description.milestones[1]?.encounters).toBe(encountersForProbability(rollsP(3), 0.5));
    expect(description.best.rolls).toBe(8);
    expect(description.atBest).toBe(false);
    expect(description.chainInput?.id).toBe('cleared');
  });

  it('recognises a selection that is already at its best', () => {
    const description = engine.describeOdds(
      sel('sv', 'outbreak', { cleared: 100, sparkling: 'lv3' }, true),
    );
    expect(description.atBest).toBe(true);
    expect(description.best.perPokemon).toBe(description.result.perPokemon);
    expect(engine.describeOdds(sel('dppt', 'full-odds'))).toMatchObject({
      atBest: true,
      multiplier: 1,
      expectedEncounters: 8192,
      chainInput: null,
    });
  });

  it('uses per-encounter odds for the encounter figures', () => {
    const description = engine.describeOdds(sel('oras', 'horde'));
    expect(description.multiplier).toBe(1);
    expectRelative(description.expectedEncounters, 819.6001, 1e-6);
  });
});

describe('checkpoints', () => {
  it('evaluates every checkpoint of the fixture', () => {
    const reports = engine.checkCheckpoints();
    const total = FIXTURE.games.flatMap((game) =>
      game.methods.flatMap((method) => method.checkpoints),
    ).length;
    expect(reports).toHaveLength(total);

    const failures = reports.filter((report) => !report.pass);
    expect(failures.map((report) => `${report.gameId}/${report.methodId}`)).toEqual([
      'dppt/mystery',
    ]);
    expect(failures[0]).toMatchObject({ evaluated: false, pass: false });
  });

  it('measures the relative error against the per-Pokémon odds', () => {
    const report = engine.evaluateCheckpoint('oras', 'horde', {
      label: 'Per Pokémon',
      shinyCharm: false,
      inputs: {},
      oneIn: 4096,
    });
    expect(report).toMatchObject({
      gameId: 'oras',
      methodId: 'horde',
      evaluated: true,
      expectedOneIn: 4096,
      actualOneIn: 4096,
      relativeError: 0,
      tolerance: DEFAULT_CHECKPOINT_TOLERANCE,
      pass: true,
    });
  });

  it('applies the default and the per-checkpoint tolerance', () => {
    const check = (oneIn: number, tolerance?: number) =>
      engine.evaluateCheckpoint('sv', 'full-odds', {
        label: 'x',
        shinyCharm: false,
        inputs: {},
        oneIn,
        tolerance,
      });
    expect(check(4096).pass).toBe(true);
    expect(check(4096 / 1.009).pass).toBe(true);
    expect(check(4096 / 1.02).pass).toBe(false);
    expect(check(4096 / 1.02).relativeError).toBeCloseTo(0.02, 10);
    expect(check(4096 / 1.02, 0.05).pass).toBe(true);
    expect(check(4096 / 1.0001, 0.00001).pass).toBe(false);
    expect(check(0).pass).toBe(false);
    expect(check(0).relativeError).toBe(Infinity);
  });

  it('passes the checkpoint inputs and charm through', () => {
    const report = engine.evaluateCheckpoint('sv', 'outbreak', {
      label: 'x',
      shinyCharm: true,
      inputs: { cleared: 60, sparkling: 'lv3' },
      oneIn: 512.44,
    });
    expect(report.pass).toBe(true);
    expect(report.result.rolls).toBe(8);
  });

  it('never passes a checkpoint for a method it could not find or evaluate', () => {
    const checkpoint = { label: 'x', shinyCharm: false, inputs: {}, oneIn: 4096 };
    // The fallback (SV full odds) happens to match the number; it still must not count.
    expect(engine.evaluateCheckpoint('sv', 'nope', checkpoint)).toMatchObject({
      evaluated: false,
      pass: false,
    });
    expect(engine.evaluateCheckpoint('nope', 'full-odds', checkpoint)).toMatchObject({
      evaluated: false,
      pass: false,
    });
    expect(
      engine.evaluateCheckpoint('dppt', 'mystery', { ...checkpoint, oneIn: 8192 }),
    ).toMatchObject({ evaluated: false, pass: false, relativeError: 0 });
  });
});

describe('helpers', () => {
  it('oddsToProbability', () => {
    expect(oddsToProbability([1, 4096])).toBe(1 / 4096);
    expect(oddsToProbability([3, 4])).toBe(0.75);
    expect(oddsToProbability([0, 5])).toBe(0);
    expect(oddsToProbability([9, 3])).toBe(1);
    expect(oddsToProbability([1, 0])).toBe(0);
    expect(oddsToProbability([-1, 5])).toBe(0);
    expect(oddsToProbability([NaN, 5])).toBe(0);
    expect(oddsToProbability(undefined as unknown as [number, number])).toBe(0);
  });

  it('probabilityToOneIn', () => {
    expect(probabilityToOneIn(1 / 4096)).toBe(4096);
    expect(probabilityToOneIn(1)).toBe(1);
    expect(probabilityToOneIn(2)).toBe(1);
    expect(probabilityToOneIn(0)).toBe(Infinity);
    expect(probabilityToOneIn(-1)).toBe(Infinity);
    expect(probabilityToOneIn(NaN)).toBe(Infinity);
  });

  it('rollsToProbability', () => {
    expect(rollsToProbability(1, 4096)).toBe(1 / 4096);
    expectRelative(rollsToProbability(3, 4096), rollsP(3));
    expectRelative(rollsToProbability(2.5, 8192), rollsP(2.5, 8192));
    expect(rollsToProbability(5, 1)).toBe(1);
    expect(rollsToProbability(0, 4096)).toBe(0);
    expect(rollsToProbability(-2, 4096)).toBe(0);
    expect(rollsToProbability(3, 0)).toBe(0);
    expect(rollsToProbability(NaN, 4096)).toBe(0);
    expect(rollsToProbability(3, NaN)).toBe(0);
  });

  it('normalizeNumberInput', () => {
    const input: NumberInput = { id: 'n', kind: 'number', label: 'N', min: 1, max: 10, default: 4 };
    expect(normalizeNumberInput(input, 7)).toBe(7);
    expect(normalizeNumberInput(input, 7.4)).toBe(7);
    expect(normalizeNumberInput(input, undefined)).toBe(4);
    expect(normalizeNumberInput(input, null)).toBe(4);
    expect(normalizeNumberInput(input, '')).toBe(4);
    expect(normalizeNumberInput(input, ' 9 ')).toBe(9);
    expect(normalizeNumberInput(input, 0)).toBe(1);
    expect(normalizeNumberInput(input, 11)).toBe(10);
    // Fractional steps come back without binary noise.
    const tenths: NumberInput = { ...input, min: 0, max: 1, step: 0.1, default: 0 };
    expect(normalizeNumberInput(tenths, 0.3)).toBe(0.3);
    expect(normalizeNumberInput(tenths, 0.34)).toBe(0.3);
    expect(normalizeNumberInput(tenths, 0.7000000001)).toBe(0.7);
    // Every value of a decimal grid — the maximum included — is a fixed point.
    for (const step of [0.1, 0.2, 0.05, 0.25, 0.01, 0.3, 0.15, 2, 5]) {
      for (const min of [0, 0.1, 1, -1, 0.5]) {
        const places = Math.max(decimalsOf(step), decimalsOf(min));
        for (let count = 1; count <= 25; count++) {
          const max = Number((min + count * step).toFixed(places));
          const grid: NumberInput = { ...input, min, max, step, default: min };
          for (let index = 0; index <= count; index++) {
            const value = Number((min + index * step).toFixed(places));
            expect(normalizeNumberInput(grid, value), `${min}…${max} step ${step}`).toBe(value);
          }
          expect(normalizeNumberInput(grid, max + 10 * step)).toBe(max);
          expect(normalizeNumberInput(grid, min - 10 * step)).toBe(min);
        }
      }
    }
    // Defensive: a reversed range and a bad step still give a value inside the range.
    expect(normalizeNumberInput({ ...input, min: 10, max: 1 }, 20)).toBe(10);
    expect(normalizeNumberInput({ ...input, step: 0 }, 3.2)).toBe(3);
    expect(normalizeNumberInput({ ...input, step: -2 }, 3.2)).toBe(3);
    expect(normalizeNumberInput({ ...input, default: NaN }, 'x')).toBe(1);
  });

  it('normalizeInputValue', () => {
    const select: SelectInput = {
      id: 's',
      kind: 'select',
      label: 'S',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      default: 'b',
    };
    expect(normalizeInputValue(select, 'a')).toBe('a');
    expect(normalizeInputValue(select, 'z')).toBe('b');
    expect(normalizeInputValue({ ...select, default: 'gone' }, 'z')).toBe('a');
    expect(normalizeInputValue({ ...select, options: [], default: 'gone' }, 'z')).toBe('');
    expect(
      normalizeInputValue({ id: 't', kind: 'toggle', label: 'T', default: true }, undefined),
    ).toBe(true);
    expect(normalizeInputValue({ id: 't', kind: 'toggle', label: 'T', default: true }, false)).toBe(
      false,
    );
    expect(normalizeInputValue({ id: 't', kind: 'toggle', label: 'T', default: false }, 1)).toBe(
      false,
    );
  });
});
