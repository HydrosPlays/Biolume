/**
 * The two windows of the app and everything about where and how they appear.
 *
 *   main     frameless (the renderer draws the title bar); bounds, maximized and
 *            always-on-top state persist in `window-state.json`
 *   overlay  the "Mini-Overlay": a separate transparent, frameless, always-on-top,
 *            non-focusable window that floats over a game — a separate window
 *            because transparency cannot be toggled on a live one
 *
 * Placement decisions are pure functions in `windowGeometry.ts`; this module
 * applies them to `BrowserWindow`s.
 */
import { BrowserWindow, screen, type WebContents, type WebPreferences } from 'electron';
import { APP_VERSION_ARG, IPC, OVERLAY_SIZE_LIMITS, WINDOW_KIND_ARG } from '@shared/ipc';
// Copied into out/main/chunks by electron-vite; resolves to an absolute path in dev and when packaged.
import windowIcon from '../../build/icon-256.png?asset';
import type { Settings, WindowKind, WindowStateInfo } from '@shared/types';
import type { Storage } from './storage';
import {
  clampOverlayScale,
  clampOverlaySize,
  defaultWindowState,
  isReachable,
  keepInside,
  MAIN_WINDOW_SIZE,
  parseWindowState,
  resizeAnchored,
  resolveMainBounds,
  resolveOverlayBounds,
  scaleOverlaySize,
  serializeWindowState,
  WINDOW_STATE_FILE,
  type DisplayLike,
  type Size,
} from './windowGeometry';

/** What happened to the main window — the hotkey mode depends on it. */
export type MainWindowActivity =
  'focus' | 'blur' | 'show' | 'hide' | 'minimize' | 'restore' | 'reload' | 'closed';

export interface WindowManagerOptions {
  /** Where `window-state.json` lives. */
  storage: Pick<Storage, 'readJson' | 'writeJson'>;
  /** The current settings; read whenever the overlay is (re)configured. */
  getSettings: () => Settings;
  /** Absolute path of the built preload script. */
  preloadPath: string;
  /** Absolute path of the built renderer entry (`index.html`). */
  rendererFile: string;
  /** Dev-server URL to load instead of `rendererFile` (development only). */
  devServerUrl: string | null;
  /** Handed to the preload, which exposes it as `window.biolume.versions.app`. */
  appVersion: string;
  allowDevTools: boolean;
  /** Smoke mode: windows are created and rendered, but never shown or focused. */
  headless?: boolean;
  /** The main window is gone; the app is expected to quit. */
  onMainClosed: () => void;
  /** Windows is logging off or shutting down — `before-quit` will not fire. */
  onSessionEnd?: () => void;
  log?: (message: string, detail?: unknown) => void;
}

export interface WindowManager {
  /** Creates the main window, or returns the existing one. */
  createMainWindow(): BrowserWindow;
  getMainWindow(): BrowserWindow | null;
  getOverlayWindow(): BrowserWindow | null;
  /** Which of our windows `contents` belongs to; null for anything else. */
  kindOf(contents: WebContents): WindowKind | null;
  /** True while the main window is visible, not minimized and holds keyboard focus. */
  isMainFocused(): boolean;
  isOverlayOpen(): boolean;
  /** Brings the main window back in front, whatever state it was in (second launch). */
  revealMain(): void;
  setOverlayOpen(open: boolean): void;
  toggleOverlay(): void;
  /** Fits the overlay to its content, given in CSS pixels before the overlay scale. */
  resizeOverlay(size: Partial<Size>): void;
  setAlwaysOnTop(pinned: boolean): void;
  minimize(kind: WindowKind): void;
  toggleMaximize(kind: WindowKind): void;
  getStateInfo(kind: WindowKind): WindowStateInfo;
  /** Re-applies everything that depends on settings (overlay window size, click-through, …). */
  applySettings(settings: Settings): void;
  /** Sends `payload` on `channel` to every open window. */
  broadcast(channel: string, payload: unknown): void;
  /** Captures the current window state and hands it to storage right away. */
  persistState(): void;
  onMainActivity(listener: (activity: MainWindowActivity) => void): () => void;
  /** Stops timers and listeners and closes the overlay. */
  dispose(): void;
}

const SAVE_DEBOUNCE_MS = 250;
/** A renderer that never paints must not leave the app running invisibly. */
const REVEAL_FALLBACK_MS = 5_000;
/** Automatic reloads of a crashed renderer per minute before giving up. */
const MAX_RELOADS_PER_MINUTE = 3;
const BACKGROUND_COLOR = '#01040a';
/**
 * The level a pinned main window is given. Electron's default, `floating`, is special on
 * Windows: such a window is re-inserted directly below the taskbar, and the taskbar gives up its
 * own topmost status while a full-screen application is in front — taking the window's with it.
 * Pinning would then silently do nothing exactly when Biolume sits next to a full-screen game.
 * Any level outside Electron's "behind the taskbar" list is a plain topmost window there.
 */
const PIN_LEVEL = process.platform === 'win32' ? 'pop-up-menu' : 'floating';

function alive(win: BrowserWindow | null): win is BrowserWindow {
  return win !== null && !win.isDestroyed();
}

export function createWindowManager(options: WindowManagerOptions): WindowManager {
  const headless = options.headless === true;
  const log = options.log ?? (() => undefined);

  const state = options.storage.readJson(WINDOW_STATE_FILE, defaultWindowState(), parseWindowState);

  let main: BrowserWindow | null = null;
  let overlay: BrowserWindow | null = null;
  let mainFocused = false;
  /** The main window is hidden because the overlay took its place. */
  let hiddenForOverlay = false;
  /** Last content size the overlay reported, in CSS pixels before the overlay scale. */
  let overlayContent: Size = clampOverlaySize(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const lastSent: Record<WindowKind, string | null> = { main: null, overlay: null };
  const activityListeners = new Set<(activity: MainWindowActivity) => void>();
  let reloadTimes: number[] = [];

  const displays = (): DisplayLike[] =>
    screen.getAllDisplays().map(({ workArea }) => ({ workArea }));

  const webPreferences = (kind: WindowKind): WebPreferences => ({
    preload: options.preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    // The hidden main window keeps reacting to hotkey counts and playing their sounds.
    backgroundThrottling: false,
    autoplayPolicy: 'no-user-gesture-required',
    devTools: options.allowDevTools,
    additionalArguments: [`${WINDOW_KIND_ARG}${kind}`, `${APP_VERSION_ARG}${options.appVersion}`],
  });

  const load = (win: BrowserWindow, kind: WindowKind): void => {
    const loading =
      options.devServerUrl !== null
        ? win.loadURL(options.devServerUrl)
        : win.loadFile(options.rendererFile);
    loading.catch((error: unknown) => log(`The ${kind} window failed to load`, error));
  };

  // ───────────────────────────── Persistence ─────────────────────────────

  const captureState = (): void => {
    if (alive(main)) {
      // Normal bounds: what the window returns to after being maximized or minimized.
      state.bounds = main.getNormalBounds();
      state.maximized = main.isMaximized();
      state.alwaysOnTop = main.isAlwaysOnTop();
    }
    if (alive(overlay)) {
      const { x, y } = overlay.getBounds();
      state.overlayPosition = { x, y };
    }
  };

  const persistState = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      captureState();
      options.storage.writeJson(WINDOW_STATE_FILE, serializeWindowState(state));
    } catch (error) {
      log('Could not save the window state', error);
    }
  };

  /** Move and resize fire continuously while dragging; one save after the last event is enough. */
  const scheduleSave = (): void => {
    if (disposed) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistState, SAVE_DEBOUNCE_MS);
  };

  // ───────────────────────────── State broadcast ─────────────────────────────

  const getStateInfo = (kind: WindowKind): WindowStateInfo => ({
    kind,
    maximized: kind === 'main' && alive(main) ? main.isMaximized() : false,
    // The overlay is not focusable, so it never reports focus.
    focused: kind === 'main' ? isMainFocused() : false,
    alwaysOnTop: alive(main) ? main.isAlwaysOnTop() : state.alwaysOnTop,
    overlayOpen: alive(overlay),
  });

  const sendTo = (win: BrowserWindow | null, channel: string, payload: unknown): void => {
    if (!alive(win)) return;
    const contents = win.webContents;
    if (contents.isDestroyed() || contents.isCrashed()) return;
    try {
      contents.send(channel, payload);
    } catch (error) {
      // The frame can be torn down between the checks above and the send.
      log(`Could not send ${channel}`, error);
    }
  };

  const broadcast = (channel: string, payload: unknown): void => {
    sendTo(main, channel, payload);
    sendTo(overlay, channel, payload);
  };

  /** Tells each window its own `WindowStateInfo`, but only when it actually changed. */
  const broadcastState = (): void => {
    for (const kind of ['main', 'overlay'] as const) {
      const win = kind === 'main' ? main : overlay;
      if (!alive(win)) {
        lastSent[kind] = null;
        continue;
      }
      const info = getStateInfo(kind);
      const signature = JSON.stringify(info);
      if (lastSent[kind] === signature) continue;
      lastSent[kind] = signature;
      sendTo(win, IPC.windowStateEvent, info);
    }
  };

  const notifyActivity = (activity: MainWindowActivity): void => {
    for (const listener of [...activityListeners]) {
      try {
        listener(activity);
      } catch (error) {
        log(`A main-window listener failed on "${activity}"`, error);
      }
    }
  };

  function isMainFocused(): boolean {
    return mainFocused && alive(main) && main.isVisible() && !main.isMinimized();
  }

  // ───────────────────────────── Main window ─────────────────────────────

  /** Reloads a renderer that crashed, unless it keeps crashing. */
  const recover = (win: BrowserWindow, kind: WindowKind, reason: string): void => {
    log(`The ${kind} renderer stopped (${reason})`);
    if (!alive(win)) return;
    const now = Date.now();
    reloadTimes = reloadTimes.filter((at) => now - at < 60_000);
    if (reloadTimes.length >= MAX_RELOADS_PER_MINUTE) return;
    reloadTimes.push(now);
    win.webContents.reload();
  };

  const createMainWindow = (): BrowserWindow => {
    if (alive(main)) return main;

    const bounds = resolveMainBounds(state.bounds, displays(), screen.getPrimaryDisplay());
    const win = new BrowserWindow({
      ...bounds,
      minWidth: MAIN_WINDOW_SIZE.minWidth,
      minHeight: MAIN_WINDOW_SIZE.minHeight,
      title: 'Biolume',
      // Taskbar and Alt+Tab; the packaged exe carries the same artwork as build/icon.ico.
      icon: windowIcon,
      // The renderer draws the title bar and window controls; drag regions are CSS.
      frame: false,
      backgroundColor: BACKGROUND_COLOR,
      // Shown on `ready-to-show`, so there is never a white flash.
      show: false,
      webPreferences: webPreferences('main'),
    });
    main = win;
    mainFocused = false;
    // Not the `alwaysOnTop` constructor option: that one always uses the default level.
    if (state.alwaysOnTop) win.setAlwaysOnTop(true, PIN_LEVEL);

    let revealed = false;
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    const reveal = (): void => {
      if (revealTimer !== null) clearTimeout(revealTimer);
      revealTimer = null;
      if (revealed) return;
      revealed = true;
      if (headless || !alive(win) || hiddenForOverlay) return;
      if (state.maximized) win.maximize();
      win.show();
    };
    revealTimer = setTimeout(reveal, REVEAL_FALLBACK_MS);
    win.once('ready-to-show', reveal);

    win.on('focus', () => {
      mainFocused = true;
      broadcastState();
      notifyActivity('focus');
    });
    win.on('blur', () => {
      mainFocused = false;
      broadcastState();
      notifyActivity('blur');
    });
    win.on('show', () => {
      mainFocused = win.isFocused();
      broadcastState();
      notifyActivity('show');
    });
    win.on('hide', () => {
      mainFocused = false;
      broadcastState();
      notifyActivity('hide');
    });
    win.on('minimize', () => {
      mainFocused = false;
      broadcastState();
      notifyActivity('minimize');
    });
    win.on('restore', () => {
      mainFocused = win.isFocused();
      broadcastState();
      notifyActivity('restore');
    });

    const onMaximizeChange = (): void => {
      scheduleSave();
      broadcastState();
    };
    win.on('maximize', onMaximizeChange);
    win.on('unmaximize', onMaximizeChange);
    win.on('resize', scheduleSave);
    win.on('move', scheduleSave);
    win.on('always-on-top-changed', () => {
      scheduleSave();
      broadcastState();
    });

    win.on('session-end', () => {
      persistState();
      options.onSessionEnd?.();
    });
    // Capture the bounds while the window still has them.
    win.on('close', persistState);
    win.on('closed', () => {
      if (revealTimer !== null) clearTimeout(revealTimer);
      revealTimer = null;
      if (main === win) main = null;
      mainFocused = false;
      lastSent.main = null;
      destroyOverlay();
      notifyActivity('closed');
      options.onMainClosed();
    });

    win.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) notifyActivity('reload');
    });
    win.webContents.on('dom-ready', () => {
      if (main === win) resetPageZoom(win.webContents);
    });
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation replaced by another one, not a failure.
      if (!isMainFrame || code === -3) return;
      log(`The main window could not load ${url}: ${description} (${code})`);
      reveal();
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') recover(win, 'main', details.reason);
    });

    load(win, 'main');
    return win;
  };

  const showMain = (): void => {
    hiddenForOverlay = false;
    if (headless || !alive(main)) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  };

  // ───────────────────────────── Overlay ─────────────────────────────

  /**
   * Sizes the overlay window to its content at the overlay scale. The scaling itself happens
   * in the overlay's renderer (CSS zoom on its root element, from `settings.overlay.scale`):
   * Chromium keys page zoom by origin and both windows share one, so `setZoomFactor` on the
   * overlay would zoom the main window too.
   */
  const fitOverlay = (): void => {
    if (!alive(overlay)) return;
    const scale = clampOverlayScale(options.getSettings().overlay.scale);
    const size = scaleOverlaySize(overlayContent, scale);
    const current = overlay.getBounds();
    if (current.width !== size.width || current.height !== size.height) {
      const { workArea } = screen.getDisplayMatching(current);
      overlay.setBounds(resizeAnchored(current, size, workArea));
    }
  };

  /**
   * Biolume never uses page zoom, but Chromium remembers it per origin: this undoes a factor
   * left behind by an earlier build that zoomed the overlay window.
   */
  const resetPageZoom = (contents: WebContents): void => {
    try {
      if (!contents.isDestroyed() && Math.abs(contents.getZoomFactor() - 1) > 0.001) {
        contents.setZoomFactor(1);
      }
    } catch (error) {
      log('Could not reset the page zoom', error);
    }
  };

  const applyOverlayMouse = (settings: Settings): void => {
    if (!alive(overlay)) return;
    // `forward` keeps mouse-move events flowing so hover styles still work while clicks fall through.
    overlay.setIgnoreMouseEvents(settings.overlay.clickThrough, { forward: true });
  };

  const openOverlay = (): void => {
    if (alive(overlay)) return;

    const settings = options.getSettings();
    overlayContent = clampOverlaySize({
      width: OVERLAY_SIZE_LIMITS.width.default,
      height: OVERLAY_SIZE_LIMITS.height.default,
    });
    const size = scaleOverlaySize(overlayContent, settings.overlay.scale);
    const bounds = resolveOverlayBounds(
      state.overlayPosition,
      size,
      displays(),
      screen.getPrimaryDisplay(),
    );

    const win = new BrowserWindow({
      ...bounds,
      title: 'Biolume overlay',
      icon: windowIcon,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // Clicking the overlay must never take keyboard focus away from the game.
      focusable: false,
      webPreferences: webPreferences('overlay'),
    });
    overlay = win;

    // The highest level, so the overlay also floats above borderless-fullscreen games.
    win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform !== 'win32') {
      try {
        win.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      } catch (error) {
        log('The overlay could not be made visible on all workspaces', error);
      }
    }
    applyOverlayMouse(settings);

    win.webContents.on('dom-ready', () => {
      if (overlay === win) resetPageZoom(win.webContents);
    });

    win.once('ready-to-show', () => {
      if (overlay !== win || !alive(win)) return;
      if (!headless) win.showInactive();
      // Only now: a hidden main window with no overlay on screen would strand the user.
      if (options.getSettings().overlay.hideMainWindow && alive(main) && !headless) {
        hiddenForOverlay = true;
        main.hide();
      }
    });

    win.on('move', scheduleSave);
    win.on('closed', () => {
      // Closed behind our back; `destroyOverlay` has already cleaned up otherwise.
      if (overlay !== win) return;
      overlay = null;
      lastSent.overlay = null;
      showMain();
      broadcastState();
    });
    win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3 || overlay !== win) return;
      log(`The overlay could not load: ${description} (${code})`);
      closeOverlay();
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || overlay !== win) return;
      log(`The overlay renderer stopped (${details.reason})`);
      closeOverlay();
    });

    load(win, 'overlay');
    broadcastState();
  };

  /** Destroys the overlay without touching the main window. */
  function destroyOverlay(): boolean {
    const win = overlay;
    if (win === null) return false;
    if (alive(win)) {
      const { x, y } = win.getBounds();
      state.overlayPosition = { x, y };
    }
    overlay = null;
    lastSent.overlay = null;
    if (!win.isDestroyed()) win.destroy();
    return true;
  }

  function closeOverlay(): void {
    if (!destroyOverlay()) return;
    scheduleSave();
    showMain();
    broadcastState();
  }

  // ───────────────────────────── Displays ─────────────────────────────

  /** A display was unplugged or changed resolution: pull stranded windows back on-screen. */
  const keepOnScreen = (): void => {
    if (alive(overlay)) {
      const current = overlay.getBounds();
      const next = keepInside(current, screen.getDisplayMatching(current).workArea);
      if (next.x !== current.x || next.y !== current.y) overlay.setBounds(next);
    }
    if (alive(main) && !main.isMaximized() && !main.isMinimized() && !main.isFullScreen()) {
      const current = main.getBounds();
      if (!isReachable(current, displays())) {
        main.setBounds(resolveMainBounds(current, displays(), screen.getPrimaryDisplay()));
      }
    }
  };
  screen.on('display-added', keepOnScreen);
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);

  // ───────────────────────────── Public API ─────────────────────────────

  return {
    createMainWindow,
    getMainWindow: () => (alive(main) ? main : null),
    getOverlayWindow: () => (alive(overlay) ? overlay : null),

    kindOf(contents) {
      try {
        if (alive(main) && main.webContents.id === contents.id) return 'main';
        if (alive(overlay) && overlay.webContents.id === contents.id) return 'overlay';
      } catch {
        // A destroyed web contents has no id any more.
      }
      return null;
    },

    isMainFocused,
    isOverlayOpen: () => alive(overlay),

    revealMain() {
      if (disposed || headless) return;
      if (!alive(main)) {
        createMainWindow();
        return;
      }
      showMain();
    },

    setOverlayOpen(open) {
      if (disposed) return;
      if (open) openOverlay();
      else closeOverlay();
    },

    toggleOverlay() {
      if (disposed) return;
      if (alive(overlay)) closeOverlay();
      else openOverlay();
    },

    resizeOverlay(size) {
      if (!alive(overlay)) return;
      overlayContent = clampOverlaySize(size);
      fitOverlay();
    },

    setAlwaysOnTop(pinned) {
      state.alwaysOnTop = pinned;
      if (alive(main)) main.setAlwaysOnTop(pinned, PIN_LEVEL);
      scheduleSave();
      broadcastState();
    },

    minimize(kind) {
      // The overlay is not minimizable; closing it is the way to get it out of the way.
      if (kind === 'main' && alive(main)) main.minimize();
    },

    toggleMaximize(kind) {
      if (kind !== 'main' || !alive(main)) return;
      if (main.isMaximized()) main.unmaximize();
      else main.maximize();
    },

    getStateInfo,

    applySettings(settings) {
      if (!alive(overlay)) return;
      applyOverlayMouse(settings);
      fitOverlay();
      // Turning "hide main window" off brings it back; turning it on waits for the next open,
      // because the switch is flipped in the very window that would disappear.
      if (!settings.overlay.hideMainWindow && hiddenForOverlay) {
        hiddenForOverlay = false;
        if (alive(main) && !headless) main.showInactive();
      }
    },

    broadcast,
    persistState,

    onMainActivity(listener) {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      screen.removeListener('display-added', keepOnScreen);
      screen.removeListener('display-removed', keepOnScreen);
      screen.removeListener('display-metrics-changed', keepOnScreen);
      destroyOverlay();
      activityListeners.clear();
    },
  };
}
