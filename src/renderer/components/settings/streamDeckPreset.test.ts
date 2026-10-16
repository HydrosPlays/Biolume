import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '@shared/defaults';
import { MAX_BINDINGS_PER_ACTION } from '@shared/types';
import type { Bindings } from './hotkeyRecording';
import {
  applyStreamDeckPreset,
  describePresetOutcome,
  STREAM_DECK_HOTKEYS,
} from './streamDeckPreset';

const WIN = 'win32';

/** Defaults: increment numadd, decrement numsub, toggleOverlay Ctrl+Shift+B, the rest unbound. */
function bindings(patch: Partial<Bindings> = {}): Bindings {
  return { ...createDefaultSettings().hotkeys.bindings, ...patch };
}

describe('STREAM_DECK_HOTKEYS', () => {
  it('maps F13–F16 to count, −1, log phase and Shiny Found', () => {
    expect(STREAM_DECK_HOTKEYS).toEqual([
      { action: 'increment', accelerator: 'F13' },
      { action: 'decrement', accelerator: 'F14' },
      { action: 'logPhase', accelerator: 'F15' },
      { action: 'shinyFound', accelerator: 'F16' },
    ]);
  });
});

describe('applyStreamDeckPreset', () => {
  it('adds the keys next to the existing ones and touches nothing else', () => {
    const current = bindings();
    const outcome = applyStreamDeckPreset(current, WIN);

    expect(outcome.patch).toEqual({
      increment: ['numadd', 'F13'],
      decrement: ['numsub', 'F14'],
      logPhase: ['F15'],
      shinyFound: ['F16'],
    });
    expect(outcome.added.map((entry) => entry.accelerator)).toEqual(['F13', 'F14', 'F15', 'F16']);
    expect(outcome.skipped).toEqual([]);
    // Pure: the input is not mutated.
    expect(current).toEqual(bindings());
  });

  it('skips keys that are already bound to their action, in any spelling', () => {
    const outcome = applyStreamDeckPreset(
      bindings({ increment: ['numadd', 'f13'], shinyFound: ['F16'] }),
      WIN,
    );
    expect(outcome.plan.map((entry) => entry.state)).toEqual([
      'bound',
      'available',
      'available',
      'bound',
    ]);
    expect(outcome.patch).toEqual({ decrement: ['numsub', 'F14'], logPhase: ['F15'] });
  });

  it('reports a key another action owns instead of taking it', () => {
    const outcome = applyStreamDeckPreset(bindings({ undo: ['F15'] }), WIN);
    expect(outcome.plan[2]).toMatchObject({
      action: 'logPhase',
      accelerator: 'F15',
      state: 'conflict',
      conflictWith: 'undo',
    });
    expect(outcome.patch.undo).toBeUndefined();
    expect(outcome.patch.logPhase).toBeUndefined();
    expect(outcome.skipped.map((entry) => entry.accelerator)).toEqual(['F15']);
  });

  it('respects the per-action limit', () => {
    const full = ['numadd', 'Space', 'F9'];
    expect(full).toHaveLength(MAX_BINDINGS_PER_ACTION);
    const outcome = applyStreamDeckPreset(bindings({ increment: full }), WIN);
    expect(outcome.plan[0]).toMatchObject({ action: 'increment', state: 'full' });
    expect(outcome.patch.increment).toBeUndefined();
    expect(outcome.patch.decrement).toEqual(['numsub', 'F14']);
  });

  it('has nothing to do once everything is bound', () => {
    const outcome = applyStreamDeckPreset(
      bindings({
        increment: ['numadd', 'F13'],
        decrement: ['numsub', 'F14'],
        logPhase: ['F15'],
        shinyFound: ['F16'],
      }),
      WIN,
    );
    expect(outcome.patch).toEqual({});
    expect(outcome.added).toEqual([]);
    expect(outcome.plan.every((entry) => entry.state === 'bound')).toBe(true);
  });
});

describe('describePresetOutcome', () => {
  it('confirms a clean run', () => {
    const message = describePresetOutcome(applyStreamDeckPreset(bindings(), WIN), true);
    expect(message).toMatchObject({ tone: 'success', title: 'Stream Deck hotkeys bound' });
    expect(message.description).toContain('Added F13, F14, F15, F16');
  });

  it('warns about what it could not bind, naming the owner', () => {
    const message = describePresetOutcome(
      applyStreamDeckPreset(bindings({ undo: ['F15'] }), WIN),
      true,
    );
    expect(message.tone).toBe('warning');
    expect(message.title).toBe('Some Stream Deck hotkeys were not bound');
    expect(message.description).toContain('F15 already belongs to “Undo last action”');
  });

  it('warns that the keys stay in-app while global hotkeys are off', () => {
    const message = describePresetOutcome(applyStreamDeckPreset(bindings(), WIN), false);
    expect(message.tone).toBe('warning');
    expect(message.description).toContain('Global hotkeys are off');
  });

  it('says so when there was nothing to do', () => {
    const done = bindings({
      increment: ['F13'],
      decrement: ['F14'],
      logPhase: ['F15'],
      shinyFound: ['F16'],
    });
    expect(describePresetOutcome(applyStreamDeckPreset(done, WIN), true)).toEqual({
      tone: 'info',
      title: 'F13–F16 are already set up',
    });
  });
});
