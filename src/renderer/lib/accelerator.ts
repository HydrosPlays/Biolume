/**
 * Electron accelerator helpers for the renderer.
 *
 * The main process registers `settings.hotkeys.bindings` with `globalShortcut`
 * while Biolume is unfocused; while it is focused the renderer has to match the
 * very same strings against DOM keyboard events. Everything here is pure.
 *
 * @see https://www.electronjs.org/docs/latest/api/accelerator
 */
import { HOTKEY_ACTIONS, type HotkeyAction } from '@shared/types';

/** The subset of `KeyboardEvent` these helpers read (DOM and React events both fit). */
export interface KeyEventLike {
  readonly code: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  getModifierState?(key: string): boolean;
}

/** Canonical modifier tokens, in canonical order. */
export const ACCELERATOR_MODIFIERS = [
  'CommandOrControl',
  'Command',
  'Control',
  'Alt',
  'AltGr',
  'Shift',
  'Super',
] as const;
export type AcceleratorModifier = (typeof ACCELERATOR_MODIFIERS)[number];

export interface ParsedAccelerator {
  /** Canonical tokens in canonical order, without duplicates. */
  modifiers: AcceleratorModifier[];
  /** Canonical key token, e.g. `B`, `numadd`, `Space`, `F5`, `=`. Never a shifted symbol. */
  key: string;
}

const MODIFIER_ALIASES: Readonly<Record<string, AcceleratorModifier>> = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
};

/** Named (multi-character) keys: lower-cased alias → canonical token. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  space: 'Space',
  tab: 'Tab',
  capslock: 'Capslock',
  numlock: 'Numlock',
  scrolllock: 'Scrolllock',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  return: 'Return',
  enter: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute',
  medianexttrack: 'MediaNextTrack',
  mediaprevioustrack: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
  mediaplaypause: 'MediaPlayPause',
  printscreen: 'PrintScreen',
  numdec: 'numdec',
  numadd: 'numadd',
  numsub: 'numsub',
  nummult: 'nummult',
  numdiv: 'numdiv',
};

const BASE_PUNCTUATION = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);

/**
 * Symbols Electron accepts as keys but that are really Shift + another key on
 * the US layout Chromium resolves accelerators against. They canonicalise to
 * `Shift+<base>` so `Plus`, `+` and `Shift+=` all compare equal.
 */
const SHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
};

/** `KeyboardEvent.code` → canonical key token (letters, digits, F-keys and numpad digits are computed). */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  PrintScreen: 'PrintScreen',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  MediaPlayPause: 'MediaPlayPause',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
};

/** `KeyboardEvent.key` fallback for events without a usable `code` (IME, synthetic events). */
const KEY_VALUE_KEYS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Tab: 'Tab',
  Enter: 'Return',
  Escape: 'Escape',
  Esc: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Del: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  PrintScreen: 'PrintScreen',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  MediaPlayPause: 'MediaPlayPause',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
};

const MODIFIER_KEY_VALUES = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Super',
  'Hyper',
  'Fn',
  'FnLock',
  'Symbol',
  'SymbolLock',
  'Dead',
  'Process',
  'Unidentified',
]);

const FUNCTION_KEY = /^f([1-9]|1\d|2[0-4])$/;
const NUMPAD_DIGIT = /^num\d$/;

/** Keys a person types or navigates with — see {@link isRiskyGlobalAccelerator}. */
const ESSENTIAL_KEYS = new Set([
  'Space',
  'Return',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** Host platform (`process.platform` style); falls back to `navigator` outside Electron. */
export function getPlatform(): string {
  const fromBridge = typeof window === 'undefined' ? undefined : window.biolume?.platform;
  if (fromBridge) return fromBridge;
  const hint = typeof navigator === 'undefined' ? '' : navigator.platform.toLowerCase();
  if (hint.startsWith('mac')) return 'darwin';
  if (hint.startsWith('win')) return 'win32';
  return 'linux';
}

function isMac(platform: string): boolean {
  return platform === 'darwin';
}

/** Resolves one key token to `{ key, shifted }`, or null when Electron would not accept it. */
function canonicalKey(token: string): { key: string; shifted: boolean } | null {
  if (token.length === 1) {
    if (/[a-z]/i.test(token)) return { key: token.toUpperCase(), shifted: false };
    if (/\d/.test(token)) return { key: token, shifted: false };
    if (BASE_PUNCTUATION.has(token)) return { key: token, shifted: false };
    const base = SHIFTED_SYMBOLS[token];
    return base === undefined ? null : { key: base, shifted: true };
  }
  const lower = token.toLowerCase();
  if (lower === 'plus') return { key: '=', shifted: true };
  if (FUNCTION_KEY.test(lower)) return { key: lower.toUpperCase(), shifted: false };
  if (NUMPAD_DIGIT.test(lower)) return { key: lower, shifted: false };
  const named = NAMED_KEYS[lower];
  return named === undefined ? null : { key: named, shifted: false };
}

function tokenize(accelerator: string): string[] {
  const parts = accelerator.split('+').map((part) => part.trim());
  // A literal "+" key shows up as trailing empty parts: "Control++" → ['Control', '', ''].
  if (parts.length >= 2 && parts.at(-1) === '' && parts.at(-2) === '') {
    parts.splice(-2, 2, '+');
  }
  return parts;
}

function sortModifiers(modifiers: Iterable<AcceleratorModifier>): AcceleratorModifier[] {
  const present = new Set(modifiers);
  return ACCELERATOR_MODIFIERS.filter((modifier) => present.has(modifier));
}

/**
 * Parses an accelerator string. Returns null when it is not a valid Electron
 * accelerator: empty, an unknown token, a repeated modifier, or anything other
 * than exactly one non-modifier key.
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  if (typeof accelerator !== 'string' || accelerator.trim() === '') return null;

  const modifiers = new Set<AcceleratorModifier>();
  let key: string | null = null;

  for (const token of tokenize(accelerator)) {
    if (token === '') return null;
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier !== undefined) {
      if (modifiers.has(modifier)) return null;
      modifiers.add(modifier);
      continue;
    }
    const resolved = canonicalKey(token);
    if (resolved === null || key !== null) return null;
    key = resolved.key;
    if (resolved.shifted) modifiers.add('Shift');
  }

  return key === null ? null : { modifiers: sortModifiers(modifiers), key };
}

function serialize(parsed: ParsedAccelerator): string {
  return [...parsed.modifiers, parsed.key].join('+');
}

/**
 * Canonical spelling of an accelerator: alias-free modifiers in a fixed order
 * (CommandOrControl, Command, Control, Alt, AltGr, Shift, Super) followed by the
 * key (`ctrl+shift+b` → `Control+Shift+B`, `Plus` → `Shift+=`, `Enter` → `Return`).
 * The result is always accepted by Electron. Returns null for invalid input.
 */
export function normalizeAccelerator(accelerator: string): string | null {
  const parsed = parseAccelerator(accelerator);
  return parsed === null ? null : serialize(parsed);
}

export function isValidAccelerator(accelerator: string): boolean {
  return parseAccelerator(accelerator) !== null;
}

interface PhysicalCombo {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  altGr: boolean;
  key: string;
}

/** Maps the platform-dependent tokens onto the modifier keys that are physically held. */
function toPhysical(parsed: ParsedAccelerator, platform: string): PhysicalCombo {
  const has = (modifier: AcceleratorModifier): boolean => parsed.modifiers.includes(modifier);
  const mac = isMac(platform);
  return {
    ctrl: has('Control') || (!mac && has('CommandOrControl')),
    meta: has('Command') || has('Super') || (mac && has('CommandOrControl')),
    alt: has('Alt'),
    shift: has('Shift'),
    altGr: has('AltGr'),
    key: parsed.key,
  };
}

/**
 * Whether two accelerators describe the same key combination on `platform`
 * (`CommandOrControl+B` equals `Ctrl+B` on Windows and `Cmd+B` on macOS).
 * Invalid accelerators never equal anything.
 */
export function acceleratorsEqual(a: string, b: string, platform: string = getPlatform()): boolean {
  const left = parseAccelerator(a);
  const right = parseAccelerator(b);
  if (left === null || right === null) return false;
  const x = toPhysical(left, platform);
  const y = toPhysical(right, platform);
  return (
    x.key === y.key &&
    x.ctrl === y.ctrl &&
    x.meta === y.meta &&
    x.alt === y.alt &&
    x.shift === y.shift &&
    x.altGr === y.altGr
  );
}

/** The non-modifier key of a keyboard event as a canonical token, or null for modifier-only presses. */
function eventKey(event: KeyEventLike): string | null {
  const { code, key } = event;

  // Letters follow the active layout (like Electron's globalShortcut does); everything
  // else follows the physical key so digits and punctuation survive Shift and AltGr.
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();

  if (code) {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter?.[1]) return letter[1];
    const digit = /^Digit(\d)$/.exec(code);
    if (digit?.[1]) return digit[1];
    const numpadDigit = /^Numpad(\d)$/.exec(code);
    if (numpadDigit?.[1]) return `num${numpadDigit[1]}`;
    if (FUNCTION_KEY.test(code.toLowerCase())) return code.toUpperCase();
    const mapped = CODE_KEYS[code];
    if (mapped !== undefined) return mapped;
  }

  if (MODIFIER_KEY_VALUES.has(key)) return null;
  const named = KEY_VALUE_KEYS[key];
  if (named !== undefined) return named;
  if (FUNCTION_KEY.test(key.toLowerCase())) return key.toUpperCase();
  if (key.length === 1) return canonicalKey(key)?.key ?? null;
  return null;
}

function isAltGraph(event: KeyEventLike): boolean {
  return event.getModifierState?.('AltGraph') === true;
}

/**
 * Converts a keydown into an Electron accelerator string, e.g. `CommandOrControl+Shift+B`,
 * `numadd`, `Space`. Returns null while only modifier keys are held, so a capture UI can
 * keep listening. Ctrl maps to `CommandOrControl` (and ⌘ to `Super`) everywhere except on
 * macOS, where ⌘ is `CommandOrControl` and Ctrl is `Control`.
 */
export function eventToAccelerator(
  event: KeyEventLike,
  platform: string = getPlatform(),
): string | null {
  const key = eventKey(event);
  if (key === null) return null;

  const mac = isMac(platform);
  const modifiers = new Set<AcceleratorModifier>();
  if (isAltGraph(event)) {
    // Windows reports AltGr as Ctrl+Alt; record the intent rather than the side effect.
    modifiers.add('AltGr');
  } else {
    if (event.ctrlKey) modifiers.add(mac ? 'Control' : 'CommandOrControl');
    if (event.altKey) modifiers.add('Alt');
  }
  if (event.metaKey) modifiers.add(mac ? 'CommandOrControl' : 'Super');
  if (event.shiftKey) modifiers.add('Shift');

  return serialize({ modifiers: sortModifiers(modifiers), key });
}

/** Whether a keyboard event is exactly the given accelerator (no extra modifiers held). */
export function matchesEvent(
  accelerator: string,
  event: KeyEventLike,
  platform: string = getPlatform(),
): boolean {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return false;
  const key = eventKey(event);
  if (key === null) return false;

  const combo = toPhysical(parsed, platform);
  if (combo.key !== key || combo.shift !== event.shiftKey || combo.meta !== event.metaKey)
    return false;

  const altGraph = isAltGraph(event);
  if (combo.altGr !== altGraph) return false;
  // With AltGr held, ctrlKey / altKey are platform noise.
  return altGraph || (combo.ctrl === event.ctrlKey && combo.alt === event.altKey);
}

/** First action in `HOTKEY_ACTIONS` order with a binding matching the event, or null. */
export function matchBinding(
  bindings: Readonly<Record<HotkeyAction, readonly string[]>>,
  event: KeyEventLike,
  platform: string = getPlatform(),
): HotkeyAction | null {
  for (const action of HOTKEY_ACTIONS) {
    if (bindings[action].some((accelerator) => matchesEvent(accelerator, event, platform))) {
      return action;
    }
  }
  return null;
}

/**
 * The action that already uses `accelerator`, or null — for conflict warnings while
 * recording. `ignore` skips one action (the one being edited).
 */
export function findBoundAction(
  bindings: Readonly<Record<HotkeyAction, readonly string[]>>,
  accelerator: string,
  options: { ignore?: HotkeyAction; platform?: string } = {},
): HotkeyAction | null {
  const platform = options.platform ?? getPlatform();
  for (const action of HOTKEY_ACTIONS) {
    if (action === options.ignore) continue;
    if (bindings[action].some((bound) => acceleratorsEqual(bound, accelerator, platform))) {
      return action;
    }
  }
  return null;
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  numadd: 'Num +',
  numsub: 'Num -',
  nummult: 'Num *',
  numdiv: 'Num /',
  numdec: 'Num .',
  Return: 'Enter',
  Escape: 'Esc',
  Delete: 'Del',
  Insert: 'Ins',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Capslock: 'Caps Lock',
  Numlock: 'Num Lock',
  Scrolllock: 'Scroll Lock',
  PrintScreen: 'PrtSc',
  VolumeUp: 'Vol +',
  VolumeDown: 'Vol -',
  VolumeMute: 'Mute',
  MediaNextTrack: 'Next Track',
  MediaPreviousTrack: 'Prev Track',
  MediaStop: 'Stop',
  MediaPlayPause: 'Play/Pause',
};

function modifierLabel(modifier: AcceleratorModifier, platform: string): string {
  if (isMac(platform)) {
    switch (modifier) {
      case 'CommandOrControl':
      case 'Command':
      case 'Super':
        return '⌘';
      case 'Control':
        return '⌃';
      case 'Alt':
      case 'AltGr':
        return '⌥';
      case 'Shift':
        return '⇧';
    }
  }
  switch (modifier) {
    case 'CommandOrControl':
    case 'Control':
      return 'Ctrl';
    case 'Command':
      return 'Cmd';
    case 'Alt':
      return 'Alt';
    case 'AltGr':
      return 'AltGr';
    case 'Shift':
      return 'Shift';
    case 'Super':
      return platform === 'win32' ? 'Win' : 'Super';
  }
}

/**
 * Key-cap labels for display: `CommandOrControl+Shift+B` → `['Ctrl', 'Shift', 'B']`,
 * `numadd` → `['Num +']`, `Space` → `['Space']`. Invalid accelerators fall back to
 * their raw `+`-separated tokens so a corrupt setting is still visible.
 */
export function formatAccelerator(accelerator: string, platform: string = getPlatform()): string[] {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return tokenize(accelerator).filter((token) => token !== '');

  const labels: string[] = [];
  for (const modifier of parsed.modifiers) {
    const label = modifierLabel(modifier, platform);
    if (!labels.includes(label)) labels.push(label);
  }
  const { key } = parsed;
  labels.push(NUMPAD_DIGIT.test(key) ? `Num ${key.slice(3)}` : (KEY_LABELS[key] ?? key));
  return labels;
}

/**
 * True for accelerators that are dangerous to register OS-wide: a typing or
 * navigation key (letter, digit, punctuation, Space, Enter, Tab, Backspace,
 * arrows, …) with no modifier other than Shift. While registered, the OS
 * swallows the key from every other application — chat, the game itself, the
 * browser. Numpad, function and media keys are considered safe.
 */
export function isRiskyGlobalAccelerator(accelerator: string): boolean {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return false;
  if (parsed.modifiers.some((modifier) => modifier !== 'Shift')) return false;
  const { key } = parsed;
  return key.length === 1 || ESSENTIAL_KEYS.has(key);
}
