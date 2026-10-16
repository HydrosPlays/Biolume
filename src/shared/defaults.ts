import {
  SCHEMA_VERSION,
  type HotkeyAction,
  type OddsSelection,
  type Settings,
  type SoundPack,
} from './types';

/**
 * Every game in `oddsMethods.json` lists a plain base-odds method first under
 * this id, so a selection of `{ gameId, methodId: FULL_ODDS_METHOD_ID }` is
 * always valid.
 */
export const FULL_ODDS_METHOD_ID = 'full-odds';

export const DEFAULT_GAME_ID = 'sv';

export function createDefaultOddsSelection(): OddsSelection {
  return { gameId: DEFAULT_GAME_ID, methodId: FULL_ODDS_METHOD_ID, shinyCharm: false, inputs: {} };
}

export const DEFAULT_TARGET_LEVEL = 30;

export const SOUND_PACKS: readonly SoundPack[] = ['sonar', 'bubble', 'click', 'chime'];

export const HOTKEY_ACTION_LABELS: Record<HotkeyAction, string> = {
  increment: 'Count encounter',
  decrement: 'Undo count (−1 step)',
  undo: 'Undo last action',
  logPhase: 'Quick-log phase',
  shinyFound: 'Shiny found (press twice)',
  toggleOverlay: 'Toggle mini-overlay',
};

/**
 * NumPad + is the default increment key: unlike Space it is rarely bound in
 * games, and a registered global shortcut is swallowed by the OS before the
 * focused game ever sees it.
 */
export function createDefaultSettings(): Settings {
  return {
    schemaVersion: SCHEMA_VERSION,
    hotkeys: {
      globalEnabled: true,
      bindings: {
        increment: ['numadd'],
        decrement: ['numsub'],
        undo: [],
        logPhase: [],
        shinyFound: [],
        toggleOverlay: ['CommandOrControl+Shift+B'],
      },
    },
    audio: { enabled: true, volume: 0.5, pack: 'sonar', milestoneChime: true },
    overlay: {
      opacity: 0.82,
      scale: 1,
      showSprite: true,
      showOdds: true,
      showPhase: true,
      clickThrough: false,
      hideMainWindow: true,
    },
    general: { confirmDestructive: true, sessionIdleMinutes: 15, reducedMotion: 'system' },
    streamDeck: { enabled: true },
  };
}

export const LIMITS = {
  count: { min: 0, max: 99_999_999 },
  step: { min: 1, max: 9_999 },
  targetLevel: { min: 1, max: 100 },
  huntName: 80,
  notes: 4_000,
  sessions: 2_000,
  undoDepth: 100,
  overlayOpacity: { min: 0.2, max: 1 },
  overlayScale: { min: 0.75, max: 1.5 },
  sessionIdleMinutes: { min: 1, max: 240 },
} as const;
