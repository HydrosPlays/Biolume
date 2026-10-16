/**
 * The rules of the shortcut editor, as pure functions: what happens to a
 * recorded key combination, what a preset changes, and how a binding's live
 * registration result reads. The components only render the outcome.
 */
import { createDefaultSettings, HOTKEY_ACTION_LABELS } from '@shared/defaults';
import {
  HOTKEY_ACTIONS,
  MAX_BINDINGS_PER_ACTION,
  type HotkeyAction,
  type HotkeyMode,
  type HotkeySettings,
  type HotkeyStatus,
} from '@shared/types';
import {
  acceleratorsEqual,
  eventToAccelerator,
  findBoundAction,
  formatAccelerator,
  getPlatform,
  isRiskyGlobalAccelerator,
  normalizeAccelerator,
  type KeyEventLike,
} from '@renderer/lib/accelerator';

export type Bindings = HotkeySettings['bindings'];

/** Shown for bare typing / navigation keys such as Space. */
export const RISKY_KEY_WARNING =
  'While Biolume is in the background this key is captured system-wide and will not reach your game.';

/** A combination as people read it: `CommandOrControl+Shift+B` → `Ctrl + Shift + B`. */
export function describeAccelerator(accelerator: string, platform: string = getPlatform()): string {
  return formatAccelerator(accelerator, platform).join(' + ');
}

export type RecordingRejection = 'invalid' | 'full' | 'already-bound' | 'conflict';

export type RecordingVerdict =
  | {
      ok: true;
      /** Canonical spelling to store. */
      accelerator: string;
      /** The action's bindings with the new one appended. */
      next: string[];
      /** Set for keys that are dangerous to capture system-wide; the binding is still accepted. */
      warning: string | null;
    }
  | {
      ok: false;
      reason: RecordingRejection;
      message: string;
      /** For `conflict`: the action that owns the combination. */
      conflictWith?: HotkeyAction;
    };

/**
 * Decides what to do with a combination recorded for `action`: accepted
 * (possibly with a warning) or rejected with a message for the user.
 */
export function evaluateRecording(
  bindings: Bindings,
  action: HotkeyAction,
  recorded: string,
  platform: string = getPlatform(),
): RecordingVerdict {
  const current = bindings[action];
  if (current.length >= MAX_BINDINGS_PER_ACTION) {
    return {
      ok: false,
      reason: 'full',
      message: `“${HOTKEY_ACTION_LABELS[action]}” already has ${MAX_BINDINGS_PER_ACTION} shortcuts. Remove one to add another.`,
    };
  }

  const accelerator = normalizeAccelerator(recorded);
  if (accelerator === null) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'That key cannot be used as a shortcut. Try another combination.',
    };
  }

  const label = describeAccelerator(accelerator, platform);
  if (current.some((bound) => acceleratorsEqual(bound, accelerator, platform))) {
    return {
      ok: false,
      reason: 'already-bound',
      message: `${label} is already bound to this action.`,
    };
  }

  const owner = findBoundAction(bindings, accelerator, { ignore: action, platform });
  if (owner !== null) {
    return {
      ok: false,
      reason: 'conflict',
      conflictWith: owner,
      message: `${label} is already bound to “${HOTKEY_ACTION_LABELS[owner]}”. Remove it there first, or press a different combination.`,
    };
  }

  return {
    ok: true,
    accelerator,
    next: [...current, accelerator],
    warning: isRiskyGlobalAccelerator(accelerator) ? RISKY_KEY_WARNING : null,
  };
}

/** The action's bindings without `accelerator` (matched exactly as stored). */
export function removeBinding(
  bindings: Bindings,
  action: HotkeyAction,
  accelerator: string,
): string[] {
  return bindings[action].filter((bound) => bound !== accelerator);
}

/** Whether another binding can still be added to the action. */
export function canAddBinding(bindings: Bindings, action: HotkeyAction): boolean {
  return bindings[action].length < MAX_BINDINGS_PER_ACTION;
}

// ───────────────────────────── Live capture ─────────────────────────────

export type CaptureStep =
  | { kind: 'cancel' }
  /** Only modifiers are down so far; `held` are their key caps. */
  | { kind: 'pending'; held: string[] }
  | { kind: 'complete'; accelerator: string };

/**
 * Interprets one keydown while recording: a bare Esc cancels, modifiers alone
 * keep the recording open, anything else completes the combination.
 */
export function captureStep(event: KeyEventLike, platform: string = getPlatform()): CaptureStep {
  const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
  if (bare && (event.key === 'Escape' || event.code === 'Escape')) return { kind: 'cancel' };

  const accelerator = eventToAccelerator(event, platform);
  if (accelerator !== null) return { kind: 'complete', accelerator };

  // Format the held modifiers through the same code path as a full combination.
  const probe = eventToAccelerator({ ...modifiersOf(event), code: 'KeyA', key: 'a' }, platform);
  const held = probe === null ? [] : formatAccelerator(probe, platform).slice(0, -1);
  return { kind: 'pending', held };
}

function modifiersOf(event: KeyEventLike): Omit<KeyEventLike, 'code' | 'key'> {
  const altGraph = event.getModifierState?.('AltGraph') === true;
  return {
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    getModifierState: (key: string) => key === 'AltGraph' && altGraph,
  };
}

// ───────────────────────────── Presets ─────────────────────────────

export interface CountPreset {
  id: string;
  label: string;
  accelerator: string;
  hint: string;
}

/** One-click choices for the "count encounter" key. */
export const COUNT_PRESETS: readonly CountPreset[] = [
  {
    id: 'numpad',
    label: 'NumPad +',
    accelerator: 'numadd',
    hint: 'Rarely used by games — the safe default.',
  },
  {
    id: 'space',
    label: 'Space',
    accelerator: 'Space',
    hint: 'Easy to hit, but taken away from every other app while Biolume is in the background.',
  },
  { id: 'f9', label: 'F9', accelerator: 'F9', hint: 'A function key most games leave alone.' },
];

export interface PresetOutcome {
  /** Only the actions whose bindings change. */
  patch: Partial<Bindings>;
  /** Actions that lost the key to "count encounter". */
  movedFrom: HotkeyAction[];
  warning: string | null;
}

/**
 * Makes `accelerator` the one key that counts an encounter. A one-click choice
 * has to work, so the key is taken from any other action that used it (the
 * caller tells the user) instead of being rejected as a recorded one would be.
 */
export function applyCountPreset(
  bindings: Bindings,
  accelerator: string,
  platform: string = getPlatform(),
): PresetOutcome {
  const patch: Partial<Bindings> = { increment: [accelerator] };
  const movedFrom: HotkeyAction[] = [];
  for (const action of HOTKEY_ACTIONS) {
    if (action === 'increment') continue;
    const kept = bindings[action].filter(
      (bound) => !acceleratorsEqual(bound, accelerator, platform),
    );
    if (kept.length !== bindings[action].length) {
      patch[action] = kept;
      movedFrom.push(action);
    }
  }
  return {
    patch,
    movedFrom,
    warning: isRiskyGlobalAccelerator(accelerator) ? RISKY_KEY_WARNING : null,
  };
}

/** The preset currently in effect: "count encounter" is bound to exactly its key. */
export function activeCountPreset(
  bindings: Bindings,
  platform: string = getPlatform(),
): CountPreset | null {
  const [only, ...rest] = bindings.increment;
  if (only === undefined || rest.length > 0) return null;
  return (
    COUNT_PRESETS.find((preset) => acceleratorsEqual(preset.accelerator, only, platform)) ?? null
  );
}

export function defaultBindings(): Bindings {
  return createDefaultSettings().hotkeys.bindings;
}

export function bindingsEqual(a: Bindings, b: Bindings): boolean {
  return HOTKEY_ACTIONS.every(
    (action) =>
      a[action].length === b[action].length &&
      a[action].every((accelerator, index) => accelerator === b[action][index]),
  );
}

// ───────────────────────────── Registration status ─────────────────────────────

export type BindingHealth = 'registered' | 'ready' | 'failed' | 'off' | 'unknown';

export interface BindingStatus {
  health: BindingHealth;
  /** One or two words for the chip's status dot. */
  label: string;
  /** A full sentence for the tooltip / the row's error line. */
  detail: string;
}

/**
 * How one binding fared in the main process' latest registration attempt.
 * While Biolume is focused nothing is held; `registered` then means the OS
 * accepted the key in a probe, i.e. it is free for when the game has focus.
 */
export function bindingStatus(
  status: HotkeyStatus,
  action: HotkeyAction,
  accelerator: string,
): BindingStatus {
  if (status.mode === 'disabled') {
    return {
      health: 'off',
      label: 'In-app only',
      detail: 'Global hotkeys are off: this shortcut works while the Biolume window is focused.',
    };
  }
  const entry = status.registrations.find(
    (registration) => registration.action === action && registration.accelerator === accelerator,
  );
  if (entry === undefined) {
    return { health: 'unknown', label: 'Checking…', detail: 'Waiting for the system to answer.' };
  }
  if (!entry.registered) {
    const reason = entry.error ?? 'The system refused this shortcut';
    return { health: 'failed', label: 'Failed', detail: `Not registered: ${reason}.` };
  }
  return status.mode === 'active'
    ? {
        health: 'registered',
        label: 'Registered',
        detail: 'Registered system-wide: it works while your game has focus.',
      }
    : {
        health: 'ready',
        label: 'Ready',
        detail: 'Available: it is registered system-wide as soon as Biolume loses focus.',
      };
}

export interface ModeExplanation {
  tone: 'ok' | 'accent' | 'neutral' | 'violet';
  label: string;
  text: string;
}

/** The current {@link HotkeyMode} in plain words. */
export function explainMode(mode: HotkeyMode): ModeExplanation {
  switch (mode) {
    case 'active':
      return {
        tone: 'ok',
        label: 'Active',
        text: 'Your shortcuts are registered system-wide and work while the game has focus.',
      };
    case 'app-focused':
      return {
        tone: 'accent',
        label: 'Paused while Biolume is focused',
        text: 'Right now the same keys are handled inside the app, so they stay typeable in text fields. They go system-wide the moment you switch to your game.',
      };
    case 'capturing':
      return {
        tone: 'violet',
        label: 'Recording',
        text: 'Every shortcut is suspended while you press a new key combination.',
      };
    case 'disabled':
      return {
        tone: 'neutral',
        label: 'Disabled',
        text: 'Shortcuts only work while the Biolume window is focused. Switch global hotkeys on to count while you play.',
      };
  }
}
