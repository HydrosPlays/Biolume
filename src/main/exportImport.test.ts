import { describe, expect, it } from 'vitest';
import { LIMITS, createDefaultSettings } from '@shared/defaults';
import {
  SCHEMA_VERSION,
  type AppState,
  type ExportBundle,
  type ExportDataset,
  type Hunt,
  type PhaseEntry,
  type SessionRecord,
  type TargetRef,
} from '@shared/types';
import { CSV_BOM, parseCsv, toCsv } from './csv';
import {
  IMPORTED_HUNT_NAME,
  MAX_IMPORT_BYTES,
  PHASE_COLUMNS,
  SESSION_COLUMNS,
  TARGET_COLUMNS,
  applyImport,
  buildExport,
  parseImport,
  type ImportContext,
} from './exportImport';
import { BOUNDS } from './validation';

const NOW = new Date(2026, 9, 13, 18, 4, 30);

const VULPIX: TargetRef = {
  speciesId: 37,
  pokemonId: 10103,
  slug: 'vulpix-alola',
  name: 'Alolan Vulpix',
  types: ['ice'],
  spriteUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/10103.png',
  shinySpriteUrl:
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/10103.png',
};

function phase(id: string, overrides: Partial<PhaseEntry> = {}): PhaseEntry {
  return {
    id,
    speciesId: 133,
    speciesName: 'Eevee',
    spriteUrl: 'https://example.com/eevee.png',
    encounters: 100,
    totalEncounters: 100,
    timestamp: '2026-10-11T10:00:00.000Z',
    notes: '',
    ...overrides,
  };
}

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

/** A state with awkward text in every free-form field. */
function sampleState(): AppState {
  const settings = createDefaultSettings();
  settings.audio.volume = 0.3;
  settings.hotkeys.bindings.undo = ['CommandOrControl+Z'];
  return {
    settings,
    activeHuntId: 'h1',
    hunts: [
      hunt('h1', {
        name: 'Vulpix, "the" hunt',
        target: VULPIX,
        targetLevel: 17,
        odds: {
          gameId: 'usum',
          methodId: 'sos-chain',
          shinyCharm: true,
          inputs: { chain: 31, mode: 'fast', synced: true },
        },
        count: 12,
        priorCount: 350,
        step: 2,
        notes: '=cmd|/c calc\nsecond line, with "quotes"',
        elapsedMs: 5_400_000,
        phases: [
          phase('p1', { notes: '-not a formula', speciesName: '@Eevee' }),
          phase('p2', {
            speciesId: null,
            speciesName: '',
            spriteUrl: null,
            encounters: 250,
            totalEncounters: 350,
            timestamp: '2026-10-12T11:30:00.000Z',
            notes: 'multi\nline; semi',
          }),
        ],
      }),
      hunt('h2', {
        name: 'Finished',
        status: 'completed',
        completedAt: '2026-10-12T09:00:00.000Z',
        count: 4_096,
        phases: [phase('p1', { speciesName: 'Same id, other hunt' })],
      }),
      hunt('h3', { name: '+Plus', notes: '\tTabbed' }),
    ],
    sessions: [
      session('s2', {
        huntName: 'Vulpix, "the" hunt',
        targetName: 'Alolan Vulpix',
        gameId: 'usum',
        methodId: 'sos-chain',
        startedAt: '2026-10-13T08:00:00.000Z',
        endedAt: '2026-10-13T09:30:00.000Z',
        startCount: 350,
        endCount: 362,
        encounters: 12,
        phasesLogged: 1,
      }),
      session('s1'),
      session('s0', {
        huntId: 'h2',
        huntName: '=Finished',
        startedAt: '2026-10-11T08:00:00.000Z',
        endedAt: '2026-10-11T08:00:00.000Z',
      }),
    ],
  };
}

function emptyState(): AppState {
  return { settings: createDefaultSettings(), hunts: [], activeHuntId: null, sessions: [] };
}

function context(): ImportContext {
  let next = 0;
  return { now: new Date('2026-10-14T00:00:00.000Z'), idGenerator: () => `new-${(next += 1)}` };
}

function exportOf(
  state: AppState,
  dataset: ExportDataset,
  format: 'json' | 'csv',
  huntIds?: string[],
): string {
  return buildExport(state, huntIds ? { dataset, format, huntIds } : { dataset, format }, NOW)
    .content;
}

/** Hunts reduced to what a target setup carries. */
function setupOf(value: Hunt) {
  const { name, target, targetLevel, odds, step, notes } = value;
  return { name, target, targetLevel, odds, step, notes };
}

describe('buildExport', () => {
  it('names files biolume-<dataset>-YYYYMMDD-HHmm.<ext> in local time', () => {
    const state = sampleState();
    expect(buildExport(state, { dataset: 'backup', format: 'json' }, NOW)).toMatchObject({
      defaultFileName: 'biolume-backup-20261013-1804.json',
      extension: 'json',
    });
    expect(
      buildExport(state, { dataset: 'phases', format: 'csv' }, new Date(2027, 0, 2, 3, 4)),
    ).toMatchObject({
      defaultFileName: 'biolume-phases-20270102-0304.csv',
      extension: 'csv',
    });
  });

  it('refuses a CSV backup and malformed requests with clear errors', () => {
    const state = sampleState();
    expect(() => buildExport(state, { dataset: 'backup', format: 'csv' }, NOW)).toThrow(
      /backup can only be exported as JSON/,
    );
    expect(() =>
      buildExport(state, { dataset: 'everything' as never, format: 'json' }, NOW),
    ).toThrow(/Invalid export request: dataset/);
    expect(() => buildExport(state, { dataset: 'sessions', format: 'xml' as never }, NOW)).toThrow(
      /format/,
    );
    expect(() =>
      buildExport(state, { dataset: 'sessions', format: 'json', huntIds: 'h1' as never }, NOW),
    ).toThrow(/huntIds/);
    expect(() => buildExport(state, null as never, NOW)).toThrow(/Invalid export request/);
  });

  it('wraps JSON exports in the bundle envelope', () => {
    const state = sampleState();
    const backup = JSON.parse(exportOf(state, 'backup', 'json')) as ExportBundle;
    expect(backup).toEqual({
      app: 'biolume',
      kind: 'backup',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: NOW.toISOString(),
      hunts: state.hunts,
      sessions: state.sessions,
      settings: state.settings,
    });

    const phases = JSON.parse(exportOf(state, 'phases', 'json')) as ExportBundle;
    expect(Object.keys(phases).sort()).toEqual([
      'app',
      'exportedAt',
      'kind',
      'phases',
      'schemaVersion',
    ]);
    expect(phases.phases?.[1]).toEqual({
      huntId: 'h1',
      huntName: 'Vulpix, "the" hunt',
      targetName: 'Alolan Vulpix',
      phaseNumber: 2,
      phaseId: 'p2',
      speciesId: null,
      speciesName: '',
      encounters: 250,
      totalEncounters: 350,
      timestamp: '2026-10-12T11:30:00.000Z',
      notes: 'multi\nline; semi',
    });

    const targets = JSON.parse(exportOf(state, 'targets', 'json')) as ExportBundle;
    expect(targets.targets).toEqual(state.hunts.map(setupOf));
  });

  it('counts the records it wrote', () => {
    const state = sampleState();
    const records = (dataset: ExportDataset, format: 'json' | 'csv' = 'json') =>
      buildExport(state, { dataset, format }, NOW).records;
    expect(records('backup')).toBe(6);
    expect(records('sessions')).toBe(3);
    expect(records('sessions', 'csv')).toBe(3);
    expect(records('phases', 'csv')).toBe(3);
    expect(records('targets', 'csv')).toBe(3);
    expect(buildExport(emptyState(), { dataset: 'phases', format: 'csv' }, NOW).records).toBe(0);
  });

  it('restricts the export to the requested hunts', () => {
    const state = sampleState();
    const backup = JSON.parse(exportOf(state, 'backup', 'json', ['h2', 'unknown'])) as ExportBundle;
    expect(backup.hunts?.map((entry) => entry.id)).toEqual(['h2']);
    expect(backup.sessions?.map((entry) => entry.id)).toEqual(['s0']);
    expect(
      buildExport(state, { dataset: 'phases', format: 'csv', huntIds: ['h1'] }, NOW).records,
    ).toBe(2);
    expect(
      buildExport(state, { dataset: 'targets', format: 'json', huntIds: [] }, NOW).records,
    ).toBe(0);
  });

  it('writes CSV with a BOM, CRLF line endings and the documented columns', () => {
    const state = sampleState();
    const sessions = exportOf(state, 'sessions', 'csv');
    expect(sessions.startsWith(CSV_BOM)).toBe(true);
    expect(sessions.endsWith('\r\n')).toBe(true);
    expect(sessions.slice(1).split('\r\n')[0]).toBe(
      'id,huntId,huntName,targetName,gameId,methodId,startedAt,endedAt,startCount,endCount,encounters,phasesLogged',
    );
    expect(parseCsv(exportOf(state, 'phases', 'csv'))[0]).toEqual([
      'huntId',
      'huntName',
      'targetName',
      'phaseNumber',
      'phaseId',
      'speciesId',
      'speciesName',
      'encounters',
      'totalEncounters',
      'timestamp',
      'notes',
    ]);
    expect(parseCsv(exportOf(state, 'targets', 'csv'))[0]).toEqual([
      'name',
      'targetName',
      'speciesId',
      'pokemonId',
      'slug',
      'types',
      'targetLevel',
      'gameId',
      'methodId',
      'shinyCharm',
      'inputs',
      'step',
      'notes',
      'spriteUrl',
      'shinySpriteUrl',
    ]);
    // The column lists cover every field of the exported row types.
    expect([...SESSION_COLUMNS].sort()).toEqual(Object.keys(session('x')).sort());
    expect(PHASE_COLUMNS).toHaveLength(11);
    expect(TARGET_COLUMNS).toHaveLength(15);
  });

  it('neutralises formula cells in CSV output', () => {
    const state = sampleState();
    for (const dataset of ['sessions', 'phases', 'targets'] as const) {
      for (const record of parseCsv(exportOf(state, dataset, 'csv')).slice(1)) {
        for (const cell of record) expect(cell).not.toMatch(/^[=+@\t\r]/);
      }
    }
    const targets = parseCsv(exportOf(state, 'targets', 'csv'));
    expect(targets[1]?.[12]).toBe(`'=cmd|/c calc\nsecond line, with "quotes"`);
    expect(targets[3]?.[0]).toBe("'+Plus");
    expect(targets[1]?.[5]).toBe('ice');
    expect(targets[1]?.[10]).toBe('{"chain":31,"mode":"fast","synced":true}');
  });
});

describe('parseImport detection', () => {
  it('detects every dataset in both formats', () => {
    const state = sampleState();
    expect(parseImport(exportOf(state, 'backup', 'json'))).toMatchObject({
      dataset: 'backup',
      format: 'json',
    });
    for (const dataset of ['sessions', 'phases', 'targets'] as const) {
      for (const format of ['json', 'csv'] as const) {
        const parsed = parseImport(exportOf(state, dataset, format));
        expect(parsed).toMatchObject({ dataset, format, skipped: 0, errors: [] });
      }
    }
  });

  it('rejects content that is not a Biolume export', () => {
    const cases: [string, RegExp][] = [
      ['', /empty/],
      ['   \r\n  ', /empty/],
      ['{ not json', /not valid JSON/],
      ['{"app":"other","kind":"backup"}', /not a Biolume export/],
      ['[1,2,3]', /not a Biolume export/],
      ['{"app":"biolume","kind":"mystery"}', /unknown kind/],
      ['{"app":"biolume","kind":"sessions"}', /no "sessions" list/],
      ['{"app":"biolume","kind":"backup","hunts":[]}', /no "sessions" list/],
      ['{"app":"biolume","kind":"backup","hunts":{},"sessions":[]}', /no "hunts" list/],
      ['some,random,columns\r\n1,2,3', /first row does not match/],
      ['just some prose in a text file', /first row does not match/],
      ['\u0000\u0001\u0002binary', /first row does not match/],
    ];
    for (const [content, message] of cases) {
      const parsed = parseImport(content);
      expect(parsed.dataset).toBeNull();
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]).toMatch(message);
    }
    expect(parseImport(42 as unknown as string).dataset).toBeNull();
  });

  it('rejects oversized content before parsing it', () => {
    const parsed = parseImport(`{"app":"biolume","pad":"${'x'.repeat(MAX_IMPORT_BYTES)}"}`);
    expect(parsed.dataset).toBeNull();
    expect(parsed.errors[0]).toMatch(/too large .* 25 MB/);
  });

  it('refuses exports from a newer schema instead of guessing', () => {
    const bundle = {
      ...(JSON.parse(exportOf(sampleState(), 'backup', 'json')) as ExportBundle),
      schemaVersion: SCHEMA_VERSION + 1,
    };
    const parsed = parseImport(JSON.stringify(bundle));
    expect(parsed.dataset).toBeNull();
    expect(parsed.errors[0]).toMatch(/newer Biolume \(schema v2\)/);
    // An unusable file must not change anything, even in replace mode.
    const state = sampleState();
    expect(applyImport(state, parsed, 'replace', context()).state).toBe(state);
  });

  it('accepts a JSON bundle with a BOM and leading whitespace', () => {
    const content = `${CSV_BOM}\n  ${exportOf(sampleState(), 'sessions', 'json')}`;
    expect(parseImport(content)).toMatchObject({ dataset: 'sessions', format: 'json' });
  });

  it('reads CSV saved by a spreadsheet: semicolons, reordered columns, TRUE/FALSE, extra columns', () => {
    const csv = [
      'Comment;MethodId;GameId;Name;ShinyCharm;Step;Slug;SpeciesId;TargetName',
      'ignore me;masuda;swsh;Egg hunt;TRUE;;pikachu;25;Pikachu',
      ';;;Bare minimum;;;;;',
    ].join('\n');
    const parsed = parseImport(csv);
    expect(parsed).toMatchObject({ dataset: 'targets', format: 'csv', skipped: 0, errors: [] });
    expect(parsed.targets).toEqual([
      {
        name: 'Egg hunt',
        target: {
          speciesId: 25,
          pokemonId: 25,
          slug: 'pikachu',
          name: 'Pikachu',
          types: [],
          spriteUrl: null,
          shinySpriteUrl: null,
        },
        targetLevel: 30,
        odds: { gameId: 'swsh', methodId: 'masuda', shinyCharm: true, inputs: {} },
        step: 1,
        notes: '',
      },
      {
        name: 'Bare minimum',
        target: null,
        targetLevel: 30,
        odds: { gameId: 'sv', methodId: 'full-odds', shinyCharm: false, inputs: {} },
        step: 1,
        notes: '',
      },
    ]);
  });
});

describe('round trips', () => {
  it('backup → replace restores hunts, sessions and settings exactly', () => {
    const source = sampleState();
    const parsed = parseImport(exportOf(source, 'backup', 'json'));
    const target: AppState = {
      ...emptyState(),
      hunts: [hunt('other')],
      activeHuntId: 'other',
      sessions: [session('old')],
    };
    const { state, result } = applyImport(target, parsed, 'replace', context());

    expect(state.hunts).toEqual(source.hunts);
    expect(state.sessions).toEqual(source.sessions);
    expect(state.settings).toEqual(source.settings);
    // The previously active hunt is gone; the most recently updated countable hunt takes over.
    expect(state.activeHuntId).toBe('h1');
    expect(result).toEqual({
      dataset: 'backup',
      imported: { hunts: 3, phases: 3, sessions: 3, targets: 0 },
      skipped: 0,
      errors: [],
    });
  });

  it('backup → merge upserts hunts by id, adds unseen sessions and keeps the current settings', () => {
    const source = sampleState();
    const parsed = parseImport(exportOf(source, 'backup', 'json'));
    const mine = createDefaultSettings();
    mine.audio.pack = 'chime';
    const target: AppState = {
      settings: mine,
      hunts: [hunt('other'), hunt('h2', { name: 'Stale copy', count: 1 })],
      activeHuntId: 'other',
      sessions: [
        session('s1', { encounters: 999 }),
        session('mine', {
          startedAt: '2026-10-14T00:00:00.000Z',
          endedAt: '2026-10-14T00:10:00.000Z',
        }),
      ],
    };
    const { state, result } = applyImport(target, parsed, 'merge', context());

    expect(state.hunts.map((entry) => entry.id)).toEqual(['other', 'h2', 'h1', 'h3']);
    expect(state.hunts[1]).toEqual(source.hunts[1]);
    expect(state.settings).toBe(mine);
    expect(state.activeHuntId).toBe('other');
    // Newest first; the existing record with a known id wins.
    expect(state.sessions.map((entry) => entry.id)).toEqual(['mine', 's2', 's1', 's0']);
    expect(state.sessions[2]?.encounters).toBe(999);
    expect(result).toEqual({
      dataset: 'backup',
      imported: { hunts: 3, phases: 3, sessions: 2, targets: 0 },
      skipped: 1,
      errors: [],
    });

    // Merging the same file again adds nothing new.
    const again = applyImport(state, parsed, 'merge', context());
    expect(again.state.hunts).toEqual(state.hunts);
    expect(again.state.sessions).toBe(state.sessions);
    expect(again.result.imported.sessions).toBe(0);
    expect(again.result.skipped).toBe(3);
  });

  it.each(['json', 'csv'] as const)('sessions (%s) → replace and merge', (format) => {
    const source = sampleState();
    const parsed = parseImport(exportOf(source, 'sessions', format));
    expect(parsed.sessions).toEqual(source.sessions);

    const target: AppState = {
      ...emptyState(),
      hunts: [hunt('keep')],
      activeHuntId: 'keep',
      sessions: [session('old'), session('s1', { encounters: 7 })],
    };
    const replaced = applyImport(target, parsed, 'replace', context());
    expect(replaced.state.sessions).toEqual(source.sessions);
    expect(replaced.state.hunts).toBe(target.hunts);
    expect(replaced.state.activeHuntId).toBe('keep');
    expect(replaced.result).toMatchObject({
      dataset: 'sessions',
      imported: { hunts: 0, phases: 0, sessions: 3, targets: 0 },
      skipped: 0,
      errors: [],
    });

    const merged = applyImport(target, parsed, 'merge', context());
    expect(merged.state.sessions.map((entry) => entry.id)).toEqual(['s2', 'old', 's1', 's0']);
    expect(merged.state.sessions.find((entry) => entry.id === 's1')?.encounters).toBe(7);
    expect(merged.result).toMatchObject({ imported: { sessions: 2 }, skipped: 1, errors: [] });
  });

  it.each(['json', 'csv'] as const)(
    'phases (%s) → merge into the same hunts is a no-op, replace restores them',
    (format) => {
      const source = sampleState();
      const parsed = parseImport(exportOf(source, 'phases', format));
      expect(parsed.phases).toHaveLength(3);

      // Everything is already there: nothing changes and the state object is returned as is.
      const same = applyImport(source, parsed, 'merge', context());
      expect(same.state).toBe(source);
      expect(same.result).toMatchObject({
        dataset: 'phases',
        imported: { hunts: 0, phases: 0 },
        skipped: 3,
        errors: [],
      });

      // Lose the logs, then bring them back from the file.
      const wiped: AppState = {
        ...source,
        hunts: source.hunts.map((entry) => ({ ...entry, phases: [] })),
      };
      for (const mode of ['merge', 'replace'] as const) {
        const { state, result } = applyImport(wiped, parsed, mode, context());
        expect(result).toMatchObject({
          imported: { hunts: 0, phases: 3, sessions: 0, targets: 0 },
          skipped: 0,
          errors: [],
        });
        // Phase rows carry no sprite URL; everything else comes back, awkward text included.
        expect(state.hunts[0]?.phases).toEqual(
          source.hunts[0]?.phases.map((entry) => ({ ...entry, spriteUrl: null })),
        );
        expect(state.hunts[1]?.phases).toEqual(
          source.hunts[1]?.phases.map((entry) => ({ ...entry, spriteUrl: null })),
        );
        expect(state.hunts[0]).toMatchObject({
          count: 12,
          priorCount: 350,
          updatedAt: '2026-10-14T00:00:00.000Z',
        });
        expect(state.hunts[2]).toBe(wiped.hunts[2]);
      }
    },
  );

  it.each(['json', 'csv'] as const)(
    'phases (%s) → replace swaps the log of the hunts in the file only',
    (format) => {
      const source = sampleState();
      const parsed = parseImport(exportOf(source, 'phases', format, ['h1']));
      const target: AppState = {
        ...source,
        hunts: source.hunts.map((entry) => ({
          ...entry,
          phases: [
            phase('local', { timestamp: '2026-10-13T00:00:00.000Z' }),
            ...entry.phases.slice(0, 1),
          ],
        })),
      };
      const replaced = applyImport(target, parsed, 'replace', context());
      expect(replaced.state.hunts[0]?.phases.map((entry) => entry.id)).toEqual(['p1', 'p2']);
      // The sprite of an entry that already existed is kept.
      expect(replaced.state.hunts[0]?.phases[0]?.spriteUrl).toBe('https://example.com/eevee.png');
      expect(replaced.state.hunts[1]).toBe(target.hunts[1]);
      expect(replaced.result.imported).toEqual({ hunts: 0, phases: 2, sessions: 0, targets: 0 });

      const merged = applyImport(target, parsed, 'merge', context());
      // Only the unseen phase is added, and the log stays in chronological order.
      expect(merged.state.hunts[0]?.phases.map((entry) => entry.id)).toEqual(['p1', 'p2', 'local']);
      expect(merged.result).toMatchObject({ imported: { phases: 1 }, skipped: 1 });
    },
  );

  it.each(['json', 'csv'] as const)(
    'phases (%s) → unknown hunts are recreated from their log',
    (format) => {
      const source = sampleState();
      const parsed = parseImport(exportOf(source, 'phases', format));
      const { state, result } = applyImport(emptyState(), parsed, 'merge', context());

      expect(result).toMatchObject({
        imported: { hunts: 2, phases: 3, sessions: 0, targets: 0 },
        skipped: 0,
        errors: [],
      });
      expect(state.hunts.map((entry) => [entry.id, entry.name])).toEqual([
        ['h1', 'Vulpix, "the" hunt'],
        ['h2', 'Finished'],
      ]);
      expect(state.hunts[0]).toMatchObject({
        status: 'active',
        count: 0,
        priorCount: 350,
        target: null,
      });
      expect(state.hunts[0]?.phases.map((entry) => entry.id)).toEqual(['p1', 'p2']);
      expect(state.hunts[1]).toMatchObject({ priorCount: 100 });
      // A second import finds the hunts by id and has nothing left to add.
      expect(applyImport(state, parsed, 'merge', context()).state).toBe(state);
    },
  );

  it.each(['json', 'csv'] as const)(
    'targets (%s) → every setup becomes a zero-progress hunt, in either mode',
    (format) => {
      const source = sampleState();
      const parsed = parseImport(exportOf(source, 'targets', format));
      expect(parsed.targets).toEqual(source.hunts.map(setupOf));

      for (const mode of ['merge', 'replace'] as const) {
        const target: AppState = {
          ...emptyState(),
          hunts: [hunt('keep', { count: 5 })],
          activeHuntId: 'keep',
        };
        const { state, result } = applyImport(target, parsed, mode, context());
        expect(result).toEqual({
          dataset: 'targets',
          imported: { hunts: 3, phases: 0, sessions: 0, targets: 3 },
          skipped: 0,
          errors: [],
        });
        // `replace` never deletes hunts.
        expect(state.hunts[0]).toBe(target.hunts[0]);
        expect(state.activeHuntId).toBe('keep');
        expect(state.hunts.slice(1).map(setupOf)).toEqual(source.hunts.map(setupOf));
        for (const created of state.hunts.slice(1)) {
          expect(created).toMatchObject({
            status: 'active',
            count: 0,
            priorCount: 0,
            phases: [],
            elapsedMs: 0,
            completedAt: null,
            createdAt: '2026-10-14T00:00:00.000Z',
          });
          expect(created.id).toMatch(/^new-\d+$/);
        }

        // Importing the same setups again duplicates nothing.
        const again = applyImport(state, parsed, mode, context());
        expect(again.state).toBe(state);
        expect(again.result).toMatchObject({
          imported: { hunts: 0, targets: 0 },
          skipped: 3,
          errors: [],
        });
      }
    },
  );

  it('does not import a setup that matches an existing hunt (name + target + game + method)', () => {
    const source = sampleState();
    const parsed = parseImport(exportOf(source, 'targets', 'json'));
    const { state, result } = applyImport(source, parsed, 'merge', context());
    expect(state).toBe(source);
    expect(result).toMatchObject({ imported: { targets: 0 }, skipped: 3 });

    // A different method makes it a different hunt.
    const changed: AppState = {
      ...source,
      hunts: source.hunts.map((entry) => ({
        ...entry,
        odds: { ...entry.odds, methodId: 'other' },
      })),
    };
    expect(applyImport(changed, parsed, 'merge', context()).result.imported.targets).toBe(3);
  });

  it('never modifies the state it is given', () => {
    const source = sampleState();
    const snapshot = JSON.stringify(source);
    for (const dataset of ['backup', 'sessions', 'phases', 'targets'] as const) {
      const parsed = parseImport(exportOf(source, dataset, 'json'));
      for (const mode of ['merge', 'replace'] as const) {
        applyImport(source, parsed, mode, context());
        applyImport(emptyState(), parsed, mode, context());
      }
    }
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(() => applyImport(source, parseImport('x'), 'sideways' as never, context())).toThrow(
      /Invalid import mode/,
    );
  });
});

describe('phase rows without ids', () => {
  const csv = toCsv(
    ['huntName', 'speciesName', 'encounters', 'timestamp'],
    [
      ['Hunt h1', 'Rattata', 40, '2026-10-01T10:00:00Z'],
      ['Brand new', 'Pidgey', 10, '2026-10-02 12:00:00Z'],
      ['Brand new', 'Spearow', 25, 'Oct 3, 2026 12:00:00 UTC'],
      ['', 'Orphan', 1, '2026-10-02T12:00:00Z'],
      ['Brand new', 'Bad count', 'lots', '2026-10-02T12:00:00Z'],
      ['Brand new', 'Bad date', 5, 'yesterday-ish'],
    ],
  );

  it('matches hunts by exact name, creates missing ones and reports unusable rows', () => {
    const parsed = parseImport(csv);
    expect(parsed).toMatchObject({ dataset: 'phases', skipped: 3 });
    expect(parsed.errors).toEqual([
      'Row 5: needs a huntId or a huntName',
      'Row 6: encounters: expected number, received NaN',
      'Row 7: timestamp: expected a date and time',
    ]);

    const target: AppState = {
      ...emptyState(),
      hunts: [hunt('h1', { phases: [phase('p1')] })],
      activeHuntId: 'h1',
    };
    const { state, result } = applyImport(target, parsed, 'merge', context());
    expect(result).toMatchObject({ imported: { hunts: 1, phases: 3 }, skipped: 3 });
    expect(result.errors).toHaveLength(3);

    // Chronological order: the imported phase predates the existing one.
    expect(state.hunts[0]?.phases.map((entry) => entry.speciesName)).toEqual(['Rattata', 'Eevee']);
    expect(state.hunts[0]?.phases[0]).toMatchObject({
      encounters: 40,
      totalEncounters: 40,
      speciesId: null,
      spriteUrl: null,
    });
    const created = state.hunts[1];
    expect(created).toMatchObject({ name: 'Brand new', priorCount: 25, count: 0 });
    expect(created?.phases.map((entry) => [entry.speciesName, entry.timestamp])).toEqual([
      ['Pidgey', '2026-10-02T12:00:00.000Z'],
      ['Spearow', '2026-10-03T12:00:00.000Z'],
    ]);
    expect(new Set(state.hunts.flatMap((entry) => entry.phases.map((p) => p.id))).size).toBe(4);
  });

  it('names a hunt that only has an id', () => {
    const bundle = {
      app: 'biolume',
      kind: 'phases',
      schemaVersion: 1,
      exportedAt: '2026-10-13T00:00:00.000Z',
      phases: [
        {
          huntId: 'lost',
          huntName: '',
          targetName: '',
          phaseNumber: 1,
          phaseId: '',
          speciesId: null,
          speciesName: 'X',
          encounters: 3,
          totalEncounters: 3,
          timestamp: '2026-10-01T00:00:00.000Z',
          notes: '',
        },
      ],
    };
    const { state } = applyImport(
      emptyState(),
      parseImport(JSON.stringify(bundle)),
      'merge',
      context(),
    );
    expect(state.hunts[0]).toMatchObject({ id: 'lost', name: IMPORTED_HUNT_NAME });
    expect(state.activeHuntId).toBe('lost');
  });
});

describe('invalid records', () => {
  it('skips invalid records with a readable message and keeps the valid ones', () => {
    const bundle = JSON.parse(exportOf(sampleState(), 'backup', 'json')) as {
      hunts: unknown[];
      sessions: unknown[];
    };
    bundle.hunts.push(
      { id: 'broken', name: 'No counts' },
      'text',
      { ...hunt('h1'), name: 'Duplicate id' },
      { ...hunt('dup-phases'), phases: [phase('same'), phase('same')] },
    );
    bundle.sessions.push({ ...session('bad'), endCount: 'many' }, null);
    const parsed = parseImport(JSON.stringify(bundle));

    expect(parsed.hunts.map((entry) => entry.id)).toEqual(['h1', 'h2', 'h3']);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.rejected).toEqual({ hunts: 4, sessions: 2, phases: 0, targets: 0 });
    expect(parsed.skipped).toBe(6);
    expect(parsed.errors).toHaveLength(6);
    expect(parsed.errors[0]).toMatch(
      /^Hunt 4: status: expected one of active, completed, archived/,
    );
    expect(parsed.errors[1]).toMatch(/^Hunt 5: expected object, received string/);
    expect(parsed.errors[2]).toBe('Hunt 6: duplicate id "h1"');
    expect(parsed.errors[3]).toBe('Hunt 7: phases: duplicate phase id "same"');
    expect(parsed.errors[4]).toBe('Session 4: endCount: expected number, received string');
    expect(parsed.errors[5]).toMatch(/^Session 5: expected object, received null/);
  });

  it('caps the error list at about fifty entries and summarises the rest', () => {
    const rows = Array.from({ length: 200 }, (_, index) => [
      `s-${index}`,
      'h1',
      '2026-10-01T00:00:00Z',
      'x',
      index,
    ]);
    const parsed = parseImport(
      toCsv(['id', 'huntId', 'startedAt', 'startCount', 'endCount'], rows),
    );
    expect(parsed).toMatchObject({ dataset: 'sessions', skipped: 200, suppressedErrors: 150 });
    expect(parsed.errors).toHaveLength(50);

    const { state, result } = applyImport(sampleState(), parsed, 'merge', context());
    expect(result.skipped).toBe(200);
    expect(result.errors).toHaveLength(51);
    expect(result.errors[50]).toBe('…and 150 more problems.');
    expect(result.imported.sessions).toBe(0);
    expect(state.sessions).toHaveLength(3);
  });

  it('keeps error messages short even for absurd input', () => {
    const parsed = parseImport(
      JSON.stringify({ app: 'biolume', kind: 'sessions', sessions: [{ id: 'x'.repeat(100_000) }] }),
    );
    expect(parsed.errors[0]?.length).toBeLessThanOrEqual(240);
    expect(parsed.errors[0]).not.toContain('xxxxxxxx');
  });

  it('never lets a replace wipe data because every record was invalid', () => {
    const state = sampleState();
    const sessions = parseImport(
      JSON.stringify({ app: 'biolume', kind: 'sessions', sessions: [{ id: 1 }, { id: 2 }] }),
    );
    const outcome = applyImport(state, sessions, 'replace', context());
    expect(outcome.state).toBe(state);
    expect(outcome.result).toMatchObject({ imported: { sessions: 0 }, skipped: 2 });
    expect(outcome.result.errors.at(-1)).toMatch(
      /No valid sessions were found .* existing sessions were kept/,
    );

    const backup = parseImport(
      JSON.stringify({ app: 'biolume', kind: 'backup', hunts: ['x'], sessions: [] }),
    );
    const restored = applyImport(state, backup, 'replace', context());
    expect(restored.state.hunts).toBe(state.hunts);
    // The session list in the file was genuinely empty, so that part of the replace goes ahead.
    expect(restored.state.sessions).toEqual([]);
  });

  it('a genuinely empty export replaces with an empty list', () => {
    const state = sampleState();
    const parsed = parseImport(exportOf(emptyState(), 'sessions', 'json'));
    expect(applyImport(state, parsed, 'replace', context()).state.sessions).toEqual([]);
    expect(applyImport(state, parsed, 'merge', context()).state).toBe(state);
  });

  it('rejects a target row whose inputs are not valid JSON', () => {
    const parsed = parseImport(
      toCsv(['name', 'gameId', 'methodId', 'inputs'], [['A', 'sv', 'full-odds', '{oops']]),
    );
    expect(parsed.targets).toEqual([]);
    expect(parsed.errors[0]).toMatch(/^Row 2: odds\.inputs: expected record/);
  });
});

describe('hostile input', () => {
  it('cannot pollute prototypes through __proto__ or constructor keys', () => {
    const content = `{
      "app": "biolume", "kind": "backup", "schemaVersion": 1,
      "__proto__": { "polluted": "bundle" },
      "hunts": [{
        "__proto__": { "polluted": "hunt" },
        "constructor": { "prototype": { "polluted": "ctor" } },
        "id": "evil", "name": "Evil", "status": "active", "target": null, "targetLevel": 5,
        "odds": {
          "gameId": "sv", "methodId": "full-odds", "shinyCharm": false,
          "inputs": { "__proto__": { "polluted": "inputs" }, "constructor": "x", "prototype": 1, "chain": 3 }
        },
        "count": 1, "priorCount": 0, "step": 1,
        "phases": [{
          "__proto__": { "polluted": "phase" },
          "id": "p", "speciesId": null, "speciesName": "", "spriteUrl": null,
          "encounters": 0, "totalEncounters": 0, "timestamp": "2026-10-01T00:00:00.000Z", "notes": ""
        }],
        "notes": "", "createdAt": "2026-10-01T00:00:00.000Z", "updatedAt": "2026-10-01T00:00:00.000Z",
        "completedAt": null, "elapsedMs": 0, "isAdmin": true
      }],
      "sessions": [],
      "settings": { "__proto__": { "polluted": "settings" }, "audio": { "__proto__": { "polluted": "audio" }, "volume": 0.4 } }
    }`;
    const parsed = parseImport(content);
    expect(parsed).toMatchObject({ dataset: 'backup', skipped: 0, errors: [] });
    const { state } = applyImport(emptyState(), parsed, 'replace', context());

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const evil = state.hunts[0];
    expect(evil).toBeDefined();
    for (const value of [
      state,
      state.settings,
      state.settings.audio,
      evil,
      evil?.odds,
      evil?.odds.inputs,
      evil?.phases[0],
    ]) {
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(value).not.toHaveProperty('polluted');
    }
    expect(evil).not.toHaveProperty('isAdmin');
    expect(Object.keys(evil ?? {}).sort()).toEqual(Object.keys(hunt('x')).sort());
    expect(evil?.odds.inputs).toEqual({ chain: 3 });
    expect(Object.keys(evil?.odds.inputs ?? {})).toEqual(['chain']);
    expect(state.settings.audio.volume).toBe(0.4);
  });

  it('clamps numbers and caps string lengths', () => {
    const bundle = {
      app: 'biolume',
      kind: 'backup',
      hunts: [
        hunt('big', {
          name: 'n'.repeat(5_000),
          notes: 'x'.repeat(50_000),
          count: 1e300,
          priorCount: -5,
          step: 1e9,
          targetLevel: -3,
          elapsedMs: 1e300,
          odds: {
            gameId: 'sv',
            methodId: 'full-odds',
            shinyCharm: false,
            inputs: Object.fromEntries(
              Array.from({ length: 500 }, (_, index) => [`k${index}`, 's'.repeat(5_000)]),
            ),
          },
          phases: [
            phase('p', {
              encounters: 1e300,
              totalEncounters: -1,
              speciesName: 'y'.repeat(5_000),
              notes: 'z'.repeat(50_000),
            }),
          ],
        }),
      ],
      sessions: [
        session('s', {
          startCount: -10,
          endCount: 1e300,
          encounters: 1e300,
          phasesLogged: 1e300,
          huntName: 'h'.repeat(5_000),
        }),
      ],
    };
    const parsed = parseImport(JSON.stringify(bundle));
    expect(parsed.errors).toEqual([]);
    const [big] = parsed.hunts;

    expect(big?.name).toHaveLength(LIMITS.huntName);
    expect(big?.notes).toHaveLength(LIMITS.notes);
    expect(big).toMatchObject({
      count: LIMITS.count.max,
      priorCount: 0,
      step: LIMITS.step.max,
      targetLevel: LIMITS.targetLevel.min,
      elapsedMs: BOUNDS.elapsedMs,
    });
    expect(Object.keys(big?.odds.inputs ?? {})).toHaveLength(BOUNDS.oddsInputs);
    expect(String(big?.odds.inputs['k0'])).toHaveLength(BOUNDS.oddsInputText);
    expect(big?.phases[0]).toMatchObject({
      encounters: LIMITS.count.max,
      totalEncounters: LIMITS.count.max,
    });
    expect(big?.phases[0]?.speciesName).toHaveLength(LIMITS.huntName);
    expect(big?.phases[0]?.notes).toHaveLength(LIMITS.notes);
    expect(parsed.sessions[0]).toMatchObject({
      startCount: 0,
      endCount: BOUNDS.total,
      phasesLogged: BOUNDS.phasesPerHunt,
    });
    expect(parsed.sessions[0]?.huntName).toHaveLength(LIMITS.huntName);
    for (const value of [big?.count, big?.elapsedMs, parsed.sessions[0]?.endCount]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it('only accepts https sprite URLs', () => {
    const urls = [
      'http://example.com/a.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'file:///C:/Windows/win.ini',
      '//example.com/a.png',
      'https://user:pass@example.com/a.png',
      `https://example.com/${'a'.repeat(5_000)}`,
      42,
      { href: 'https://example.com' },
    ];
    const bundle = {
      app: 'biolume',
      kind: 'backup',
      hunts: urls.map((url, index) => ({
        ...hunt(`u${index}`),
        target: { ...VULPIX, spriteUrl: url, shinySpriteUrl: url },
        phases: [{ ...phase('p'), spriteUrl: url }],
      })),
      sessions: [],
    };
    const parsed = parseImport(JSON.stringify(bundle));
    expect(parsed.hunts).toHaveLength(urls.length);
    for (const entry of parsed.hunts) {
      expect(entry.target).toMatchObject({
        slug: 'vulpix-alola',
        spriteUrl: null,
        shinySpriteUrl: null,
      });
      expect(entry.phases[0]?.spriteUrl).toBeNull();
    }

    const csv = toCsv(
      [
        'name',
        'gameId',
        'methodId',
        'slug',
        'speciesId',
        'targetName',
        'spriteUrl',
        'shinySpriteUrl',
      ],
      [
        [
          'A',
          'sv',
          'full-odds',
          'pikachu',
          25,
          'Pikachu',
          'http://example.com/a.png',
          'https://example.com/ok.png',
        ],
      ],
    );
    expect(parseImport(csv).targets[0]?.target).toMatchObject({
      spriteUrl: null,
      shinySpriteUrl: 'https://example.com/ok.png',
    });
  });

  it('rejects ids and slugs that could be used for path or key tricks', () => {
    const bundle = {
      app: 'biolume',
      kind: 'backup',
      hunts: [
        hunt('__proto__'),
        hunt('constructor'),
        hunt('../../etc/passwd'),
        hunt('has space'),
        hunt('x'.repeat(65)),
        hunt(''),
        { ...hunt('slug'), target: { ...VULPIX, slug: 'Vulpix/../../x' } },
        {
          ...hunt('game'),
          odds: { gameId: '<script>', methodId: 'full-odds', shinyCharm: false, inputs: {} },
        },
      ],
      sessions: [session('__proto__'), session('ok', { huntId: 'a b' })],
    };
    const parsed = parseImport(JSON.stringify(bundle));
    expect(parsed.hunts).toEqual([]);
    expect(parsed.sessions).toEqual([]);
    expect(parsed.skipped).toBe(10);
  });

  it('strips control characters from names and normalises line breaks in notes', () => {
    const bundle = {
      app: 'biolume',
      kind: 'backup',
      hunts: [
        hunt('ctl', {
          name: 'A\u0000B\u001b[31mC\r\nD',
          notes: 'one\r\ntwo\rthree\u0000\u0007\tend',
        }),
      ],
      sessions: [],
    };
    const [clean] = parseImport(JSON.stringify(bundle)).hunts;
    expect(clean?.name).toBe('A B [31mC D');
    expect(clean?.notes).toBe('one\ntwo\nthree\tend');
  });

  it('treats non-finite and wrongly typed numbers as invalid rather than guessing', () => {
    const content = `{"app":"biolume","kind":"sessions","sessions":[
      ${JSON.stringify(session('a')).replace('"endCount":50', '"endCount":1e999')},
      ${JSON.stringify(session('b')).replace('"startCount":0', '"startCount":"0"')},
      ${JSON.stringify(session('c')).replace('"startCount":0', '"startCount":null')},
      ${JSON.stringify(session('d'))}
    ]}`;
    const parsed = parseImport(content);
    expect(parsed.sessions.map((entry) => entry.id)).toEqual(['d']);
    expect(parsed.skipped).toBe(3);
  });

  it('survives deeply nested and oddly shaped JSON', () => {
    const deep = `${'['.repeat(50_000)}${']'.repeat(50_000)}`;
    expect(() => parseImport(`{"app":"biolume","kind":"targets","targets":${deep}}`)).not.toThrow();
    expect(() => parseImport(deep)).not.toThrow();
    const odd = parseImport(
      '{"app":"biolume","kind":"targets","targets":[[],{},null,1,"x",{"name":{},"odds":[]}]}',
    );
    expect(odd).toMatchObject({ dataset: 'targets', targets: [], skipped: 6 });
  });

  it('round-trips formula-looking text without leaving it executable in the CSV', () => {
    const state: AppState = {
      ...emptyState(),
      hunts: [
        hunt('f', {
          name: '=HYPERLINK("http://evil","click")',
          notes: "'=already quoted\n+second",
          phases: [phase('p', { speciesName: '@SUM(1+1)', notes: '-2+3' })],
        }),
      ],
    };
    const targets = exportOf(state, 'targets', 'csv');
    const phases = exportOf(state, 'phases', 'csv');
    for (const csv of [targets, phases]) {
      for (const record of parseCsv(csv).slice(1)) {
        for (const cell of record) expect(cell).not.toMatch(/^[=+\-@]/);
      }
    }
    expect(parseImport(targets).targets[0]).toMatchObject({
      name: '=HYPERLINK("http://evil","click")',
      notes: "'=already quoted\n+second",
    });
    expect(parseImport(phases).phases[0]).toMatchObject({
      speciesName: '@SUM(1+1)',
      notes: '-2+3',
      huntName: '=HYPERLINK("http://evil","click")',
    });
  });

  it('enforces the hunt limit on import', () => {
    const many = Array.from({ length: BOUNDS.hunts + 10 }, (_, index) => ({
      name: `T${index}`,
      gameId: 'sv',
      methodId: 'full-odds',
    }));
    const csv = toCsv(
      ['name', 'gameId', 'methodId'],
      many.map((row) => [row.name, row.gameId, row.methodId]),
    );
    const parsed = parseImport(csv);
    expect(parsed.targets).toHaveLength(BOUNDS.hunts);
    expect(parsed.skipped).toBe(10);

    const { state, result } = applyImport(
      { ...emptyState(), hunts: [hunt('existing')] },
      parsed,
      'merge',
      context(),
    );
    expect(state.hunts).toHaveLength(BOUNDS.hunts);
    expect(result.imported.targets).toBe(BOUNDS.hunts - 1);
    expect(result.skipped).toBe(11);
    expect(result.errors.at(-1)).toMatch(/limit of 2000 hunts/);
  });

  it('caps imported sessions at the session limit, keeping the newest', () => {
    const rows = Array.from({ length: LIMITS.sessions + 50 }, (_, index) =>
      session(`s-${index}`, {
        startedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        endedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      }),
    );
    const existing = rows.slice(0, 100);
    const incoming = parseImport(
      JSON.stringify({
        app: 'biolume',
        kind: 'sessions',
        sessions: rows.slice(100, LIMITS.sessions + 50),
      }),
    );
    const { state, result } = applyImport(
      { ...emptyState(), sessions: existing },
      incoming,
      'merge',
      context(),
    );
    expect(state.sessions).toHaveLength(LIMITS.sessions);
    expect(state.sessions[0]?.id).toBe(`s-${LIMITS.sessions + 49}`);
    expect(result.imported.sessions).toBe(LIMITS.sessions - 50);
  });
});
