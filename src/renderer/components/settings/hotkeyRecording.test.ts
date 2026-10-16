import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '@shared/defaults';
import { MAX_BINDINGS_PER_ACTION, type HotkeyStatus } from '@shared/types';
import type { KeyEventLike } from '@renderer/lib/accelerator';
import {
  activeCountPreset,
  applyCountPreset,
  bindingStatus,
  captureStep,
  describeAccelerator,
  evaluateRecording,
  removeBinding,
  RISKY_KEY_WARNING,
  type Bindings,
} from './hotkeyRecording';

const WIN = 'win32';

/** Defaults: increment numadd, decrement numsub, toggleOverlay Ctrl+Shift+B. */
function bindings(patch: Partial<Bindings> = {}): Bindings {
  return { ...createDefaultSettings().hotkeys.bindings, ...patch };
}

function key(init: Partial<KeyEventLike> & { key: string; code: string }): KeyEventLike {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init };
}

describe('evaluateRecording', () => {
  it('accepts a free combination and appends it to the action', () => {
    const verdict = evaluateRecording(bindings(), 'increment', 'F9', WIN);
    expect(verdict).toEqual({
      ok: true,
      accelerator: 'F9',
      next: ['numadd', 'F9'],
      warning: null,
    });
  });

  it('rejects a combination that another action owns, naming that action', () => {
    const verdict = evaluateRecording(bindings(), 'undo', 'numadd', WIN);
    expect(verdict).toMatchObject({ ok: false, reason: 'conflict', conflictWith: 'increment' });
    expect(verdict.ok ? '' : verdict.message).toContain(
      'Num + is already bound to “Count encounter”',
    );
  });

  it('sees through different spellings of the same keys', () => {
    // Stored as CommandOrControl+Shift+B; on Windows that is Ctrl+Shift+B however it is written.
    for (const spelling of ['Control+Shift+B', 'shift+ctrl+b', 'CmdOrCtrl+Shift+B']) {
      expect(evaluateRecording(bindings(), 'logPhase', spelling, WIN)).toMatchObject({
        ok: false,
        reason: 'conflict',
        conflictWith: 'toggleOverlay',
      });
    }
    // On macOS the stored binding is ⌘⇧B, so ⌃⇧B is a different, free combination.
    expect(evaluateRecording(bindings(), 'logPhase', 'Control+Shift+B', 'darwin').ok).toBe(true);
  });

  it('rejects a combination the same action already has', () => {
    expect(evaluateRecording(bindings(), 'increment', 'NumAdd', WIN)).toMatchObject({
      ok: false,
      reason: 'already-bound',
    });
  });

  it('enforces the per-action limit before anything else', () => {
    const full = bindings({ increment: ['numadd', 'Space', 'F9'] });
    expect(full.increment).toHaveLength(MAX_BINDINGS_PER_ACTION);
    const verdict = evaluateRecording(full, 'increment', 'F10', WIN);
    expect(verdict).toMatchObject({ ok: false, reason: 'full' });
    expect(verdict.ok ? '' : verdict.message).toContain(`${MAX_BINDINGS_PER_ACTION} shortcuts`);
    // Other actions are unaffected by one action being full.
    expect(evaluateRecording(full, 'undo', 'F10', WIN).ok).toBe(true);
  });

  it('rejects what Electron would not accept', () => {
    expect(evaluateRecording(bindings(), 'undo', 'Biolume+Not+A+Key', WIN)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('accepts a bare typing key but warns that it is captured system-wide', () => {
    const space = evaluateRecording(bindings(), 'increment', 'Space', WIN);
    expect(space).toMatchObject({ ok: true, accelerator: 'Space', warning: RISKY_KEY_WARNING });
    expect(RISKY_KEY_WARNING).toContain('captured system-wide and will not reach your game');

    expect(evaluateRecording(bindings(), 'undo', 'Shift+A', WIN)).toMatchObject({
      warning: RISKY_KEY_WARNING,
    });
    // A modifier, the numpad and function keys are safe.
    for (const safe of ['CommandOrControl+Space', 'num5', 'F9']) {
      expect(evaluateRecording(bindings(), 'undo', safe, WIN)).toMatchObject({ warning: null });
    }
  });
});

describe('captureStep', () => {
  it('cancels on a bare Esc only', () => {
    expect(captureStep(key({ key: 'Escape', code: 'Escape' }), WIN)).toEqual({ kind: 'cancel' });
    expect(captureStep(key({ key: 'Escape', code: 'Escape', shiftKey: true }), WIN)).toEqual({
      kind: 'complete',
      accelerator: 'Shift+Escape',
    });
  });

  it('captures F13–F24, the keys Stream Deck’s Hotkey action sends, and labels them', () => {
    for (const name of ['F13', 'F16', 'F20', 'F24']) {
      const step = captureStep(key({ key: name, code: name }), WIN);
      expect(step).toEqual({ kind: 'complete', accelerator: name });
      const verdict = evaluateRecording(bindings(), 'shinyFound', name, WIN);
      expect(verdict).toMatchObject({ ok: true, accelerator: name, warning: null });
    }
    expect(describeAccelerator('F13', WIN)).toBe('F13');
    expect(describeAccelerator('Shift+F14', WIN)).toBe('Shift + F14');
    // Keys injected by another program (Stream Deck sends virtual keys) may come without a code.
    expect(captureStep(key({ key: 'F15', code: '' }), WIN)).toEqual({
      kind: 'complete',
      accelerator: 'F15',
    });
  });

  it('shows the held modifiers and waits for a key', () => {
    const step = captureStep(
      key({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true }),
      WIN,
    );
    expect(step).toEqual({ kind: 'pending', held: ['Ctrl', 'Shift'] });
  });

  it('completes with the Electron accelerator of the combination', () => {
    expect(
      captureStep(key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }), WIN),
    ).toEqual({ kind: 'complete', accelerator: 'CommandOrControl+Shift+B' });
    expect(captureStep(key({ key: '+', code: 'NumpadAdd' }), WIN)).toEqual({
      kind: 'complete',
      accelerator: 'numadd',
    });
  });
});

describe('count presets', () => {
  it('replaces the count key and takes it from an action that used it', () => {
    const current = bindings({ increment: ['numadd', 'F9'], logPhase: ['Space', 'F8'] });
    const outcome = applyCountPreset(current, 'Space', WIN);
    expect(outcome.patch).toEqual({ increment: ['Space'], logPhase: ['F8'] });
    expect(outcome.movedFrom).toEqual(['logPhase']);
    expect(outcome.warning).toBe(RISKY_KEY_WARNING);
  });

  it('knows which preset is in effect', () => {
    expect(activeCountPreset(bindings(), WIN)?.id).toBe('numpad');
    expect(activeCountPreset(bindings({ increment: ['F9'] }), WIN)?.id).toBe('f9');
    expect(activeCountPreset(bindings({ increment: ['numadd', 'F9'] }), WIN)).toBeNull();
  });
});

describe('removeBinding', () => {
  it('removes exactly the stored accelerator', () => {
    const current = bindings({ increment: ['numadd', 'Space'] });
    expect(removeBinding(current, 'increment', 'numadd')).toEqual(['Space']);
  });
});

describe('bindingStatus', () => {
  const registrations: HotkeyStatus['registrations'] = [
    { action: 'increment', accelerator: 'numadd', registered: true },
    {
      action: 'decrement',
      accelerator: 'numsub',
      registered: false,
      error: 'In use by another application or reserved by the system',
    },
  ];

  it('tells registered from merely available', () => {
    expect(bindingStatus({ mode: 'active', registrations }, 'increment', 'numadd').health).toBe(
      'registered',
    );
    expect(
      bindingStatus({ mode: 'app-focused', registrations }, 'increment', 'numadd').health,
    ).toBe('ready');
  });

  it('carries the reason of a failed registration', () => {
    const status = bindingStatus({ mode: 'app-focused', registrations }, 'decrement', 'numsub');
    expect(status.health).toBe('failed');
    expect(status.detail).toContain('In use by another application');
  });

  it('reports nothing about the OS while global hotkeys are off', () => {
    const off: HotkeyStatus = {
      mode: 'disabled',
      registrations: registrations.map((entry) => ({ ...entry, registered: false })),
    };
    expect(bindingStatus(off, 'decrement', 'numsub').health).toBe('off');
  });
});
