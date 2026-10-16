/**
 * The main-process side of the IPC contract in `@shared/ipc`.
 *
 * Every channel in {@link IPC} is accounted for at compile time: request /
 * response channels get an `ipcMain.handle` handler, fire-and-forget channels
 * an `ipcMain.on` listener, and the remaining ones are pushes from main to the
 * renderers. Each call is checked twice before it reaches the store: the
 * sender must be the main frame of one of our two windows, showing the app's
 * own page, and every argument is parsed with zod.
 *
 * Handlers answer with an {@link IpcResult} envelope instead of throwing, so
 * the renderer receives error messages verbatim.
 */
import { dirname, join } from 'node:path';
import {
  app,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type FileFilter,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import { IPC, type IpcChannel, type IpcResult } from '@shared/ipc';
import type {
  ExportResult,
  HotkeyStatus,
  ImportResult,
  StreamDeckStatus,
  WindowKind,
  WindowStateInfo,
} from '@shared/types';
import {
  canceledExport,
  canceledImport,
  describeError,
  failedExport,
  failedImport,
  importFromFile,
  writeExportFile,
} from './dataFiles';
import { buildExport, type BuiltExport } from './exportImport';
import { openExternalLink } from './security';
import type { ShinyConfirm } from './shinyConfirm';
import type { AppStore } from './store';
import type { AppUrlPolicy } from './urlPolicy';
import { inputSchemas, parseInput } from './validation';

/** What the handlers need from the window manager. */
export interface IpcWindows {
  kindOf(contents: WebContents): WindowKind | null;
  getMainWindow(): BrowserWindow | null;
  broadcast(channel: string, payload: unknown): void;
  getStateInfo(kind: WindowKind): WindowStateInfo;
  setAlwaysOnTop(pinned: boolean): void;
  setOverlayOpen(open: boolean): void;
  resizeOverlay(size: { width: number; height: number }): void;
  minimize(kind: WindowKind): void;
  toggleMaximize(kind: WindowKind): void;
}

/** What the handlers need from the hotkey controller. */
export interface IpcHotkeys {
  getStatus(): HotkeyStatus;
  setCapturing(capturing: boolean): void;
  /** Suspends global shortcuts while a native dialog is open; returns the release function. */
  holdForDialog(): () => void;
}

/** What the handlers need from the Stream Deck integration. */
export interface IpcStreamDeck {
  getStatus(): StreamDeckStatus;
  /** Opens the bundled `.streamDeckPlugin`; resolves with an error message instead of throwing. */
  installPlugin(): Promise<{ ok: boolean; error?: string }>;
}

export interface SmokeReadyInfo {
  windowKind: WindowKind;
  errors: string[];
}

export interface IpcDeps {
  store: AppStore;
  windows: IpcWindows;
  hotkeys: IpcHotkeys;
  /** Shiny Found with its confirming second press. */
  shiny: Pick<ShinyConfirm, 'request'>;
  streamDeck: IpcStreamDeck;
  policy: AppUrlPolicy;
  /** The userData directory holding Biolume's JSON files. */
  dataDir: string;
  /** Quits the app — the main window's close button. */
  quit: () => void;
  /** Smoke mode only: receives each renderer's "first frame painted" signal. */
  onSmokeReady?: (info: SmokeReadyInfo) => void;
  log?: (message: string, detail?: unknown) => void;
}

/** Channels main only ever sends on. */
type PushChannel = (typeof IPC)[
  | 'stateEvent'
  | 'hotkeysStatusEvent'
  | 'hotkeysActionEvent'
  | 'windowStateEvent'
  | 'huntsShinyArmedEvent'
  | 'streamDeckStatusEvent'];
/** Fire-and-forget channels (`ipcRenderer.send`). */
type SendChannel = (typeof IPC)[
  'windowMinimize' | 'windowToggleMaximize' | 'windowClose' | 'windowResizeOverlay' | 'smokeReady'];
/** Request / response channels (`ipcRenderer.invoke`). */
type InvokeChannel = Exclude<IpcChannel, PushChannel | SendChannel>;

interface Caller {
  /** Which of our windows sent the message — derived from the sender, never from the payload. */
  kind: WindowKind;
}

type InvokeHandler = (caller: Caller, args: readonly unknown[]) => unknown;
type SendHandler = (caller: Caller, args: readonly unknown[]) => void;

export const UNTRUSTED_SENDER_MESSAGE = 'Biolume: IPC message from an untrusted sender';

// Ids are only looked up, so a generous cap is enough; an unknown id is reported by the store.
const idSchema = z.string().min(1).max(256);
const flagSchema = z.boolean();
const urlSchema = z.string().min(1).max(2_048);
const overlaySizeSchema = z.object({ width: z.number(), height: z.number() });
const importRequestSchema = z.object({ mode: z.enum(['merge', 'replace']) });
const smokeReadySchema = z.object({
  errors: z.array(z.string().transform((message) => message.slice(0, 2_000))).max(200),
});

const FILE_FILTERS: Record<'json' | 'csv', FileFilter> = {
  json: { name: 'JSON', extensions: ['json'] },
  csv: { name: 'CSV (spreadsheet)', extensions: ['csv'] },
};
const ALL_FILES: FileFilter = { name: 'All files', extensions: ['*'] };

/**
 * Registers a handler for every renderer → main channel and forwards every
 * store event to the windows. Returns a function that undoes all of it.
 */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const { store, windows, hotkeys, shiny, streamDeck, policy } = deps;
  const log = deps.log ?? (() => undefined);
  /** Folder of the last export or import, offered again next time. */
  let lastDirectory: string | null = null;

  /** The window a message came from, or null when it is not the app's own page in a main frame. */
  const identify = (event: IpcMainEvent | IpcMainInvokeEvent): WindowKind | null => {
    try {
      const kind = windows.kindOf(event.sender);
      const frame = event.senderFrame;
      if (kind === null || frame === null || frame.parent !== null) return null;
      const mainFrame = event.sender.mainFrame;
      if (frame.processId !== mainFrame.processId || frame.routingId !== mainFrame.routingId) {
        return null;
      }
      return policy.isAppUrl(frame.url) ? kind : null;
    } catch {
      // The frame or its web contents went away while the message was in flight.
      return null;
    }
  };

  const huntId = (value: unknown): string => parseInput(idSchema, value, 'hunt id');
  const phaseId = (value: unknown): string => parseInput(idSchema, value, 'phase id');

  /** A dialog parented to a hidden window would be invisible, so it then stands alone. */
  const dialogParent = (): BrowserWindow | null => {
    const parent = windows.getMainWindow();
    return parent !== null && parent.isVisible() && !parent.isMinimized() ? parent : null;
  };

  const exportData = async (raw: unknown): Promise<ExportResult> => {
    let built: BuiltExport;
    try {
      const request = parseInput(inputSchemas.exportRequest, raw, 'export request');
      built = buildExport(store.getState(), request, new Date());
    } catch (error) {
      return failedExport(error);
    }

    const release = hotkeys.holdForDialog();
    try {
      const options: SaveDialogOptions = {
        title: 'Export Biolume data',
        defaultPath: join(lastDirectory ?? app.getPath('documents'), built.defaultFileName),
        filters: [FILE_FILTERS[built.extension], ALL_FILES],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      };
      const parent = dialogParent();
      const choice = await (parent === null
        ? dialog.showSaveDialog(options)
        : dialog.showSaveDialog(parent, options));
      if (choice.canceled || choice.filePath === '') return canceledExport();
      lastDirectory = dirname(choice.filePath);
      return await writeExportFile(built, choice.filePath);
    } catch (error) {
      return failedExport(error);
    } finally {
      release();
    }
  };

  const importData = async (raw: unknown): Promise<ImportResult> => {
    let mode: 'merge' | 'replace';
    try {
      mode = parseInput(importRequestSchema, raw, 'import request').mode;
    } catch (error) {
      return failedImport(error);
    }

    const release = hotkeys.holdForDialog();
    try {
      const options: OpenDialogOptions = {
        title: 'Import Biolume data',
        properties: ['openFile'],
        filters: [
          { name: 'Biolume exports', extensions: ['json', 'csv'] },
          FILE_FILTERS.json,
          FILE_FILTERS.csv,
          ALL_FILES,
        ],
      };
      if (lastDirectory !== null) options.defaultPath = lastDirectory;
      const parent = dialogParent();
      const choice = await (parent === null
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(parent, options));
      const filePath = choice.filePaths[0];
      if (choice.canceled || filePath === undefined) return canceledImport();
      lastDirectory = dirname(filePath);
      return await importFromFile(store, filePath, mode);
    } catch (error) {
      return failedImport(error);
    } finally {
      release();
    }
  };

  const invokeHandlers: Record<InvokeChannel, InvokeHandler> = {
    [IPC.stateGet]: () => store.getState(),

    [IPC.huntsCreate]: (_caller, [input]) =>
      store.createHunt(parseInput(inputSchemas.createHunt, input ?? {}, 'hunt')),
    [IPC.huntsUpdate]: (_caller, [id, patch]) =>
      store.updateHunt(huntId(id), parseInput(inputSchemas.huntPatch, patch, 'hunt changes')),
    [IPC.huntsRemove]: (_caller, [id]) => store.removeHunt(huntId(id)),
    [IPC.huntsSetActive]: (_caller, [id]) =>
      store.setActiveHunt(parseInput(idSchema.nullable(), id, 'hunt id')),
    [IPC.huntsAdjustCount]: (_caller, [id, delta, source]) =>
      store.adjustCount(
        huntId(id),
        parseInput(inputSchemas.delta, delta, 'count change'),
        parseInput(inputSchemas.counterSource, source, 'counter source'),
      ),
    [IPC.huntsSetCount]: (_caller, [id, count, source]) =>
      store.setCount(
        huntId(id),
        parseInput(inputSchemas.count, count, 'count'),
        parseInput(inputSchemas.counterSource, source, 'counter source'),
      ),
    // The contract resolves with the hunt; the new phase id travels in the `hunt-changed` event.
    [IPC.huntsLogPhase]: (_caller, [id, input]) =>
      store.logPhase(huntId(id), parseInput(inputSchemas.logPhase, input ?? {}, 'phase')).hunt,
    [IPC.huntsUpdatePhase]: (_caller, [id, phase, patch]) =>
      store.updatePhase(
        huntId(id),
        phaseId(phase),
        parseInput(inputSchemas.phasePatch, patch, 'phase changes'),
      ),
    [IPC.huntsRemovePhase]: (_caller, [id, phase]) => store.removePhase(huntId(id), phaseId(phase)),
    [IPC.huntsComplete]: (_caller, [id, input]) =>
      store.completeHunt(
        huntId(id),
        parseInput(inputSchemas.completeHunt, input ?? {}, 'completion details'),
      ),
    [IPC.huntsReopen]: (_caller, [id]) => store.reopenHunt(huntId(id)),
    [IPC.huntsUndo]: (caller, [id]) =>
      store.undo(huntId(id), caller.kind === 'overlay' ? 'overlay' : 'ui'),
    [IPC.huntsRequestShinyFound]: (_caller, [id, source]) =>
      shiny.request(huntId(id), parseInput(inputSchemas.counterSource, source, 'counter source')),

    [IPC.settingsUpdate]: (_caller, [patch]) =>
      store.updateSettings(parseInput(inputSchemas.settingsPatch, patch, 'settings')),
    [IPC.settingsReset]: () => store.resetSettings(),

    [IPC.hotkeysGetStatus]: () => hotkeys.getStatus(),
    [IPC.streamDeckGetStatus]: () => streamDeck.getStatus(),
    [IPC.streamDeckInstallPlugin]: () => streamDeck.installPlugin(),
    [IPC.hotkeysSetCapturing]: (caller, [flag]) => {
      const capturing = parseInput(flagSchema, flag, 'recording flag');
      if (caller.kind !== 'main') throw new Error('Shortcuts are recorded in the main window');
      hotkeys.setCapturing(capturing);
    },

    [IPC.windowGetState]: (caller) => windows.getStateInfo(caller.kind),
    [IPC.windowSetAlwaysOnTop]: (_caller, [pinned]) =>
      windows.setAlwaysOnTop(parseInput(flagSchema, pinned, 'pin flag')),
    [IPC.windowSetOverlayOpen]: (caller, [flag]) => {
      const open = parseInput(flagSchema, flag, 'overlay flag');
      // The overlay closing itself: answer first, its frame is gone once the window is destroyed.
      if (!open && caller.kind === 'overlay') setImmediate(() => windows.setOverlayOpen(false));
      else windows.setOverlayOpen(open);
    },

    [IPC.dataExport]: (_caller, [request]) => exportData(request),
    [IPC.dataImport]: (_caller, [request]) => importData(request),
    [IPC.dataGetPath]: () => deps.dataDir,
    [IPC.dataRevealFolder]: async () => {
      const problem = await shell.openPath(deps.dataDir);
      if (problem !== '') throw new Error(`The data folder could not be opened: ${problem}`);
    },

    [IPC.shellOpenExternal]: (_caller, [url]) =>
      openExternalLink(parseInput(urlSchema, url, 'link')),
  };

  const sendHandlers: Record<SendChannel, SendHandler> = {
    [IPC.windowMinimize]: ({ kind }) => windows.minimize(kind),
    [IPC.windowToggleMaximize]: ({ kind }) => windows.toggleMaximize(kind),
    [IPC.windowClose]: ({ kind }) => {
      if (kind === 'main') deps.quit();
      else setImmediate(() => windows.setOverlayOpen(false));
    },
    [IPC.windowResizeOverlay]: ({ kind }, [size]) => {
      if (kind !== 'overlay') return;
      windows.resizeOverlay(parseInput(overlaySizeSchema, size, 'overlay size'));
    },
    [IPC.smokeReady]: ({ kind }, [info]) => {
      if (deps.onSmokeReady === undefined) return;
      const { errors } = parseInput(smokeReadySchema, info, 'smoke report');
      deps.onSmokeReady({ windowKind: kind, errors });
    },
  };

  for (const [channel, handler] of Object.entries(invokeHandlers)) {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      const kind = identify(event);
      if (kind === null) {
        log(`Rejected "${channel}" from an untrusted sender`);
        throw new Error(UNTRUSTED_SENDER_MESSAGE);
      }
      try {
        return { ok: true, value: await handler({ kind }, args) };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    });
  }

  const listeners = Object.entries(sendHandlers).map(([channel, handler]) => {
    const listener = (event: IpcMainEvent, ...args: unknown[]): void => {
      const kind = identify(event);
      if (kind === null) {
        log(`Ignored "${channel}" from an untrusted sender`);
        return;
      }
      try {
        handler({ kind }, args);
      } catch (error) {
        // Nobody is waiting for an answer on these channels.
        log(`"${channel}" failed`, error);
      }
    };
    ipcMain.on(channel, listener);
    return { channel, listener };
  });

  const stopForwarding = store.subscribe((event) => windows.broadcast(IPC.stateEvent, event));

  return () => {
    stopForwarding();
    for (const channel of Object.keys(invokeHandlers)) ipcMain.removeHandler(channel);
    for (const { channel, listener } of listeners) ipcMain.removeListener(channel, listener);
  };
}
