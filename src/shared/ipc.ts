/**
 * The IPC contract between the main process and renderers.
 *
 * `preload.ts` implements {@link BiolumeApi} on top of `ipcRenderer` and exposes
 * it as `window.biolume` via `contextBridge`; `main.ts` registers a handler for
 * every channel in {@link IPC}. Renderers never touch `ipcRenderer` directly.
 */
import type {
  AppState,
  CompleteHuntInput,
  CounterSource,
  CreateHuntInput,
  ExportRequest,
  ExportResult,
  HotkeyActionEvent,
  HotkeyStatus,
  Hunt,
  HuntPatch,
  ImportRequest,
  ImportResult,
  LogPhaseInput,
  PhasePatch,
  Settings,
  SettingsPatch,
  StateEvent,
  WindowKind,
  WindowStateInfo,
  ShinyArmedEvent,
  ShinyFoundResult,
  StreamDeckStatus,
} from './types';

/** Channel names. `invoke` channels are request/response; `event` channels are main → renderer pushes. */
export const IPC = {
  // state
  stateGet: 'biolume:state:get',
  stateEvent: 'biolume:state:event',

  // hunts
  huntsCreate: 'biolume:hunts:create',
  huntsUpdate: 'biolume:hunts:update',
  huntsRemove: 'biolume:hunts:remove',
  huntsSetActive: 'biolume:hunts:set-active',
  huntsAdjustCount: 'biolume:hunts:adjust-count',
  huntsSetCount: 'biolume:hunts:set-count',
  huntsLogPhase: 'biolume:hunts:log-phase',
  huntsUpdatePhase: 'biolume:hunts:update-phase',
  huntsRemovePhase: 'biolume:hunts:remove-phase',
  huntsComplete: 'biolume:hunts:complete',
  huntsReopen: 'biolume:hunts:reopen',
  huntsUndo: 'biolume:hunts:undo',

  // settings
  settingsUpdate: 'biolume:settings:update',
  settingsReset: 'biolume:settings:reset',

  // hotkeys
  hotkeysGetStatus: 'biolume:hotkeys:get-status',
  hotkeysSetCapturing: 'biolume:hotkeys:set-capturing',
  hotkeysStatusEvent: 'biolume:hotkeys:status-event',
  hotkeysActionEvent: 'biolume:hotkeys:action-event',

  // shiny found (two-press confirmation for hotkeys and the Stream Deck)
  huntsRequestShinyFound: 'biolume:hunts:request-shiny-found',
  huntsShinyArmedEvent: 'biolume:hunts:shiny-armed-event',

  // stream deck bridge
  streamDeckGetStatus: 'biolume:streamdeck:get-status',
  streamDeckStatusEvent: 'biolume:streamdeck:status-event',
  streamDeckInstallPlugin: 'biolume:streamdeck:install-plugin',

  // window
  windowMinimize: 'biolume:window:minimize',
  windowToggleMaximize: 'biolume:window:toggle-maximize',
  windowClose: 'biolume:window:close',
  windowGetState: 'biolume:window:get-state',
  windowSetAlwaysOnTop: 'biolume:window:set-always-on-top',
  windowSetOverlayOpen: 'biolume:window:set-overlay-open',
  windowResizeOverlay: 'biolume:window:resize-overlay',
  windowStateEvent: 'biolume:window:state-event',

  // data
  dataExport: 'biolume:data:export',
  dataImport: 'biolume:data:import',
  dataGetPath: 'biolume:data:get-path',
  dataRevealFolder: 'biolume:data:reveal-folder',

  // shell
  shellOpenExternal: 'biolume:shell:open-external',

  // smoke test (renderer → main once the first frame has painted)
  smokeReady: 'biolume:smoke:ready',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export type Unsubscribe = () => void;

/** Hosts `shell.openExternal` will open; everything else is rejected by main. */
export const EXTERNAL_URL_ALLOWLIST: readonly string[] = [
  'pokeapi.co',
  'bulbapedia.bulbagarden.net',
  'www.serebii.net',
  'serebii.net',
  'github.com',
];

/**
 * Main tags each BrowserWindow through `webPreferences.additionalArguments`
 * (`--biolume-window=overlay`); the preload reads it back from `process.argv`
 * and exposes it as `window.biolume.windowKind`.
 */
export const WINDOW_KIND_ARG = '--biolume-window=';

/**
 * Main passes `app.getVersion()` to the preload the same way
 * (`--biolume-app-version=0.1.0`), so `window.biolume.versions.app` is known
 * synchronously without a blocking IPC round trip.
 */
export const APP_VERSION_ARG = '--biolume-app-version=';

export const OVERLAY_SIZE_LIMITS = {
  width: { min: 160, max: 640, default: 320 },
  height: { min: 56, max: 420, default: 132 },
} as const;

/** Views of the main window, addressable as `#/<id>` in the renderer URL. */
export const VIEW_IDS = ['hunt', 'target', 'odds', 'sandwich', 'log', 'settings'] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export function parseWindowKind(argv: readonly string[]): WindowKind {
  const arg = argv.find((entry) => entry.startsWith(WINDOW_KIND_ARG));
  return arg?.slice(WINDOW_KIND_ARG.length) === 'overlay' ? 'overlay' : 'main';
}

/** The app version main passed through {@link APP_VERSION_ARG}; `0.0.0` when it is missing. */
export function parseAppVersion(argv: readonly string[]): string {
  const arg = argv.find((entry) => entry.startsWith(APP_VERSION_ARG));
  return arg?.slice(APP_VERSION_ARG.length) || '0.0.0';
}

/**
 * Wire format of every request/response (`invoke`) channel. Main answers with
 * this envelope instead of throwing, so its error messages reach the renderer
 * verbatim (a thrown error would arrive wrapped in Electron's "Error invoking
 * remote method" boilerplate). The preload unwraps it and rejects with
 * `new Error(error)`; callers of {@link BiolumeApi} never see the envelope.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface BiolumeApi {
  /** Which window this renderer is running in. */
  readonly windowKind: WindowKind;
  /** `process.platform` of the host, e.g. `win32`. */
  readonly platform: string;
  readonly versions: { app: string; electron: string; chrome: string; node: string };

  state: {
    /** Full snapshot; call once on boot, then follow {@link subscribe}. */
    get(): Promise<AppState>;
    /** Every state change, including ones caused by global hotkeys or the other window. */
    subscribe(listener: (event: StateEvent) => void): Unsubscribe;
  };

  /**
   * Hunt mutations. Each resolves with the updated hunt *and* is broadcast to all
   * windows as a `hunt-changed` {@link StateEvent}. Rejects with an Error when the
   * hunt / phase id is unknown or the input fails validation.
   */
  hunts: {
    create(input: CreateHuntInput): Promise<Hunt>;
    update(huntId: string, patch: HuntPatch): Promise<Hunt>;
    remove(huntId: string): Promise<void>;
    setActive(huntId: string | null): Promise<void>;
    /** Add `delta` (may be negative) to the current-phase count; clamps at 0. */
    adjustCount(huntId: string, delta: number, source: CounterSource): Promise<Hunt>;
    setCount(huntId: string, count: number, source: CounterSource): Promise<Hunt>;
    logPhase(huntId: string, input: LogPhaseInput): Promise<Hunt>;
    updatePhase(huntId: string, phaseId: string, patch: PhasePatch): Promise<Hunt>;
    /** Deletes the log entry only; counts are left untouched (use `undo` to revert a fresh log). */
    removePhase(huntId: string, phaseId: string): Promise<Hunt>;
    /** Mark the target shiny as found. */
    complete(huntId: string, input?: CompleteHuntInput): Promise<Hunt>;
    reopen(huntId: string): Promise<Hunt>;
    /** Revert the hunt's most recent count / phase / completion change. Null when nothing to undo. */
    undo(huntId: string): Promise<Hunt | null>;
    /**
     * Shiny Found with confirmation, for hotkeys and other non-mouse inputs:
     * the first call arms it, a second call within SHINY_CONFIRM_WINDOW_MS
     * completes the hunt. Rejects when the hunt is not active.
     */
    requestShinyFound(huntId: string, source: CounterSource): Promise<ShinyFoundResult>;
    /** A Shiny Found confirmation was armed, confirmed or expired (from any source, incl. the Stream Deck). */
    onShinyArmed(listener: (event: ShinyArmedEvent) => void): Unsubscribe;
  };

  /** The local bridge the Elgato Stream Deck plugin talks to. */
  streamDeck: {
    getStatus(): Promise<StreamDeckStatus>;
    onStatus(listener: (status: StreamDeckStatus) => void): Unsubscribe;
    /**
     * Opens the .streamDeckPlugin bundled with the app, which makes the Stream
     * Deck app offer to install it. Resolves with an error message instead of
     * throwing when the file is missing or nothing handles it.
     */
    installPlugin(): Promise<{ ok: boolean; error?: string }>;
  };

  settings: {
    update(patch: SettingsPatch): Promise<Settings>;
    reset(): Promise<Settings>;
  };

  hotkeys: {
    getStatus(): Promise<HotkeyStatus>;
    /** Suspend global shortcuts while the settings UI records a key combination. */
    setCapturing(capturing: boolean): Promise<void>;
    onStatus(listener: (status: HotkeyStatus) => void): Unsubscribe;
    /** A global hotkey fired (main already applied it) — use for toasts / audio cues. */
    onAction(listener: (event: HotkeyActionEvent) => void): Unsubscribe;
  };

  window: {
    minimize(): void;
    toggleMaximize(): void;
    /** Main window: quits the app. Overlay window: closes the overlay and restores main. */
    close(): void;
    getState(): Promise<WindowStateInfo>;
    onState(listener: (state: WindowStateInfo) => void): Unsubscribe;
    /** Pin / unpin the main window above other windows. */
    setAlwaysOnTop(pinned: boolean): Promise<void>;
    /** Open or close the always-on-top mini-overlay window. */
    setOverlayOpen(open: boolean): Promise<void>;
    /**
     * Overlay window only: fit the window to its rendered content (CSS pixels,
     * before the overlay scale is applied). Main clamps to {@link OVERLAY_SIZE_LIMITS}.
     */
    resizeOverlay(size: { width: number; height: number }): void;
  };

  data: {
    /** Shows a save dialog and writes the requested dataset. */
    exportData(request: ExportRequest): Promise<ExportResult>;
    /** Shows an open dialog, detects the dataset (JSON bundle or CSV header) and imports it. */
    importData(request: ImportRequest): Promise<ImportResult>;
    /** Absolute path of the userData folder holding Biolume's JSON files. */
    getPath(): Promise<string>;
    revealFolder(): Promise<void>;
  };

  shell: {
    /** Opens an https URL whose host is in {@link EXTERNAL_URL_ALLOWLIST} in the default browser. */
    openExternal(url: string): Promise<void>;
  };

  /** Smoke-test hook: tells main the first frame has rendered. No-op outside `--smoke`. */
  smokeReady(info: { windowKind: WindowKind; errors: string[] }): void;
}
