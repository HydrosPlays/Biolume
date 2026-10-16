import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { oddsEngine } from '@renderer/lib/oddsData';
import {
  buildCurveModel,
  chainBaseSelection,
  chainPlateau,
  chainRamp,
  charmBlockedReason,
  paceFromSessions,
  selectionForGame,
  selectionForMethod,
  shortPlatform,
  timeAtPace,
} from './model';

function session(huntId: string, minutes: number, encounters: number): SessionRecord {
  const start = Date.parse('2026-10-13T10:00:00.000Z');
  return {
    id: `${huntId}-${minutes}-${encounters}`,
    huntId,
    huntName: huntId,
    targetName: null,
    gameId: 'sv',
    methodId: 'full-odds',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + minutes * 60_000).toISOString(),
    startCount: 0,
    endCount: encounters,
    encounters,
    phasesLogged: 0,
  };
}

describe('buildCurveModel', () => {
  const base = 1 / 4096;

  it('runs a constant curve to its 99 % quantile and skips the comparison at full odds', () => {
    const model = buildCurveModel({ perEncounter: base, baseProbability: base });
    expect(model.mode).toBe('constant');
    expect(model.maxN).toBe(model.encountersFor(0.99));
    expect(model.curve[0]).toEqual({ n: 0, probability: 0 });
    expect(model.curve.at(-1)?.n).toBe(model.maxN);
    expect(model.curve.at(-1)?.probability).toBeGreaterThanOrEqual(0.99);
    expect(model.comparison).toBeNull();
    expect(model.comparisonAt).toBeNull();
  });

  it('adds the full-odds reference for a boosted method, over the same range', () => {
    const model = buildCurveModel({ perEncounter: 1 / 512, baseProbability: base });
    expect(model.comparison?.at(-1)?.n).toBe(model.maxN);
    expect(model.comparisonAt?.(model.maxN)).toBeLessThan(model.probabilityAt(model.maxN));
  });

  it('stretches the range to keep the hunt total on the chart', () => {
    const model = buildCurveModel({ perEncounter: 1 / 512, baseProbability: base, total: 10_000 });
    expect(model.maxN).toBe(10_800);
    expect(model.probabilityAt(10_000)).toBeGreaterThan(0.99);
  });

  it('follows a chain ramp in chain mode', () => {
    // Odds that start at 1/100 and jump to 1/10 after five encounters.
    const ramp = [0.01, 0.01, 0.01, 0.01, 0.01, 0.1];
    const model = buildCurveModel({ perEncounter: 0.01, baseProbability: 0.01, ramp });
    const flat = buildCurveModel({ perEncounter: 0.01, baseProbability: 0.01 });
    expect(model.mode).toBe('chain');
    expect(model.probabilityAt(5)).toBeCloseTo(flat.probabilityAt(5), 12);
    expect(model.encountersFor(0.5)).toBeLessThan(flat.encountersFor(0.5));
    expect(model.comparison).not.toBeNull();
  });

  it('stays finite when a shiny is impossible', () => {
    const model = buildCurveModel({ perEncounter: 0, baseProbability: base });
    expect(model.encountersFor(0.5)).toBe(Infinity);
    expect(model.maxN).toBe(1000);
    expect(model.curve.every((point) => point.probability === 0)).toBe(true);
  });
});

describe('chain ramps', () => {
  it('finds where a capped chain stops improving, and none for a cyclic one', () => {
    const radar = oddsEngine.defaultSelection('dppt', 'poke-radar');
    const radarInput = oddsEngine.chainInput(radar);
    if (!radarInput) throw new Error('the Poké Radar has a chain input');
    const ramp = chainRamp(oddsEngine, chainBaseSelection(radar, radarInput), radarInput);
    const plateau = chainPlateau(ramp, radarInput);
    expect(ramp).toHaveLength(radarInput.max - radarInput.min + 1);
    expect(plateau).not.toBeNull();
    const index = (plateau ?? 0) - radarInput.min;
    expect(ramp[index]).toBe(ramp.at(-1));
    expect(ramp[index - 1]).not.toBe(ramp[index]);
    expect(ramp[index]).toBeGreaterThan(ramp[0] ?? 1);

    // DexNav's bonus recurs every 100 encounters right up to the input's maximum.
    const dexnav = oddsEngine.defaultSelection('oras', 'dexnav');
    const dexnavInput = oddsEngine.chainInput(dexnav);
    if (!dexnavInput) throw new Error('DexNav has a chain input');
    expect(chainPlateau(chainRamp(oddsEngine, dexnav, dexnavInput), dexnavInput)).toBeNull();
    expect(chainPlateau([0.1, 0.1, 0.1], dexnavInput)).toBeNull();
  });
});

describe('paceFromSessions', () => {
  it('measures the active hunt from its own sessions', () => {
    const pace = paceFromSessions(
      [session('a', 30, 200), session('a', 30, 100), session('b', 60, 6000)],
      'a',
    );
    expect(pace).toEqual({ perHour: 300, sessions: 2, scope: 'hunt' });
  });

  it('falls back to every session when the hunt has too little history', () => {
    const sessions = [session('a', 1, 5), session('b', 60, 600)];
    expect(paceFromSessions(sessions, 'a')).toMatchObject({ scope: 'all', sessions: 2 });
    expect(paceFromSessions(sessions, null)?.perHour).toBeCloseTo(605 / (61 / 60), 9);
  });

  it('ignores sessions that say nothing about pace and gives up without history', () => {
    // Too short, and one with no net encounters.
    expect(paceFromSessions([session('a', 0.2, 50), session('a', 45, 0)], 'a')).toBeNull();
    expect(paceFromSessions([], null)).toBeNull();
  });

  it('turns encounters into time', () => {
    const pace = { perHour: 300, sessions: 1, scope: 'hunt' } as const;
    expect(timeAtPace(150, pace)).toBe(30 * 60_000);
    expect(timeAtPace(Infinity, pace)).toBe(Infinity);
  });
});

describe('selection changes', () => {
  it('keeps the method across games that share it, else falls back to full odds', () => {
    const masuda = oddsEngine.updateSelection(oddsEngine.defaultSelection('sv', 'masuda-method'), {
      shinyCharm: true,
    });
    expect(selectionForGame(oddsEngine, masuda, 'swsh')).toMatchObject({
      gameId: 'swsh',
      methodId: 'masuda-method',
      shinyCharm: true,
    });
    expect(selectionForGame(oddsEngine, masuda, 'pla')).toMatchObject({
      gameId: 'pla',
      methodId: 'full-odds',
      shinyCharm: true,
    });
    // RSE has no Shiny Charm: it cannot stay on.
    expect(selectionForGame(oddsEngine, masuda, 'rse')).toMatchObject({
      gameId: 'rse',
      methodId: 'full-odds',
      shinyCharm: false,
    });
  });

  it('starts a newly picked method from its defaults and keeps the charm', () => {
    const outbreak = oddsEngine.updateSelection(
      oddsEngine.defaultSelection('sv', 'mass-outbreak'),
      {
        shinyCharm: true,
        inputs: { defeated: 10, sparkling: 'lv3' },
      },
    );
    const event = selectionForMethod(oddsEngine, outbreak, 'event-mass-outbreak');
    expect(event).toEqual({
      ...oddsEngine.defaultSelection('sv', 'event-mass-outbreak'),
      shinyCharm: true,
    });
  });

  it('explains why the Shiny Charm is unavailable', () => {
    const game = (id: string) => {
      const found = oddsEngine.getGame(id);
      if (!found) throw new Error(id);
      return found;
    };
    const method = (gameId: string, methodId: string) => {
      const found = oddsEngine.getMethod(gameId, methodId);
      if (!found) throw new Error(methodId);
      return found;
    };
    expect(charmBlockedReason(game('rse'), method('rse', 'full-odds'))).toMatch(/no Shiny Charm/);
    expect(charmBlockedReason(game('sv'), method('sv', 'full-odds'))).toBeNull();
    const ignoring = game('sv').methods.find((entry) => !entry.charmApplies);
    if (ignoring) expect(charmBlockedReason(game('sv'), ignoring)).toContain(ignoring.name);
  });

  it('drops the maker from platform names', () => {
    expect(shortPlatform('Nintendo Switch / Nintendo Switch 2')).toBe('Switch / Switch 2');
    expect(shortPlatform('Game Boy Advance')).toBe('Game Boy Advance');
  });
});
