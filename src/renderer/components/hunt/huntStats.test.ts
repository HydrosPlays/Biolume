import { describe, expect, it } from 'vitest';
import type { ImportResult } from '@shared/types';
import { makeHunt, makePhase, makeSession, makeTarget } from '@renderer/test';
import {
  countChangeDirection,
  countGlyphUnits,
  deriveHuntStats,
  encountersPerHour,
  exportFormatsFor,
  flattenPhases,
  formatOddsRatio,
  groupHunts,
  huntProbability,
  importOutcome,
  phaseDisplayName,
  resolveExportFormat,
  restoredStatus,
  sessionDurationMs,
  sessionTotals,
  suggestHuntName,
} from './huntStats';

const FULL_ODDS = 1 / 4096;

describe('deriveHuntStats', () => {
  it('judges luck and milestones on the total across phases, not the phase count', () => {
    const hunt = makeHunt({
      count: 100,
      priorCount: 2740,
      phases: [makePhase(), makePhase()],
      elapsedMs: 2 * 3_600_000,
    });
    const stats = deriveHuntStats(hunt, FULL_ODDS);

    expect(stats.count).toBe(100);
    expect(stats.total).toBe(2840);
    expect(stats.phaseNumber).toBe(3);
    // 2,839 encounters is the 50 % mark at 1 in 4,096.
    expect(stats.milestones[0]).toMatchObject({ encounters: 2839, reached: true, remaining: 0 });
    expect(stats.cumulative).toBeGreaterThan(0.5);
    expect(stats.next?.probability).toBe(0.9);
    expect(stats.next?.remaining).toBe((stats.next?.encounters ?? 0) - 2840);
    expect(stats.oddsRatio).toBeCloseTo(2840 / 4096, 10);
    expect(stats.verdict).toBe('average');
    expect(stats.perHour).toBeCloseTo(1420, 6);
  });

  it('has nothing to say at zero encounters', () => {
    const stats = deriveHuntStats(makeHunt(), FULL_ODDS);
    expect(stats.cumulative).toBe(0);
    expect(stats.verdict).toBe('unknown');
    expect(stats.next).toMatchObject({ probability: 0.5, remaining: 2839 });
    expect(stats.perHour).toBeNull();
  });

  it('stays finite when the odds are unknown', () => {
    const stats = deriveHuntStats(makeHunt({ count: 500 }), null);
    expect(stats.probability).toBe(0);
    expect(stats.cumulative).toBe(0);
    expect(stats.next).toBeNull();
    expect(stats.milestones.every((entry) => !entry.reached)).toBe(true);
  });

  it('reports no next milestone once past 99 %', () => {
    const stats = deriveHuntStats(makeHunt({ count: 40_000 }), FULL_ODDS);
    expect(stats.milestones.every((entry) => entry.reached)).toBe(true);
    expect(stats.next).toBeNull();
    expect(stats.verdict).toBe('very-unlucky');
  });
});

describe('huntProbability', () => {
  it('resolves the default selection through the odds engine', () => {
    expect(huntProbability(makeHunt())).toBeCloseTo(FULL_ODDS, 12);
  });

  it('survives a selection the data does not know', () => {
    const hunt = makeHunt({
      odds: { gameId: 'not-a-game', methodId: 'nope', shinyCharm: false, inputs: {} },
    });
    const probability = huntProbability(hunt);
    expect(probability).not.toBeNull();
    expect(probability).toBeGreaterThan(0);
  });
});

describe('rates and formatting', () => {
  it('needs a meaningful window before quoting a rate', () => {
    expect(encountersPerHour(3, 2_000)).toBeNull();
    expect(encountersPerHour(0, 3_600_000)).toBeNull();
    expect(encountersPerHour(250, 1_800_000)).toBe(500);
  });

  it('formats the odds ratio with magnitude-aware precision', () => {
    expect(formatOddsRatio(0)).toBe('—');
    expect(formatOddsRatio(0.4239)).toBe('0.42×');
    expect(formatOddsRatio(12.54)).toBe('12.5×');
    expect(formatOddsRatio(240.2)).toBe('240×');
  });

  it('measures a formatted count in digit widths', () => {
    expect(countGlyphUnits('7')).toBe(3);
    expect(countGlyphUnits('1,234')).toBe(4.45);
    expect(countGlyphUnits('12,345,678')).toBe(8.9);
  });
});

describe('countChangeDirection', () => {
  it('follows the sign of the delta and treats a phase reset as a move down', () => {
    expect(countChangeDirection({ kind: 'increment', delta: 5, source: 'hotkey-global' })).toBe(
      'up',
    );
    expect(countChangeDirection({ kind: 'undo', delta: -1, source: 'ui' })).toBe('down');
    expect(countChangeDirection({ kind: 'set-count', delta: 0, source: 'ui' })).toBeNull();
    expect(countChangeDirection({ kind: 'phase-logged', delta: 0, source: 'overlay' })).toBe(
      'down',
    );
    expect(countChangeDirection({ kind: 'edited', delta: 0, source: 'ui' })).toBeNull();
  });
});

describe('hunt and phase lists', () => {
  it('groups hunts by status, most recent first', () => {
    const older = makeHunt({ name: 'Older', updatedAt: '2026-10-01T00:00:00.000Z' });
    const newer = makeHunt({ name: 'Newer', updatedAt: '2026-10-12T00:00:00.000Z' });
    const done = makeHunt({ status: 'completed', completedAt: '2026-09-01T00:00:00.000Z' });
    const shelved = makeHunt({ status: 'archived' });

    const groups = groupHunts([older, done, newer, shelved]);
    expect(groups.active.map((hunt) => hunt.name)).toEqual(['Newer', 'Older']);
    expect(groups.completed).toEqual([done]);
    expect(groups.archived).toEqual([shelved]);
  });

  it('restores an archived hunt to the status it had', () => {
    expect(restoredStatus({ completedAt: null })).toBe('active');
    expect(restoredStatus({ completedAt: '2026-09-01T00:00:00.000Z' })).toBe('completed');
  });

  it('flattens phases newest first with per-hunt numbering and an optional hunt filter', () => {
    const ralts = makeHunt({
      name: 'Ralts hunt',
      phases: [
        makePhase({ speciesName: 'Zigzagoon', timestamp: '2026-10-01T10:00:00.000Z' }),
        makePhase({ speciesName: '', speciesId: null, timestamp: '2026-10-03T10:00:00.000Z' }),
      ],
    });
    const eevee = makeHunt({
      name: 'Eevee hunt',
      target: makeTarget({ name: 'Eevee' }),
      phases: [makePhase({ speciesName: 'Pidgey', timestamp: '2026-10-02T10:00:00.000Z' })],
    });

    const all = flattenPhases([ralts, eevee]);
    expect(all.map((row) => [row.huntName, row.phaseNumber])).toEqual([
      ['Ralts hunt', 2],
      ['Eevee hunt', 1],
      ['Ralts hunt', 1],
    ]);
    expect(all[1]?.targetName).toBe('Eevee');
    expect(phaseDisplayName(all[0]?.phase ?? makePhase())).toBe('Unidentified');

    expect(flattenPhases([ralts, eevee], eevee.id)).toHaveLength(1);
  });

  it('suggests a hunt name from the target', () => {
    expect(suggestHuntName('Ralts')).toBe('Shiny Ralts');
    expect(suggestHuntName('  ')).toBe('New hunt');
    expect(suggestHuntName(null)).toBe('New hunt');
  });
});

describe('sessions', () => {
  it('totals duration, encounters and phases and derives the overall rate', () => {
    const sessions = [
      makeSession({
        startedAt: '2026-10-13T10:00:00.000Z',
        endedAt: '2026-10-13T11:00:00.000Z',
        encounters: 300,
        phasesLogged: 1,
      }),
      makeSession({
        startedAt: '2026-10-13T12:00:00.000Z',
        endedAt: '2026-10-13T12:30:00.000Z',
        encounters: 150,
      }),
    ];
    expect(sessionDurationMs(sessions[1] ?? makeSession())).toBe(1_800_000);
    expect(sessionTotals(sessions)).toEqual({
      sessions: 2,
      durationMs: 5_400_000,
      encounters: 450,
      phases: 1,
      perHour: 300,
    });
  });

  it('never reports a negative duration for a malformed record', () => {
    expect(
      sessionDurationMs({ startedAt: '2026-10-13T12:00:00.000Z', endedAt: 'not a date' }),
    ).toBe(0);
  });
});

describe('export / import helpers', () => {
  it('keeps a full backup JSON-only', () => {
    expect(exportFormatsFor('backup')).toEqual(['json']);
    expect(resolveExportFormat('backup', 'csv')).toBe('json');
    expect(resolveExportFormat('phases', 'csv')).toBe('csv');
  });

  it('classifies import results', () => {
    const base: ImportResult = {
      canceled: false,
      filePath: 'C:\\backup.json',
      dataset: 'backup',
      imported: { hunts: 2, phases: 5, sessions: 9, targets: 0 },
      skipped: 0,
      errors: [],
    };
    expect(importOutcome(base)).toBe('clean');
    expect(importOutcome({ ...base, skipped: 1, errors: ['Row 4: invalid count'] })).toBe(
      'partial',
    );
    expect(importOutcome({ ...base, dataset: null })).toBe('unrecognised');
    expect(importOutcome({ ...base, canceled: true })).toBe('canceled');
    expect(
      importOutcome({ ...base, imported: { hunts: 0, phases: 0, sessions: 0, targets: 0 } }),
    ).toBe('nothing');
  });
});
