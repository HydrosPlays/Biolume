/**
 * Builders for domain objects in tests. Every builder returns a complete,
 * valid object; pass overrides for the fields the test cares about.
 */
import {
  createDefaultOddsSelection,
  createDefaultSettings,
  DEFAULT_TARGET_LEVEL,
} from '@shared/defaults';
import type {
  Hunt,
  PhaseEntry,
  SessionRecord,
  Settings,
  SettingsPatch,
  TargetRef,
} from '@shared/types';

/** A fixed, readable instant so snapshots and relative times are deterministic. */
export const TEST_TIMESTAMP = '2026-10-13T12:00:00.000Z';

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** Restarts the id sequence used by the builders (called between tests by the shared setup). */
export function resetFactorySequence(): void {
  sequence = 0;
}

export function makeTarget(overrides: Partial<TargetRef> = {}): TargetRef {
  return {
    speciesId: 280,
    pokemonId: 280,
    slug: 'ralts',
    name: 'Ralts',
    types: ['psychic', 'fairy'],
    spriteUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/280.png',
    shinySpriteUrl:
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/280.png',
    ...overrides,
  };
}

export function makePhase(overrides: Partial<PhaseEntry> = {}): PhaseEntry {
  return {
    id: nextId('phase'),
    speciesId: 263,
    speciesName: 'Zigzagoon',
    spriteUrl: null,
    encounters: 120,
    totalEncounters: 120,
    timestamp: TEST_TIMESTAMP,
    notes: '',
    ...overrides,
  };
}

export function makeHunt(overrides: Partial<Hunt> = {}): Hunt {
  const target = overrides.target === undefined ? makeTarget() : overrides.target;
  return {
    id: nextId('hunt'),
    name: target ? `Shiny ${target.name}` : 'Untitled hunt',
    status: 'active',
    target,
    targetLevel: DEFAULT_TARGET_LEVEL,
    odds: createDefaultOddsSelection(),
    count: 0,
    priorCount: 0,
    step: 1,
    phases: [],
    notes: '',
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
    completedAt: null,
    elapsedMs: 0,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: nextId('session'),
    huntId: 'hunt-1',
    huntName: 'Shiny Ralts',
    targetName: 'Ralts',
    gameId: 'sv',
    methodId: 'full-odds',
    startedAt: TEST_TIMESTAMP,
    endedAt: TEST_TIMESTAMP,
    startCount: 0,
    endCount: 0,
    encounters: 0,
    phasesLogged: 0,
    ...overrides,
  };
}

/** Applies a `SettingsPatch` the way the main process does: per section, bindings per action. */
export function applySettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
  const { bindings, ...hotkeys } = patch.hotkeys ?? {};
  return {
    ...settings,
    hotkeys: {
      ...settings.hotkeys,
      ...hotkeys,
      bindings: { ...settings.hotkeys.bindings, ...bindings },
    },
    audio: { ...settings.audio, ...patch.audio },
    overlay: { ...settings.overlay, ...patch.overlay },
    general: { ...settings.general, ...patch.general },
    streamDeck: { ...settings.streamDeck, ...patch.streamDeck },
  };
}

/** Default settings with a patch applied: `makeSettings({ audio: { enabled: false } })`. */
export function makeSettings(patch: SettingsPatch = {}): Settings {
  return applySettingsPatch(createDefaultSettings(), patch);
}
