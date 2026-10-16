/**
 * The renderer's only door to the main process.
 *
 * Runs sandboxed and context-isolated: it may import nothing but `electron`
 * and the bundled `@shared` contract. It exposes the typed {@link BiolumeApi}
 * as `window.biolume` and never hands `ipcRenderer` — or an IPC event object —
 * to the page.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  parseAppVersion,
  parseWindowKind,
  type BiolumeApi,
  type IpcResult,
  type Unsubscribe,
} from '@shared/ipc';

/** Calls a request / response channel and unwraps main's {@link IpcResult} envelope. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** Follows a main → renderer push channel, forwarding the payload only. */
function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: BiolumeApi = {
  windowKind: parseWindowKind(process.argv),
  platform: process.platform,
  versions: {
    app: parseAppVersion(process.argv),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
  },

  state: {
    get: () => invoke(IPC.stateGet),
    subscribe: (listener) => subscribe(IPC.stateEvent, listener),
  },

  hunts: {
    create: (input) => invoke(IPC.huntsCreate, input),
    update: (huntId, patch) => invoke(IPC.huntsUpdate, huntId, patch),
    remove: (huntId) => invoke(IPC.huntsRemove, huntId),
    setActive: (huntId) => invoke(IPC.huntsSetActive, huntId),
    adjustCount: (huntId, delta, source) => invoke(IPC.huntsAdjustCount, huntId, delta, source),
    setCount: (huntId, count, source) => invoke(IPC.huntsSetCount, huntId, count, source),
    logPhase: (huntId, input) => invoke(IPC.huntsLogPhase, huntId, input),
    updatePhase: (huntId, phaseId, patch) => invoke(IPC.huntsUpdatePhase, huntId, phaseId, patch),
    removePhase: (huntId, phaseId) => invoke(IPC.huntsRemovePhase, huntId, phaseId),
    complete: (huntId, input) => invoke(IPC.huntsComplete, huntId, input),
    reopen: (huntId) => invoke(IPC.huntsReopen, huntId),
    undo: (huntId) => invoke(IPC.huntsUndo, huntId),
    requestShinyFound: (huntId, source) => invoke(IPC.huntsRequestShinyFound, huntId, source),
    onShinyArmed: (listener) => subscribe(IPC.huntsShinyArmedEvent, listener),
  },

  streamDeck: {
    getStatus: () => invoke(IPC.streamDeckGetStatus),
    onStatus: (listener) => subscribe(IPC.streamDeckStatusEvent, listener),
    installPlugin: () => invoke(IPC.streamDeckInstallPlugin),
  },

  settings: {
    update: (patch) => invoke(IPC.settingsUpdate, patch),
    reset: () => invoke(IPC.settingsReset),
  },

  hotkeys: {
    getStatus: () => invoke(IPC.hotkeysGetStatus),
    setCapturing: (capturing) => invoke(IPC.hotkeysSetCapturing, capturing),
    onStatus: (listener) => subscribe(IPC.hotkeysStatusEvent, listener),
    onAction: (listener) => subscribe(IPC.hotkeysActionEvent, listener),
  },

  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    getState: () => invoke(IPC.windowGetState),
    onState: (listener) => subscribe(IPC.windowStateEvent, listener),
    setAlwaysOnTop: (pinned) => invoke(IPC.windowSetAlwaysOnTop, pinned),
    setOverlayOpen: (open) => invoke(IPC.windowSetOverlayOpen, open),
    resizeOverlay: (size) => ipcRenderer.send(IPC.windowResizeOverlay, size),
  },

  data: {
    exportData: (request) => invoke(IPC.dataExport, request),
    importData: (request) => invoke(IPC.dataImport, request),
    getPath: () => invoke(IPC.dataGetPath),
    revealFolder: () => invoke(IPC.dataRevealFolder),
  },

  shell: {
    openExternal: (url) => invoke(IPC.shellOpenExternal, url),
  },

  smokeReady: (info) => ipcRenderer.send(IPC.smokeReady, info),
};

contextBridge.exposeInMainWorld('biolume', api);
