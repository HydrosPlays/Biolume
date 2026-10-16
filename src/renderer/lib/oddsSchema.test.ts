import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as z from 'zod';
import type {
  FixedModel,
  GameDef,
  MethodDef,
  NumberInput,
  OddsData,
  RollsModel,
  SelectInput,
  TableModel,
} from '@renderer/data/schema';
import { OddsDataError, oddsDataSchema, parseOddsData, validateOddsData } from './oddsSchema';

const URL = 'https://bulbapedia.bulbagarden.net/wiki/Shiny_Pok%C3%A9mon';

function fullOdds(denominator: number): MethodDef {
  return {
    id: 'full-odds',
    name: 'Full odds',
    summary: 'Plain random encounters.',
    charmApplies: true,
    inputs: [],
    model: { kind: 'rolls', baseRolls: 1, bonuses: [] },
    checkpoints: [{ label: 'Base', shinyCharm: false, inputs: {}, oneIn: denominator }],
    sources: [URL],
  };
}

/** A small document that uses every model kind, bonus kind, input kind and optional field. */
function validDocument(): OddsData {
  return {
    version: 3,
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
        versionGroups: ['scarlet-violet', 'the-teal-mask'],
        shinyCharmRolls: 2,
        methods: [
          fullOdds(4096),
          {
            id: 'outbreak',
            name: 'Mass Outbreak',
            summary: 'Clear an outbreak.',
            details: 'Knock out Pokémon from the outbreak to raise the odds.',
            charmApplies: true,
            inputs: [
              {
                id: 'cleared',
                kind: 'number',
                label: 'Cleared',
                description: 'Pokémon knocked out so far.',
                min: 0,
                max: 100,
                step: 10,
                default: 0,
                unit: 'KOs',
                chain: true,
              },
              {
                id: 'sparkling',
                kind: 'select',
                label: 'Sparkling Power',
                options: [
                  { id: 'none', label: 'None' },
                  { id: 'lv3', label: 'Lv. 3', description: 'Needs two Herba Mystica.' },
                ],
                default: 'none',
              },
              { id: 'encounterPower', kind: 'toggle', label: 'Encounter Power', default: false },
            ],
            model: {
              kind: 'rolls',
              baseRolls: 1,
              denominator: 4096,
              bonuses: [
                {
                  kind: 'tiers',
                  label: 'Outbreak',
                  input: 'cleared',
                  tiers: [
                    { min: 30, rolls: 1 },
                    { min: 60, rolls: 2 },
                  ],
                },
                { kind: 'select', label: 'Sparkling Power', input: 'sparkling', rolls: { lv3: 3 } },
                {
                  kind: 'toggle',
                  label: 'Encounter Power',
                  input: 'encounterPower',
                  rolls: 1,
                  chance: 0.5,
                },
                { kind: 'linear', label: 'Streak', input: 'cleared', perUnit: 0.01, maxUnits: 50 },
                { kind: 'constant', label: 'Event', rolls: 1 },
              ],
            },
            pokemonPerEncounter: 1,
            checkpoints: [
              {
                label: '60 cleared',
                shinyCharm: true,
                inputs: { cleared: 60, sparkling: 'lv3', encounterPower: false },
                oneIn: 455,
                tolerance: 0.05,
              },
            ],
            notes: ['Outbreak odds stack with Sparkling Power.'],
            sources: [URL],
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
          fullOdds(4096),
          {
            id: 'catch-combo',
            name: 'Catch Combo',
            summary: 'Catch the same species repeatedly.',
            charmApplies: true,
            inputs: [
              {
                id: 'combo',
                kind: 'number',
                label: 'Combo',
                min: 0,
                max: 31,
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
              ],
              charmTable: [
                [3, 4096],
                [1, 512],
              ],
            },
            checkpoints: [
              { label: 'Combo 31', shinyCharm: false, inputs: { combo: 31 }, oneIn: 1024 },
            ],
            sources: [URL],
          },
          {
            id: 'static',
            name: 'Static encounter',
            summary: 'Flat odds switched by a lure, a mode and the charm.',
            charmApplies: true,
            inputs: [
              { id: 'lure', kind: 'toggle', label: 'Lure', default: false },
              {
                id: 'mode',
                kind: 'select',
                label: 'Mode',
                options: [
                  { id: 'a', label: 'A' },
                  { id: 'b', label: 'B' },
                ],
                default: 'a',
              },
            ],
            model: {
              kind: 'fixed',
              odds: [1, 4096],
              cases: [{ when: { lure: true, mode: 'b', shinyCharm: true }, odds: [1, 1024] }],
            },
            checkpoints: [],
            sources: [URL],
          },
          {
            id: 'formula',
            name: 'Formula method',
            summary: 'Needs engine code.',
            charmApplies: true,
            inputs: [],
            model: {
              kind: 'custom',
              formula: 'lgpe-formula',
              spec: 'p = base * scale',
              params: { scale: 2 },
            },
            checkpoints: [{ label: 'Scaled', shinyCharm: false, inputs: {}, oneIn: 2048 }],
            sources: [URL],
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
        versionGroups: [],
        shinyCharmRolls: null,
        methods: [fullOdds(8192)],
      },
    ],
    sandwiches: {
      summary: 'Sparkling Power adds shiny rolls for one type.',
      herba: [{ id: 'salty', name: 'Salty Herba Mystica', source: '5★ and 6★ Tera Raids' }],
      recipes: [
        {
          id: 'dragon-sparkling-3',
          type: 'dragon',
          name: 'Dragon shiny sandwich',
          sparklingLevel: 3,
          herbaCount: 2,
          herba: { salty: 1, sweet: 1 },
          fillings: [{ name: 'Avocado', quantity: 1 }],
          condiments: [
            { name: 'Salty Herba Mystica', quantity: 1 },
            { name: 'Sweet Herba Mystica', quantity: 1 },
          ],
          powers: [
            { power: 'sparkling', type: 'dragon', level: 3 },
            { power: 'title', type: 'dragon', level: 3 },
            { power: 'egg', type: null, level: 1 },
          ],
          players: 1,
          minimal: true,
          notes: 'Any two Herba Mystica work.',
        },
      ],
      notes: ['Meal powers last 30 minutes.'],
      sources: [URL],
    },
  };
}

// ───────────────────────────── Helpers ─────────────────────────────

function gameOf(doc: OddsData, id: string): GameDef {
  const game = doc.games.find((entry) => entry.id === id);
  if (!game) throw new Error(`fixture has no game ${id}`);
  return game;
}

function methodOf(doc: OddsData, gameId: string, methodId: string): MethodDef {
  const method = gameOf(doc, gameId).methods.find((entry) => entry.id === methodId);
  if (!method) throw new Error(`fixture has no method ${gameId}/${methodId}`);
  return method;
}

const outbreak = (doc: OddsData): MethodDef => methodOf(doc, 'sv', 'outbreak');
const outbreakModel = (doc: OddsData): RollsModel => outbreak(doc).model as RollsModel;
const clearedInput = (doc: OddsData): NumberInput => outbreak(doc).inputs[0] as NumberInput;
const sparklingInput = (doc: OddsData): SelectInput => outbreak(doc).inputs[1] as SelectInput;
const comboModel = (doc: OddsData): TableModel =>
  methodOf(doc, 'lgpe', 'catch-combo').model as TableModel;
const staticModel = (doc: OddsData): FixedModel =>
  methodOf(doc, 'lgpe', 'static').model as FixedModel;

/** Issues reported after a type-safe edit of the valid document. */
function issuesAfter(edit: (doc: OddsData) => void): string[] {
  const doc = validDocument();
  edit(doc);
  return validateOddsData(doc);
}

type Json = Record<string, unknown>;

/** Issues reported after an edit that deliberately breaks the types. */
function issuesAfterRaw(edit: (doc: Json) => void): string[] {
  const doc = structuredClone(validDocument()) as unknown as Json;
  edit(doc);
  return validateOddsData(doc);
}

/** Walks a path of keys / indexes through untyped JSON. */
function at(root: unknown, ...path: (string | number)[]): Json {
  let node = root;
  for (const key of path) node = (node as Record<string | number, unknown>)[key];
  return node as Json;
}

/** Exactly one issue, containing every fragment. */
function expectSingleIssue(issues: string[], ...fragments: string[]): void {
  expect(issues).toHaveLength(1);
  for (const fragment of fragments) expect(issues[0]).toContain(fragment);
}

// ───────────────────────────── Tests ─────────────────────────────

describe('oddsDataSchema', () => {
  it('has exactly the OddsData shape', () => {
    // Checked by the compiler: a field added to schema.ts but not here (or the
    // other way round) fails `tsc`.
    expectTypeOf<z.output<typeof oddsDataSchema>>().toEqualTypeOf<OddsData>();

    const parsed = oddsDataSchema.safeParse(validDocument());
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(validDocument());
  });
});

describe('validateOddsData — structure', () => {
  it('accepts a valid document', () => {
    expect(validateOddsData(validDocument())).toEqual([]);
  });

  it('accepts a document without optional fields or games', () => {
    expect(
      validateOddsData({
        version: 0,
        updated: '2026-10-13T08:00:00Z',
        games: [],
        sandwiches: { summary: '', herba: [], recipes: [], notes: [], sources: [] },
      }),
    ).toEqual([]);
  });

  it('rejects things that are not a document', () => {
    for (const junk of [null, undefined, 42, 'oddsMethods', [], true]) {
      const issues = validateOddsData(junk);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]).toMatch(/^\(root\): /);
    }
    expect(validateOddsData({}).length).toBe(4);
  });

  it('names array items by id in the issue path', () => {
    const issues = issuesAfterRaw((doc) => {
      at(doc, 'games', 0, 'methods', 1, 'model', 'bonuses', 4).rolls = 'five';
    });
    expectSingleIssue(
      issues,
      'games[sv].methods[outbreak].model.bonuses[4].rolls: ',
      'expected number',
    );
  });

  it('reports every structural problem at once', () => {
    const issues = issuesAfterRaw((doc) => {
      at(doc, 'games', 0).generation = '9';
      at(doc, 'games', 1, 'methods', 0).charmApplies = 'yes';
      delete at(doc, 'sandwiches').summary;
      doc.version = 1.5;
    });
    expect(issues).toHaveLength(4);
    expect(issues.join('\n')).toContain('games[sv].generation');
    expect(issues.join('\n')).toContain('games[lgpe].methods[full-odds].charmApplies');
    expect(issues.join('\n')).toContain('sandwiches.summary');
    expect(issues.join('\n')).toContain('version');
  });

  it('rejects unknown keys, which are usually typos of optional ones', () => {
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        const method = at(doc, 'games', 0, 'methods', 1);
        method.pokemonPerEncouter = 5;
      }),
      'games[sv].methods[outbreak]',
      'pokemonPerEncouter',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 1, 'methods', 1, 'model').charmtable = [];
      }),
      'games[lgpe].methods[catch-combo].model',
      'charmtable',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 0, 'methods', 1, 'model', 'bonuses', 2).chanse = 0.5;
      }),
      'bonuses[2]',
      'chanse',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        doc.$schema = './schema.json';
      }),
      '(root)',
      '$schema',
    );
  });

  it('rejects unknown model, bonus and input kinds', () => {
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 0, 'methods', 0, 'model').kind = 'lookup';
      }),
      'games[sv].methods[full-odds].model.kind',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 0, 'methods', 1, 'model', 'bonuses', 0).kind = 'ladder';
      }),
      'model.bonuses[0].kind',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 0, 'methods', 1, 'inputs', 2).kind = 'checkbox';
      }),
      'inputs[encounterPower].kind',
    );
  });

  it('requires odds to be a [numerator, denominator] pair', () => {
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 1, 'methods', 2, 'model').odds = [1];
      }),
      'games[lgpe].methods[static].model.odds',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 1, 'methods', 2, 'model').odds = [1, 2, 3];
      }),
      'model.odds',
    );
    expectSingleIssue(
      issuesAfter((doc) => {
        comboModel(doc).table[1] = [1, 0];
      }),
      'model.table[1][1]',
    );
    expectSingleIssue(
      issuesAfter((doc) => {
        staticModel(doc).odds = [-1, 4096];
      }),
      'model.odds[0]',
    );
    expectSingleIssue(
      issuesAfter((doc) => {
        comboModel(doc).table = [];
      }),
      'model.table',
    );
  });

  it('range-checks numbers', () => {
    const cases: [string, (doc: OddsData) => void][] = [
      [
        'bonuses[2].chance',
        (doc) => void ((outbreakModel(doc).bonuses[2] as { chance?: number }).chance = 1.5),
      ],
      [
        'bonuses[4].rolls',
        (doc) => void ((outbreakModel(doc).bonuses[4] as { rolls: number }).rolls = -1),
      ],
      ['model.baseRolls', (doc) => void (outbreakModel(doc).baseRolls = -1)],
      ['model.denominator', (doc) => void (outbreakModel(doc).denominator = 0)],
      ['pokemonPerEncounter', (doc) => void (outbreak(doc).pokemonPerEncounter = 2.5)],
      ['pokemonPerEncounter', (doc) => void (outbreak(doc).pokemonPerEncounter = 0)],
      ['inputs[cleared].step', (doc) => void (clearedInput(doc).step = 0)],
      [
        'checkpoints[0].oneIn',
        (doc) => void ((outbreak(doc).checkpoints[0] as { oneIn: number }).oneIn = 0),
      ],
      [
        'checkpoints[0].tolerance',
        (doc) => void ((outbreak(doc).checkpoints[0] as { tolerance?: number }).tolerance = 0),
      ],
      ['games[sv].baseDenominator', (doc) => void (gameOf(doc, 'sv').baseDenominator = 0)],
      ['games[sv].shinyCharmRolls', (doc) => void (gameOf(doc, 'sv').shinyCharmRolls = -2)],
      ['games[sv].generation', (doc) => void (gameOf(doc, 'sv').generation = 0)],
      ['games[sv].releaseYear', (doc) => void (gameOf(doc, 'sv').releaseYear = 22)],
      [
        'recipes[dragon-sparkling-3].players',
        (doc) => void ((doc.sandwiches.recipes[0] as { players: number }).players = 0),
      ],
    ];
    for (const [fragment, edit] of cases) expectSingleIssue(issuesAfter(edit), fragment);
  });

  it('requires kebab-case ids, URL sources and an ISO date', () => {
    expectSingleIssue(
      issuesAfter((doc) => void (gameOf(doc, 'dppt').id = 'DPPt')),
      'games[DPPt].id',
      'kebab-case',
    );
    expectSingleIssue(
      issuesAfter((doc) => void (methodOf(doc, 'lgpe', 'static').id = 'static_encounter')),
      'kebab-case',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 1, 'methods', 3, 'model').formula = 'lgpeFormula';
      }),
      'model.formula',
    );
    expectSingleIssue(
      issuesAfter((doc) => void gameOf(doc, 'sv').versionGroups.push('Scarlet Violet')),
      'versionGroups[2]',
    );
    expectSingleIssue(
      issuesAfter((doc) => void outbreak(doc).sources.push('Bulbapedia')),
      'sources[1]',
      'URL',
    );
    expectSingleIssue(
      issuesAfter((doc) => void (doc.updated = 'October 13')),
      'updated',
      'ISO date',
    );
  });

  it('checks the sandwich tables', () => {
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'sandwiches', 'recipes', 0).sparklingLevel = 4;
      }),
      'sandwiches.recipes[dragon-sparkling-3].sparklingLevel',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'sandwiches', 'recipes', 0, 'herba').umami = 1;
      }),
      'recipes[dragon-sparkling-3].herba',
      'umami',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'sandwiches', 'recipes', 0, 'powers', 0).power = 'shiny';
      }),
      'powers[0].power',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'sandwiches', 'herba', 0).id = 'umami';
      }),
      'sandwiches.herba[umami].id',
    );
  });
});

describe('validateOddsData — semantics', () => {
  it('requires unique ids', () => {
    expectSingleIssue(
      issuesAfter((doc) => void (gameOf(doc, 'dppt').id = 'sv')),
      'games: duplicate game id "sv"',
    );
    expectSingleIssue(
      issuesAfter((doc) => void (methodOf(doc, 'lgpe', 'static').id = 'catch-combo')),
      'games[lgpe].methods: duplicate method id "catch-combo"',
    );
    expectSingleIssue(
      issuesAfter((doc) => {
        const inputs = outbreak(doc).inputs;
        inputs.push({ id: 'cleared', kind: 'toggle', label: 'Again', default: false });
      }),
      'games[sv].methods[outbreak].inputs: duplicate input id "cleared"',
    );
    expectSingleIssue(
      issuesAfter((doc) => void sparklingInput(doc).options.push({ id: 'lv3', label: 'Again' })),
      'inputs[sparkling].options: duplicate option id "lv3"',
    );
    expectSingleIssue(
      issuesAfter(
        (doc) => void doc.sandwiches.recipes.push(...structuredClone(doc.sandwiches.recipes)),
      ),
      'sandwiches.recipes: duplicate recipe id "dragon-sparkling-3"',
    );
    expectSingleIssue(
      issuesAfter(
        (doc) => void doc.sandwiches.herba.push({ id: 'salty', name: 'Again', source: '' }),
      ),
      'sandwiches.herba: duplicate herba id "salty"',
    );
  });

  it("requires every game's first method to be full-odds", () => {
    expectSingleIssue(
      issuesAfter((doc) => void gameOf(doc, 'lgpe').methods.reverse()),
      'games[lgpe].methods[0]',
      '"full-odds"',
      '"formula"',
    );
    expect(issuesAfter((doc) => void (gameOf(doc, 'dppt').methods = []))).toHaveLength(1);
  });

  it('reserves the shinyCharm input id', () => {
    expectSingleIssue(
      issuesAfter((doc) => {
        outbreak(doc).inputs.push({
          id: 'shinyCharm',
          kind: 'toggle',
          label: 'Shiny Charm',
          default: false,
        });
      }),
      'inputs[shinyCharm]',
      'reserved',
    );
  });

  it('checks select defaults', () => {
    expectSingleIssue(
      issuesAfter((doc) => void (sparklingInput(doc).default = 'lv2')),
      'inputs[sparkling].default',
      '"lv2" is not one of the options (none, lv3)',
    );
  });

  it('checks number ranges, defaults and step grids', () => {
    expectSingleIssue(
      issuesAfter((doc) => void (clearedInput(doc).default = 110)),
      'inputs[cleared].default',
      '110 is outside 0–100',
    );
    expectSingleIssue(
      issuesAfter((doc) => void (clearedInput(doc).default = -10)),
      'inputs[cleared].default',
    );
    expectSingleIssue(
      issuesAfter((doc) => {
        clearedInput(doc).min = 200;
        outbreak(doc).checkpoints = [];
      }),
      'inputs[cleared]',
      'min (200) is greater than max (100)',
    );
    expectSingleIssue(
      issuesAfter((doc) => void (clearedInput(doc).default = 25)),
      'inputs[cleared].default',
      '25 is not on the step grid (min 0, step 10)',
    );
    // Without a declared step the grid is whole numbers.
    expectSingleIssue(
      issuesAfter(
        (doc) =>
          void ((methodOf(doc, 'lgpe', 'catch-combo').inputs[0] as NumberInput).default = 0.5),
      ),
      'inputs[combo].default',
      'step 1',
    );
    expect(issuesAfter((doc) => void (clearedInput(doc).default = 100))).toEqual([]);
  });

  it('accepts values at the top of a decimal step grid', () => {
    // 3 × 0.1 is 0.30000000000000004 in binary; 0.3 is on the grid all the same.
    const decimalGrid = (value: number) => (doc: OddsData) => {
      Object.assign(clearedInput(doc), { min: 0, max: 0.3, step: 0.1, default: value });
      outbreak(doc).checkpoints = [
        { label: 'Top of the range', shinyCharm: false, inputs: { cleared: value }, oneIn: 4096 },
      ];
    };
    expect(issuesAfter(decimalGrid(0.3))).toEqual([]);
    expect(issuesAfter(decimalGrid(0.2))).toEqual([]);
    // Off the grid is still caught, for the default and for the checkpoint.
    const offGrid = issuesAfter(decimalGrid(0.25));
    expect(offGrid).toHaveLength(2);
    expect(offGrid[0]).toContain('inputs[cleared].default');
    expect(offGrid[1]).toContain('checkpoints[0].inputs.cleared');
  });

  it('checks that roll bonuses reference declared inputs of the right kind', () => {
    const retarget = (index: number, input: string) => (doc: OddsData) => {
      (outbreakModel(doc).bonuses[index] as { input: string }).input = input;
    };
    // tiers, select, toggle, linear — each pointed at a missing input…
    for (const index of [0, 1, 2, 3]) {
      expectSingleIssue(
        issuesAfter(retarget(index, 'ghost')),
        `games[sv].methods[outbreak].model.bonuses[${index}]`,
        'references input "ghost", which the method does not declare',
      );
    }
    // …and at an input of the wrong kind.
    expectSingleIssue(
      issuesAfter(retarget(0, 'sparkling')),
      'bonuses[0]',
      'needs a number input',
      'is a select input',
    );
    expectSingleIssue(
      issuesAfter(retarget(1, 'cleared')),
      'bonuses[1]',
      'needs a select input',
      'is a number input',
    );
    expectSingleIssue(issuesAfter(retarget(2, 'cleared')), 'bonuses[2]', 'needs a toggle input');
    expectSingleIssue(
      issuesAfter(retarget(3, 'encounterPower')),
      'bonuses[3]',
      'needs a number input',
      'is a toggle input',
    );
  });

  it('checks select-bonus keys and tier thresholds', () => {
    expectSingleIssue(
      issuesAfter((doc) => {
        (outbreakModel(doc).bonuses[1] as { rolls: Record<string, number> }).rolls.lv2 = 2;
      }),
      'bonuses[1].rolls',
      '"lv2" is not an option of the "sparkling" input',
    );
    expectSingleIssue(
      issuesAfter((doc) => {
        (outbreakModel(doc).bonuses[0] as { tiers: { min: number; rolls: number }[] }).tiers.push({
          min: 30,
          rolls: 5,
        });
      }),
      'bonuses[0].tiers',
      'two tiers start at 30',
    );
    expectSingleIssue(
      issuesAfterRaw((doc) => {
        at(doc, 'games', 0, 'methods', 1, 'model', 'bonuses', 0).tiers = [];
      }),
      'bonuses[0].tiers',
    );
  });

  it('checks table models', () => {
    expectSingleIssue(
      issuesAfter((doc) => void (comboModel(doc).input = 'chain')),
      'games[lgpe].methods[catch-combo].model.input',
      'references input "chain"',
    );
    expectSingleIssue(
      issuesAfter((doc) => {
        const method = methodOf(doc, 'lgpe', 'catch-combo');
        method.inputs.push({ id: 'lure', kind: 'toggle', label: 'Lure', default: false });
        comboModel(doc).input = 'lure';
      }),
      'model.input',
      'needs a number input',
    );
    expectSingleIssue(
      issuesAfter((doc) => void (comboModel(doc).table[0] = [5000, 4096])),
      'model.table[0]',
      'odds 5000/4096 exceed 1',
    );
    expectSingleIssue(
      issuesAfter((doc) => void ((comboModel(doc).charmTable as [number, number][])[1] = [2, 1])),
      'model.charmTable[1]',
      'exceed 1',
    );
  });

  it('flags a charm table that can never be used', () => {
    expectSingleIssue(
      issuesAfter((doc) => void (methodOf(doc, 'lgpe', 'catch-combo').charmApplies = false)),
      'model.charmTable',
      'is never used',
      'charmApplies: false',
    );
    const issues = issuesAfter((doc) => {
      gameOf(doc, 'lgpe').shinyCharmRolls = null;
      staticModel(doc).cases = [];
    });
    expectSingleIssue(issues, 'model.charmTable', 'LGPE has no Shiny Charm');
  });

  it('checks fixed-model cases', () => {
    const setWhen = (when: Record<string, boolean | string>) => (doc: OddsData) => {
      staticModel(doc).cases = [{ when, odds: [1, 1024] }];
    };
    const prefix = 'games[lgpe].methods[static].model.cases[0].when';

    expect(issuesAfter(setWhen({}))).toEqual([]);
    expect(issuesAfter(setWhen({ lure: false, mode: 'a', shinyCharm: false }))).toEqual([]);
    expectSingleIssue(issuesAfter(setWhen({ ghost: true })), `${prefix}.ghost`, 'does not declare');
    expectSingleIssue(
      issuesAfter(setWhen({ lure: 'on' })),
      `${prefix}.lure`,
      'must be true or false',
    );
    expectSingleIssue(
      issuesAfter(setWhen({ mode: 'c' })),
      `${prefix}.mode`,
      '"c" is not an option of the "mode" input',
    );
    expectSingleIssue(
      issuesAfter(setWhen({ mode: true })),
      `${prefix}.mode`,
      'true is not an option',
    );
    expectSingleIssue(
      issuesAfter(setWhen({ shinyCharm: 'yes' })),
      `${prefix}.shinyCharm`,
      'must be true or false',
    );

    expectSingleIssue(
      issuesAfter((doc) => {
        const method = methodOf(doc, 'lgpe', 'static');
        method.inputs.push({
          id: 'combo',
          kind: 'number',
          label: 'Combo',
          min: 0,
          max: 9,
          default: 0,
        });
        staticModel(doc).cases = [{ when: { combo: '3' }, odds: [1, 1024] }];
      }),
      `${prefix}.combo`,
      'number input',
    );
    expectSingleIssue(
      issuesAfter(
        (doc) => void ((staticModel(doc).cases?.[0] as { odds: [number, number] }).odds = [3, 2]),
      ),
      'model.cases[0].odds',
      'exceed 1',
    );
    expectSingleIssue(
      issuesAfter((doc) => void (staticModel(doc).odds = [9, 8])),
      'model.odds',
      'exceed 1',
    );
  });

  it('flags charm cases that can never match', () => {
    expectSingleIssue(
      issuesAfter((doc) => void (methodOf(doc, 'lgpe', 'static').charmApplies = false)),
      'cases[0].when.shinyCharm',
      'can never match',
      'charmApplies: false',
    );
    // Branching on the charm being *off* is fine either way.
    expect(
      issuesAfter((doc) => {
        methodOf(doc, 'lgpe', 'static').charmApplies = false;
        staticModel(doc).cases = [{ when: { shinyCharm: false }, odds: [1, 1024] }];
      }),
    ).toEqual([]);
  });

  it('checks checkpoint inputs against the declared inputs', () => {
    const setInputs = (inputs: Record<string, boolean | number | string>) => (doc: OddsData) => {
      (outbreak(doc).checkpoints[0] as { inputs: typeof inputs }).inputs = inputs;
    };
    const prefix = 'games[sv].methods[outbreak].checkpoints[0].inputs';

    expect(issuesAfter(setInputs({}))).toEqual([]);
    expectSingleIssue(issuesAfter(setInputs({ chain: 3 })), `${prefix}.chain`, 'does not declare');
    expectSingleIssue(
      issuesAfter(setInputs({ shinyCharm: true })),
      `${prefix}.shinyCharm`,
      'does not declare',
    );
    expectSingleIssue(
      issuesAfter(setInputs({ encounterPower: 1 })),
      `${prefix}.encounterPower`,
      'true or false',
    );
    expectSingleIssue(
      issuesAfter(setInputs({ sparkling: 'lv2' })),
      `${prefix}.sparkling`,
      '"lv2" is not an option',
    );
    expectSingleIssue(
      issuesAfter(setInputs({ sparkling: 3 })),
      `${prefix}.sparkling`,
      '3 is not an option',
    );
    expectSingleIssue(
      issuesAfter(setInputs({ cleared: '60' })),
      `${prefix}.cleared`,
      'needs a number',
    );
    expectSingleIssue(
      issuesAfter(setInputs({ cleared: 150 })),
      `${prefix}.cleared`,
      '150 is not a value the input can take',
    );
    expectSingleIssue(issuesAfter(setInputs({ cleared: 65 })), `${prefix}.cleared`, 'step 10');
  });

  it('checks that herbaCount matches the herba map', () => {
    expectSingleIssue(
      issuesAfter(
        (doc) => void ((doc.sandwiches.recipes[0] as { herbaCount: number }).herbaCount = 3),
      ),
      'sandwiches.recipes[dragon-sparkling-3].herbaCount',
      'is 3, but the herba map adds up to 2',
    );
  });

  it('collects every semantic problem', () => {
    const issues = issuesAfter((doc) => {
      gameOf(doc, 'dppt').id = 'sv';
      sparklingInput(doc).default = 'lv9';
      comboModel(doc).input = 'chain';
    });
    expect(issues).toHaveLength(3);
  });
});

describe('parseOddsData', () => {
  it('returns the typed document', () => {
    const doc = validDocument();
    const parsed = parseOddsData(structuredClone(doc));
    expect(parsed).toEqual(doc);
    expectTypeOf(parsed).toEqualTypeOf<OddsData>();
  });

  it('throws one readable error listing every problem', () => {
    const doc = validDocument();
    gameOf(doc, 'dppt').id = 'sv';
    sparklingInput(doc).default = 'lv9';

    let thrown: unknown;
    try {
      parseOddsData(doc);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OddsDataError);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as OddsDataError;
    expect(error.name).toBe('OddsDataError');
    expect(error.issues).toEqual(validateOddsData(doc));
    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe(
      [
        'Invalid odds data (2 problems):',
        '  - games: duplicate game id "sv"',
        '  - games[sv].methods[outbreak].inputs[sparkling].default: "lv9" is not one of the options (none, lv3)',
      ].join('\n'),
    );
  });

  it('throws for structurally broken input', () => {
    expect(() => parseOddsData(null)).toThrow(OddsDataError);
    expect(() => parseOddsData({ version: 1 })).toThrow(/Invalid odds data \(3 problems\)/);
    expect(() => parseOddsData('{}')).toThrow(/1 problem\)/);
  });
});
