/**
 * Pure helpers of the smoke test (`smoke.ts`): the demo state it seeds and the
 * classification of what it observes.
 *
 * This module must stay free of `electron` imports so it can be unit-tested.
 */
import { createDefaultSettings } from '@shared/defaults';
import type { AppState, Hunt, PhaseEntry, SessionRecord, Settings, TargetRef } from '@shared/types';

export const DEMO_ACTIVE_HUNT_ID = 'demo-hunt-gastly';
export const DEMO_COMPLETED_HUNT_ID = 'demo-hunt-ralts';

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const GASTLY: TargetRef = {
  speciesId: 92,
  pokemonId: 92,
  slug: 'gastly',
  name: 'Gastly',
  types: ['ghost', 'poison'],
  spriteUrl: `${SPRITES}/92.png`,
  shinySpriteUrl: `${SPRITES}/shiny/92.png`,
};

const RALTS: TargetRef = {
  speciesId: 280,
  pokemonId: 280,
  slug: 'ralts',
  name: 'Ralts',
  types: ['psychic', 'fairy'],
  spriteUrl: `${SPRITES}/280.png`,
  shinySpriteUrl: `${SPRITES}/shiny/280.png`,
};

/**
 * A lived-in state for screenshots: an active Gastly hunt 599 encounters in
 * with two logged phases, a completed Ralts hunt, and three sessions spread
 * over the past week. Every timestamp is relative to `now`.
 */
export function buildDemoState(now: Date, settings: Settings = createDefaultSettings()): AppState {
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();

  const phases: PhaseEntry[] = [
    {
      id: 'demo-phase-shuppet',
      speciesId: 353,
      speciesName: 'Shuppet',
      spriteUrl: `${SPRITES}/shiny/353.png`,
      encounters: 163,
      totalEncounters: 163,
      timestamp: ago(DAY + 2 * HOUR + 10 * MINUTE),
      notes: 'Blue Shuppet in the first hour. Not the one.',
    },
    {
      id: 'demo-phase-murkrow',
      speciesId: 198,
      speciesName: 'Murkrow',
      spriteUrl: `${SPRITES}/shiny/198.png`,
      encounters: 249,
      totalEncounters: 412,
      timestamp: ago(DAY + 40 * MINUTE),
      notes: '',
    },
  ];

  const gastly: Hunt = {
    id: DEMO_ACTIVE_HUNT_ID,
    name: 'Gastly — night outbreak',
    status: 'active',
    target: GASTLY,
    targetLevel: 25,
    // Opt-in: BIOLUME_SMOKE_GAME=za seeds the demo hunt in another game, to review game-specific UI.
    odds:
      process.env['BIOLUME_SMOKE_GAME'] !== undefined
        ? {
            gameId: process.env['BIOLUME_SMOKE_GAME'],
            methodId: 'full-odds',
            shinyCharm: true,
            inputs: {},
          }
        : {
            gameId: 'sv',
            methodId: 'mass-outbreak',
            shinyCharm: true,
            inputs: { defeated: 60, sparkling: 'none' },
          },
    count: 187,
    priorCount: 412,
    step: 1,
    phases,
    notes: 'Outbreak cleared to 60 first. Watch out: Haunter in the pack knows Curse.',
    createdAt: ago(2 * DAY + 3 * HOUR),
    updatedAt: ago(4 * MINUTE),
    completedAt: null,
    elapsedMs: 4 * HOUR + 5 * MINUTE,
  };

  const ralts: Hunt = {
    id: DEMO_COMPLETED_HUNT_ID,
    name: 'Ralts',
    status: 'completed',
    target: RALTS,
    targetLevel: 1,
    odds: { gameId: 'bdsp', methodId: 'masuda-method', shinyCharm: true, inputs: {} },
    count: 318,
    priorCount: 0,
    step: 1,
    phases: [],
    notes: 'Hatched on egg 318. Blue hair at last.',
    createdAt: ago(6 * DAY + 5 * HOUR),
    updatedAt: ago(6 * DAY + 50 * MINUTE),
    completedAt: ago(6 * DAY + 50 * MINUTE),
    elapsedMs: 4 * HOUR + 10 * MINUTE,
  };

  // Newest first, as the store keeps them.
  const sessions: SessionRecord[] = [
    {
      id: 'demo-session-3',
      huntId: gastly.id,
      huntName: gastly.name,
      targetName: GASTLY.name,
      gameId: gastly.odds.gameId,
      methodId: gastly.odds.methodId,
      startedAt: ago(HOUR + 49 * MINUTE),
      endedAt: ago(4 * MINUTE),
      startCount: 412,
      endCount: 599,
      encounters: 187,
      phasesLogged: 0,
    },
    {
      id: 'demo-session-2',
      huntId: gastly.id,
      huntName: gastly.name,
      targetName: GASTLY.name,
      gameId: gastly.odds.gameId,
      methodId: gastly.odds.methodId,
      startedAt: ago(DAY + 3 * HOUR),
      endedAt: ago(DAY + 40 * MINUTE),
      startCount: 0,
      endCount: 412,
      encounters: 412,
      phasesLogged: 2,
    },
    {
      id: 'demo-session-1',
      huntId: ralts.id,
      huntName: ralts.name,
      targetName: RALTS.name,
      gameId: ralts.odds.gameId,
      methodId: ralts.odds.methodId,
      startedAt: ago(6 * DAY + 5 * HOUR),
      endedAt: ago(6 * DAY + 50 * MINUTE),
      startCount: 0,
      endCount: 318,
      encounters: 318,
      phasesLogged: 0,
    },
  ];

  return { settings, hunts: [ralts, gastly], activeHuntId: gastly.id, sessions };
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Chromium logs "Failed to load resource" as a console error when a request
 * fails. For a remote host (a sprite, PokeAPI) that only says the machine is
 * offline or the host is down — not that the app is broken.
 */
export function isRemoteLoadFailure(message: string, sourceId: string): boolean {
  if (!message.startsWith('Failed to load resource')) return false;
  try {
    const url = new URL(sourceId);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !LOCAL_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Number of different colours among evenly spread sample pixels of a 4-bytes-
 * per-pixel bitmap, counted up to `limit`. One colour means the capture is blank.
 */
export function countDistinctColors(bitmap: Uint8Array, limit = 8): number {
  const pixels = Math.floor(bitmap.length / 4);
  // An odd stride walks through the columns instead of sampling a single one.
  const stride = Math.max(1, Math.floor(pixels / 8_192)) | 1;
  const seen = new Set<string>();
  for (let pixel = 0; pixel < pixels && seen.size < limit; pixel += stride) {
    const offset = pixel * 4;
    seen.add(
      `${bitmap[offset] ?? 0},${bitmap[offset + 1] ?? 0},${bitmap[offset + 2] ?? 0},${bitmap[offset + 3] ?? 0}`,
    );
  }
  return seen.size;
}
