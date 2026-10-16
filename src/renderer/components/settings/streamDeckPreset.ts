/**
 * The zero-plugin Stream Deck setup: Stream Deck's built-in Hotkey action
 * presses F13–F16, and Biolume's own (global) shortcuts do the rest. F13–F24
 * exist on hardly any keyboard and no game binds them, so registering them
 * system-wide takes nothing away from anything else.
 *
 * Pure functions: what the one-click preset would change, and how to tell the
 * user. The preset only ever ADDS shortcuts — existing ones are kept, a key
 * another action already owns is left alone (and reported), and an action
 * that is at MAX_BINDINGS_PER_ACTION is skipped (and reported).
 */
import { HOTKEY_ACTION_LABELS } from '@shared/defaults';
import { HOTKEY_ACTIONS, MAX_BINDINGS_PER_ACTION, type HotkeyAction } from '@shared/types';
import { acceleratorsEqual, findBoundAction, getPlatform } from '@renderer/lib/accelerator';
import type { Bindings } from './hotkeyRecording';

export interface DeckHotkey {
  action: HotkeyAction;
  /** Canonical Electron accelerator, e.g. `F13`. */
  accelerator: string;
}

/** The preset, in the order Stream Deck keys are usually laid out. */
export const STREAM_DECK_HOTKEYS: readonly DeckHotkey[] = [
  { action: 'increment', accelerator: 'F13' },
  { action: 'decrement', accelerator: 'F14' },
  { action: 'logPhase', accelerator: 'F15' },
  { action: 'shinyFound', accelerator: 'F16' },
];

/**
 * - `bound`     — the action already has this key; nothing to do.
 * - `available` — the preset adds it.
 * - `conflict`  — another action owns the key; the preset leaves both alone.
 * - `full`      — the action already has MAX_BINDINGS_PER_ACTION shortcuts.
 */
export type DeckHotkeyState = 'bound' | 'available' | 'conflict' | 'full';

export interface DeckHotkeyPlan extends DeckHotkey {
  state: DeckHotkeyState;
  /** For `conflict`: the action that owns the key. */
  conflictWith?: HotkeyAction;
}

export interface DeckPresetOutcome {
  /** Every preset key and what the preset does with it. */
  plan: DeckHotkeyPlan[];
  /** Only the actions whose bindings change: their full new lists (existing keys first). */
  patch: Partial<Bindings>;
  /** Keys the preset adds. */
  added: DeckHotkeyPlan[];
  /** Keys it cannot add: `conflict` or `full`. */
  skipped: DeckHotkeyPlan[];
}

/** Works out the preset against the current bindings. Does not mutate them. */
export function applyStreamDeckPreset(
  bindings: Bindings,
  platform: string = getPlatform(),
): DeckPresetOutcome {
  const next = Object.fromEntries(
    HOTKEY_ACTIONS.map((action) => [action, [...bindings[action]]]),
  ) as Bindings;
  const plan: DeckHotkeyPlan[] = [];

  for (const entry of STREAM_DECK_HOTKEYS) {
    const current = next[entry.action];
    if (current.some((bound) => acceleratorsEqual(bound, entry.accelerator, platform))) {
      plan.push({ ...entry, state: 'bound' });
      continue;
    }
    const owner = findBoundAction(next, entry.accelerator, { ignore: entry.action, platform });
    if (owner !== null) {
      plan.push({ ...entry, state: 'conflict', conflictWith: owner });
      continue;
    }
    if (current.length >= MAX_BINDINGS_PER_ACTION) {
      plan.push({ ...entry, state: 'full' });
      continue;
    }
    next[entry.action] = [...current, entry.accelerator];
    plan.push({ ...entry, state: 'available' });
  }

  const patch: Partial<Bindings> = {};
  for (const action of HOTKEY_ACTIONS) {
    if (next[action].length !== bindings[action].length) patch[action] = next[action];
  }

  return {
    plan,
    patch,
    added: plan.filter((entry) => entry.state === 'available'),
    skipped: plan.filter((entry) => entry.state === 'conflict' || entry.state === 'full'),
  };
}

/** Why one preset key could not be added, in a sentence. */
export function describeSkipped(entry: DeckHotkeyPlan): string {
  if (entry.state === 'conflict' && entry.conflictWith !== undefined) {
    return `${entry.accelerator} already belongs to “${HOTKEY_ACTION_LABELS[entry.conflictWith]}” — remove it there to use it for “${HOTKEY_ACTION_LABELS[entry.action]}”.`;
  }
  if (entry.state === 'full') {
    return `“${HOTKEY_ACTION_LABELS[entry.action]}” already has ${MAX_BINDINGS_PER_ACTION} shortcuts, so ${entry.accelerator} was not added.`;
  }
  return `${entry.accelerator} was not added.`;
}

export interface PresetMessage {
  tone: 'success' | 'info' | 'warning';
  title: string;
  description?: string;
}

/** The toast that reports a preset run. */
export function describePresetOutcome(
  outcome: DeckPresetOutcome,
  globalEnabled: boolean,
): PresetMessage {
  const offNote = globalEnabled
    ? null
    : 'Global hotkeys are off, so they only work while Biolume has focus — switch them on under Hotkeys.';

  if (outcome.added.length === 0 && outcome.skipped.length === 0) {
    return {
      tone: 'info',
      title: 'F13–F16 are already set up',
      ...(offNote === null ? {} : { description: offNote }),
    };
  }

  const addedKeys = outcome.added.map((entry) => entry.accelerator).join(', ');
  const parts = [
    outcome.added.length > 0 ? `Added ${addedKeys}; your other shortcuts are unchanged.` : null,
    ...outcome.skipped.map(describeSkipped),
    offNote,
  ].filter((part): part is string => part !== null);

  if (outcome.skipped.length > 0) {
    return {
      tone: 'warning',
      title:
        outcome.added.length > 0
          ? 'Some Stream Deck hotkeys were not bound'
          : 'No Stream Deck hotkeys were bound',
      description: parts.join(' '),
    };
  }
  return {
    tone: offNote === null ? 'success' : 'warning',
    title: 'Stream Deck hotkeys bound',
    description: parts.join(' '),
  };
}
