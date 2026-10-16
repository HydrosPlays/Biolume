/**
 * File IO around the export / import core: the part of `data.exportData` and
 * `data.importData` that runs once the user has picked a path. Failures the
 * user can cause (a locked file, a huge or unreadable import) come back in the
 * result's error fields; nothing here throws.
 *
 * This module must stay free of `electron` imports so it can be unit-tested.
 */
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ExportResult, ImportRequest, ImportResult } from '@shared/types';
import { applyImport, MAX_IMPORT_BYTES, parseImport, type BuiltExport } from './exportImport';
import type { AppStore } from './store';

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === 'string' ? error : String(error);
}

/** Adds the export's extension when the chosen file name has none. */
export function ensureExtension(filePath: string, extension: string): string {
  return extname(filePath) === '' ? `${filePath}.${extension}` : filePath;
}

export function canceledExport(): ExportResult {
  return { canceled: true, filePath: null, records: 0 };
}

export function failedExport(error: unknown, filePath: string | null = null): ExportResult {
  return { canceled: false, filePath, records: 0, error: describeError(error) };
}

/** Writes a built export exactly as returned by `buildExport` (CSV content carries its own BOM). */
export async function writeExportFile(built: BuiltExport, filePath: string): Promise<ExportResult> {
  const target = ensureExtension(filePath, built.extension);
  try {
    await writeFile(target, built.content, 'utf8');
    return { canceled: false, filePath: target, records: built.records };
  } catch (error) {
    return failedExport(`The file could not be written: ${describeError(error)}`, target);
  }
}

function emptyImport(canceled: boolean, filePath: string | null, errors: string[]): ImportResult {
  return {
    canceled,
    filePath,
    dataset: null,
    imported: { hunts: 0, phases: 0, sessions: 0, targets: 0 },
    skipped: 0,
    errors,
  };
}

export function canceledImport(): ImportResult {
  return emptyImport(true, null, []);
}

export function failedImport(error: unknown, filePath: string | null = null): ImportResult {
  return emptyImport(false, filePath, [describeError(error)]);
}

/**
 * Reads `filePath`, detects the dataset and applies it to the store. The file
 * size is checked before the file is read; the state is swapped only when the
 * import changed something.
 */
export async function importFromFile(
  store: Pick<AppStore, 'getState' | 'replaceState'>,
  filePath: string,
  mode: ImportRequest['mode'],
): Promise<ImportResult> {
  let text: string;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return failedImport('The selected item is not a file.', filePath);
    if (info.size > MAX_IMPORT_BYTES) {
      const limit = MAX_IMPORT_BYTES / (1024 * 1024);
      return failedImport(`The file is too large to import (the limit is ${limit} MB).`, filePath);
    }
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return failedImport(`The file could not be read: ${describeError(error)}`, filePath);
  }

  try {
    // No await between reading the state and replacing it: nothing can change in between.
    const current = store.getState();
    const { state, result } = applyImport(current, parseImport(text), mode, {
      now: new Date(),
      idGenerator: randomUUID,
    });
    if (state !== current) store.replaceState(state);
    return { canceled: false, filePath, ...result };
  } catch (error) {
    return failedImport(`The import failed: ${describeError(error)}`, filePath);
  }
}
