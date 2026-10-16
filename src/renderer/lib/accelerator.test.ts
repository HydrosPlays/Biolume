import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '@shared/defaults';
import {
  acceleratorsEqual,
  eventToAccelerator,
  findBoundAction,
  formatAccelerator,
  isRiskyGlobalAccelerator,
  isValidAccelerator,
  matchBinding,
  matchesEvent,
  normalizeAccelerator,
  parseAccelerator,
  type KeyEventLike,
} from './accelerator';

function key(code: string, keyValue: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    code,
    key: keyValue,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  };
}

describe('eventToAccelerator', () => {
  it('maps numpad operators and digits to Electron numpad tokens', () => {
    expect(eventToAccelerator(key('NumpadAdd', '+'), 'win32')).toBe('numadd');
    expect(eventToAccelerator(key('NumpadSubtract', '-'), 'win32')).toBe('numsub');
    expect(eventToAccelerator(key('NumpadMultiply', '*'), 'win32')).toBe('nummult');
    expect(eventToAccelerator(key('NumpadDivide', '/'), 'win32')).toBe('numdiv');
    expect(eventToAccelerator(key('NumpadDecimal', '.'), 'win32')).toBe('numdec');
    expect(eventToAccelerator(key('Numpad0', '0'), 'win32')).toBe('num0');
    expect(eventToAccelerator(key('Numpad9', '9'), 'win32')).toBe('num9');
  });

  it('maps Space, arrows, function keys, letters, digits and punctuation', () => {
    expect(eventToAccelerator(key('Space', ' '), 'win32')).toBe('Space');
    expect(eventToAccelerator(key('ArrowUp', 'ArrowUp'), 'win32')).toBe('Up');
    expect(eventToAccelerator(key('ArrowLeft', 'ArrowLeft'), 'win32')).toBe('Left');
    expect(eventToAccelerator(key('F1', 'F1'), 'win32')).toBe('F1');
    expect(eventToAccelerator(key('F24', 'F24'), 'win32')).toBe('F24');
    expect(eventToAccelerator(key('KeyB', 'b'), 'win32')).toBe('B');
    expect(eventToAccelerator(key('Digit7', '7'), 'win32')).toBe('7');
    expect(eventToAccelerator(key('Minus', '-'), 'win32')).toBe('-');
    expect(eventToAccelerator(key('BracketLeft', '['), 'win32')).toBe('[');
    expect(eventToAccelerator(key('Enter', 'Enter'), 'win32')).toBe('Return');
    expect(eventToAccelerator(key('Escape', 'Escape'), 'win32')).toBe('Escape');
  });

  it('returns null for modifier-only presses', () => {
    expect(eventToAccelerator(key('ShiftLeft', 'Shift', { shiftKey: true }), 'win32')).toBeNull();
    expect(
      eventToAccelerator(key('ControlRight', 'Control', { ctrlKey: true }), 'win32'),
    ).toBeNull();
    expect(eventToAccelerator(key('AltLeft', 'Alt', { altKey: true }), 'win32')).toBeNull();
    expect(eventToAccelerator(key('MetaLeft', 'Meta', { metaKey: true }), 'win32')).toBeNull();
  });

  it('orders modifiers CommandOrControl, Alt, Shift, Super on Windows', () => {
    const event = key('KeyB', 'B', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true });
    expect(eventToAccelerator(event, 'win32')).toBe('CommandOrControl+Alt+Shift+Super+B');
    expect(eventToAccelerator(key('KeyB', 'B', { ctrlKey: true, shiftKey: true }), 'win32')).toBe(
      'CommandOrControl+Shift+B',
    );
  });

  it('distinguishes ⌘ from Ctrl on macOS', () => {
    expect(eventToAccelerator(key('KeyB', 'b', { metaKey: true }), 'darwin')).toBe(
      'CommandOrControl+B',
    );
    expect(eventToAccelerator(key('KeyB', 'b', { ctrlKey: true }), 'darwin')).toBe('Control+B');
    expect(eventToAccelerator(key('KeyB', 'b', { ctrlKey: true, metaKey: true }), 'darwin')).toBe(
      'CommandOrControl+Control+B',
    );
  });

  it('keeps the physical digit / punctuation key when Shift changes the character', () => {
    expect(eventToAccelerator(key('Digit1', '!', { shiftKey: true }), 'win32')).toBe('Shift+1');
    expect(eventToAccelerator(key('Equal', '+', { shiftKey: true }), 'win32')).toBe('Shift+=');
  });

  it('follows the layout for letters and the position for everything else', () => {
    // AZERTY: the key in the QWERTY "Q" position types "a".
    expect(eventToAccelerator(key('KeyQ', 'a'), 'win32')).toBe('A');
    // A non-Latin layout falls back to the physical key.
    expect(eventToAccelerator(key('KeyA', 'ф'), 'win32')).toBe('A');
  });

  it('falls back to `key` when `code` is missing', () => {
    expect(eventToAccelerator(key('', ' '), 'win32')).toBe('Space');
    expect(eventToAccelerator(key('', 'ArrowDown'), 'win32')).toBe('Down');
    expect(eventToAccelerator(key('', 'Unidentified'), 'win32')).toBeNull();
  });

  it('reports AltGr as AltGr rather than Ctrl+Alt', () => {
    const event = key('KeyE', '€', {
      ctrlKey: true,
      altKey: true,
      getModifierState: (name) => name === 'AltGraph',
    });
    expect(eventToAccelerator(event, 'win32')).toBe('AltGr+E');
  });
});

describe('parseAccelerator / normalizeAccelerator / isValidAccelerator', () => {
  it('canonicalises aliases, case and order', () => {
    expect(normalizeAccelerator('shift+ctrl+b')).toBe('Control+Shift+B');
    expect(normalizeAccelerator('CmdOrCtrl+Alt+f5')).toBe('CommandOrControl+Alt+F5');
    expect(normalizeAccelerator('Option+Meta+enter')).toBe('Alt+Super+Return');
    expect(normalizeAccelerator('ESC')).toBe('Escape');
    expect(normalizeAccelerator('NUMADD')).toBe('numadd');
    expect(normalizeAccelerator('Num5')).toBe('num5');
    expect(normalizeAccelerator(' Shift + Space ')).toBe('Shift+Space');
  });

  it('rewrites shifted symbols as Shift + base key', () => {
    expect(normalizeAccelerator('Plus')).toBe('Shift+=');
    expect(normalizeAccelerator('Control++')).toBe('Control+Shift+=');
    expect(normalizeAccelerator('!')).toBe('Shift+1');
    expect(normalizeAccelerator('Shift+?')).toBe('Shift+/');
  });

  it('is idempotent', () => {
    for (const accelerator of [
      'CommandOrControl+Shift+B',
      'numadd',
      'Shift+=',
      'Alt+F4',
      'Space',
    ]) {
      expect(normalizeAccelerator(normalizeAccelerator(accelerator) ?? '')).toBe(
        normalizeAccelerator(accelerator),
      );
    }
  });

  it('rejects malformed accelerators', () => {
    for (const bad of [
      '',
      '   ',
      'Control',
      'Control+Shift',
      'A+B',
      'Control+Control+A',
      'Ctrl+',
      '+A',
      'F25',
      'num10',
      'Hyper+A',
      'Banana',
    ]) {
      expect(isValidAccelerator(bad), bad).toBe(false);
      expect(normalizeAccelerator(bad), bad).toBeNull();
      expect(parseAccelerator(bad), bad).toBeNull();
    }
  });

  it('accepts everything in the default settings', () => {
    const { bindings } = createDefaultSettings().hotkeys;
    for (const accelerator of Object.values(bindings).flat()) {
      expect(isValidAccelerator(accelerator), accelerator).toBe(true);
    }
  });

  it('exposes parsed modifiers and key', () => {
    expect(parseAccelerator('Shift+CmdOrCtrl+b')).toEqual({
      modifiers: ['CommandOrControl', 'Shift'],
      key: 'B',
    });
  });
});

describe('acceleratorsEqual', () => {
  it('treats CommandOrControl as Ctrl on Windows and ⌘ on macOS', () => {
    expect(acceleratorsEqual('CommandOrControl+B', 'Ctrl+B', 'win32')).toBe(true);
    expect(acceleratorsEqual('CommandOrControl+B', 'Cmd+B', 'win32')).toBe(false);
    expect(acceleratorsEqual('CommandOrControl+B', 'Cmd+B', 'darwin')).toBe(true);
    expect(acceleratorsEqual('CommandOrControl+B', 'Ctrl+B', 'darwin')).toBe(false);
  });

  it('ignores spelling differences and compares the real combination', () => {
    expect(acceleratorsEqual('shift+alt+f1', 'Alt+Shift+F1', 'win32')).toBe(true);
    expect(acceleratorsEqual('Plus', 'Shift+=', 'win32')).toBe(true);
    expect(acceleratorsEqual('Enter', 'Return', 'win32')).toBe(true);
    expect(acceleratorsEqual('numadd', 'Plus', 'win32')).toBe(false);
    expect(acceleratorsEqual('A', 'Shift+A', 'win32')).toBe(false);
  });

  it('never equates invalid accelerators', () => {
    expect(acceleratorsEqual('', '', 'win32')).toBe(false);
    expect(acceleratorsEqual('Banana', 'Banana', 'win32')).toBe(false);
  });
});

describe('matchesEvent', () => {
  it('matches the exact combination only', () => {
    const accelerator = 'CommandOrControl+Shift+B';
    expect(
      matchesEvent(accelerator, key('KeyB', 'B', { ctrlKey: true, shiftKey: true }), 'win32'),
    ).toBe(true);
    expect(matchesEvent(accelerator, key('KeyB', 'b', { ctrlKey: true }), 'win32')).toBe(false);
    expect(
      matchesEvent(
        accelerator,
        key('KeyB', 'B', { ctrlKey: true, shiftKey: true, altKey: true }),
        'win32',
      ),
    ).toBe(false);
    expect(
      matchesEvent(accelerator, key('KeyB', 'B', { metaKey: true, shiftKey: true }), 'darwin'),
    ).toBe(true);
  });

  it('matches bare keys without modifiers', () => {
    expect(matchesEvent('numadd', key('NumpadAdd', '+'), 'win32')).toBe(true);
    expect(matchesEvent('numadd', key('NumpadAdd', '+', { ctrlKey: true }), 'win32')).toBe(false);
    expect(matchesEvent('Space', key('Space', ' '), 'win32')).toBe(true);
    expect(matchesEvent('Space', key('Space', ' ', { shiftKey: true }), 'win32')).toBe(false);
  });

  it('never matches modifier-only events or invalid accelerators', () => {
    expect(matchesEvent('Shift+A', key('ShiftLeft', 'Shift', { shiftKey: true }), 'win32')).toBe(
      false,
    );
    expect(matchesEvent('Banana', key('KeyB', 'b'), 'win32')).toBe(false);
  });

  it('round-trips with eventToAccelerator', () => {
    const events = [
      key('NumpadAdd', '+'),
      key('KeyZ', 'z', { ctrlKey: true }),
      key('F9', 'F9', { altKey: true, shiftKey: true }),
      key('Equal', '+', { shiftKey: true }),
      key('Slash', '/', { metaKey: true }),
    ];
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const event of events) {
        const accelerator = eventToAccelerator(event, platform);
        expect(accelerator).not.toBeNull();
        expect(matchesEvent(accelerator ?? '', event, platform)).toBe(true);
      }
    }
  });
});

describe('matchBinding / findBoundAction', () => {
  const bindings = {
    ...createDefaultSettings().hotkeys.bindings,
    undo: ['CommandOrControl+Z'],
    logPhase: ['F8', 'Shift+P'],
  };

  it('returns the action bound to an event', () => {
    expect(matchBinding(bindings, key('NumpadAdd', '+'), 'win32')).toBe('increment');
    expect(matchBinding(bindings, key('NumpadSubtract', '-'), 'win32')).toBe('decrement');
    expect(matchBinding(bindings, key('KeyZ', 'z', { ctrlKey: true }), 'win32')).toBe('undo');
    expect(matchBinding(bindings, key('KeyP', 'P', { shiftKey: true }), 'win32')).toBe('logPhase');
    expect(
      matchBinding(bindings, key('KeyB', 'B', { ctrlKey: true, shiftKey: true }), 'win32'),
    ).toBe('toggleOverlay');
    expect(matchBinding(bindings, key('KeyQ', 'q'), 'win32')).toBeNull();
  });

  it('finds conflicts, optionally ignoring the action being edited', () => {
    expect(findBoundAction(bindings, 'Ctrl+Z', { platform: 'win32' })).toBe('undo');
    expect(findBoundAction(bindings, 'Ctrl+Z', { platform: 'win32', ignore: 'undo' })).toBeNull();
    expect(findBoundAction(bindings, 'F9', { platform: 'win32' })).toBeNull();
  });
});

describe('formatAccelerator', () => {
  it('produces key-cap labels for Windows', () => {
    expect(formatAccelerator('CommandOrControl+Shift+B', 'win32')).toEqual(['Ctrl', 'Shift', 'B']);
    expect(formatAccelerator('numadd', 'win32')).toEqual(['Num +']);
    expect(formatAccelerator('numsub', 'win32')).toEqual(['Num -']);
    expect(formatAccelerator('num7', 'win32')).toEqual(['Num 7']);
    expect(formatAccelerator('Space', 'win32')).toEqual(['Space']);
    expect(formatAccelerator('Super+Return', 'win32')).toEqual(['Win', 'Enter']);
    expect(formatAccelerator('Alt+Up', 'win32')).toEqual(['Alt', '↑']);
    expect(formatAccelerator('Plus', 'win32')).toEqual(['Shift', '=']);
  });

  it('uses symbols on macOS and never repeats a label', () => {
    expect(formatAccelerator('CommandOrControl+Shift+B', 'darwin')).toEqual(['⌘', '⇧', 'B']);
    expect(formatAccelerator('Control+Alt+Delete', 'darwin')).toEqual(['⌃', '⌥', 'Del']);
    expect(formatAccelerator('CommandOrControl+Command+K', 'darwin')).toEqual(['⌘', 'K']);
  });

  it('falls back to raw tokens for invalid accelerators', () => {
    expect(formatAccelerator('Hyper+Banana', 'win32')).toEqual(['Hyper', 'Banana']);
    expect(formatAccelerator('', 'win32')).toEqual([]);
  });
});

describe('isRiskyGlobalAccelerator', () => {
  it('flags bare typing and navigation keys', () => {
    for (const accelerator of [
      'Space',
      'A',
      'z',
      '7',
      '-',
      'Return',
      'Tab',
      'Backspace',
      'Up',
      'Shift+A',
      'Plus',
    ]) {
      expect(isRiskyGlobalAccelerator(accelerator), accelerator).toBe(true);
    }
  });

  it('accepts modified keys, numpad, function and media keys', () => {
    for (const accelerator of [
      'numadd',
      'numsub',
      'num0',
      'F8',
      'Shift+F8',
      'CommandOrControl+Shift+B',
      'Alt+Space',
      'Super+A',
      'MediaPlayPause',
    ]) {
      expect(isRiskyGlobalAccelerator(accelerator), accelerator).toBe(false);
    }
  });

  it('does not flag the default bindings or invalid input', () => {
    const { bindings } = createDefaultSettings().hotkeys;
    for (const accelerator of Object.values(bindings).flat()) {
      expect(isRiskyGlobalAccelerator(accelerator), accelerator).toBe(false);
    }
    expect(isRiskyGlobalAccelerator('Banana')).toBe(false);
  });
});
