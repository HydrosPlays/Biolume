import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, createDefaultOddsSelection, createDefaultSettings } from '@shared/defaults';
import {
  MAX_BINDINGS_PER_ACTION,
  SCHEMA_VERSION,
  type Hunt,
  type SessionRecord,
} from '@shared/types';
import {
  HUNTS_FILE,
  SESSIONS_FILE,
  SETTINGS_FILE,
  createStorage,
  loadState,
  type Storage,
  type StorageFs,
  type StorageOptions,
} from './storage';

const NOW = new Date('2026-10-13T18:04:11.201Z');

function makeHunt(overrides: Partial<Hunt> = {}): Hunt {
  return {
    id: 'hunt-1',
    name: 'Shiny Vulpix',
    status: 'active',
    target: {
      speciesId: 37,
      pokemonId: 10103,
      slug: 'vulpix-alola',
      name: 'Alolan Vulpix',
      types: ['ice'],
      spriteUrl:
        'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/10103.png',
      shinySpriteUrl: null,
    },
    targetLevel: 30,
    odds: {
      gameId: 'sv',
      methodId: 'full-odds',
      shinyCharm: true,
      inputs: { sparkling: 3, outbreak: true },
    },
    count: 412,
    priorCount: 1_000,
    step: 1,
    phases: [
      {
        id: 'phase-1',
        speciesId: 133,
        speciesName: 'Eevee',
        spriteUrl: null,
        encounters: 1_000,
        totalEncounters: 1_000,
        timestamp: '2026-10-12T10:00:00.000Z',
        notes: 'so close',
      },
    ],
    notes: 'Route 3',
    createdAt: '2026-10-10T08:00:00.000Z',
    updatedAt: '2026-10-13T09:00:00.000Z',
    completedAt: null,
    elapsedMs: 3_600_000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    huntId: 'hunt-1',
    huntName: 'Shiny Vulpix',
    targetName: 'Alolan Vulpix',
    gameId: 'sv',
    methodId: 'full-odds',
    startedAt: '2026-10-13T08:00:00.000Z',
    endedAt: '2026-10-13T09:00:00.000Z',
    startCount: 1_000,
    endCount: 1_412,
    encounters: 412,
    phasesLogged: 0,
    ...overrides,
  };
}

/** Temp directory of the current test; removed afterwards whatever the test does with `dir`. */
let root: string;
let dir: string;
let errors: { message: string; file: string }[];
const storages: Storage[] = [];

function open(options: StorageOptions = {}): Storage {
  const storage = createStorage(dir, {
    now: () => NOW,
    onError: (error, file) => errors.push({ message: error.message, file }),
    ...options,
  });
  storages.push(storage);
  return storage;
}

const path = (name: string): string => join(dir, name);
const readFile = (name: string): string => fs.readFileSync(path(name), 'utf8');
const readDoc = (name: string): unknown => JSON.parse(readFile(name)) as unknown;
const writeFile = (name: string, content: string): void =>
  fs.writeFileSync(path(name), content, 'utf8');
const exists = (name: string): boolean => fs.existsSync(path(name));
const listDir = (): string[] => fs.readdirSync(dir).sort();

function systemError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'biolume-storage-'));
  dir = root;
  errors = [];
});

afterEach(() => {
  vi.useRealTimers();
  // A save left pending would fire later and recreate the directory after it is removed, so
  // every test must end with a disk that works: flush, and insist that nothing is left over.
  const opened = storages.splice(0);
  for (const storage of opened) storage.flushSync();
  const stillPending = opened.filter((storage) => storage.hasPendingWrites()).length;
  fs.rmSync(root, { recursive: true, force: true });
  expect(stillPending).toBe(0);
});

describe('loadState', () => {
  it('returns defaults for an empty directory without reporting errors or writing files', () => {
    const storage = open();
    expect(storage.loadState()).toEqual({
      settings: createDefaultSettings(),
      hunts: [],
      activeHuntId: null,
      sessions: [],
    });
    expect(errors).toEqual([]);
    expect(storage.hasPendingWrites()).toBe(false);
    expect(listDir()).toEqual([]);
  });

  it('works when the directory does not exist yet and creates it on the first save', () => {
    dir = join(dir, 'nested', 'userData');
    const storage = open();
    expect(storage.loadState().hunts).toEqual([]);
    storage.saveSettings(createDefaultSettings());
    storage.flushSync();
    expect(exists(SETTINGS_FILE)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('round-trips settings, hunts and sessions through the files', () => {
    const settings = createDefaultSettings();
    settings.audio.volume = 0.25;
    settings.hotkeys.bindings.undo = ['CommandOrControl+Z'];
    const hunts = [
      makeHunt(),
      makeHunt({ id: 'hunt-2', name: 'Second', target: null, phases: [] }),
    ];
    const sessions = [makeSession()];

    const writer = open();
    writer.saveSettings(settings);
    writer.saveHunts(hunts, 'hunt-2');
    writer.saveSessions(sessions);
    writer.flushSync();

    expect(readDoc(SETTINGS_FILE)).toEqual(settings);
    expect(readDoc(HUNTS_FILE)).toEqual({
      schemaVersion: SCHEMA_VERSION,
      activeHuntId: 'hunt-2',
      hunts,
    });
    expect(readDoc(SESSIONS_FILE)).toEqual({ schemaVersion: SCHEMA_VERSION, sessions });

    expect(open().loadState()).toEqual({ settings, hunts, activeHuntId: 'hunt-2', sessions });
    expect(errors).toEqual([]);
  });

  it('drops unknown keys, fills missing keys from the defaults and clamps numbers', () => {
    writeFile(
      SETTINGS_FILE,
      JSON.stringify({
        schemaVersion: 1,
        mystery: true,
        audio: { volume: 7, pack: 'kazoo', enabled: false },
        overlay: { opacity: 0, scale: 99, showSprite: 'yes' },
        general: { sessionIdleMinutes: 100_000 },
        hotkeys: {
          bindings: {
            increment: [' numadd ', 'NUMADD', 'Space', 'F1', 'F2', 42],
            selfDestruct: ['F12'],
          },
        },
      }),
    );
    const { settings } = open().loadState();
    const defaults = createDefaultSettings();

    expect(settings).not.toHaveProperty('mystery');
    expect(settings.audio).toEqual({ ...defaults.audio, enabled: false, volume: 1 });
    expect(settings.overlay.opacity).toBe(LIMITS.overlayOpacity.min);
    expect(settings.overlay.scale).toBe(LIMITS.overlayScale.max);
    expect(settings.overlay.showSprite).toBe(defaults.overlay.showSprite);
    expect(settings.general.sessionIdleMinutes).toBe(LIMITS.sessionIdleMinutes.max);
    expect(settings.general.reducedMotion).toBe('system');
    expect(settings.hotkeys.globalEnabled).toBe(true);
    // Trimmed, de-duplicated without regard to case, capped, and only for known actions.
    expect(settings.hotkeys.bindings.increment).toEqual(['numadd', 'Space', 'F1']);
    expect(settings.hotkeys.bindings.increment).toHaveLength(MAX_BINDINGS_PER_ACTION);
    expect(settings.hotkeys.bindings.decrement).toEqual(defaults.hotkeys.bindings.decrement);
    expect(Object.keys(settings.hotkeys.bindings).sort()).toEqual(
      Object.keys(defaults.hotkeys.bindings).sort(),
    );
    expect(errors).toEqual([]);
  });

  it('repairs hunts so that every invariant holds', () => {
    writeFile(
      HUNTS_FILE,
      JSON.stringify({
        schemaVersion: 1,
        activeHuntId: 'ghost',
        hunts: [
          {
            id: 'a',
            name: '  Lots of spaces  ',
            status: 'paused',
            count: -5,
            priorCount: 12.9,
            step: 0,
            targetLevel: 250,
            target: {
              speciesId: 25,
              pokemonId: 25,
              slug: '../etc/passwd',
              name: 'Pikachu',
              types: ['electric'],
            },
            odds: {
              gameId: 'sv',
              methodId: 'full-odds',
              shinyCharm: 'yes',
              inputs: { chain: 40, bad: { nested: 1 } },
            },
            phases: [
              {
                id: 'p',
                speciesName: 'Eevee',
                encounters: 10,
                totalEncounters: 4,
                timestamp: 'not a date',
              },
              { id: 'p', speciesId: 0, speciesName: 7, encounters: 3 },
              'garbage',
            ],
            notes: 5,
            updatedAt: '2026-10-11T00:00:00.000Z',
            createdAt: '2026-10-12T00:00:00.000Z',
            completedAt: '2026-10-12T00:00:00.000Z',
            elapsedMs: -1,
            secret: 'dropped',
          },
          {
            id: 'b',
            name: 'Done',
            status: 'completed',
            count: 1e12,
            updatedAt: '2026-10-13T00:00:00.000Z',
          },
          { id: 'a', name: 'Duplicate id' },
          {},
        ],
      }),
    );
    let counter = 0;
    const state = open({ idGenerator: () => `gen-${(counter += 1)}` }).loadState();
    const [first, second, third, fourth] = state.hunts;

    expect(state.hunts).toHaveLength(4);
    expect(first).toMatchObject({
      id: 'a',
      name: 'Lots of spaces',
      status: 'active',
      count: 0,
      priorCount: 12,
      step: 1,
      targetLevel: 100,
      target: null,
      notes: '',
      completedAt: null,
      elapsedMs: 0,
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
    });
    expect(first).not.toHaveProperty('secret');
    expect(first?.odds).toEqual({
      gameId: 'sv',
      methodId: 'full-odds',
      shinyCharm: false,
      inputs: { chain: 40 },
    });
    expect(first?.phases).toHaveLength(2);
    expect(first?.phases[0]).toMatchObject({
      id: 'p',
      encounters: 10,
      totalEncounters: 10,
      timestamp: NOW.toISOString(),
    });
    expect(first?.phases[1]).toMatchObject({
      speciesId: null,
      speciesName: '',
      encounters: 3,
      totalEncounters: 3,
    });
    expect(new Set(first?.phases.map((phase) => phase.id)).size).toBe(2);

    expect(second).toMatchObject({
      id: 'b',
      status: 'completed',
      count: LIMITS.count.max,
      completedAt: '2026-10-13T00:00:00.000Z',
    });
    expect(third?.name).toBe('Duplicate id');
    expect(third?.id).not.toBe('a');
    expect(fourth?.name).toBe('Untitled hunt');
    expect(fourth?.odds).toEqual(createDefaultOddsSelection());
    expect(new Set(state.hunts.map((hunt) => hunt.id)).size).toBe(4);

    // The stored id pointed nowhere, so the most recently updated countable hunt takes over.
    expect(
      state.hunts.some((hunt) => hunt.id === state.activeHuntId && hunt.status === 'active'),
    ).toBe(true);
  });

  it('keeps an explicit null active hunt', () => {
    writeFile(
      HUNTS_FILE,
      JSON.stringify({ schemaVersion: 1, activeHuntId: null, hunts: [makeHunt()] }),
    );
    expect(open().loadState().activeHuntId).toBeNull();
  });

  it('sorts sessions newest first, removes duplicate ids and caps the list', () => {
    const sessions = Array.from({ length: LIMITS.sessions + 20 }, (_, index) =>
      makeSession({
        id: `s-${index}`,
        startedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        endedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000 + 1_000).toISOString(),
      }),
    );
    writeFile(
      SESSIONS_FILE,
      JSON.stringify({ schemaVersion: 1, sessions: [...sessions, sessions[5]] }),
    );
    const loaded = open().loadState().sessions;

    expect(loaded).toHaveLength(LIMITS.sessions);
    expect(loaded[0]?.id).toBe(`s-${LIMITS.sessions + 19}`);
    expect(new Set(loaded.map((session) => session.id)).size).toBe(LIMITS.sessions);
    for (let index = 1; index < loaded.length; index += 1) {
      expect((loaded[index - 1]?.startedAt ?? '') >= (loaded[index]?.startedAt ?? '')).toBe(true);
    }
  });

  it('tolerates a UTF-8 BOM', () => {
    writeFile(
      HUNTS_FILE,
      `\uFEFF${JSON.stringify({ schemaVersion: 1, activeHuntId: 'hunt-1', hunts: [makeHunt()] })}`,
    );
    expect(open().loadState().hunts).toEqual([makeHunt()]);
    expect(errors).toEqual([]);
  });
});

describe('corrupt-file recovery', () => {
  it('moves an unparsable file aside and falls back to defaults when there is no backup', () => {
    writeFile(HUNTS_FILE, '{"hunts": [ {"id": "a", ');
    const state = open().loadState();

    expect(state.hunts).toEqual([]);
    expect(state.activeHuntId).toBeNull();
    expect(exists(HUNTS_FILE)).toBe(false);
    expect(listDir()).toEqual(['hunts.corrupt-20261013T180411201Z.json']);
    expect(readFile('hunts.corrupt-20261013T180411201Z.json')).toBe('{"hunts": [ {"id": "a", ');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe(HUNTS_FILE);
    expect(errors[0]?.message).toMatch(
      /hunts\.json is corrupt .*hunts\.corrupt-20261013T180411201Z\.json.*defaults/,
    );
  });

  it('restores from the backup and re-establishes the main file', () => {
    const backup = { schemaVersion: 1, activeHuntId: 'hunt-1', hunts: [makeHunt()] };
    writeFile(`${HUNTS_FILE}.bak`, JSON.stringify(backup));
    writeFile(HUNTS_FILE, 'not json at all');

    const storage = open();
    const state = storage.loadState();
    expect(state.hunts).toEqual([makeHunt()]);
    expect(state.activeHuntId).toBe('hunt-1');
    expect(errors[0]?.message).toMatch(/restored from hunts\.json\.bak/);

    storage.flushSync();
    expect(readDoc(HUNTS_FILE)).toEqual(backup);
    // The damaged file was moved away, so it never overwrote the good backup.
    expect(readDoc(`${HUNTS_FILE}.bak`)).toEqual(backup);
    expect(exists('hunts.corrupt-20261013T180411201Z.json')).toBe(true);
  });

  it('treats valid JSON of the wrong shape as corrupt', () => {
    writeFile(HUNTS_FILE, JSON.stringify({ schemaVersion: 1, hunts: 'nope' }));
    writeFile(SESSIONS_FILE, JSON.stringify([1, 2, 3]));
    writeFile(SETTINGS_FILE, 'null');
    const state = open().loadState();

    expect(state).toEqual({
      settings: createDefaultSettings(),
      hunts: [],
      activeHuntId: null,
      sessions: [],
    });
    expect(errors.map((entry) => entry.file).sort()).toEqual(
      [HUNTS_FILE, SESSIONS_FILE, SETTINGS_FILE].sort(),
    );
    expect(listDir().filter((name) => name.includes('.corrupt-'))).toHaveLength(3);
  });

  it('uses the backup when the main file is missing', () => {
    writeFile(
      `${SETTINGS_FILE}.bak`,
      JSON.stringify({ ...createDefaultSettings(), audio: { volume: 0.1 } }),
    );
    const storage = open();
    expect(storage.loadState().settings.audio.volume).toBe(0.1);
    expect(errors[0]?.message).toMatch(
      /settings\.json was missing; restored from settings\.json\.bak/,
    );
    storage.flushSync();
    expect(exists(SETTINGS_FILE)).toBe(true);
  });

  it('ignores a backup that is itself unusable', () => {
    writeFile(HUNTS_FILE, '{{{{');
    writeFile(`${HUNTS_FILE}.bak`, '}}}}');
    expect(open().loadState().hunts).toEqual([]);
    expect(errors[0]?.message).toMatch(/no usable backup/);
  });

  it('salvages the readable records and keeps a copy of the original', () => {
    const original = JSON.stringify({
      schemaVersion: 1,
      activeHuntId: 'hunt-1',
      hunts: [makeHunt(), 'not a hunt', null, makeHunt({ id: 'hunt-2', name: 'Survivor' })],
    });
    writeFile(HUNTS_FILE, original);
    const good = JSON.stringify({ schemaVersion: 1, activeHuntId: null, hunts: [] });
    writeFile(`${HUNTS_FILE}.bak`, good);

    const storage = open();
    const state = storage.loadState();
    expect(state.hunts.map((hunt) => hunt.id)).toEqual(['hunt-1', 'hunt-2']);
    expect(errors[0]?.message).toMatch(/contained 2 unreadable records.*kept as hunts\.corrupt-/);
    expect(readFile('hunts.corrupt-20261013T180411201Z.json')).toBe(original);

    storage.flushSync();
    expect((readDoc(HUNTS_FILE) as { hunts: unknown[] }).hunts).toHaveLength(2);
    // A damaged main file must not become the backup.
    expect(readFile(`${HUNTS_FILE}.bak`)).toBe(good);
  });

  it('keeps a copy of a file written by a newer schema version before rewriting it', () => {
    const original = JSON.stringify({
      schemaVersion: SCHEMA_VERSION + 4,
      activeHuntId: 'hunt-1',
      hunts: [makeHunt()],
      extra: 1,
    });
    writeFile(HUNTS_FILE, original);
    const storage = open();
    expect(storage.loadState().hunts).toEqual([makeHunt()]);
    expect(errors[0]?.message).toMatch(/newer Biolume \(schema v5\)/);
    expect(readFile(`hunts.v${SCHEMA_VERSION + 4}-20261013T180411201Z.json`)).toBe(original);
    storage.flushSync();
    expect((readDoc(HUNTS_FILE) as { schemaVersion: number }).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('never throws, whatever the files contain', () => {
    const payloads = [
      '',
      ' ',
      '[]',
      '0',
      '"text"',
      '{"hunts":[[[[]]]]}',
      '{"sessions":{}}',
      '\u0000\u0001\u0002',
      '{"a":',
    ];
    for (const payload of payloads) {
      for (const file of [SETTINGS_FILE, HUNTS_FILE, SESSIONS_FILE]) writeFile(file, payload);
      const storage = open();
      expect(() => storage.loadState()).not.toThrow();
      storage.flushSync();
    }
  });

  it('survives an onError handler that throws', () => {
    writeFile(HUNTS_FILE, 'broken');
    const storage = open({
      onError: () => {
        throw new Error('handler exploded');
      },
    });
    expect(() => storage.loadState()).not.toThrow();
  });

  it('reports a path that cannot be read as a file without throwing', () => {
    fs.mkdirSync(path(SETTINGS_FILE));
    expect(open().loadState().settings).toEqual(createDefaultSettings());
    expect(errors[0]?.message).toMatch(/settings\.json could not be read/);
  });
});

describe('saving', () => {
  it('debounces: rapid saves produce one write of the latest value', () => {
    vi.useFakeTimers();
    const renameSync = vi.fn(fs.renameSync);
    const storage = open({ fs: { ...fs, renameSync } });

    for (let count = 1; count <= 50; count += 1) {
      storage.saveHunts([makeHunt({ count })], 'hunt-1');
      vi.advanceTimersByTime(10);
    }
    expect(storage.hasPendingWrites()).toBe(true);
    expect(exists(HUNTS_FILE)).toBe(false);

    vi.advanceTimersByTime(299);
    expect(exists(HUNTS_FILE)).toBe(true);
    expect(storage.hasPendingWrites()).toBe(false);
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect((readDoc(HUNTS_FILE) as { hunts: Hunt[] }).hunts[0]?.count).toBe(50);
  });

  it('does not defer a continuously re-scheduled save beyond maxWaitMs', () => {
    vi.useFakeTimers();
    const storage = open({ debounceMs: 300, maxWaitMs: 1_000 });
    for (let elapsed = 0; elapsed < 1_000; elapsed += 100) {
      storage.saveHunts([makeHunt({ count: elapsed })], 'hunt-1');
      vi.advanceTimersByTime(100);
    }
    expect(exists(HUNTS_FILE)).toBe(true);
  });

  it('flushSync writes everything pending immediately', () => {
    const storage = open({ debounceMs: 60_000 });
    storage.saveSettings(createDefaultSettings());
    storage.saveHunts([makeHunt()], 'hunt-1');
    storage.saveSessions([makeSession()]);
    storage.writeJson('window-state', { width: 800 });
    expect(listDir()).toEqual([]);

    storage.flushSync();
    expect(listDir()).toEqual(
      [HUNTS_FILE, SESSIONS_FILE, SETTINGS_FILE, 'window-state.json'].sort(),
    );
    expect(storage.hasPendingWrites()).toBe(false);
  });

  it('keeps the previous generation as .bak and leaves no temp file behind', () => {
    const storage = open();
    storage.saveHunts([makeHunt({ count: 1 })], 'hunt-1');
    storage.flushSync();
    expect(exists(`${HUNTS_FILE}.bak`)).toBe(false);

    storage.saveHunts([makeHunt({ count: 2 })], 'hunt-1');
    storage.flushSync();
    storage.saveHunts([makeHunt({ count: 3 })], 'hunt-1');
    storage.flushSync();

    expect((readDoc(HUNTS_FILE) as { hunts: Hunt[] }).hunts[0]?.count).toBe(3);
    expect((readDoc(`${HUNTS_FILE}.bak`) as { hunts: Hunt[] }).hunts[0]?.count).toBe(2);
    expect(listDir()).toEqual([HUNTS_FILE, `${HUNTS_FILE}.bak`]);
  });

  it('does not let a damaged file that was never loaded replace a good backup', () => {
    const good = JSON.stringify({ schemaVersion: 1, activeHuntId: null, hunts: [] });
    writeFile(`${HUNTS_FILE}.bak`, good);
    writeFile(HUNTS_FILE, '{ truncated');
    const storage = open();
    storage.saveHunts([makeHunt()], 'hunt-1');
    storage.flushSync();

    expect((readDoc(HUNTS_FILE) as { hunts: Hunt[] }).hunts).toHaveLength(1);
    expect(readFile(`${HUNTS_FILE}.bak`)).toBe(good);
  });

  it('leaves the previous file intact when a write fails, reports it and retries later', () => {
    vi.useFakeTimers();
    const first = open();
    first.saveHunts([makeHunt({ count: 1 })], 'hunt-1');
    first.flushSync();
    const before = readFile(HUNTS_FILE);

    let diskFull = true;
    const failing: StorageFs = {
      ...fs,
      renameSync: (from, to) => {
        if (diskFull) throw systemError('ENOSPC');
        fs.renameSync(from, to);
      },
    };
    const storage = open({ fs: failing });
    storage.saveHunts([makeHunt({ count: 2 })], 'hunt-1');
    expect(() => storage.flushSync()).not.toThrow();

    expect(readFile(HUNTS_FILE)).toBe(before);
    expect(exists(`${HUNTS_FILE}.tmp`)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: HUNTS_FILE });
    expect(errors[0]?.message).toMatch(/ENOSPC/);
    // The save stays queued …
    expect(storage.hasPendingWrites()).toBe(true);

    // … and goes through on its own once the disk recovers.
    diskFull = false;
    vi.advanceTimersByTime(10_000);
    expect(storage.hasPendingWrites()).toBe(false);
    expect((readDoc(HUNTS_FILE) as { hunts: Hunt[] }).hunts[0]?.count).toBe(2);
    expect(open().loadState().hunts[0]?.count).toBe(2);
  });

  it('leaves the previous file intact when the temp file cannot be written', () => {
    const first = open();
    first.saveSettings(createDefaultSettings());
    first.flushSync();
    const before = readFile(SETTINGS_FILE);

    let broken = true;
    const failing: StorageFs = {
      ...fs,
      fsyncSync: (fd) => {
        if (broken) throw systemError('EIO');
        fs.fsyncSync(fd);
      },
    };
    const storage = open({ fs: failing, debounceMs: 60_000 });
    const changed = createDefaultSettings();
    changed.audio.volume = 0.9;
    storage.saveSettings(changed);
    storage.flushSync();

    expect(readFile(SETTINGS_FILE)).toBe(before);
    expect(exists(`${SETTINGS_FILE}.tmp`)).toBe(false);
    expect(errors[0]?.message).toMatch(/EIO/);
    expect(open().loadState().settings).toEqual(createDefaultSettings());

    // Nothing was lost: the save is still queued and lands once the disk works again.
    broken = false;
    storage.flushSync();
    expect(open().loadState().settings.audio.volume).toBe(0.9);
  });

  it.each(['EPERM', 'EBUSY'])(
    'retries a rename that fails with %s (a locked file on Windows)',
    (code) => {
      let failuresLeft = 2;
      const renameSync = vi.fn((from: fs.PathLike, to: fs.PathLike) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw systemError(code);
        }
        fs.renameSync(from, to);
      });
      const storage = open({ fs: { ...fs, renameSync } });
      storage.saveHunts([makeHunt()], 'hunt-1');
      storage.flushSync();

      expect(renameSync).toHaveBeenCalledTimes(3);
      expect(errors).toEqual([]);
      expect(open().loadState().hunts).toEqual([makeHunt()]);
    },
  );

  it('gives up on a lock that never clears, without corrupting anything', () => {
    const first = open();
    first.saveHunts([makeHunt({ count: 1 })], 'hunt-1');
    first.flushSync();
    const before = readFile(HUNTS_FILE);

    let locked = true;
    const renameSync = vi.fn((from: fs.PathLike, to: fs.PathLike) => {
      if (locked) throw systemError('EBUSY');
      fs.renameSync(from, to);
    });
    const storage = open({ fs: { ...fs, renameSync }, debounceMs: 60_000 });
    storage.saveHunts([makeHunt({ count: 2 })], 'hunt-1');
    storage.flushSync();

    // One attempt plus a bounded number of quick retries, then a single report.
    expect(renameSync).toHaveBeenCalledTimes(5);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/EBUSY/);
    expect(readFile(HUNTS_FILE)).toBe(before);
    expect(exists(`${HUNTS_FILE}.tmp`)).toBe(false);

    locked = false;
    storage.flushSync();
    expect((readDoc(HUNTS_FILE) as { hunts: Hunt[] }).hunts[0]?.count).toBe(2);
  });

  it('reports a value that cannot be serialised instead of throwing', () => {
    const storage = open();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => storage.writeJson('window-state', cyclic)).not.toThrow();
    expect(() => storage.writeJson('window-state', undefined)).not.toThrow();
    expect(errors).toHaveLength(2);
    expect(storage.hasPendingWrites()).toBe(false);
  });
});

describe('readJson / writeJson', () => {
  it('round-trips a shell-owned document, with or without the .json suffix', () => {
    const storage = open();
    const bounds = { x: 10, y: 20, width: 1100, height: 720, maximized: false };
    storage.writeJson('window-state.json', bounds);
    // Readable before it reaches the disk.
    expect(storage.readJson('window-state', null)).toEqual(bounds);
    storage.flushSync();
    expect(readDoc('window-state.json')).toEqual(bounds);
    expect(open().readJson('window-state', null)).toEqual(bounds);
  });

  it('serialises at call time, so later mutations of the object are not saved', () => {
    const storage = open();
    const bounds = { width: 800 };
    storage.writeJson('window-state', bounds);
    bounds.width = 1;
    storage.flushSync();
    expect(readDoc('window-state.json')).toEqual({ width: 800 });
  });

  it('returns the fallback for a missing document', () => {
    expect(open().readJson('window-state', { width: 1 })).toEqual({ width: 1 });
    expect(errors).toEqual([]);
  });

  it('quarantines a corrupt document and falls back to its backup', () => {
    const storage = open();
    storage.writeJson('window-state', { width: 1 });
    storage.flushSync();
    storage.writeJson('window-state', { width: 2 });
    storage.flushSync();
    writeFile('window-state.json', '<<<');

    expect(open().readJson('window-state', null)).toEqual({ width: 1 });
    expect(exists('window-state.corrupt-20261013T180411201Z.json')).toBe(true);
    expect(errors[0]?.message).toMatch(/restored from window-state\.json\.bak/);
  });

  it('treats a document rejected by the validator as corrupt', () => {
    writeFile('window-state.json', JSON.stringify({ width: 'wide' }));
    const parse = (raw: unknown): { width: number } => {
      const width = (raw as { width?: unknown } | null)?.width;
      if (typeof width !== 'number') throw new Error('width must be a number');
      return { width };
    };
    expect(open().readJson('window-state', { width: 640 }, parse)).toEqual({ width: 640 });
    expect(errors[0]?.message).toMatch(/width must be a number/);
  });

  it('rejects names that could escape the directory or shadow the state files', () => {
    const storage = open();
    for (const name of ['../evil', 'a/b', 'a\\b', '', '.hidden', 'x..json', 'con:1']) {
      expect(() => storage.writeJson(name, {})).toThrow(/Invalid storage document name/);
      expect(() => storage.readJson(name, null)).toThrow(/Invalid storage document name/);
    }
    for (const name of ['settings', 'hunts.json', 'sessions']) {
      expect(() => storage.writeJson(name, {})).toThrow(/managed by the state API/);
    }
    expect(storage.hasPendingWrites()).toBe(false);
  });
});

describe('loadState (compatibility export)', () => {
  it('returns an empty default state without a directory', () => {
    expect(loadState()).toEqual({
      settings: createDefaultSettings(),
      hunts: [],
      activeHuntId: null,
      sessions: [],
    });
  });

  it('reads a directory when one is given', () => {
    const storage = open();
    storage.saveHunts([makeHunt()], 'hunt-1');
    storage.flushSync();
    expect(loadState(dir).hunts).toEqual([makeHunt()]);
  });
});

describe('a disk that keeps failing', () => {
  it('backs off instead of attempting a write for every save, and flushSync still forces one', () => {
    vi.useFakeTimers();
    let diskFull = true;
    const renameSync = vi.fn((from: fs.PathLike, to: fs.PathLike) => {
      if (diskFull) throw systemError('ENOSPC');
      fs.renameSync(from, to);
    });
    const storage = open({ fs: { ...fs, renameSync } });

    storage.saveHunts([makeHunt({ count: 1 })], 'hunt-1');
    vi.advanceTimersByTime(300);
    expect(renameSync).toHaveBeenCalledTimes(1);

    // Rapid counting during the outage must not turn into one blocked write per keypress.
    for (let count = 2; count < 12; count += 1) {
      storage.saveHunts([makeHunt({ count })], 'hunt-1');
      vi.advanceTimersByTime(20);
    }
    expect(renameSync).toHaveBeenCalledTimes(1);

    // The retry comes once the backoff (600 ms after the first failure) has passed.
    vi.advanceTimersByTime(400);
    expect(renameSync).toHaveBeenCalledTimes(2);

    storage.flushSync();
    expect(renameSync).toHaveBeenCalledTimes(3);
    expect(errors).toHaveLength(3);
    expect(exists(HUNTS_FILE)).toBe(false);
    expect(exists(`${HUNTS_FILE}.tmp`)).toBe(false);

    // The latest value is what finally gets written.
    diskFull = false;
    storage.flushSync();
    expect((readDoc(HUNTS_FILE) as { hunts: Hunt[] }).hunts[0]?.count).toBe(11);
  });

  it('stops retrying on its own after a few attempts but tries again on the next save', () => {
    vi.useFakeTimers();
    let broken = true;
    const renameSync = vi.fn((from: fs.PathLike, to: fs.PathLike) => {
      if (broken) throw systemError('EROFS');
      fs.renameSync(from, to);
    });
    const storage = open({ fs: { ...fs, renameSync } });
    storage.saveHunts([makeHunt({ count: 1 })], 'hunt-1');
    vi.advanceTimersByTime(10 * 60_000);
    const attempts = renameSync.mock.calls.length;
    expect(attempts).toBe(6);
    vi.advanceTimersByTime(10 * 60_000);
    expect(renameSync).toHaveBeenCalledTimes(attempts);
    expect(storage.hasPendingWrites()).toBe(true);

    broken = false;
    storage.saveHunts([makeHunt({ count: 2 })], 'hunt-1');
    vi.advanceTimersByTime(300);
    expect(storage.hasPendingWrites()).toBe(false);
    expect((readDoc(HUNTS_FILE) as { hunts: Hunt[] }).hunts[0]?.count).toBe(2);
  });
});
