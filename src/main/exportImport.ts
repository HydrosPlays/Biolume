/**
 * Export and import of session history, phase logs, target setups and full
 * backups — pure functions; the shell adds the dialogs and the file IO.
 *
 * Imported content is hostile until proven otherwise: it is size-limited, every
 * record goes through a strict zod schema that rebuilds it field by field, and
 * nothing from the file is ever spread into application state.
 */
import {
  DEFAULT_GAME_ID,
  DEFAULT_TARGET_LEVEL,
  FULL_ODDS_METHOD_ID,
  LIMITS,
} from '@shared/defaults';
import {
  SCHEMA_VERSION,
  type AppState,
  type ExportBundle,
  type ExportDataset,
  type ExportRequest,
  type Hunt,
  type ImportResult,
  type OddsSelection,
  type PhaseEntry,
  type PhaseExportRow,
  type SessionRecord,
  type Settings,
  type TargetRef,
  type TargetSetup,
} from '@shared/types';
import type { z } from 'zod';
import { parseCsv, toCsv, unguardFormula, type CsvValue } from './csv';
import { mergeSessions } from './sessions';
import { createHuntRecord } from './store';
import {
  BOUNDS,
  describeIssues,
  inputSchemas,
  isExportDataset,
  isRecord,
  isValidId,
  migrateDocument,
  parseInput,
  pickFallbackActiveHunt,
  recordSchemas,
  resolveActiveHuntId,
  resolveHuntName,
  sanitizeSettings,
  sortSessions,
  truncate,
} from './validation';

// ───────────────────────────── Shared ─────────────────────────────

/** Largest import the app accepts. The shell should check the file size before reading it. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Individual problems kept for display; the rest is summarised in one closing line. */
const MAX_ERRORS = 50;
const MAX_ERROR_LENGTH = 240;

/** Name of a hunt created for phase rows that carry an id but no hunt name. */
export const IMPORTED_HUNT_NAME = 'Imported hunt';

export const SESSION_COLUMNS: readonly (keyof SessionRecord)[] = [
  'id',
  'huntId',
  'huntName',
  'targetName',
  'gameId',
  'methodId',
  'startedAt',
  'endedAt',
  'startCount',
  'endCount',
  'encounters',
  'phasesLogged',
];

export const PHASE_COLUMNS: readonly (keyof PhaseExportRow)[] = [
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
];

export const TARGET_COLUMNS = [
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
] as const;

/** Columns a CSV header must contain to be recognised as a dataset (matched case-insensitively). */
const CSV_SIGNATURES: readonly {
  dataset: Exclude<ExportDataset, 'backup'>;
  required: readonly string[];
}[] = [
  { dataset: 'sessions', required: ['id', 'huntId', 'startedAt', 'startCount', 'endCount'] },
  { dataset: 'phases', required: ['huntName', 'speciesName', 'encounters', 'timestamp'] },
  { dataset: 'targets', required: ['name', 'gameId', 'methodId'] },
];

// ───────────────────────────── Export ─────────────────────────────

export interface BuiltExport {
  /** Complete file content (CSV content starts with a UTF-8 BOM). */
  content: string;
  /** Rows / records in the file. A backup counts hunts plus sessions. */
  records: number;
  /** `biolume-<dataset>-YYYYMMDD-HHmm.<ext>`, in local time. */
  defaultFileName: string;
  extension: 'json' | 'csv';
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function fileNameStamp(at: Date): string {
  return (
    `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`
  );
}

function toPhaseRows(hunts: readonly Hunt[]): PhaseExportRow[] {
  return hunts.flatMap((hunt) =>
    hunt.phases.map((phase, index) => ({
      huntId: hunt.id,
      huntName: hunt.name,
      targetName: hunt.target?.name ?? '',
      phaseNumber: index + 1,
      phaseId: phase.id,
      speciesId: phase.speciesId,
      speciesName: phase.speciesName,
      encounters: phase.encounters,
      totalEncounters: phase.totalEncounters,
      timestamp: phase.timestamp,
      notes: phase.notes,
    })),
  );
}

function toTargetSetups(hunts: readonly Hunt[]): TargetSetup[] {
  return hunts.map((hunt) => ({
    name: hunt.name,
    target: hunt.target,
    targetLevel: hunt.targetLevel,
    odds: hunt.odds,
    step: hunt.step,
    notes: hunt.notes,
  }));
}

function targetSetupCells(setup: TargetSetup): Record<(typeof TARGET_COLUMNS)[number], CsvValue> {
  const { target, odds } = setup;
  return {
    name: setup.name,
    targetName: target?.name ?? '',
    speciesId: target?.speciesId ?? null,
    pokemonId: target?.pokemonId ?? null,
    slug: target?.slug ?? '',
    types: target?.types.join('|') ?? '',
    targetLevel: setup.targetLevel,
    gameId: odds.gameId,
    methodId: odds.methodId,
    shinyCharm: odds.shinyCharm,
    inputs: JSON.stringify(odds.inputs),
    step: setup.step,
    notes: setup.notes,
    spriteUrl: target?.spriteUrl ?? null,
    shinySpriteUrl: target?.shinySpriteUrl ?? null,
  };
}

/**
 * Serialises the requested dataset. Throws an Error for an invalid request and
 * for `backup` + `csv` (a backup spans several record types and is JSON-only).
 */
export function buildExport(state: AppState, request: ExportRequest, now: Date): BuiltExport {
  const { dataset, format, huntIds } = parseInput(
    inputSchemas.exportRequest,
    request,
    'export request',
  );
  if (dataset === 'backup' && format === 'csv') {
    throw new Error(
      'A backup can only be exported as JSON — CSV cannot hold hunts, sessions and settings together.',
    );
  }

  const wanted = huntIds === undefined ? null : new Set(huntIds);
  const hunts = wanted === null ? state.hunts : state.hunts.filter((hunt) => wanted.has(hunt.id));
  const sessions =
    wanted === null
      ? state.sessions
      : state.sessions.filter((session) => wanted.has(session.huntId));

  const at = Number.isNaN(now.getTime()) ? new Date() : now;
  const envelope = {
    app: 'biolume',
    kind: dataset,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: at.toISOString(),
  } as const;
  let bundle: ExportBundle;
  let csv: string;
  let records: number;

  switch (dataset) {
    case 'backup':
      bundle = { ...envelope, hunts, sessions, settings: state.settings };
      csv = '';
      records = hunts.length + sessions.length;
      break;
    case 'sessions':
      bundle = { ...envelope, sessions };
      csv = toCsv(
        SESSION_COLUMNS,
        sessions.map((session) => SESSION_COLUMNS.map((column) => session[column])),
      );
      records = sessions.length;
      break;
    case 'phases': {
      const rows = toPhaseRows(hunts);
      bundle = { ...envelope, phases: rows };
      csv = toCsv(
        PHASE_COLUMNS,
        rows.map((row) => PHASE_COLUMNS.map((column) => row[column])),
      );
      records = rows.length;
      break;
    }
    case 'targets': {
      const setups = toTargetSetups(hunts);
      bundle = { ...envelope, targets: setups };
      csv = toCsv(
        TARGET_COLUMNS,
        setups.map((setup) => {
          const cells = targetSetupCells(setup);
          return TARGET_COLUMNS.map((column) => cells[column]);
        }),
      );
      records = setups.length;
      break;
    }
  }

  return {
    content: format === 'json' ? `${JSON.stringify(bundle, null, 2)}\n` : csv,
    records,
    defaultFileName: `biolume-${dataset}-${fileNameStamp(at)}.${format}`,
    extension: format,
  };
}

// ───────────────────────────── Parsing ─────────────────────────────

type RecordCounts = { hunts: number; sessions: number; phases: number; targets: number };

export interface ParsedImport {
  /** Detected dataset; null when the content is unusable — `applyImport` then changes nothing. */
  dataset: ExportDataset | null;
  format: 'json' | 'csv' | null;
  /** Valid records, already rebuilt and clamped. Only the lists of `dataset` are filled. */
  hunts: Hunt[];
  sessions: SessionRecord[];
  phases: PhaseExportRow[];
  targets: TargetSetup[];
  /** Settings of a backup, sanitised; null when the file carries none. */
  settings: Settings | null;
  /** Records per list that failed validation — a `replace` never swaps in an all-invalid list. */
  rejected: RecordCounts;
  /** Total records left out so far (invalid or duplicated inside the file). */
  skipped: number;
  /** One readable line per problem, at most 50. */
  errors: string[];
  /** Problems beyond the ones listed in `errors`. */
  suppressedErrors: number;
}

class ProblemLog {
  readonly messages: string[];
  suppressed: number;
  skipped: number;

  constructor(messages: readonly string[] = [], suppressed = 0, skipped = 0) {
    this.messages = [...messages];
    this.suppressed = suppressed;
    this.skipped = skipped;
  }

  /** Records a problem that did not cost a record (or whose records are counted separately). */
  note(message: string): void {
    if (this.messages.length < MAX_ERRORS) this.messages.push(truncate(message, MAX_ERROR_LENGTH));
    else this.suppressed += 1;
  }

  /** Records `count` records left out for one reason. */
  skip(message: string, count = 1): void {
    this.skipped += count;
    this.note(message);
  }

  /** The capped list plus a closing summary line when problems were suppressed. */
  finalMessages(): string[] {
    if (this.suppressed === 0) return [...this.messages];
    return [
      ...this.messages,
      `…and ${this.suppressed} more problem${this.suppressed === 1 ? '' : 's'}.`,
    ];
  }
}

function emptyCounts(): RecordCounts {
  return { hunts: 0, sessions: 0, phases: 0, targets: 0 };
}

function buildParsed(partial: Partial<ParsedImport>, log: ProblemLog): ParsedImport {
  return {
    dataset: null,
    format: null,
    hunts: [],
    sessions: [],
    phases: [],
    targets: [],
    settings: null,
    rejected: emptyCounts(),
    ...partial,
    skipped: log.skipped,
    errors: [...log.messages],
    suppressedErrors: log.suppressed,
  };
}

function unusable(message: string, format: ParsedImport['format'] = null): ParsedImport {
  const log = new ProblemLog();
  log.note(message);
  return buildParsed({ format }, log);
}

interface ListResult<T> {
  items: T[];
  rejected: number;
}

/** Validates each entry on its own so that one bad record does not sink the file. */
function validateList<T>(
  entries: readonly unknown[],
  schema: z.ZodType<T>,
  label: (index: number) => string,
  log: ProblemLog,
  max: number,
  idOf?: (item: T) => string,
): ListResult<T> {
  const items: T[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (items.length >= max) {
      const rest = entries.length - index;
      rejected += rest;
      log.skip(`Only the first ${max} records are read; ${rest} more were ignored.`, rest);
      break;
    }
    const parsed = schema.safeParse(entries[index]);
    if (!parsed.success) {
      rejected += 1;
      log.skip(`${label(index)}: ${describeIssues(parsed.error)}`);
      continue;
    }
    const id = idOf?.(parsed.data);
    if (id !== undefined && id !== '') {
      if (seen.has(id)) {
        rejected += 1;
        log.skip(`${label(index)}: duplicate id "${id}"`);
        continue;
      }
      seen.add(id);
    }
    items.push(parsed.data);
  }
  return { items, rejected };
}

function parseJsonImport(text: string): ParsedImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unusable('The file is not valid JSON.', 'json');
  }
  if (!isRecord(raw) || raw['app'] !== 'biolume')
    return unusable('This JSON file is not a Biolume export.', 'json');
  const kind = raw['kind'];
  if (!isExportDataset(kind)) return unusable('This Biolume export has an unknown kind.', 'json');
  const version = raw['schemaVersion'];
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    return unusable(
      `This file was exported by a newer Biolume (schema v${truncate(String(version), 12)}). Update Biolume to import it.`,
      'json',
    );
  }
  const schemaVersion = typeof version === 'number' ? version : SCHEMA_VERSION;

  const log = new ProblemLog();
  const rejected = emptyCounts();
  const missing = (list: string): ParsedImport =>
    unusable(`This ${kind} export is damaged: it has no "${list}" list.`, 'json');

  switch (kind) {
    case 'backup': {
      // Bundles reuse the persisted record shapes, so they go through the same upgrade path.
      const huntsDoc = migrateDocument('hunts', { schemaVersion, hunts: raw['hunts'] }).doc;
      const sessionsDoc = migrateDocument('sessions', {
        schemaVersion,
        sessions: raw['sessions'],
      }).doc;
      const rawHunts = huntsDoc['hunts'];
      const rawSessions = sessionsDoc['sessions'];
      if (!Array.isArray(rawHunts)) return missing('hunts');
      if (!Array.isArray(rawSessions)) return missing('sessions');
      const hunts = validateList(
        rawHunts,
        recordSchemas.hunt,
        (i) => `Hunt ${i + 1}`,
        log,
        BOUNDS.hunts,
        (h) => h.id,
      );
      const sessions = validateList(
        rawSessions,
        recordSchemas.session,
        (i) => `Session ${i + 1}`,
        log,
        LIMITS.sessions,
        (s) => s.id,
      );
      rejected.hunts = hunts.rejected;
      rejected.sessions = sessions.rejected;
      const rawSettings = raw['settings'];
      const settings = isRecord(rawSettings)
        ? sanitizeSettings(
            migrateDocument('settings', pickSettingsSections(rawSettings, schemaVersion)).doc,
          )
        : null;
      return buildParsed(
        {
          dataset: kind,
          format: 'json',
          hunts: hunts.items,
          sessions: sortSessions(sessions.items),
          settings,
          rejected,
        },
        log,
      );
    }
    case 'sessions': {
      const list = raw['sessions'];
      if (!Array.isArray(list)) return missing('sessions');
      const sessions = validateList(
        list,
        recordSchemas.session,
        (i) => `Session ${i + 1}`,
        log,
        LIMITS.sessions,
        (s) => s.id,
      );
      rejected.sessions = sessions.rejected;
      return buildParsed(
        { dataset: kind, format: 'json', sessions: sortSessions(sessions.items), rejected },
        log,
      );
    }
    case 'phases': {
      const list = raw['phases'];
      if (!Array.isArray(list)) return missing('phases');
      const phases = validateList(
        list,
        recordSchemas.phaseRow,
        (i) => `Phase ${i + 1}`,
        log,
        BOUNDS.hunts * BOUNDS.phasesPerHunt,
      );
      rejected.phases = phases.rejected;
      return buildParsed({ dataset: kind, format: 'json', phases: phases.items, rejected }, log);
    }
    case 'targets': {
      const list = raw['targets'];
      if (!Array.isArray(list)) return missing('targets');
      const targets = validateList(
        list,
        recordSchemas.targetSetup,
        (i) => `Target ${i + 1}`,
        log,
        BOUNDS.hunts,
      );
      rejected.targets = targets.rejected;
      return buildParsed({ dataset: kind, format: 'json', targets: targets.items, rejected }, log);
    }
  }
}

/** Only the known sections are handed on — the rest of the untrusted object is left behind. */
function pickSettingsSections(
  raw: Record<string, unknown>,
  schemaVersion: number,
): Record<string, unknown> {
  return {
    schemaVersion,
    hotkeys: raw['hotkeys'],
    audio: raw['audio'],
    overlay: raw['overlay'],
    general: raw['general'],
    streamDeck: raw['streamDeck'],
  };
}

const NUMERIC_CELL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const TRUE_CELLS: ReadonlySet<string> = new Set(['true', '1', 'yes', 'y']);
const FALSE_CELLS: ReadonlySet<string> = new Set(['false', '0', 'no', 'n', '']);

/** Typed access to the cells of one CSV record, by column name. */
class RowReader {
  constructor(
    private readonly columns: ReadonlyMap<string, number>,
    private readonly cells: readonly string[],
  ) {}

  /** The cell with its formula guard removed; undefined when the file has no such column. */
  text(column: string): string | undefined {
    const index = this.columns.get(column.toLowerCase());
    return index === undefined ? undefined : unguardFormula(this.cells[index] ?? '');
  }

  trimmed(column: string): string | undefined {
    return this.text(column)?.trim();
  }

  /** undefined for a missing or empty cell, NaN for text that is not a number (fails validation). */
  number(column: string): number | undefined {
    const cell = this.trimmed(column);
    if (cell === undefined || cell === '') return undefined;
    return NUMERIC_CELL.test(cell) ? Number(cell) : Number.NaN;
  }

  /** Spreadsheets rewrite booleans as TRUE / FALSE; unrecognised text is passed on to fail validation. */
  boolean(column: string): boolean | string | undefined {
    const cell = this.trimmed(column);
    if (cell === undefined) return undefined;
    const key = cell.toLowerCase();
    if (TRUE_CELLS.has(key)) return true;
    if (FALSE_CELLS.has(key)) return false;
    return cell;
  }
}

function sessionCandidate(row: RowReader): unknown {
  const startCount = row.number('startCount');
  const endCount = row.number('endCount');
  // Without an encounters column the net change stands in. A bad count is reported once, on its own column.
  const derived =
    startCount !== undefined &&
    endCount !== undefined &&
    Number.isFinite(startCount) &&
    Number.isFinite(endCount)
      ? Math.max(0, endCount - startCount)
      : 0;
  const startedAt = row.trimmed('startedAt') ?? '';
  return {
    id: row.trimmed('id') ?? '',
    huntId: row.trimmed('huntId') ?? '',
    huntName: row.text('huntName') ?? '',
    targetName: row.trimmed('targetName') || null,
    gameId: row.trimmed('gameId') || DEFAULT_GAME_ID,
    methodId: row.trimmed('methodId') || FULL_ODDS_METHOD_ID,
    startedAt,
    endedAt: row.trimmed('endedAt') || startedAt,
    startCount,
    endCount,
    encounters: row.number('encounters') ?? derived,
    phasesLogged: row.number('phasesLogged') ?? 0,
  };
}

function phaseCandidate(row: RowReader, index: number): unknown {
  const encounters = row.number('encounters');
  return {
    huntId: row.trimmed('huntId') ?? '',
    huntName: row.text('huntName') ?? '',
    targetName: row.text('targetName') ?? '',
    phaseNumber: row.number('phaseNumber') ?? index + 1,
    phaseId: row.trimmed('phaseId') ?? '',
    speciesId: row.number('speciesId') ?? null,
    speciesName: row.text('speciesName') ?? '',
    encounters,
    // A missing total is raised to at least the phase's own encounters by validation.
    totalEncounters:
      row.number('totalEncounters') ??
      (encounters !== undefined && Number.isFinite(encounters) ? encounters : 0),
    timestamp: row.trimmed('timestamp') ?? '',
    notes: row.text('notes') ?? '',
  };
}

function targetCandidate(row: RowReader): unknown {
  const slug = row.trimmed('slug') ?? '';
  const speciesId = row.number('speciesId');
  const inputsCell = row.trimmed('inputs') ?? '';
  let inputs: unknown = {};
  if (inputsCell !== '') {
    try {
      inputs = JSON.parse(inputsCell);
    } catch {
      // Left as text so that validation rejects the row with a message naming the column.
      inputs = inputsCell;
    }
  }
  const hasTarget = slug !== '' || speciesId !== undefined;
  return {
    name: row.text('name') ?? '',
    target: hasTarget
      ? {
          speciesId,
          pokemonId: row.number('pokemonId') ?? speciesId,
          slug,
          name: row.trimmed('targetName') || slug,
          types: (row.trimmed('types') ?? '').split('|'),
          spriteUrl: row.trimmed('spriteUrl') ?? null,
          shinySpriteUrl: row.trimmed('shinySpriteUrl') ?? null,
        }
      : null,
    targetLevel: row.number('targetLevel') ?? DEFAULT_TARGET_LEVEL,
    odds: {
      gameId: row.trimmed('gameId') || DEFAULT_GAME_ID,
      methodId: row.trimmed('methodId') || FULL_ODDS_METHOD_ID,
      shinyCharm: row.boolean('shinyCharm') ?? false,
      inputs,
    },
    step: row.number('step') ?? 1,
    notes: row.text('notes') ?? '',
  };
}

function parseCsvImport(text: string): ParsedImport {
  const records = parseCsv(text);
  const header = records[0];
  if (header === undefined) return unusable('The file is empty.', 'csv');

  const columns = new Map<string, number>();
  header.forEach((name, index) => {
    const key = name.trim().toLowerCase();
    if (key !== '' && !columns.has(key)) columns.set(key, index);
  });
  const signature = CSV_SIGNATURES.find((entry) =>
    entry.required.every((name) => columns.has(name.toLowerCase())),
  );
  if (signature === undefined) {
    return unusable(
      'The file is not a Biolume export: its first row does not match a sessions, phases or targets table.',
      'csv',
    );
  }

  const { dataset } = signature;
  const log = new ProblemLog();
  const rejected = emptyCounts();
  const rows = records.slice(1).map((cells) => new RowReader(columns, cells));
  // The header is row 1, as a spreadsheet shows it.
  const label = (index: number): string => `Row ${index + 2}`;

  switch (dataset) {
    case 'sessions': {
      const sessions = validateList(
        rows.map(sessionCandidate),
        recordSchemas.session,
        label,
        log,
        LIMITS.sessions,
        (s) => s.id,
      );
      rejected.sessions = sessions.rejected;
      return buildParsed(
        { dataset, format: 'csv', sessions: sortSessions(sessions.items), rejected },
        log,
      );
    }
    case 'phases': {
      const phases = validateList(
        rows.map(phaseCandidate),
        recordSchemas.phaseRow,
        label,
        log,
        BOUNDS.hunts * BOUNDS.phasesPerHunt,
      );
      rejected.phases = phases.rejected;
      return buildParsed({ dataset, format: 'csv', phases: phases.items, rejected }, log);
    }
    case 'targets': {
      const targets = validateList(
        rows.map(targetCandidate),
        recordSchemas.targetSetup,
        label,
        log,
        BOUNDS.hunts,
      );
      rejected.targets = targets.rejected;
      return buildParsed({ dataset, format: 'csv', targets: targets.items, rejected }, log);
    }
  }
}

/**
 * Detects and validates an import: a JSON {@link ExportBundle} (`app === 'biolume'`)
 * or a CSV recognised by its header row. Never throws; an unusable file comes
 * back with `dataset: null` and the reason in `errors`.
 */
export function parseImport(content: string): ParsedImport {
  if (typeof content !== 'string') return unusable('The file could not be read as text.');
  if (content.length > MAX_IMPORT_BYTES) {
    return unusable(
      `The file is too large to import (the limit is ${MAX_IMPORT_BYTES / (1024 * 1024)} MB).`,
    );
  }
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const firstChar = /\S/.exec(text)?.[0];
  if (firstChar === undefined) return unusable('The file is empty.');
  return firstChar === '{' || firstChar === '[' ? parseJsonImport(text) : parseCsvImport(text);
}

// ───────────────────────────── Applying ─────────────────────────────

export interface ImportContext {
  /** Timestamp for hunts the import creates or touches. */
  now: Date;
  /** Ids for created hunts and for phases that arrive without one. */
  idGenerator: () => string;
}

export type ImportOutcome = Omit<ImportResult, 'canceled' | 'filePath'>;

function uniqueId(taken: ReadonlySet<string>, generate: () => string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = generate();
    if (isValidId(id) && !taken.has(id)) return id;
  }
  throw new Error(
    'Could not generate a unique id — the id generator keeps returning invalid or used ids',
  );
}

/** Identity of a target setup: the same name, target, game and method is the same hunt. */
function setupSignature(name: string, target: TargetRef | null, odds: OddsSelection): string {
  return JSON.stringify([name, target?.slug ?? null, odds.gameId, odds.methodId]);
}

function sortByTimestamp(phases: readonly PhaseEntry[]): PhaseEntry[] {
  return [...phases].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
}

interface PhaseImport {
  hunts: Hunt[];
  createdHunts: number;
  addedPhases: number;
}

function importPhases(
  current: readonly Hunt[],
  rows: readonly PhaseExportRow[],
  mode: 'merge' | 'replace',
  ctx: ImportContext,
  log: ProblemLog,
): PhaseImport {
  const hunts = current.slice();
  const indexById = new Map<string, number>();
  const indexByName = new Map<string, number>();
  hunts.forEach((hunt, index) => {
    indexById.set(hunt.id, index);
    if (!indexByName.has(hunt.name)) indexByName.set(hunt.name, index);
  });
  const created = new Set<number>();
  const groups = new Map<number, PhaseExportRow[]>();
  let huntLimitReported = false;

  for (const row of rows) {
    let index = row.huntId === '' ? undefined : indexById.get(row.huntId);
    if (index === undefined && row.huntName !== '') index = indexByName.get(row.huntName);
    if (index === undefined) {
      if (hunts.length >= BOUNDS.hunts) {
        if (huntLimitReported) log.skipped += 1;
        else
          log.skip(
            `The limit of ${BOUNDS.hunts} hunts was reached; phases of further unknown hunts were left out.`,
          );
        huntLimitReported = true;
        continue;
      }
      // An unmatched huntId is by definition unused, so keeping it makes re-imports land on the same hunt.
      const id =
        row.huntId === '' ? uniqueId(new Set(indexById.keys()), ctx.idGenerator) : row.huntId;
      const hunt = createHuntRecord({
        id,
        at: ctx.now,
        name: row.huntName === '' ? IMPORTED_HUNT_NAME : row.huntName,
      });
      index = hunts.push(hunt) - 1;
      indexById.set(id, index);
      if (row.huntName !== '' && !indexByName.has(row.huntName))
        indexByName.set(row.huntName, index);
      created.add(index);
    }
    const group = groups.get(index);
    if (group === undefined) groups.set(index, [row]);
    else group.push(row);
  }

  const touchedAt = ctx.now.toISOString();
  let addedPhases = 0;
  for (const [index, group] of groups) {
    const hunt = hunts[index];
    if (hunt === undefined) continue;
    const ordered = [...group].sort((a, b) => a.phaseNumber - b.phaseNumber);
    const kept = mode === 'replace' ? [] : hunt.phases;
    const previous = new Map(hunt.phases.map((phase) => [phase.id, phase]));
    const taken = new Set(kept.map((phase) => phase.id));
    const additions: PhaseEntry[] = [];
    let overflow = 0;

    for (const row of ordered) {
      if (row.phaseId !== '' && taken.has(row.phaseId)) {
        // Already present — expected when the same log is merged twice, so not reported as a problem.
        log.skipped += 1;
        continue;
      }
      if (kept.length + additions.length >= BOUNDS.phasesPerHunt) {
        overflow += 1;
        continue;
      }
      const id = row.phaseId === '' ? uniqueId(taken, ctx.idGenerator) : row.phaseId;
      taken.add(id);
      additions.push({
        id,
        speciesId: row.speciesId,
        speciesName: row.speciesName,
        // Phase rows carry no sprite; keep the one the entry already had.
        spriteUrl: previous.get(id)?.spriteUrl ?? null,
        encounters: row.encounters,
        totalEncounters: row.totalEncounters,
        timestamp: row.timestamp,
        notes: row.notes,
      });
    }
    if (overflow > 0) {
      log.skip(
        `Hunt "${hunt.name}" is limited to ${BOUNDS.phasesPerHunt} phases; ${overflow} were left out.`,
        overflow,
      );
    }

    const isNew = created.has(index);
    if (additions.length === 0 && !isNew) continue;
    addedPhases += additions.length;
    const phases = mode === 'replace' ? additions : sortByTimestamp([...hunt.phases, ...additions]);
    // A hunt rebuilt from its log resumes after its last phase, with the count reset.
    const priorCount = isNew
      ? Math.min(
          BOUNDS.priorCount,
          additions.reduce((max, phase) => Math.max(max, phase.totalEncounters), 0),
        )
      : hunt.priorCount;
    hunts[index] = { ...hunt, phases, priorCount, updatedAt: touchedAt };
  }

  return { hunts, createdHunts: created.size, addedPhases };
}

/**
 * Applies a parsed import to `state` and reports what happened. Pure: the input
 * state is never modified, and it is returned as is when nothing changed.
 *
 *   backup    merge: upsert hunts by id, add sessions with unseen ids, keep settings
 *             replace: swap hunts, sessions and (when present) settings
 *   sessions  merge: add unseen ids · replace: replace the list
 *   phases    rows are matched to a hunt by huntId, then by exact huntName, else a hunt is created;
 *             merge: add phases with unseen ids · replace: replace the phase list of those hunts
 *   targets   every setup becomes a new zero-progress hunt unless an identical hunt exists;
 *             `replace` behaves like `merge` (targets never delete hunts)
 *
 * `imported.hunts` counts hunts created or overwritten; `skipped` counts invalid
 * records and duplicates; `errors` lists the problems (duplicates are not problems).
 */
export function applyImport(
  state: AppState,
  parsed: ParsedImport,
  mode: 'merge' | 'replace',
  ctx: ImportContext,
): { state: AppState; result: ImportOutcome } {
  if (mode !== 'merge' && mode !== 'replace')
    throw new Error('Invalid import mode: expected "merge" or "replace"');
  const log = new ProblemLog(parsed.errors, parsed.suppressedErrors, parsed.skipped);
  const imported = emptyCounts();
  const finish = (next: AppState): { state: AppState; result: ImportOutcome } => ({
    state: next,
    result: {
      dataset: parsed.dataset,
      imported,
      skipped: log.skipped,
      errors: log.finalMessages(),
    },
  });
  if (parsed.dataset === null) return finish(state);

  /** A replace must not wipe a list because every record in the file turned out to be invalid. */
  const canReplace = (list: keyof RecordCounts, valid: number): boolean => {
    if (valid > 0 || parsed.rejected[list] === 0) return true;
    log.note(`No valid ${list} were found in the file, so the existing ${list} were kept.`);
    return false;
  };

  let hunts = state.hunts;
  let sessions = state.sessions;
  let settings = state.settings;

  switch (parsed.dataset) {
    case 'backup': {
      if (mode === 'replace') {
        if (canReplace('hunts', parsed.hunts.length)) {
          hunts = parsed.hunts;
          imported.hunts = parsed.hunts.length;
          imported.phases = parsed.hunts.reduce((sum, hunt) => sum + hunt.phases.length, 0);
        }
        if (canReplace('sessions', parsed.sessions.length)) {
          sessions = parsed.sessions.slice(0, LIMITS.sessions);
          imported.sessions = sessions.length;
        }
        if (parsed.settings !== null) settings = parsed.settings;
        break;
      }
      const merged = state.hunts.slice();
      const indexById = new Map(merged.map((hunt, index) => [hunt.id, index]));
      let overLimit = 0;
      for (const hunt of parsed.hunts) {
        const index = indexById.get(hunt.id);
        if (index !== undefined) merged[index] = hunt;
        else if (merged.length >= BOUNDS.hunts) {
          overLimit += 1;
          continue;
        } else indexById.set(hunt.id, merged.push(hunt) - 1);
        imported.hunts += 1;
        imported.phases += hunt.phases.length;
      }
      if (overLimit > 0)
        log.skip(
          `The limit of ${BOUNDS.hunts} hunts was reached; ${overLimit} were left out.`,
          overLimit,
        );
      if (imported.hunts > 0) hunts = merged;
      const mergedSessions = mergeSessions(state.sessions, parsed.sessions);
      log.skipped += mergedSessions.duplicates;
      imported.sessions = mergedSessions.added;
      if (mergedSessions.added > 0) sessions = mergedSessions.sessions;
      break;
    }

    case 'sessions': {
      if (mode === 'replace') {
        if (canReplace('sessions', parsed.sessions.length)) {
          sessions = parsed.sessions.slice(0, LIMITS.sessions);
          imported.sessions = sessions.length;
        }
        break;
      }
      const merged = mergeSessions(state.sessions, parsed.sessions);
      log.skipped += merged.duplicates;
      imported.sessions = merged.added;
      if (merged.added > 0) sessions = merged.sessions;
      break;
    }

    case 'phases': {
      const outcome = importPhases(state.hunts, parsed.phases, mode, ctx, log);
      imported.hunts = outcome.createdHunts;
      imported.phases = outcome.addedPhases;
      if (outcome.createdHunts > 0 || outcome.addedPhases > 0) hunts = outcome.hunts;
      break;
    }

    case 'targets': {
      const next = state.hunts.slice();
      const takenIds = new Set(next.map((hunt) => hunt.id));
      const known = new Set(next.map((hunt) => setupSignature(hunt.name, hunt.target, hunt.odds)));
      let overLimit = 0;
      for (const setup of parsed.targets) {
        const name = resolveHuntName(setup.name, setup.target);
        const signature = setupSignature(name, setup.target, setup.odds);
        if (known.has(signature)) {
          log.skipped += 1;
          continue;
        }
        if (next.length >= BOUNDS.hunts) {
          overLimit += 1;
          continue;
        }
        const id = uniqueId(takenIds, ctx.idGenerator);
        takenIds.add(id);
        known.add(signature);
        next.push(
          createHuntRecord({
            id,
            at: ctx.now,
            name,
            target: setup.target,
            targetLevel: setup.targetLevel,
            odds: setup.odds,
            step: setup.step,
            notes: setup.notes,
          }),
        );
        imported.targets += 1;
        imported.hunts += 1;
      }
      if (overLimit > 0)
        log.skip(
          `The limit of ${BOUNDS.hunts} hunts was reached; ${overLimit} were left out.`,
          overLimit,
        );
      if (imported.targets > 0) hunts = next;
      break;
    }
  }

  if (hunts === state.hunts && sessions === state.sessions && settings === state.settings)
    return finish(state);
  // "No active hunt" is only a choice when there were hunts to choose from; otherwise select one.
  const activeHuntId =
    state.activeHuntId === null && state.hunts.length === 0
      ? pickFallbackActiveHunt(hunts)
      : resolveActiveHuntId(hunts, state.activeHuntId);
  return finish({ settings, hunts, activeHuntId, sessions });
}
