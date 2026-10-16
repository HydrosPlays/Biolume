/**
 * The decisions behind the global hotkeys, as pure functions: which
 * {@link HotkeyMode} applies, which accelerator belongs to which action, and
 * whether a trigger is a key auto-repeat. The `globalShortcut` calls themselves
 * live in `main.ts`.
 *
 * This module must stay free of `electron` imports so it can be unit-tested.
 */
import {
  HOTKEY_ACTIONS,
  type HotkeyAction,
  type HotkeyMode,
  type HotkeySettings,
  type HotkeyStatus,
} from '@shared/types';

/** Reported for an accelerator that an earlier action already claimed. */
export const DUPLICATE_BINDING_ERROR = 'Duplicate binding';

/** Triggers of one accelerator closer together than this are key auto-repeat. */
export const REPEAT_GUARD_MS = 60;

export interface HotkeyModeInput {
  /** `settings.hotkeys.globalEnabled`. */
  globalEnabled: boolean;
  /** The settings UI is recording a key combination. */
  capturing: boolean;
  /** The main window (or a dialog it owns) has keyboard focus. */
  mainFocused: boolean;
}

export function resolveHotkeyMode(input: HotkeyModeInput): HotkeyMode {
  if (!input.globalEnabled) return 'disabled';
  if (input.capturing) return 'capturing';
  return input.mainFocused ? 'app-focused' : 'active';
}

// Maps, not object literals: tokens come from user settings and must not hit `Object.prototype`.
const MODIFIERS: ReadonlyMap<string, string> = new Map([
  ['ctrl', 'control'],
  ['control', 'control'],
  ['cmd', 'command'],
  ['command', 'command'],
  ['super', 'command'],
  ['meta', 'command'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['altgr', 'altgr'],
  ['shift', 'shift'],
]);

const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['enter', 'return'],
  ['esc', 'escape'],
]);

/** Keys Electron resolves as Shift + another key of the US layout. */
const SHIFTED_KEYS: ReadonlyMap<string, string> = new Map([
  ['plus', '='],
  ['!', '1'],
  ['@', '2'],
  ['#', '3'],
  ['$', '4'],
  ['%', '5'],
  ['^', '6'],
  ['&', '7'],
  ['*', '8'],
  ['(', '9'],
  [')', '0'],
  ['_', '-'],
  ['{', '['],
  ['}', ']'],
  ['|', '\\'],
  [':', ';'],
  ['"', "'"],
  ['<', ','],
  ['>', '.'],
  ['?', '/'],
  ['~', '`'],
]);

/**
 * A comparison key for an accelerator: two strings that Electron would resolve
 * to the same key combination (`Ctrl+Shift+B`, `shift+control+b`,
 * `CmdOrCtrl+Shift+B` on Windows) share it. Malformed accelerators compare by
 * their lower-cased text. Only used to spot duplicates — `globalShortcut`
 * always receives the accelerator exactly as it is stored.
 */
export function normalizeAccelerator(
  accelerator: string,
  platform: string = process.platform,
): string {
  const verbatim = accelerator.trim().toLowerCase();
  const modifiers = new Set<string>();
  let key: string | null = null;

  for (const raw of verbatim.split('+')) {
    const token = raw.trim();
    const modifier =
      token === 'commandorcontrol' || token === 'cmdorctrl'
        ? platform === 'darwin'
          ? 'command'
          : 'control'
        : MODIFIERS.get(token);
    if (modifier !== undefined) {
      modifiers.add(modifier);
      continue;
    }
    // An empty token (`Ctrl++`) or a second key (`A+B`) is not something Electron accepts.
    if (token === '' || key !== null) return verbatim;
    const shifted = SHIFTED_KEYS.get(token);
    if (shifted !== undefined) {
      modifiers.add('shift');
      key = shifted;
    } else {
      key = KEY_ALIASES.get(token) ?? token;
    }
  }

  return key === null ? verbatim : [...[...modifiers].sort(), key].join('+');
}

export interface PlannedBinding {
  action: HotkeyAction;
  /** The accelerator as stored in the settings — what `globalShortcut` is given. */
  accelerator: string;
  /** The action that claimed this key combination first; null when this binding owns it. */
  duplicateOf: HotkeyAction | null;
}

/**
 * Every configured binding in a stable order (`HOTKEY_ACTIONS`, then list
 * order). A key combination bound more than once goes to its first binding;
 * the others are marked as duplicates and must not be registered.
 */
export function planBindings(
  bindings: HotkeySettings['bindings'],
  platform: string = process.platform,
): PlannedBinding[] {
  const owners = new Map<string, HotkeyAction>();
  const plan: PlannedBinding[] = [];
  for (const action of HOTKEY_ACTIONS) {
    for (const entry of bindings[action]) {
      const accelerator = entry.trim();
      if (accelerator === '') continue;
      const key = normalizeAccelerator(accelerator, platform);
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, action);
      plan.push({ action, accelerator, duplicateOf: owner ?? null });
    }
  }
  return plan;
}

/** Changes exactly when the set of bindings to register changes. */
export function planSignature(plan: readonly PlannedBinding[]): string {
  return JSON.stringify(
    plan.map((binding) => [binding.action, binding.accelerator, binding.duplicateOf]),
  );
}

/**
 * Compares a {@link HotkeyStatus} with what the OS actually holds and returns
 * one line per disagreement (empty when they match exactly).
 *
 * The comparison is per key combination, not per binding: a combination bound
 * twice is one OS registration — owned by its first binding — while the
 * duplicate is listed as `registered: false`. It must be held when ANY binding
 * of it is registered, and only in `active` mode; in every other mode the OS
 * holds nothing and `registered` merely says the key is available.
 *
 * `isRegistered` is Electron's `globalShortcut.isRegistered`, which throws for
 * a malformed accelerator: such a key cannot be held, so that counts as "no".
 */
export function findRegistrationMismatches(
  status: HotkeyStatus,
  isRegistered: (accelerator: string) => boolean,
  platform: string = process.platform,
): string[] {
  const combinations = new Map<string, { accelerator: string; expected: boolean }>();
  for (const { accelerator, registered } of status.registrations) {
    const key = normalizeAccelerator(accelerator, platform);
    const expected = status.mode === 'active' && registered;
    // The registered binding of a combination speaks for it; otherwise its first one.
    if (expected || !combinations.has(key)) combinations.set(key, { accelerator, expected });
  }

  const mismatches: string[] = [];
  for (const { accelerator, expected } of combinations.values()) {
    let held: boolean;
    try {
      held = isRegistered(accelerator);
    } catch {
      held = false;
    }
    if (held !== expected) {
      mismatches.push(
        expected
          ? `"${accelerator}" is reported as registered but the OS does not hold it`
          : `"${accelerator}" is held by the OS but not reported as registered`,
      );
    }
  }
  return mismatches;
}

export interface RepeatGuard {
  /** Records a trigger of `key` and tells whether it should be acted on. */
  accept(key: string): boolean;
  reset(): void;
}

/**
 * Filters key auto-repeat: a trigger is dropped when it follows the previous
 * trigger of the same key — accepted or not — by less than `minIntervalMs`, so
 * a held key cannot slip through on every other repeat.
 */
export function createRepeatGuard(
  minIntervalMs: number = REPEAT_GUARD_MS,
  now: () => number = Date.now,
): RepeatGuard {
  const lastTrigger = new Map<string, number>();
  return {
    accept(key) {
      const at = now();
      const previous = lastTrigger.get(key);
      lastTrigger.set(key, at);
      // `at < previous` means the clock was set back; never swallow input because of that.
      return previous === undefined || at < previous || at - previous >= minIntervalMs;
    },
    reset() {
      lastTrigger.clear();
    },
  };
}
