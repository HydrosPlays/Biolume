/**
 * JSON persistence in a single directory (the shell passes `app.getPath('userData')`).
 *
 *   settings.json   Settings
 *   hunts.json      { schemaVersion, activeHuntId, hunts }
 *   sessions.json   { schemaVersion, sessions }
 *   <name>.json     documents the shell owns (window-state.json), via readJson / writeJson
 *
 * Saves are debounced and atomic: the new content goes to `<name>.tmp`, is
 * fsynced, the previous good file is kept as `<name>.bak`, and the temp file is
 * renamed into place. A failed write therefore never damages the file that was
 * there before; it is reported through `onError` and retried.
 *
 * Loading never throws on bad data: an unparsable file is moved aside as
 * `<name>.corrupt-<timestamp>.json` and the backup (or the defaults) is used.
 *
 * This module must stay free of `electron` imports so it can be unit-tested.
 */
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { createDefaultSettings } from '@shared/defaults';
import {
  SCHEMA_VERSION,
  type AppState,
  type Hunt,
  type SessionRecord,
  type Settings,
} from '@shared/types';
import {
  readHuntsDocument,
  readSessionsDocument,
  readSettingsDocument,
  type DocumentReadResult,
  type HuntsDocument,
  type SanitizeContext,
} from './validation';

/** The slice of `node:fs` the storage uses — injectable so tests can simulate failing disks. */
export type StorageFs = Pick<
  typeof nodeFs,
  | 'closeSync'
  | 'copyFileSync'
  | 'fsyncSync'
  | 'mkdirSync'
  | 'openSync'
  | 'readFileSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'writeFileSync'
>;

export interface StorageOptions {
  /** Quiet period before a scheduled save is written (default 300 ms). */
  debounceMs?: number;
  /** Longest a continuously re-scheduled save may be deferred (default 2000 ms). */
  maxWaitMs?: number;
  /** Receives every load / save problem. `file` is the document name, e.g. `hunts.json`. */
  onError?: (error: Error, file: string) => void;
  /** Clock used for quarantine file names and repaired timestamps (default: system clock). */
  now?: () => Date;
  /** Ids for stored records that lack a valid or unique one (default: `randomUUID`). */
  idGenerator?: () => string;
  /** File-system implementation (default: `node:fs`). */
  fs?: StorageFs;
}

export interface Storage {
  /** The directory the documents live in. */
  readonly dir: string;
  /** Reads the three state documents. Never throws on missing, corrupt or invalid files. */
  loadState(): AppState;
  /** Schedules a debounced, atomic save of `settings.json`. */
  saveSettings(settings: Settings): void;
  /** Schedules a debounced, atomic save of `hunts.json`. */
  saveHunts(hunts: readonly Hunt[], activeHuntId: string | null): void;
  /** Schedules a debounced, atomic save of `sessions.json`. */
  saveSessions(sessions: readonly SessionRecord[]): void;
  /**
   * Reads a shell-owned document. Returns `fallback` when it is missing or
   * unusable. Without `parse` the content is returned unchecked — pass a
   * validator (it may throw) whenever the shape matters.
   */
  readJson<T>(name: string, fallback: T, parse?: (raw: unknown) => T): T;
  /** Schedules a debounced, atomic save of a shell-owned document. */
  writeJson(name: string, value: unknown): void;
  /** Writes everything pending right now (call on quit). */
  flushSync(): void;
  /** True while a scheduled save has not reached the disk yet. */
  hasPendingWrites(): boolean;
}

export const SETTINGS_FILE = 'settings.json';
export const HUNTS_FILE = 'hunts.json';
export const SESSIONS_FILE = 'sessions.json';

const STATE_FILES: ReadonlySet<string> = new Set([SETTINGS_FILE, HUNTS_FILE, SESSIONS_FILE]);
const DOCUMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.json$/;

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MAX_WAIT_MS = 2_000;

/** Antivirus scanners and the Windows indexer hold files open for a few milliseconds at a time. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [8, 16, 32, 64] as const;
/** Consecutive failed saves that are retried on a timer before waiting for the next change. */
const MAX_AUTOMATIC_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 10_000;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** Blocks the thread briefly; when no blocking wait is available the retry simply happens at once. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No blocking sleep in this environment.
  }
}

function withRetry<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      const code = errorCode(error);
      if (delay === undefined || code === undefined || !TRANSIENT_CODES.has(code)) throw error;
      sleepSync(delay);
    }
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** `20261013T180411201Z` — sortable and valid in a Windows file name. */
function fileStamp(date: Date): string {
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toISOString().replace(/[-:.]/g, '');
}

function toJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== 'string') throw new Error('The value cannot be represented as JSON');
  return `${text}\n`;
}

type ReadOutcome =
  { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'unreadable'; error: Error };

interface PendingWrite {
  /** Produces the text to write; state documents serialise lazily, at write time. */
  serialize: () => string;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the oldest change that is still unwritten was scheduled. */
  queuedAt: number;
  /** Consecutive failed attempts to write this document. */
  failures: number;
  /** After a failure: the earliest time a timer may try again (flushSync ignores it). */
  notBefore: number;
}

interface LoadPlan<T> {
  file: string;
  read: (raw: unknown) => DocumentReadResult<T>;
  fallback: () => T;
  /** Serialises a recovered value so it can be written back in its repaired form. */
  serialize: (value: T) => string;
}

export function createStorage(dir: string, options: StorageOptions = {}): Storage {
  const fs: StorageFs = options.fs ?? nodeFs;
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const now = options.now ?? (() => new Date());

  const pending = new Map<string, PendingWrite>();
  /**
   * Whether the file currently on disk is known to be intact. Only an intact
   * file may replace the backup — a damaged one must not overwrite a good `.bak`.
   */
  const intact = new Map<string, boolean>();

  const report = (error: unknown, file: string): void => {
    try {
      options.onError?.(toError(error), file);
    } catch {
      // An error handler that throws must not take the storage down with it.
    }
  };

  const pathOf = (file: string): string => join(dir, file);

  const resolveName = (name: string): string => {
    const file = typeof name === 'string' && name.endsWith('.json') ? name : `${String(name)}.json`;
    if (!DOCUMENT_NAME.test(file)) throw new Error(`Invalid storage document name: "${file}"`);
    if (STATE_FILES.has(file)) {
      throw new Error(
        `"${file}" is managed by the state API — use loadState / saveSettings / saveHunts / saveSessions`,
      );
    }
    return file;
  };

  // ───────────────────────────── Reading ─────────────────────────────

  const readText = (path: string): ReadOutcome => {
    try {
      return { kind: 'ok', text: fs.readFileSync(path, 'utf8') };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unreadable', error: toError(error) };
    }
  };

  /** A free `<base>.<tag>-<stamp>.json` name for a file that is being set aside. */
  const asideName = (file: string, tag: string): string => {
    const base = file.slice(0, -'.json'.length);
    const stamp = fileStamp(now());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = `${base}.${tag}-${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`;
      if (readText(pathOf(candidate)).kind === 'missing') return candidate;
    }
    return `${base}.${tag}-${stamp}-${Math.random().toString(36).slice(2, 10)}.json`;
  };

  /** Moves a damaged file out of the way; returns its new name, or null when it could not be moved. */
  const quarantine = (file: string): string | null => {
    const target = asideName(file, 'corrupt');
    try {
      withRetry(() => fs.renameSync(pathOf(file), pathOf(target)));
      return target;
    } catch {
      return null;
    }
  };

  /** Keeps a copy of a file whose content is about to be rewritten in a lossy way. */
  const preserveCopy = (file: string, tag: string): string | null => {
    const target = asideName(file, tag);
    try {
      fs.copyFileSync(pathOf(file), pathOf(target));
      return target;
    } catch {
      return null;
    }
  };

  const parseWith = <T>(
    text: string,
    read: (raw: unknown) => T,
  ): { ok: true; value: T } | { ok: false; reason: string } => {
    try {
      return { ok: true, value: read(JSON.parse(stripBom(text)) as unknown) };
    } catch (error) {
      return { ok: false, reason: toError(error).message };
    }
  };

  /** Shared recovery path: the previous good generation kept beside the main file. */
  const readBackup = <T>(
    file: string,
    read: (raw: unknown) => T,
  ): { ok: true; value: T } | { ok: false } => {
    const backup = readText(`${pathOf(file)}.bak`);
    if (backup.kind !== 'ok') return { ok: false };
    const parsed = parseWith(backup.text, read);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false };
  };

  const loadDocument = <T>(plan: LoadPlan<T>): T => {
    const { file, read } = plan;
    const main = readText(pathOf(file));
    let problem: string | null = null;

    if (main.kind === 'ok') {
      const parsed = parseWith(main.text, read);
      if (parsed.ok) {
        const { value, dropped, newer, fromVersion } = parsed.value;
        if (dropped > 0 || newer) {
          // Saving would discard what this version could not read, so keep the original.
          const copy = preserveCopy(file, newer ? `v${fromVersion}` : 'corrupt');
          intact.set(file, false);
          schedule(file, () => plan.serialize(value));
          const what = newer
            ? `was written by a newer Biolume (schema v${fromVersion})`
            : `contained ${dropped} unreadable record${dropped === 1 ? '' : 's'}`;
          report(
            new Error(
              `${file} ${what}; ${copy ? `the original was kept as ${copy}` : 'the original could not be copied'}`,
            ),
            file,
          );
        } else {
          intact.set(file, true);
          // Persist the upgraded shape; the pre-migration file becomes the backup.
          if (fromVersion < SCHEMA_VERSION) schedule(file, () => plan.serialize(value));
        }
        return value;
      }
      const moved = quarantine(file);
      intact.set(file, false);
      problem = `${file} is corrupt (${parsed.reason}); ${moved ? `it was moved to ${moved}` : 'it could not be moved aside'}`;
    } else if (main.kind === 'unreadable') {
      intact.set(file, false);
      problem = `${file} could not be read (${main.error.message})`;
    }

    const backup = readBackup(file, read);
    if (backup.ok) {
      const { value } = backup.value;
      // Re-establish the main file so the next launch does not depend on the backup again.
      schedule(file, () => plan.serialize(value));
      report(new Error(`${problem ?? `${file} was missing`}; restored from ${file}.bak`), file);
      return value;
    }
    if (problem !== null)
      report(new Error(`${problem}; no usable backup, starting from defaults`), file);
    return plan.fallback();
  };

  // ───────────────────────────── Writing ─────────────────────────────

  /** Should the file on disk replace the current backup before it is overwritten? */
  const isWorthBackingUp = (file: string): boolean => {
    const known = intact.get(file);
    if (known !== undefined) return known;
    // Never read or written by this instance: only trust it if it parses.
    const current = readText(pathOf(file));
    if (current.kind !== 'ok') return false;
    try {
      JSON.parse(stripBom(current.text));
      return true;
    } catch {
      return false;
    }
  };

  const writeDurably = (path: string, text: string): void => {
    const fd = fs.openSync(path, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };

  /** Flushes the directory entry on platforms that allow it (Windows does not). */
  const syncDirectory = (): void => {
    if (process.platform === 'win32') return;
    try {
      const fd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Durability of the rename is best-effort.
    }
  };

  const writeAtomic = (file: string, text: string): void => {
    const target = pathOf(file);
    const temp = `${target}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      withRetry(() => writeDurably(temp, text));
      if (isWorthBackingUp(file)) {
        try {
          fs.copyFileSync(target, `${target}.bak`);
        } catch {
          // Losing the backup generation is preferable to losing the save itself.
        }
      }
      withRetry(() => fs.renameSync(temp, target));
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Nothing to clean up, or the temp file is locked — the next save truncates it.
      }
      throw error;
    }
    intact.set(file, true);
    syncDirectory();
  };

  const writePending = (file: string): boolean => {
    const entry = pending.get(file);
    if (entry === undefined) return true;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;

    let text: string;
    try {
      text = entry.serialize();
    } catch (error) {
      // Retrying cannot fix a value that does not serialise.
      pending.delete(file);
      report(error, file);
      return false;
    }

    try {
      writeAtomic(file, text);
    } catch (error) {
      entry.failures += 1;
      const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(debounceMs, 100) * 2 ** entry.failures);
      entry.notBefore = Date.now() + delay;
      if (entry.failures <= MAX_AUTOMATIC_RETRIES) {
        entry.timer = setTimeout(() => writePending(file), delay);
      }
      report(error, file);
      return false;
    }
    // A save scheduled from inside `serialize` would have replaced the entry; only clear our own.
    if (pending.get(file) === entry) pending.delete(file);
    return true;
  };

  function schedule(file: string, serialize: () => string): void {
    const existing = pending.get(file);
    if (existing !== undefined && existing.timer !== null) clearTimeout(existing.timer);
    const nowMs = Date.now();
    const queuedAt = existing?.queuedAt ?? nowMs;
    const failures = existing?.failures ?? 0;
    const notBefore = existing?.notBefore ?? 0;
    // Debounce, but never push a save further than `maxWaitMs` past its first unwritten change.
    const debounced = Math.min(debounceMs, queuedAt + maxWaitMs - nowMs);
    // While writes are failing, honour the backoff: a blocked disk must not be hit on every keypress.
    const wait = Math.max(0, debounced, notBefore - nowMs);
    const entry: PendingWrite = { serialize, timer: null, queuedAt, failures, notBefore };
    entry.timer = setTimeout(() => writePending(file), wait);
    pending.set(file, entry);
  }

  const flushSync = (): void => {
    for (const file of [...pending.keys()]) writePending(file);
  };

  // ───────────────────────────── Public API ─────────────────────────────

  const serializeSettings = (settings: Settings): string =>
    toJson({ ...settings, schemaVersion: SCHEMA_VERSION });
  const serializeHunts = (document: {
    hunts: readonly Hunt[];
    activeHuntId: string | null;
  }): string =>
    toJson({
      schemaVersion: SCHEMA_VERSION,
      activeHuntId: document.activeHuntId,
      hunts: document.hunts,
    });
  const serializeSessions = (sessions: readonly SessionRecord[]): string =>
    toJson({ schemaVersion: SCHEMA_VERSION, sessions });

  return {
    dir,

    loadState(): AppState {
      // Anything still queued is newer than the disk; write it before reading back.
      flushSync();
      const context: SanitizeContext = { now: now() };
      if (options.idGenerator) context.idGenerator = options.idGenerator;

      const settings = loadDocument<Settings>({
        file: SETTINGS_FILE,
        read: readSettingsDocument,
        fallback: createDefaultSettings,
        serialize: serializeSettings,
      });
      const hunts = loadDocument<HuntsDocument>({
        file: HUNTS_FILE,
        read: (raw) => readHuntsDocument(raw, context),
        fallback: () => ({ hunts: [], activeHuntId: null }),
        serialize: serializeHunts,
      });
      const sessions = loadDocument<SessionRecord[]>({
        file: SESSIONS_FILE,
        read: (raw) => readSessionsDocument(raw, context),
        fallback: () => [],
        serialize: serializeSessions,
      });
      return { settings, hunts: hunts.hunts, activeHuntId: hunts.activeHuntId, sessions };
    },

    saveSettings(settings) {
      schedule(SETTINGS_FILE, () => serializeSettings(settings));
    },

    saveHunts(hunts, activeHuntId) {
      schedule(HUNTS_FILE, () => serializeHunts({ hunts, activeHuntId }));
    },

    saveSessions(sessions) {
      schedule(SESSIONS_FILE, () => serializeSessions(sessions));
    },

    readJson<T>(name: string, fallback: T, parse?: (raw: unknown) => T): T {
      const file = resolveName(name);
      // Without a validator the caller vouches for the shape of its own document.
      const read = parse ?? ((raw: unknown) => raw as T);

      const queued = pending.get(file);
      if (queued !== undefined) {
        try {
          return read(JSON.parse(queued.serialize()) as unknown);
        } catch {
          return fallback;
        }
      }

      const main = readText(pathOf(file));
      let problem: string | null = null;
      if (main.kind === 'ok') {
        const parsed = parseWith(main.text, read);
        if (parsed.ok) {
          intact.set(file, true);
          return parsed.value;
        }
        const moved = quarantine(file);
        intact.set(file, false);
        problem = `${file} is corrupt (${parsed.reason}); ${moved ? `it was moved to ${moved}` : 'it could not be moved aside'}`;
      } else if (main.kind === 'unreadable') {
        intact.set(file, false);
        problem = `${file} could not be read (${main.error.message})`;
      }

      const backup = readBackup(file, read);
      if (backup.ok) {
        report(new Error(`${problem ?? `${file} was missing`}; restored from ${file}.bak`), file);
        return backup.value;
      }
      if (problem !== null) report(new Error(`${problem}; no usable backup, using defaults`), file);
      return fallback;
    },

    writeJson(name: string, value: unknown): void {
      const file = resolveName(name);
      let text: string;
      try {
        // Serialise now: the shell may keep mutating the object it handed over.
        text = toJson(value);
      } catch (error) {
        report(error, file);
        return;
      }
      schedule(file, () => text);
    },

    flushSync,

    hasPendingWrites(): boolean {
      return pending.size > 0;
    },
  };
}

/**
 * @deprecated Compatibility export for the scaffold's placeholder `main.ts`.
 * Use `createStorage(dir).loadState()` (normally through `createAppStore`).
 */
export function loadState(dir?: string): AppState {
  if (dir !== undefined) return createStorage(dir).loadState();
  return { settings: createDefaultSettings(), hunts: [], activeHuntId: null, sessions: [] };
}
