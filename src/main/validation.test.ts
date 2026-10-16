import { describe, expect, it } from 'vitest';
import { LIMITS, createDefaultSettings } from '@shared/defaults';
import {
  MAX_BINDINGS_PER_ACTION,
  SCHEMA_VERSION,
  type Hunt,
  type SessionRecord,
} from '@shared/types';
import { recordActivity, mergeSessions, type OpenSession } from './sessions';
import {
  BOUNDS,
  InvalidDocumentError,
  cleanBindings,
  cleanLine,
  cleanText,
  inputSchemas,
  isValidId,
  mergeSettings,
  migrateDocument,
  parseInput,
  pickFallbackActiveHunt,
  readHuntsDocument,
  readSessionsDocument,
  readSettingsDocument,
  recordSchemas,
  resolveActiveHuntId,
  resolveHuntName,
  sanitizeAppState,
  sanitizeHunts,
  sanitizeSessions,
  sanitizeSettings,
  toHttpsUrl,
  truncate,
  type MigrationTable,
} from './validation';

const NOW = new Date('2026-10-13T18:00:00.000Z');

function hunt(id: string, overrides: Partial<Hunt> = {}): Hunt {
  return {
    id,
    name: `Hunt ${id}`,
    status: 'active',
    target: null,
    targetLevel: 30,
    odds: { gameId: 'sv', methodId: 'full-odds', shinyCharm: false, inputs: {} },
    count: 0,
    priorCount: 0,
    step: 1,
    phases: [],
    notes: '',
    createdAt: '2026-10-10T08:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
    completedAt: null,
    elapsedMs: 0,
    ...overrides,
  };
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    huntId: 'h1',
    huntName: 'Hunt h1',
    targetName: null,
    gameId: 'sv',
    methodId: 'full-odds',
    startedAt: '2026-10-12T08:00:00.000Z',
    endedAt: '2026-10-12T09:00:00.000Z',
    startCount: 0,
    endCount: 50,
    encounters: 50,
    phasesLogged: 0,
    ...overrides,
  };
}

describe('text helpers', () => {
  it('truncates without splitting a surrogate pair', () => {
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(truncate('ab', 3)).toBe('ab');
    expect(truncate('ab✨', 3)).toBe('ab✨');
    expect(truncate('ab😀', 3)).toBe('ab');
    expect(truncate('ab😀', 4)).toBe('ab😀');
  });

  it('cleans single-line and multi-line text', () => {
    expect(cleanLine('  a\tb\nc\u0000  ', 80)).toBe('a b c');
    expect(cleanLine('x'.repeat(200), 80)).toHaveLength(80);
    expect(cleanLine('abc   def', 4)).toBe('abc');
    expect(cleanText('a\r\nb\rc\td\u0007', 100)).toBe('a\nb\nc\td');
    expect(cleanText('y'.repeat(9_000), LIMITS.notes)).toHaveLength(LIMITS.notes);
  });

  it('resolves hunt names', () => {
    const target = {
      speciesId: 1,
      pokemonId: 1,
      slug: 'bulbasaur',
      name: 'Bulbasaur',
      types: ['grass'],
      spriteUrl: null,
      shinySpriteUrl: null,
    };
    expect(resolveHuntName('  Mine ', target)).toBe('Mine');
    expect(resolveHuntName('', target)).toBe('Bulbasaur');
    expect(resolveHuntName(undefined, null)).toBe('Untitled hunt');
  });
});

describe('ids and URLs', () => {
  it('accepts plain ids and rejects dangerous or malformed ones', () => {
    for (const id of [
      'a',
      'id-1',
      '0b8f2f6e-6c1f-4b1e-9a55-0d2b3c4d5e6f',
      'A_b.c:d',
      'x'.repeat(64),
    ]) {
      expect(isValidId(id)).toBe(true);
    }
    for (const id of [
      '',
      ' ',
      'a b',
      '__proto__',
      'constructor',
      'prototype',
      '-lead',
      '../x',
      'a/b',
      'x'.repeat(65),
      7,
      null,
      undefined,
      {},
    ]) {
      expect(isValidId(id)).toBe(false);
    }
  });

  it('only lets https URLs without credentials through', () => {
    expect(toHttpsUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(toHttpsUrl('  https://example.com/a b.png ')).toBe('https://example.com/a%20b.png');
    for (const value of [
      'http://example.com',
      'ftp://x',
      'javascript:alert(1)',
      'data:,x',
      'file:///x',
      'example.com/a.png',
      '',
      'https://u:p@example.com/',
      `https://example.com/${'a'.repeat(BOUNDS.urlLength)}`,
      null,
      5,
    ]) {
      expect(toHttpsUrl(value)).toBeNull();
    }
  });
});

describe('settings', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const raw of [undefined, null, 5, 'x', [], true])
      expect(sanitizeSettings(raw)).toEqual(createDefaultSettings());
  });

  it('is idempotent on valid settings and returns fresh objects', () => {
    const defaults = createDefaultSettings();
    const once = sanitizeSettings(defaults);
    expect(once).toEqual(defaults);
    expect(once).not.toBe(defaults);
    expect(once.hotkeys.bindings.increment).not.toBe(defaults.hotkeys.bindings.increment);
    expect(sanitizeSettings(once)).toEqual(once);
    // The fallbacks are copies too: mutating a result must not leak into later calls.
    sanitizeSettings({}).hotkeys.bindings.increment.push('F24');
    expect(sanitizeSettings({}).hotkeys.bindings.increment).toEqual(
      defaults.hotkeys.bindings.increment,
    );
  });

  it('always stamps the current schema version', () => {
    expect(sanitizeSettings({ schemaVersion: 99 }).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('keeps an empty binding list (the user cleared it) but replaces a malformed one', () => {
    const settings = sanitizeSettings({
      hotkeys: { bindings: { increment: [], decrement: 'numsub', undo: [1, 2] } },
    });
    expect(settings.hotkeys.bindings.increment).toEqual([]);
    expect(settings.hotkeys.bindings.decrement).toEqual(['numsub']);
    expect(settings.hotkeys.bindings.undo).toEqual([]);
  });

  it('cleans binding lists', () => {
    expect(cleanBindings([' Space', 'space ', 'SPACE', '', '  ', 'Ctrl+A'])).toEqual([
      'Space',
      'Ctrl+A',
    ]);
  });

  it('merges a validated patch without touching the original', () => {
    const current = createDefaultSettings();
    const snapshot = JSON.stringify(current);
    const patch = parseInput(
      inputSchemas.settingsPatch,
      {
        audio: { volume: 2, enabled: undefined },
        hotkeys: { bindings: { undo: ['F9'] } },
        general: { reducedMotion: 'on' },
      },
      'settings',
    );
    const next = mergeSettings(current, patch);
    expect(next.audio).toEqual({ ...current.audio, volume: 1 });
    expect(next.hotkeys.bindings).toEqual({ ...current.hotkeys.bindings, undo: ['F9'] });
    expect(next.general.reducedMotion).toBe('on');
    expect(next.overlay).toBe(current.overlay);
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it('gives files written before the Stream Deck integration its defaults', () => {
    const old = {
      schemaVersion: 1,
      hotkeys: {
        globalEnabled: true,
        bindings: { increment: ['F13'], decrement: ['F14'], undo: [], logPhase: ['F15'] },
      },
    };
    const settings = sanitizeSettings(old);
    expect(settings.streamDeck).toEqual({ enabled: true });
    expect(settings.hotkeys.bindings.shinyFound).toEqual([]);
    expect(settings.hotkeys.bindings.logPhase).toEqual(['F15']);
  });

  it('sanitises the Stream Deck section and the shinyFound bindings', () => {
    expect(sanitizeSettings({ streamDeck: { enabled: false } }).streamDeck).toEqual({
      enabled: false,
    });
    expect(sanitizeSettings({ streamDeck: { enabled: 'no', extra: 1 } }).streamDeck).toEqual({
      enabled: true,
    });
    expect(sanitizeSettings({ streamDeck: 'on' }).streamDeck).toEqual({ enabled: true });
    expect(
      sanitizeSettings({ hotkeys: { bindings: { shinyFound: ['F16', 'f16', 7] } } }).hotkeys
        .bindings.shinyFound,
    ).toEqual(['F16']);
  });

  it('accepts and merges Stream Deck and shinyFound patches', () => {
    const current = createDefaultSettings();
    const patch = parseInput(
      inputSchemas.settingsPatch,
      { streamDeck: { enabled: false }, hotkeys: { bindings: { shinyFound: ['F16'] } } },
      'settings',
    );
    const next = mergeSettings(current, patch);
    expect(next.streamDeck).toEqual({ enabled: false });
    expect(next.hotkeys.bindings.shinyFound).toEqual(['F16']);
    expect(current.streamDeck).toEqual({ enabled: true });
    expect(() =>
      parseInput(inputSchemas.settingsPatch, { streamDeck: { enabled: 'yes' } }, 'settings'),
    ).toThrow('Invalid settings: streamDeck.enabled');
    // An empty section leaves the setting alone.
    const untouched = mergeSettings(
      current,
      parseInput(inputSchemas.settingsPatch, { streamDeck: {} }, 'settings'),
    );
    expect(untouched.streamDeck).toEqual(current.streamDeck);
  });

  it('knows the Stream Deck as a counter source', () => {
    expect(parseInput(inputSchemas.counterSource, 'streamdeck', 'source')).toBe('streamdeck');
    expect(() => parseInput(inputSchemas.counterSource, 'stream-deck', 'source')).toThrow();
  });

  it('rejects more bindings than an action may have', () => {
    const tooMany = Array.from(
      { length: MAX_BINDINGS_PER_ACTION + 1 },
      (_, index) => `F${index + 1}`,
    );
    expect(() =>
      parseInput(
        inputSchemas.settingsPatch,
        { hotkeys: { bindings: { undo: tooMany } } },
        'settings',
      ),
    ).toThrow('Invalid settings: hotkeys.bindings.undo: at most 3 shortcuts per action');
    // Duplicates do not count against the limit.
    const patch = parseInput(
      inputSchemas.settingsPatch,
      { hotkeys: { bindings: { undo: ['F1', 'f1', 'F2', ' F3 '] } } },
      'settings',
    );
    expect(patch.hotkeys?.bindings?.undo).toEqual(['F1', 'F2', 'F3']);
  });
});

describe('record schemas', () => {
  it('accept a valid hunt unchanged and drop unknown keys', () => {
    const valid = hunt('h1', {
      odds: { gameId: 'sv', methodId: 'full-odds', shinyCharm: true, inputs: { level: 3 } },
    });
    expect(recordSchemas.hunt.parse(valid)).toEqual(valid);
    expect(recordSchemas.hunt.parse({ ...valid, extra: 1 })).toEqual(valid);
  });

  it('require every field in strict mode', () => {
    const partial: Record<string, unknown> = { ...hunt('h1') };
    delete partial['createdAt'];
    expect(recordSchemas.hunt.safeParse(partial).success).toBe(false);
    expect(recordSchemas.session.safeParse({ id: 's' }).success).toBe(false);
  });

  it('keep status and completedAt consistent', () => {
    const completed = recordSchemas.hunt.parse(
      hunt('h1', { status: 'completed', completedAt: null }),
    );
    expect(completed.completedAt).toBe(completed.updatedAt);
    const active = recordSchemas.hunt.parse(
      hunt('h1', { status: 'active', completedAt: '2026-10-12T00:00:00.000Z' }),
    );
    expect(active.completedAt).toBeNull();
    const archived = recordSchemas.hunt.parse(
      hunt('h1', { status: 'archived', completedAt: '2026-10-12T00:00:00.000Z' }),
    );
    expect(archived.completedAt).toBe('2026-10-12T00:00:00.000Z');
  });

  it('normalise timestamps to ISO-8601 UTC and reject nonsense', () => {
    const parsed = recordSchemas.session.parse(
      session('s', { startedAt: '2026-10-12T10:00:00+02:00', endedAt: '2026-10-12 09:30:00Z' }),
    );
    expect(parsed.startedAt).toBe('2026-10-12T08:00:00.000Z');
    expect(parsed.endedAt).toBe('2026-10-12T09:30:00.000Z');
    for (const bad of ['', 'soon', '1960-01-01T00:00:00Z', '+275760-09-13T00:00:00.000Z', 12345]) {
      expect(
        recordSchemas.session.safeParse(session('s', { startedAt: bad as string })).success,
      ).toBe(false);
    }
  });

  it('never end a session before it started', () => {
    const parsed = recordSchemas.session.parse(
      session('s', { startedAt: '2026-10-12T10:00:00.000Z', endedAt: '2026-10-12T09:00:00.000Z' }),
    );
    expect(parsed.endedAt).toBe('2026-10-12T10:00:00.000Z');
  });

  it('validate targets strictly but clean their type list', () => {
    const target = {
      speciesId: 25,
      pokemonId: 25,
      slug: 'pikachu',
      name: 'Pikachu',
      types: ['Electric', 'electric', 'ELECTRIC ', 7, 'fairy', 'x y', 'steel', 'ghost'],
    };
    expect(recordSchemas.hunt.parse({ ...hunt('h'), target }).target).toEqual({
      speciesId: 25,
      pokemonId: 25,
      slug: 'pikachu',
      name: 'Pikachu',
      types: ['electric', 'fairy', 'steel'],
      spriteUrl: null,
      shinySpriteUrl: null,
    });
    for (const bad of [
      { ...target, speciesId: 0 },
      { ...target, pokemonId: 1.5 },
      { ...target, slug: 'Pika Chu' },
      { ...target, name: '   ' },
    ]) {
      expect(recordSchemas.hunt.safeParse({ ...hunt('h'), target: bad }).success).toBe(false);
    }
  });
});

describe('lenient sanitisers', () => {
  it('count dropped entries and keep the rest', () => {
    const { hunts, dropped } = sanitizeHunts([hunt('a'), 5, null, 'x', [], hunt('b')], {
      now: NOW,
    });
    expect(hunts.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(dropped).toBe(4);
    expect(sanitizeHunts('nope')).toEqual({ hunts: [], dropped: 0 });
  });

  it('count phases that could not be salvaged', () => {
    const { hunts, dropped } = sanitizeHunts([{ ...hunt('a'), phases: [{ id: 'p' }, 'junk', 3] }], {
      now: NOW,
    });
    expect(hunts[0]?.phases).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it('derive a missing timestamp from its sibling before falling back to now', () => {
    const [onlyUpdated, onlyCreated, neither] = sanitizeHunts(
      [
        { id: 'a', updatedAt: '2026-01-02T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-03T00:00:00.000Z' },
        { id: 'c' },
      ],
      { now: NOW },
    ).hunts;
    expect(onlyUpdated).toMatchObject({
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(onlyCreated).toMatchObject({
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(neither).toMatchObject({ createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  });

  it('cap the number of hunts and phases', () => {
    const many = Array.from({ length: BOUNDS.hunts + 3 }, (_, index) => hunt(`h${index}`));
    const result = sanitizeHunts(many);
    expect(result.hunts).toHaveLength(BOUNDS.hunts);
    expect(result.dropped).toBe(3);
  });

  it('drop sessions with duplicate ids and sort newest first', () => {
    const { sessions, dropped } = sanitizeSessions([
      session('old', {
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T01:00:00.000Z',
      }),
      session('new', {
        startedAt: '2026-06-01T00:00:00.000Z',
        endedAt: '2026-06-01T01:00:00.000Z',
      }),
      session('old'),
      'junk',
    ]);
    expect(sessions.map((entry) => entry.id)).toEqual(['new', 'old']);
    expect(dropped).toBe(2);
  });

  it('pick the active hunt', () => {
    const hunts = [
      hunt('done', {
        status: 'completed',
        completedAt: '2026-10-13T00:00:00.000Z',
        updatedAt: '2026-10-13T00:00:00.000Z',
      }),
      hunt('older', { updatedAt: '2026-10-11T00:00:00.000Z' }),
      hunt('newer', { updatedAt: '2026-10-12T00:00:00.000Z' }),
    ];
    expect(pickFallbackActiveHunt(hunts)).toBe('newer');
    expect(pickFallbackActiveHunt([hunts[0] as Hunt])).toBeNull();
    expect(pickFallbackActiveHunt([])).toBeNull();
    expect(resolveActiveHuntId(hunts, 'done')).toBe('done');
    expect(resolveActiveHuntId(hunts, null)).toBeNull();
    expect(resolveActiveHuntId(hunts, 'gone')).toBe('newer');
    expect(resolveActiveHuntId(hunts, undefined)).toBe('newer');
    expect(resolveActiveHuntId(hunts, 42)).toBe('newer');
  });

  it('rebuild a whole state', () => {
    const state = sanitizeAppState({
      hunts: [hunt('a')],
      activeHuntId: 'a',
      sessions: [session('s')],
      settings: {},
      junk: 1,
    });
    expect(state).toEqual({
      settings: createDefaultSettings(),
      hunts: [hunt('a')],
      activeHuntId: 'a',
      sessions: [session('s')],
    });
    expect(() => sanitizeAppState([])).toThrow(/Invalid state/);
  });
});

describe('documents and migrations', () => {
  it('read well-formed documents', () => {
    expect(readSettingsDocument(createDefaultSettings())).toEqual({
      value: createDefaultSettings(),
      dropped: 0,
      fromVersion: 1,
      newer: false,
    });
    expect(
      readHuntsDocument({ schemaVersion: 1, activeHuntId: 'a', hunts: [hunt('a')] }).value,
    ).toEqual({ hunts: [hunt('a')], activeHuntId: 'a' });
    expect(readSessionsDocument({ schemaVersion: 1, sessions: [session('s')] }).value).toEqual([
      session('s'),
    ]);
  });

  it('reject documents of the wrong shape', () => {
    expect(() => readSettingsDocument([])).toThrow(InvalidDocumentError);
    expect(() => readHuntsDocument({ hunts: {} })).toThrow(/expected a "hunts" array/);
    expect(() => readHuntsDocument(null)).toThrow(/expected a JSON object/);
    expect(() => readSessionsDocument({})).toThrow(/expected a "sessions" array/);
  });

  it('flag documents from a newer schema', () => {
    expect(readHuntsDocument({ schemaVersion: SCHEMA_VERSION + 2, hunts: [] })).toMatchObject({
      newer: true,
      fromVersion: SCHEMA_VERSION + 2,
    });
    expect(readHuntsDocument({ hunts: [] })).toMatchObject({ newer: false, fromVersion: 1 });
    expect(readHuntsDocument({ schemaVersion: 'x', hunts: [] })).toMatchObject({ fromVersion: 1 });
  });

  it('run the migrations between the stored and the target version, in order', () => {
    const applied: string[] = [];
    const migrations: MigrationTable = {
      settings: {},
      sessions: {},
      hunts: {
        1: (doc) => {
          applied.push('1→2');
          return {
            ...doc,
            schemaVersion: 2,
            hunts: (doc['hunts'] as { title: string }[]).map((entry) => ({ name: entry.title })),
          };
        },
        // Version 2 → 3 needs no structural change, so it has no entry.
        3: (doc) => {
          applied.push('3→4');
          return { ...doc, schemaVersion: 4, migrated: true };
        },
      },
    };
    const fromV1 = migrateDocument(
      'hunts',
      { schemaVersion: 1, hunts: [{ title: 'Old name' }] },
      migrations,
      4,
    );
    expect(applied).toEqual(['1→2', '3→4']);
    expect(fromV1).toMatchObject({
      fromVersion: 1,
      newer: false,
      doc: { hunts: [{ name: 'Old name' }], migrated: true },
    });

    applied.length = 0;
    expect(
      migrateDocument('hunts', { schemaVersion: 3, hunts: [] }, migrations, 4).doc,
    ).toMatchObject({ migrated: true });
    expect(applied).toEqual(['3→4']);

    applied.length = 0;
    const current = { schemaVersion: 4, hunts: [] };
    expect(migrateDocument('hunts', current, migrations, 4).doc).toBe(current);
    expect(migrateDocument('settings', { schemaVersion: 1 }, migrations, 4).doc).toEqual({
      schemaVersion: 1,
    });
    expect(applied).toEqual([]);
  });

  it('leaves current documents untouched with the built-in table', () => {
    const doc = { schemaVersion: SCHEMA_VERSION, hunts: [] };
    expect(migrateDocument('hunts', doc)).toEqual({
      doc,
      fromVersion: SCHEMA_VERSION,
      newer: false,
    });
  });
});

describe('parseInput', () => {
  it('names the offending field and limits how many problems it lists', () => {
    expect(() => parseInput(inputSchemas.delta, 'x', 'count change')).toThrow(
      'Invalid count change: expected number, received string',
    );
    expect(() =>
      parseInput(
        inputSchemas.createHunt,
        { name: 1, targetLevel: 'a', step: null, notes: 4, activate: 'yes' },
        'hunt',
      ),
    ).toThrow(
      /^Invalid hunt: name: expected string, received number; targetLevel: .*; step: .* \(\+2 more\)$/,
    );
  });

  it('clamps deltas and counts into range', () => {
    expect(parseInput(inputSchemas.delta, -1e15, 'x')).toBe(-LIMITS.count.max);
    expect(parseInput(inputSchemas.count, -7, 'x')).toBe(0);
    expect(parseInput(inputSchemas.count, 1e15, 'x')).toBe(LIMITS.count.max);
  });
});

describe('session helpers', () => {
  const base = {
    hunt: hunt('h1'),
    totalBefore: 10,
    totalAfter: 11,
    phasesDelta: 0,
    idleMs: 60_000,
    canOpen: true,
    newId: () => 'fresh',
  };

  it('opens, extends and rolls over sessions without mutating its input', () => {
    const empty: SessionRecord[] = [];
    const opened = recordActivity(empty, null, { ...base, at: new Date(NOW) });
    expect(empty).toEqual([]);
    expect(opened).toMatchObject({
      opened: true,
      closed: false,
      gapMs: 0,
      open: { id: 'fresh', huntId: 'h1' },
    });
    expect(opened.sessions[0]).toMatchObject({
      id: 'fresh',
      startCount: 10,
      endCount: 11,
      encounters: 1,
    });

    const frozen = JSON.stringify(opened.sessions);
    const extended = recordActivity(opened.sessions, opened.open, {
      ...base,
      totalAfter: 15,
      at: new Date(NOW.getTime() + 30_000),
    });
    expect(JSON.stringify(opened.sessions)).toBe(frozen);
    expect(extended).toMatchObject({ opened: false, closed: false, gapMs: 30_000 });
    expect(extended.sessions).toHaveLength(1);
    expect(extended.sessions[0]).toMatchObject({ endCount: 15, encounters: 5 });

    const rolled = recordActivity(extended.sessions, extended.open, {
      ...base,
      totalBefore: 15,
      totalAfter: 16,
      at: new Date(NOW.getTime() + 30_000 + 60_001),
      newId: () => 'second',
    });
    expect(rolled).toMatchObject({ opened: true, closed: true, gapMs: 0 });
    expect(rolled.sessions.map((entry) => entry.id)).toEqual(['second', 'fresh']);
  });

  it('does not open a session when it may not, and recovers when the open record vanished', () => {
    const list = [session('s')];
    const none = recordActivity(list, null, { ...base, at: NOW, canOpen: false });
    expect(none).toEqual({ sessions: list, open: null, gapMs: 0, opened: false, closed: false });
    expect(none.sessions).toBe(list);

    const stale: OpenSession = { id: 'gone', huntId: 'h1', lastActivityMs: NOW.getTime() - 1_000 };
    const recovered = recordActivity(list, stale, { ...base, at: NOW });
    expect(recovered).toMatchObject({ opened: true, closed: true });
    expect(recovered.sessions.map((entry) => entry.id)).toEqual(['fresh', 's']);
  });

  it('never reports negative encounters or phases', () => {
    const opened = recordActivity([], null, {
      ...base,
      at: NOW,
      totalBefore: 10,
      totalAfter: 4,
      phasesDelta: -2,
    });
    expect(opened.sessions[0]).toMatchObject({ encounters: 0, phasesLogged: 0 });
  });

  it('merges session lists', () => {
    const existing = [
      session('b', { startedAt: '2026-10-12T00:00:00.000Z' }),
      session('a', { startedAt: '2026-10-10T00:00:00.000Z' }),
    ];
    const merged = mergeSessions(existing, [
      session('c', { startedAt: '2026-10-11T00:00:00.000Z' }),
      session('a'),
      session('c'),
    ]);
    expect(merged.sessions.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    expect(merged).toMatchObject({ added: 1, duplicates: 2 });
    expect(existing.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(mergeSessions(existing, [])).toMatchObject({
      added: 0,
      duplicates: 0,
      sessions: existing,
    });
  });
});
