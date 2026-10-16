/**
 * Data conformance: holds the bundled `oddsMethods.json` to the contract in
 * `src/renderer/data/schema.ts` and pins the engine against every published
 * checkpoint in it.
 *
 * The file is read from disk when the tests are collected rather than imported,
 * so the suite always judges the JSON as it currently is.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_ID, FULL_ODDS_METHOD_ID, createDefaultOddsSelection } from '@shared/defaults';
import type { GameDef, MethodDef, OddsCheckpoint, OddsData } from '@renderer/data/schema';
import { DEFAULT_CHECKPOINT_TOLERANCE, createOddsEngine, type CheckpointReport } from './odds';
// Importing the default instance also loads whatever module registers the
// custom formulas, so the checkpoints below see the same registry as the app.
import { oddsData, oddsEngine, sandwichData } from './oddsData';
import { validateOddsData } from './oddsSchema';

/**
 * The renderer's tsconfig deliberately carries no Node typings (renderer code
 * must not reach for `process` or `fs`), so the few Node functions this suite
 * needs are loaded dynamically and typed here.
 */
interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
}
interface NodePath {
  dirname(path: string): string;
  resolve(...segments: string[]): string;
}
interface NodeUrl {
  fileURLToPath(url: string): string;
}
async function nodeBuiltin<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}
const { readFileSync } = await nodeBuiltin<NodeFs>('node:fs');
const { dirname, resolve } = await nodeBuiltin<NodePath>('node:path');
const { fileURLToPath } = await nodeBuiltin<NodeUrl>('node:url');

/**
 * A candidate document can be judged before it replaces the bundled one:
 *
 *   VITE_BIOLUME_ODDS_DATA=path/to/candidate.json npx vitest run src/renderer/lib/oddsData.test.ts
 *
 * Without the variable the suite reads the real `src/renderer/data/oddsMethods.json`.
 */
const candidate: unknown = import.meta.env.VITE_BIOLUME_ODDS_DATA;
const override = typeof candidate === 'string' && candidate.trim() !== '' ? candidate : null;

// Not `new URL('../data/…', import.meta.url)`: Vite rewrites that pattern into an asset URL.
const DATA_FILE =
  override === null
    ? resolve(dirname(fileURLToPath(import.meta.url)), '../data/oddsMethods.json')
    : resolve(override);
if (override !== null) {
  console.warn(`[oddsData.test] judging ${DATA_FILE} instead of the bundled oddsMethods.json`);
}

const raw: unknown = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const issues = validateOddsData(raw);
/** Null when the document is invalid — the dependent suites are then skipped, not crashed. */
const data = issues.length === 0 ? (raw as OddsData) : null;

describe('oddsMethods.json', () => {
  it('conforms to the schema and its semantic rules', () => {
    // On failure the diff lists every problem as `path: message`.
    expect(issues).toEqual([]);
  });

  it.skipIf(data === null)('contains the default game with a full-odds method', () => {
    const engine = createOddsEngine(data as OddsData);
    expect(engine.getGame(DEFAULT_GAME_ID)).toBeDefined();
    expect(engine.defaultGame.id).toBe(DEFAULT_GAME_ID);

    // A brand-new hunt's selection must survive normalisation: same game, same
    // method, nothing substituted. (Its inputs may gain defaults — a full-odds
    // method is allowed to declare inputs.)
    const selection = createDefaultOddsSelection();
    expect(engine.normalizeSelection(selection)).toMatchObject({
      gameId: selection.gameId,
      methodId: selection.methodId,
      shinyCharm: selection.shinyCharm,
    });
    const result = engine.compute(selection);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.game.id).toBe(DEFAULT_GAME_ID);
    expect(result.method.id).toBe(FULL_ODDS_METHOD_ID);
  });

  it.skipIf(data === null)('gives every game plain base odds under full-odds', () => {
    const engine = createOddsEngine(data as OddsData);
    for (const game of engine.games) {
      const result = engine.compute(engine.defaultSelection(game.id));
      expect(result.game.id, game.id).toBe(game.id);
      expect(result.method.id, game.id).toBe(FULL_ODDS_METHOD_ID);
      expect(result.valid, game.id).toBe(true);
      expect(result.charmAvailable, game.id).toBe(game.shinyCharmRolls !== null);
      const relativeError =
        Math.abs(result.oneInPerPokemon - game.baseDenominator) / game.baseDenominator;
      expect(relativeError, `${game.id}: 1 in ${result.oneInPerPokemon}`).toBeLessThanOrEqual(
        DEFAULT_CHECKPOINT_TOLERANCE,
      );
    }
  });

  it.skipIf(data === null)('evaluates every method at its defaults and at its best case', () => {
    const engine = createOddsEngine(data as OddsData);
    for (const game of engine.games) {
      for (const method of game.methods) {
        const id = `${game.id}/${method.id}`;
        const selection = engine.defaultSelection(game.id, method.id);
        expect(selection.methodId, id).toBe(method.id);

        const result = engine.compute(selection);
        expect(result.warnings.length === 0 || !result.valid, id).toBe(true);
        expect(result.perPokemon, id).toBeGreaterThanOrEqual(0);
        expect(result.perPokemon, id).toBeLessThanOrEqual(1);
        expect(result.perEncounter, id).toBeGreaterThanOrEqual(result.perPokemon);

        const best = engine.bestCase(selection);
        expect(best.perPokemon, id).toBeGreaterThanOrEqual(result.perPokemon);

        const chain = engine.chainInput(selection);
        if (chain) {
          const ramp = engine.chainProbabilities(selection, chain.id, 8, chain.min);
          expect(ramp, id).toHaveLength(8);
          expect(
            ramp.every((value) => value >= 0 && value <= 1),
            id,
          ).toBe(true);
        }
      }
    }
  });
});

describe('oddsMethods.json checkpoints', () => {
  if (data === null) {
    it.skip('are skipped until the document is valid', () => undefined);
    return;
  }

  const engine = createOddsEngine(data);
  const unpinned: string[] = [];

  for (const game of data.games) {
    describe(`${game.shortName} (${game.id})`, () => {
      for (const method of game.methods) {
        const id = `${game.id}/${method.id}`;

        if (method.model.kind === 'custom' && !engine.hasFormula(method.model.formula)) {
          // A custom model without its formula silently falls back to base odds
          // in the app, so it is a failure here — never a skipped checkpoint.
          const { formula } = method.model;
          it(`${method.id} — has its "${formula}" formula implemented`, () => {
            expect.fail(
              `No formula is registered for "${formula}" (${method.checkpoints.length} checkpoints unverified). Implement it in lib/oddsFormulas.ts.`,
            );
          });
          continue;
        }
        if (method.checkpoints.length === 0) {
          unpinned.push(id);
          continue;
        }

        for (const checkpoint of method.checkpoints) {
          it(`${method.id} — ${checkpoint.label}`, () => {
            const report = engine.evaluateCheckpoint(game.id, method.id, checkpoint);
            expect(report.evaluated, report.result.warnings.join(' ')).toBe(true);
            expect(
              report.relativeError,
              `${id} "${checkpoint.label}": expected 1 in ${report.expectedOneIn}, computed 1 in ${report.actualOneIn}`,
            ).toBeLessThanOrEqual(report.tolerance);
          });
        }
      }
    });
  }

  it('notes methods that no checkpoint pins', () => {
    if (unpinned.length > 0) {
      console.warn(`[oddsMethods.json] methods without checkpoints: ${unpinned.join(', ')}`);
    }
    // Every custom model resolves to an implemented formula…
    expect(engine.missingFormulas()).toEqual([]);
    // …so every checkpoint in the document is evaluated, and none is off.
    const failing = engine
      .checkCheckpoints()
      .filter((report) => !report.pass)
      .map((report) => `${report.gameId}/${report.methodId} "${report.checkpoint.label}"`);
    expect(failing).toEqual([]);
  });
});

describe('default engine instance', () => {
  it('is built over the bundled data', () => {
    expect(oddsEngine.data).toBe(oddsData);
    expect(sandwichData).toBe(oddsData.sandwiches);
    expect(oddsEngine.games.length).toBeGreaterThan(0);
    expect(oddsEngine.compute(createDefaultOddsSelection()).perPokemon).toBeGreaterThan(0);
  });

  // Meaningless while a candidate document stands in for the bundled one.
  it.skipIf(data === null || override !== null)('matches the file on disk', () => {
    // The bundler's JSON import and the raw file must describe the same data.
    expect(oddsData).toEqual(data);
  });
});

/**
 * The checks above are only worth something if they can fail. These tests break
 * a *copy* of the current document (never the file) in the ways a data edit
 * could, and require the same machinery to notice.
 */
describe.skipIf(data === null)('conformance checks catch a broken document', () => {
  const pristine = data as OddsData;

  /** A valid method that is not `full-odds`, for putting at the front of a game. */
  const MINIMAL_METHOD: MethodDef = {
    id: 'imposter',
    name: 'Imposter',
    summary: 'A valid method in the wrong place.',
    charmApplies: false,
    inputs: [],
    model: { kind: 'fixed', odds: [1, 2] },
    checkpoints: [],
    sources: [],
  };

  interface Pinned {
    game: GameDef;
    method: MethodDef;
    checkpoint: OddsCheckpoint;
  }

  /** Reports for the untouched document, in `checkCheckpoints()` order. */
  const baseline = (): CheckpointReport[] => createOddsEngine(pristine).checkCheckpoints();

  /**
   * A fresh copy of the document plus the first checkpoint in it that passes
   * today on a method taking its odds from the game's base denominator. Null
   * when there is none (every real data set has one: any full-odds entry).
   */
  function breakableCopy(): { doc: OddsData; pinned: Pinned | null } {
    const doc = structuredClone(pristine);
    const reports = baseline();
    // Walks the copy in the order `checkCheckpoints()` reports in.
    let index = 0;
    for (const game of doc.games) {
      for (const method of game.methods) {
        const plainRolls = method.model.kind === 'rolls' && method.model.denominator === undefined;
        for (const checkpoint of method.checkpoints) {
          if (plainRolls && reports[index]?.pass === true) {
            return { doc, pinned: { game, method, checkpoint } };
          }
          index++;
        }
      }
    }
    return { doc, pinned: null };
  }

  /**
   * Checkpoints failing in `doc` that pass in the untouched document — so these
   * tests judge the edit alone, even while a candidate document has problems of
   * its own (which the suites above report).
   */
  function newlyFailing(doc: OddsData): CheckpointReport[] {
    const before = baseline();
    return createOddsEngine(doc)
      .checkCheckpoints()
      .filter((report, index) => report.evaluated && !report.pass && before[index]?.pass === true);
  }

  it('has a checkpoint to break', () => {
    expect(breakableCopy().pinned).not.toBeNull();
    expect(newlyFailing(structuredClone(pristine))).toEqual([]);
  });

  it('flags a checkpoint whose published value is wrong', () => {
    const { doc, pinned } = breakableCopy();
    if (!pinned) return;
    // Three times the true figure is a 67 % error — beyond the largest tolerance the schema allows.
    pinned.checkpoint.oneIn *= 3;

    const report = createOddsEngine(doc).evaluateCheckpoint(
      pinned.game.id,
      pinned.method.id,
      pinned.checkpoint,
    );
    expect(report.evaluated).toBe(true);
    expect(report.pass).toBe(false);
    expect(report.relativeError).toBeGreaterThan(report.tolerance);

    const failing = newlyFailing(doc);
    expect(failing).toHaveLength(1);
    expect(failing[0]?.checkpoint).toBe(pinned.checkpoint);
    // The edit leaves the document well-formed: only the engine comparison can catch it.
    expect(validateOddsData(doc)).toEqual(validateOddsData(pristine));
  });

  it('flags a model edit that moves the odds off their checkpoints', () => {
    const { doc, pinned } = breakableCopy();
    if (!pinned) return;
    pinned.game.baseDenominator *= 2;

    const failing = newlyFailing(doc);
    expect(failing.some((report) => report.checkpoint === pinned.checkpoint)).toBe(true);
    // Nothing outside the edited game is affected.
    expect(failing.every((report) => report.gameId === pinned.game.id)).toBe(true);
    expect(validateOddsData(doc)).toEqual(validateOddsData(pristine));
  });

  it('flags structural and semantic damage', () => {
    const damage: [label: string, edit: (doc: OddsData, pinned: Pinned) => void][] = [
      ['a renamed method', (_doc, pinned) => void (pinned.method.id = 'Not Kebab')],
      ['a duplicated game', (doc, pinned) => void doc.games.push(structuredClone(pinned.game))],
      [
        'a checkpoint for an undeclared input',
        (_doc, pinned) => void (pinned.checkpoint.inputs = { noSuchInput: true }),
      ],
      [
        'a misspelt optional key',
        (_doc, pinned) => void Object.assign(pinned.method, { pokemonPerEncouter: 5 }),
      ],
      [
        'a first method that is not full-odds',
        (doc) => void doc.games[0]?.methods.unshift(structuredClone(MINIMAL_METHOD)),
      ],
      ['a missing sandwich table', (doc) => void Reflect.deleteProperty(doc, 'sandwiches')],
    ];
    for (const [label, edit] of damage) {
      const { doc, pinned } = breakableCopy();
      if (!pinned) return;
      edit(doc, pinned);
      expect(validateOddsData(doc).length, label).toBeGreaterThan(0);
    }
  });
});
