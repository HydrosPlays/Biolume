/**
 * Runtime validation of `oddsMethods.json` against the shapes in
 * `src/renderer/data/schema.ts`.
 *
 * Two layers: a zod schema mirroring {@link OddsData} (strict — an unknown key
 * is almost always a typo that would silently drop a bonus or a charm table),
 * then semantic checks zod cannot express: unique ids, references between a
 * model and the method's inputs, defaults that are real values.
 *
 * Deliberately not imported by the app at startup — the bundled data is
 * validated by the test-suite (`oddsData.test.ts`) and `npm run data:validate`.
 */
import * as z from 'zod';
import { FULL_ODDS_METHOD_ID } from '@shared/defaults';
import type {
  GameDef,
  MethodDef,
  MethodInput,
  Odds,
  OddsData,
  OddsModel,
  RollBonus,
  SandwichData,
} from '@renderer/data/schema';
import { normalizeNumberInput, SHINY_CHARM_KEY } from './odds';

// ───────────────────────────── Structure ─────────────────────────────

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const text = z.string().min(1);
const kebabId = text.regex(
  KEBAB_CASE,
  'must be kebab-case (lowercase letters, digits and single hyphens)',
);
const sourceUrl = z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');
const rollCount = z.number().min(0);
const inputValue = z.union([z.boolean(), z.number(), z.string()]);

const oddsSchema = z.tuple([z.number().min(0), z.number().positive()]);

const inputBase = {
  id: text,
  label: text,
  description: z.string().optional(),
};

const toggleInputSchema = z.strictObject({
  ...inputBase,
  kind: z.literal('toggle'),
  default: z.boolean(),
});

const selectInputSchema = z.strictObject({
  ...inputBase,
  kind: z.literal('select'),
  options: z
    .array(z.strictObject({ id: text, label: text, description: z.string().optional() }))
    .min(1),
  default: z.string(),
});

const numberInputSchema = z.strictObject({
  ...inputBase,
  kind: z.literal('number'),
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
  default: z.number(),
  unit: z.string().optional(),
  chain: z.boolean().optional(),
});

const methodInputSchema = z.discriminatedUnion('kind', [
  toggleInputSchema,
  selectInputSchema,
  numberInputSchema,
]);

const bonusBase = {
  label: text,
  chance: z.number().min(0).max(1).optional(),
};

const rollBonusSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...bonusBase, kind: z.literal('toggle'), input: text, rolls: rollCount }),
  z.strictObject({
    ...bonusBase,
    kind: z.literal('select'),
    input: text,
    rolls: z.record(z.string(), rollCount),
  }),
  z.strictObject({
    ...bonusBase,
    kind: z.literal('tiers'),
    input: text,
    tiers: z.array(z.strictObject({ min: z.number(), rolls: rollCount })).min(1),
  }),
  z.strictObject({
    ...bonusBase,
    kind: z.literal('linear'),
    input: text,
    perUnit: rollCount,
    maxUnits: z.number().min(0).optional(),
  }),
  z.strictObject({ ...bonusBase, kind: z.literal('constant'), rolls: rollCount }),
]);

const oddsModelSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('rolls'),
    baseRolls: rollCount,
    bonuses: z.array(rollBonusSchema),
    denominator: z.number().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('fixed'),
    odds: oddsSchema,
    cases: z
      .array(
        z.strictObject({
          when: z.record(z.string(), z.union([z.boolean(), z.string()])),
          odds: oddsSchema,
        }),
      )
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('table'),
    input: text,
    table: z.array(oddsSchema).min(1),
    charmTable: z.array(oddsSchema).min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('custom'),
    formula: kebabId,
    spec: text,
    params: z.record(z.string(), z.number()).optional(),
  }),
]);

const checkpointSchema = z.strictObject({
  label: text,
  shinyCharm: z.boolean(),
  inputs: z.record(z.string(), inputValue),
  oneIn: z.number().min(1),
  tolerance: z.number().positive().max(0.5).optional(),
});

const methodSchema = z.strictObject({
  id: kebabId,
  name: text,
  summary: text,
  details: z.string().optional(),
  charmApplies: z.boolean(),
  inputs: z.array(methodInputSchema),
  model: oddsModelSchema,
  pokemonPerEncounter: z.number().int().min(1).optional(),
  checkpoints: z.array(checkpointSchema),
  notes: z.array(z.string()).optional(),
  sources: z.array(sourceUrl),
});

const gameSchema = z.strictObject({
  id: kebabId,
  name: text,
  shortName: text,
  generation: z.number().int().min(1),
  platform: text,
  releaseYear: z.number().int().min(1996).max(2100),
  baseDenominator: z.number().min(1),
  versionGroups: z.array(kebabId),
  shinyCharmRolls: z.number().min(0).nullable(),
  methods: z.array(methodSchema).min(1),
});

const herbaIdSchema = z.enum(['sweet', 'salty', 'sour', 'bitter', 'spicy']);

const mealPowerSchema = z.strictObject({
  power: z.enum([
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
  ]),
  type: z.string().nullable(),
  level: z.literal([1, 2, 3]),
});

const sandwichItemSchema = z.strictObject({ name: text, quantity: z.number().positive() });

const sandwichRecipeSchema = z.strictObject({
  id: text,
  type: text,
  name: text,
  sparklingLevel: z.literal([0, 1, 2, 3]),
  herbaCount: z.number().int().min(0),
  herba: z.partialRecord(herbaIdSchema, z.number().int().min(0)),
  fillings: z.array(sandwichItemSchema),
  condiments: z.array(sandwichItemSchema),
  powers: z.array(mealPowerSchema),
  players: z.number().int().min(1),
  minimal: z.boolean(),
  notes: z.string().optional(),
});

const sandwichDataSchema = z.strictObject({
  summary: z.string(),
  herba: z.array(z.strictObject({ id: herbaIdSchema, name: text, source: z.string() })),
  recipes: z.array(sandwichRecipeSchema),
  notes: z.array(z.string()),
  sources: z.array(sourceUrl),
});

/**
 * Structural schema of `oddsMethods.json`. Its output type is {@link OddsData};
 * use {@link validateOddsData} / {@link parseOddsData} to also run the semantic checks.
 */
export const oddsDataSchema = z.strictObject({
  version: z.number().int().min(0),
  updated: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/, 'must be an ISO date'),
  games: z.array(gameSchema),
  sandwiches: sandwichDataSchema,
});

// ───────────────────────────── Semantics ─────────────────────────────

type Report = (path: string, message: string) => void;

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function checkOdds(odds: Odds, path: string, report: Report): void {
  if (odds[0] > odds[1]) report(path, `odds ${odds[0]}/${odds[1]} exceed 1`);
}

/** A declared input of `kind`, reporting a missing or wrongly typed reference. */
function requireInput<K extends MethodInput['kind']>(
  method: MethodDef,
  id: string,
  kind: K,
  path: string,
  report: Report,
): Extract<MethodInput, { kind: K }> | undefined {
  const input = method.inputs.find((entry) => entry.id === id);
  if (!input) {
    report(path, `references input "${id}", which the method does not declare`);
    return undefined;
  }
  if (input.kind !== kind) {
    report(path, `needs a ${kind} input, but "${id}" is a ${input.kind} input`);
    return undefined;
  }
  return input as Extract<MethodInput, { kind: K }>;
}

function checkInput(input: MethodInput, path: string, report: Report): void {
  if (input.id === SHINY_CHARM_KEY) {
    report(
      path,
      `"${SHINY_CHARM_KEY}" is reserved — the charm is part of the selection, not a method input`,
    );
  }
  if (input.kind === 'select') {
    const optionIds = input.options.map((option) => option.id);
    for (const id of duplicates(optionIds)) {
      report(`${path}.options`, `duplicate option id "${id}"`);
    }
    if (!optionIds.includes(input.default)) {
      report(
        `${path}.default`,
        `"${input.default}" is not one of the options (${optionIds.join(', ')})`,
      );
    }
  } else if (input.kind === 'number') {
    if (input.min > input.max) {
      report(path, `min (${input.min}) is greater than max (${input.max})`);
    } else if (input.default < input.min || input.default > input.max) {
      report(`${path}.default`, `${input.default} is outside ${input.min}–${input.max}`);
    } else if (normalizeNumberInput(input, input.default) !== input.default) {
      report(
        `${path}.default`,
        `${input.default} is not on the step grid (min ${input.min}, step ${input.step ?? 1})`,
      );
    }
  }
}

function checkBonus(method: MethodDef, bonus: RollBonus, path: string, report: Report): void {
  switch (bonus.kind) {
    case 'constant':
      return;
    case 'toggle':
      requireInput(method, bonus.input, 'toggle', path, report);
      return;
    case 'select': {
      const input = requireInput(method, bonus.input, 'select', path, report);
      if (!input) return;
      const optionIds = new Set(input.options.map((option) => option.id));
      for (const key of Object.keys(bonus.rolls)) {
        if (!optionIds.has(key)) {
          report(`${path}.rolls`, `"${key}" is not an option of the "${input.id}" input`);
        }
      }
      return;
    }
    case 'tiers': {
      requireInput(method, bonus.input, 'number', path, report);
      for (const min of duplicates(bonus.tiers.map((tier) => String(tier.min)))) {
        report(`${path}.tiers`, `two tiers start at ${min}`);
      }
      return;
    }
    case 'linear':
      requireInput(method, bonus.input, 'number', path, report);
      return;
  }
}

function checkModel(
  game: GameDef,
  method: MethodDef,
  model: OddsModel,
  path: string,
  report: Report,
): void {
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
        checkBonus(method, bonus, `${path}.bonuses[${index}]`, report),
      );
      return;

    case 'fixed':
      checkOdds(model.odds, `${path}.odds`, report);
      (model.cases ?? []).forEach((entry, index) => {
        const casePath = `${path}.cases[${index}]`;
        checkOdds(entry.odds, `${casePath}.odds`, report);
        for (const [key, required] of Object.entries(entry.when)) {
          const whenPath = `${casePath}.when.${key}`;
          if (key === SHINY_CHARM_KEY) {
            if (typeof required !== 'boolean') {
              report(whenPath, 'must be true or false');
            } else if (required && charmBlocked) {
              report(whenPath, `can never match: ${charmBlocked}`);
            }
            continue;
          }
          const input = method.inputs.find((candidate) => candidate.id === key);
          if (!input) {
            report(whenPath, `references input "${key}", which the method does not declare`);
          } else if (input.kind === 'toggle') {
            if (typeof required !== 'boolean') {
              report(whenPath, `"${key}" is a toggle, so the value must be true or false`);
            }
          } else if (input.kind === 'select') {
            if (
              typeof required !== 'string' ||
              !input.options.some((option) => option.id === required)
            ) {
              report(
                whenPath,
                `${JSON.stringify(required)} is not an option of the "${key}" input`,
              );
            }
          } else {
            report(
              whenPath,
              `cases can only branch on toggle or select inputs, and "${key}" is a number input`,
            );
          }
        }
      });
      return;

    case 'table':
      requireInput(method, model.input, 'number', `${path}.input`, report);
      model.table.forEach((odds, index) => checkOdds(odds, `${path}.table[${index}]`, report));
      (model.charmTable ?? []).forEach((odds, index) =>
        checkOdds(odds, `${path}.charmTable[${index}]`, report),
      );
      if (model.charmTable && charmBlocked) {
        report(`${path}.charmTable`, `is never used: ${charmBlocked}`);
      }
      return;

    case 'custom':
      return;
  }
}

function checkMethod(game: GameDef, method: MethodDef, path: string, report: Report): void {
  for (const id of duplicates(method.inputs.map((input) => input.id))) {
    report(`${path}.inputs`, `duplicate input id "${id}"`);
  }
  method.inputs.forEach((input) => checkInput(input, `${path}.inputs[${input.id}]`, report));
  checkModel(game, method, method.model, `${path}.model`, report);

  method.checkpoints.forEach((checkpoint, index) => {
    const checkpointPath = `${path}.checkpoints[${index}]`;
    for (const [key, value] of Object.entries(checkpoint.inputs)) {
      const valuePath = `${checkpointPath}.inputs.${key}`;
      const input = method.inputs.find((candidate) => candidate.id === key);
      if (!input) {
        report(valuePath, `sets input "${key}", which the method does not declare`);
      } else if (input.kind === 'toggle') {
        if (typeof value !== 'boolean') report(valuePath, 'a toggle input needs true or false');
      } else if (input.kind === 'select') {
        if (!input.options.some((option) => option.id === value)) {
          report(valuePath, `${JSON.stringify(value)} is not an option of the "${key}" input`);
        }
      } else if (typeof value !== 'number') {
        report(valuePath, 'a number input needs a number');
      } else if (normalizeNumberInput(input, value) !== value) {
        // The engine would silently evaluate a different value than the checkpoint states.
        report(
          valuePath,
          `${value} is not a value the input can take (min ${input.min}, max ${input.max}, step ${input.step ?? 1})`,
        );
      }
    }
  });
}

function checkSandwiches(sandwiches: SandwichData, report: Report): void {
  for (const id of duplicates(sandwiches.herba.map((herba) => herba.id))) {
    report('sandwiches.herba', `duplicate herba id "${id}"`);
  }
  for (const id of duplicates(sandwiches.recipes.map((recipe) => recipe.id))) {
    report('sandwiches.recipes', `duplicate recipe id "${id}"`);
  }
  for (const recipe of sandwiches.recipes) {
    const listed = Object.values(recipe.herba).reduce((total, count) => total + (count ?? 0), 0);
    if (listed !== recipe.herbaCount) {
      report(
        `sandwiches.recipes[${recipe.id}].herbaCount`,
        `is ${recipe.herbaCount}, but the herba map adds up to ${listed}`,
      );
    }
  }
}

function semanticIssues(data: OddsData): string[] {
  const issues: string[] = [];
  const report: Report = (path, message) => {
    issues.push(`${path}: ${message}`);
  };

  for (const id of duplicates(data.games.map((game) => game.id))) {
    report('games', `duplicate game id "${id}"`);
  }
  for (const game of data.games) {
    const gamePath = `games[${game.id}]`;
    const first = game.methods[0];
    if (first && first.id !== FULL_ODDS_METHOD_ID) {
      report(
        `${gamePath}.methods[0]`,
        `the first method must be "${FULL_ODDS_METHOD_ID}", found "${first.id}"`,
      );
    }
    for (const id of duplicates(game.methods.map((method) => method.id))) {
      report(`${gamePath}.methods`, `duplicate method id "${id}"`);
    }
    for (const method of game.methods) {
      checkMethod(game, method, `${gamePath}.methods[${method.id}]`, report);
    }
  }
  checkSandwiches(data.sandwiches, report);
  return issues;
}

// ───────────────────────────── Public API ─────────────────────────────

/** `games[sv].methods[masuda].model.bonuses[0].rolls` — array items are named by their id when they have one. */
function formatPath(path: readonly PropertyKey[], root: unknown): string {
  let node: unknown = root;
  let formatted = '';
  for (const segment of path) {
    const child: unknown =
      typeof node === 'object' && node !== null
        ? (node as Record<PropertyKey, unknown>)[segment]
        : undefined;
    if (typeof segment === 'number') {
      const id =
        typeof child === 'object' && child !== null ? (child as { id?: unknown }).id : undefined;
      formatted += `[${typeof id === 'string' && id !== '' ? id : segment}]`;
    } else {
      formatted += formatted === '' ? String(segment) : `.${String(segment)}`;
    }
    node = child;
  }
  return formatted === '' ? '(root)' : formatted;
}

function inspect(json: unknown): { data: OddsData | null; issues: string[] } {
  const parsed = oddsDataSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${formatPath(issue.path, json)}: ${issue.message}`,
    );
    return { data: null, issues };
  }
  const data: OddsData = parsed.data;
  return { data, issues: semanticIssues(data) };
}

/**
 * Every problem found in a candidate `oddsMethods.json` document, as
 * `path: message` lines; empty when the document is valid. Semantic checks only
 * run once the structure is sound.
 */
export function validateOddsData(json: unknown): string[] {
  return inspect(json).issues;
}

/** Thrown by {@link parseOddsData}; `issues` holds one line per problem. */
export class OddsDataError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    const count = `${issues.length} problem${issues.length === 1 ? '' : 's'}`;
    super(`Invalid odds data (${count}):\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'OddsDataError';
    this.issues = issues;
  }
}

/**
 * Validates and returns a typed copy of the document.
 * @throws {OddsDataError} listing every problem when the document is invalid.
 */
export function parseOddsData(json: unknown): OddsData {
  const { data, issues } = inspect(json);
  if (!data || issues.length > 0) throw new OddsDataError(issues);
  return data;
}
