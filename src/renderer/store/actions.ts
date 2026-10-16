/**
 * Thin async wrappers over `window.biolume.*`.
 *
 * None of them touch the store: the main process applies the mutation and
 * broadcasts a `StateEvent`, which is what updates the UI. A wrapper never
 * rejects — a failed call raises an error toast and resolves with `null`
 * (or `false` for calls without a result), so call sites can stay simple:
 *
 *   const hunt = await actions.createHunt({ name: 'Shiny Ralts' });
 *   if (hunt) navigate('hunt');
 */
import type {
  CompleteHuntInput,
  CounterSource,
  CreateHuntInput,
  ExportRequest,
  ExportResult,
  Hunt,
  HuntPatch,
  ImportRequest,
  ImportResult,
  LogPhaseInput,
  PhasePatch,
  Settings,
  SettingsPatch,
  ShinyFoundResult,
} from '@shared/types';
import { confirm, type ConfirmOptions } from '@renderer/components/ui/confirm';
import { useAppStore } from './appStore';
import { toast } from './uiStore';

/** Electron prefixes errors thrown by `ipcMain.handle` handlers with this boilerplate. */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

/** A readable message from anything that can be thrown across the IPC bridge. */
export function describeActionError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected error';
  const message = raw.replace(IPC_ERROR_PREFIX, '').trim();
  return message === '' ? 'Unexpected error' : message;
}

function reportFailure(title: string, error: unknown): void {
  console.error(`[biolume] ${title}`, error);
  // One toast per kind of failure: a held hotkey must not bury the screen in errors.
  toast.error(title, { id: `action-error:${title}`, description: describeActionError(error) });
}

async function attempt<T>(title: string, task: () => Promise<T> | T): Promise<T | null> {
  try {
    return await task();
  } catch (error) {
    reportFailure(title, error);
    return null;
  }
}

async function attemptVoid(title: string, task: () => Promise<void> | void): Promise<boolean> {
  try {
    await task();
    return true;
  } catch (error) {
    reportFailure(title, error);
    return false;
  }
}

// ───────────────────────────── Hunts ─────────────────────────────

export function createHunt(input: CreateHuntInput = {}): Promise<Hunt | null> {
  return attempt('Could not create the hunt', () => window.biolume.hunts.create(input));
}

export function updateHunt(huntId: string, patch: HuntPatch): Promise<Hunt | null> {
  return attempt('Could not update the hunt', () => window.biolume.hunts.update(huntId, patch));
}

export function removeHunt(huntId: string): Promise<boolean> {
  return attemptVoid('Could not delete the hunt', () => window.biolume.hunts.remove(huntId));
}

export function setActiveHunt(huntId: string | null): Promise<boolean> {
  return attemptVoid('Could not switch hunts', () => window.biolume.hunts.setActive(huntId));
}

/** Adds `delta` (may be negative) to the current-phase count. */
export function adjustCount(
  huntId: string,
  delta: number,
  source: CounterSource = 'ui',
): Promise<Hunt | null> {
  return attempt('Could not update the counter', () =>
    window.biolume.hunts.adjustCount(huntId, delta, source),
  );
}

/** One "count": adds the hunt's step. */
export function incrementHunt(
  hunt: Pick<Hunt, 'id' | 'step'>,
  source: CounterSource = 'ui',
): Promise<Hunt | null> {
  return adjustCount(hunt.id, Math.max(1, hunt.step), source);
}

/** Takes one step back off the count (clamped at 0 by the main process). */
export function decrementHunt(
  hunt: Pick<Hunt, 'id' | 'step'>,
  source: CounterSource = 'ui',
): Promise<Hunt | null> {
  return adjustCount(hunt.id, -Math.max(1, hunt.step), source);
}

export function setCount(
  huntId: string,
  count: number,
  source: CounterSource = 'ui',
): Promise<Hunt | null> {
  return attempt('Could not set the counter', () =>
    window.biolume.hunts.setCount(huntId, count, source),
  );
}

export function logPhase(huntId: string, input: LogPhaseInput): Promise<Hunt | null> {
  return attempt('Could not log the phase', () => window.biolume.hunts.logPhase(huntId, input));
}

export function updatePhase(
  huntId: string,
  phaseId: string,
  patch: PhasePatch,
): Promise<Hunt | null> {
  return attempt('Could not update the phase', () =>
    window.biolume.hunts.updatePhase(huntId, phaseId, patch),
  );
}

export function removePhase(huntId: string, phaseId: string): Promise<Hunt | null> {
  return attempt('Could not delete the phase', () =>
    window.biolume.hunts.removePhase(huntId, phaseId),
  );
}

export function completeHunt(huntId: string, input?: CompleteHuntInput): Promise<Hunt | null> {
  return attempt('Could not complete the hunt', () => window.biolume.hunts.complete(huntId, input));
}

/**
 * Shiny Found with confirmation — for hotkeys and other non-mouse inputs. The
 * first call arms it (the main process broadcasts a `ShinyArmedEvent` that
 * the store mirrors), a second call within `SHINY_CONFIRM_WINDOW_MS` completes
 * the hunt. The Hunt view's own button uses {@link completeHunt} instead.
 */
export function requestShinyFound(
  huntId: string,
  source: CounterSource,
): Promise<ShinyFoundResult | null> {
  return attempt('Could not confirm Shiny Found', () =>
    window.biolume.hunts.requestShinyFound(huntId, source),
  );
}

export function reopenHunt(huntId: string): Promise<Hunt | null> {
  return attempt('Could not reopen the hunt', () => window.biolume.hunts.reopen(huntId));
}

/**
 * Reverts the hunt's latest count / phase / completion change. Resolves with
 * null — after a brief "Nothing to undo" notice — when its history is empty.
 */
export async function undoHunt(huntId: string): Promise<Hunt | null> {
  try {
    const hunt = await window.biolume.hunts.undo(huntId);
    if (hunt === null) toast.info('Nothing to undo', { id: 'undo-empty', duration: 1800 });
    return hunt;
  } catch (error) {
    reportFailure('Could not undo', error);
    return null;
  }
}

// ───────────────────────────── Settings & hotkeys ─────────────────────────────

export function updateSettings(patch: SettingsPatch): Promise<Settings | null> {
  return attempt('Could not save settings', () => window.biolume.settings.update(patch));
}

export function resetSettings(): Promise<Settings | null> {
  return attempt('Could not reset settings', () => window.biolume.settings.reset());
}

/** Suspends every hotkey (global and in-app) while a key combination is being recorded. */
export function setHotkeyCapturing(capturing: boolean): Promise<boolean> {
  return attemptVoid('Could not change hotkey recording', () =>
    window.biolume.hotkeys.setCapturing(capturing),
  );
}

// ───────────────────────────── Window ─────────────────────────────

export function minimizeWindow(): Promise<boolean> {
  return attemptVoid('Could not minimize the window', () => window.biolume.window.minimize());
}

export function toggleMaximizeWindow(): Promise<boolean> {
  return attemptVoid('Could not resize the window', () => window.biolume.window.toggleMaximize());
}

/** Main window: quits Biolume. Overlay window: closes the overlay. */
export function closeWindow(): Promise<boolean> {
  return attemptVoid('Could not close the window', () => window.biolume.window.close());
}

export function setAlwaysOnTop(pinned: boolean): Promise<boolean> {
  return attemptVoid('Could not pin the window', () =>
    window.biolume.window.setAlwaysOnTop(pinned),
  );
}

export function toggleAlwaysOnTop(): Promise<boolean> {
  return setAlwaysOnTop(!useAppStore.getState().windowState.alwaysOnTop);
}

export function setOverlayOpen(open: boolean): Promise<boolean> {
  return attemptVoid(
    open ? 'Could not open the mini-overlay' : 'Could not close the mini-overlay',
    () => window.biolume.window.setOverlayOpen(open),
  );
}

export function toggleOverlay(): Promise<boolean> {
  return setOverlayOpen(!useAppStore.getState().windowState.overlayOpen);
}

// ───────────────────────────── Data & shell ─────────────────────────────

/** Shows the save dialog and writes the dataset. A result carrying `error` also raises a toast. */
export async function exportData(request: ExportRequest): Promise<ExportResult | null> {
  const result = await attempt('Export failed', () => window.biolume.data.exportData(request));
  if (result?.error) toast.error('Export failed', { description: result.error });
  return result;
}

/** Shows the open dialog and imports the chosen file. Inspect `errors` / `skipped` on the result. */
export function importData(request: ImportRequest): Promise<ImportResult | null> {
  return attempt('Import failed', () => window.biolume.data.importData(request));
}

export function getDataPath(): Promise<string | null> {
  return attempt('Could not locate the data folder', () => window.biolume.data.getPath());
}

export function revealDataFolder(): Promise<boolean> {
  return attemptVoid('Could not open the data folder', () => window.biolume.data.revealFolder());
}

// ───────────────────────────── Stream Deck ─────────────────────────────

const PLUGIN_INSTALL_FAILED = 'Could not install the Stream Deck plugin';

/**
 * Opens the bundled `.streamDeckPlugin`, which makes the Stream Deck app offer
 * to install it. Resolves true once the installer was handed over; a failure
 * (the call rejecting, or main reporting `ok: false`) raises an error toast.
 */
export async function installStreamDeckPlugin(): Promise<boolean> {
  const result = await attempt(PLUGIN_INSTALL_FAILED, () =>
    window.biolume.streamDeck.installPlugin(),
  );
  if (result === null) return false;
  if (!result.ok) {
    toast.error(PLUGIN_INSTALL_FAILED, {
      id: `action-error:${PLUGIN_INSTALL_FAILED}`,
      description:
        result.error && result.error.trim() !== ''
          ? result.error
          : 'The installer could not be opened. Is the Stream Deck app installed?',
    });
    return false;
  }
  return true;
}

/** Opens an allow-listed https URL in the default browser. */
export function openExternal(url: string): Promise<boolean> {
  return attemptVoid('Could not open the link', () => window.biolume.shell.openExternal(url));
}

// ───────────────────────────── Confirmation ─────────────────────────────

/**
 * Asks before a destructive operation (delete, reset) — unless the user turned
 * `settings.general.confirmDestructive` off, in which case it resolves true at once.
 */
export function confirmDestructive(options: ConfirmOptions): Promise<boolean> {
  if (!useAppStore.getState().settings.general.confirmDestructive) return Promise.resolve(true);
  return confirm({ tone: 'danger', ...options });
}
