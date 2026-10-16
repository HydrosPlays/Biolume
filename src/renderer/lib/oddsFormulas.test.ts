/**
 * Behaviour of the custom formulas beyond their published checkpoints (those
 * are pinned one by one in `oddsData.test.ts`): the branches of each spec and
 * the roll breakdown handed to the UI.
 */
import { describe, expect, it } from 'vitest';
import type { OddsInputValue } from '@shared/types';
import { oddsEngine } from './oddsData';
import { CUSTOM_FORMULAS, dexNavTarget } from './oddsFormulas';

function compute(
  gameId: string,
  methodId: string,
  inputs: Record<string, OddsInputValue>,
  shinyCharm = false,
) {
  return oddsEngine.compute({ gameId, methodId, shinyCharm, inputs });
}

describe('custom formulas', () => {
  it('cover every custom model in the bundled data, with checkpoints that pass', () => {
    expect(oddsEngine.missingFormulas()).toEqual([]);
    const custom = oddsEngine.games.flatMap((game) =>
      game.methods
        .filter((method) => method.model.kind === 'custom')
        .map((method) => ({ game, method })),
    );
    expect(
      custom
        .map(({ method }) => (method.model.kind === 'custom' ? method.model.formula : ''))
        .sort(),
    ).toEqual(Object.keys(CUSTOM_FORMULAS).sort());
    for (const { game, method } of custom) {
      expect(method.checkpoints.length, method.id).toBeGreaterThan(0);
      for (const checkpoint of method.checkpoints) {
        const report = oddsEngine.evaluateCheckpoint(game.id, method.id, checkpoint);
        expect(report.pass, `${game.id}/${method.id} "${checkpoint.label}"`).toBe(true);
      }
    }
  });
});

describe('oras-dexnav', () => {
  it('derives the check target from the Search Level in three bands', () => {
    expect([0, 50, 100, 101, 200, 201, 999].map(dexNavTarget)).toEqual([
      0, 300, 600, 602, 800, 801, 1599,
    ]);
  });

  it('wraps the chain every 100 encounters and guarantees the boost on every 5th', () => {
    const at = (chain: number) => compute('oras', 'dexnav', { searchLevel: 999, chain }).perPokemon;
    expect(at(149)).toBeCloseTo(at(49), 15);
    expect(at(199)).toBeCloseTo(at(99), 15);
    expect(at(104)).toBeCloseTo(at(4), 15);
    // 5th encounter (5 checks for certain) beats the 4th (1 check, 4 % chance of 5).
    expect(at(4)).toBeGreaterThan(at(3) * 3);
    expect(at(3)).toBeCloseTo(at(0), 15);
    expect(at(99)).toBeGreaterThan(at(49));
  });

  it('describes its checks in the breakdown and reports no single roll count', () => {
    const result = compute('oras', 'dexnav', { searchLevel: 999, chain: 99 }, true);
    expect(result.valid).toBe(true);
    expect(result.rolls).toBeNull();
    const checks = result.breakdown.filter((row) => row.unit === 'check');
    // 1 + 2 (charm) + 10 (100th) + 4 (boost) = 17 checks at 0.16 % each.
    expect(checks.reduce((total, row) => total + row.rolls, 0)).toBe(17);
    expect(checks.every((row) => row.perRoll === 0.0016 && row.chance === undefined)).toBe(true);

    const random = compute('oras', 'dexnav', { searchLevel: 100, chain: 0 });
    expect(random.breakdown.find((row) => row.label === 'Random boost')?.chance).toBe(0.04);
    // Search Level 0: no forced check at all, only the natural roll.
    expect(compute('oras', 'dexnav', { searchLevel: 0, chain: 4 }).breakdown).toHaveLength(1);
  });
});

describe('swsh-brilliant-fishing', () => {
  it('ignores the streak while nothing has been battled', () => {
    const none = compute('swsh', 'chain-fishing', { defeated: 0, chain: 999 });
    expect(none.oneInPerPokemon).toBeCloseTo(4096, 6);
    expect(none.breakdown).toHaveLength(1);
  });

  it('steps the Brilliant chance at streaks of 3, 7, 15 and 25', () => {
    const chance = (chain: number) =>
      compute('swsh', 'chain-fishing', { defeated: 500, chain }).breakdown.find(
        (row) => row.input === 'defeated',
      )?.chance;
    expect([0, 2, 3, 6, 7, 14, 15, 24, 25, 400].map(chance)).toEqual([
      0.03, 0.03, 0.05, 0.05, 0.08, 0.08, 0.13, 0.13, 0.28, 0.28,
    ]);
    // Expected rolls: 1 base + 28 % × 6 bonus.
    expect(compute('swsh', 'chain-fishing', { defeated: 500, chain: 25 }).rolls).toBeCloseTo(
      2.68,
      12,
    );
  });
});

describe('sv-event-outbreak', () => {
  it('adds the flat event check on top of the regular outbreak rolls', () => {
    const boosted = compute('sv', 'event-mass-outbreak', { defeated: 60, sparkling: 'lv3' }, true);
    const regular = compute('sv', 'mass-outbreak', { defeated: 60, sparkling: 'lv3' }, true);
    expect(boosted.rolls).toBe(8);
    expect(boosted.perPokemon).toBeCloseTo(0.005 + 0.995 * regular.perPokemon, 15);
    expect(boosted.breakdown[0]).toMatchObject({ unit: 'check', perRoll: 0.005 });
    expect(compute('sv', 'event-mass-outbreak', { defeated: 29, sparkling: 'none' }).rolls).toBe(1);
  });
});
