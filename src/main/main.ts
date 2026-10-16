/**
 * Biolume main process: application bootstrap.
 *
 *   storage.ts / store.ts   AppState, persisted as JSON in userData
 *   windows.ts              the main window and the mini-overlay
 *   hotkeyController.ts     the global hotkeys (decisions in hotkeyPlan.ts)
 *   shinyConfirm.ts         Shiny Found's two-press confirmation (hotkeys, Stream Deck)
 *   streamDeckBridge.ts     the local HTTP bridge the Stream Deck plugin talks to
 *   ipcHandlers.ts          the `window.biolume` bridge (see preload.ts)
 *   security.ts             navigation, window-open and permission guards
 *   smoke.ts                the end-to-end check, loaded only for `--smoke`
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { app, dialog, globalShortcut, Menu, shell } from 'electron';
import { IPC } from '@shared/ipc';
import { STREAM_DECK_DEFAULT_PORT } from '@shared/streamDeck';
import { describeError } from './dataFiles';
import { createHotkeyController, type HotkeyController } from './hotkeyController';
import { registerIpcHandlers, type SmokeReadyInfo } from './ipcHandlers';
import { installSecurityGuards } from './security';
import { createShinyConfirm, type ShinyConfirm } from './shinyConfirm';
import { createStorage } from './storage';
import { createAppStore } from './store';
import { createStreamDeckBridge, type StreamDeckBridge } from './streamDeckBridge';
import { isPluginBundled, openBundledPlugin, resolveBundledPluginPath } from './streamDeckPlugin';
import { createAppUrlPolicy, parseDevServerUrl } from './urlPolicy';
import { createWindowManager } from './windows';

type Logger = (message: string, detail?: unknown) => void;

const report: Logger = (message, detail) => {
  if (detail === undefined) console.error(`[biolume] ${message}`);
  else console.error(`[biolume] ${message}`, detail);
};

// ───────────────────────────── Bootstrap ─────────────────────────────

const SMOKE_FLAG = '--smoke';
const SMOKE_DIR_PREFIX = 'biolume-smoke-';
const APP_USER_MODEL_ID = 'app.biolume.desktop';
const MAX_RECORDED_ERRORS = 50;

function isSmokeRun(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === SMOKE_FLAG || arg.startsWith(`${SMOKE_FLAG}=`));
}

/**
 * Points userData somewhere else — a fresh temp directory for a smoke run, or
 * `BIOLUME_USER_DATA` — so tests never touch real hunts. Must run before the
 * app is ready, and before the single-instance lock, which is keyed by userData.
 */
function redirectUserData(smoke: boolean): void {
  if (smoke) {
    app.setPath('userData', mkdtempSync(join(tmpdir(), SMOKE_DIR_PREFIX)));
    return;
  }
  const override = process.env['BIOLUME_USER_DATA']?.trim();
  if (!override) return;
  const directory = resolve(override);
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}

/** Development only: the default menu is gone, these shortcuts stay. */
function buildDevMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Developer',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }],
    },
  ]);
}

interface Runtime {
  windows: ReturnType<typeof createWindowManager>;
  hotkeys: HotkeyController;
  shiny: ShinyConfirm;
  streamDeck: StreamDeckBridge;
  /** Writes everything that is still in memory: window state, the open session, pending saves. */
  persist(): void;
}

async function launch(smoke: boolean, mainErrors: string[]): Promise<Runtime> {
  const isDev = !app.isPackaged && !smoke;
  // A packaged app (and a smoke run) only ever loads its own bundled renderer.
  const devServerUrl = isDev
    ? (parseDevServerUrl(process.env['ELECTRON_RENDERER_URL'])?.href ?? null)
    : null;
  // electron-vite layout: out/main/main.js, out/preload/preload.js, out/renderer/index.html.
  const preloadPath = join(__dirname, '../preload/preload.js');
  const rendererFile = join(__dirname, '../renderer/index.html');
  const dataDir = app.getPath('userData');

  const storage = createStorage(dataDir, {
    // Also receives notices about recoveries (a corrupt file moved aside, a backup restored).
    onError: (error, file) => report(`storage: ${file}: ${error.message}`),
  });
  const store = createAppStore(storage, {
    onListenerError: (error) => report('A state listener failed', error),
  });

  const policy = createAppUrlPolicy({ rendererFile, devServerUrl });
  installSecurityGuards({ policy, allowDevTools: isDev, log: report });
  Menu.setApplicationMenu(isDev ? buildDevMenu() : null);

  const persist = (): void => {
    for (const task of [
      () => windows.persistState(),
      () => store.closeSessions(),
      () => store.flushSync(),
    ]) {
      try {
        task();
      } catch (error) {
        report('Could not save on shutdown', error);
      }
    }
  };

  const windows = createWindowManager({
    storage,
    getSettings: () => store.getState().settings,
    preloadPath,
    rendererFile,
    devServerUrl,
    appVersion: app.getVersion(),
    allowDevTools: isDev,
    headless: smoke,
    onMainClosed: () => app.quit(),
    onSessionEnd: persist,
    log: report,
  });

  const shiny = createShinyConfirm({ store, log: report });
  shiny.subscribe((event) => windows.broadcast(IPC.huntsShinyArmedEvent, event));

  const hotkeys = createHotkeyController({
    shortcuts: globalShortcut,
    store,
    shiny,
    host: windows,
    log: report,
  });

  const pluginPath = resolveBundledPluginPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const streamDeck = createStreamDeckBridge({
    store,
    shiny,
    toggleOverlay: () => windows.toggleOverlay(),
    pairingDir: dataDir,
    appVersion: app.getVersion(),
    // A smoke run never takes the port a real Biolume (and its paired plugin) would use.
    port: smoke ? 0 : STREAM_DECK_DEFAULT_PORT,
    isPluginBundled: () => isPluginBundled(pluginPath),
    log: report,
  });
  streamDeck.onStatus((status) => windows.broadcast(IPC.streamDeckStatusEvent, status));

  let smokeReadyListener: ((info: SmokeReadyInfo) => void) | null = null;
  registerIpcHandlers({
    store,
    windows,
    hotkeys,
    shiny,
    streamDeck: {
      getStatus: () => streamDeck.getStatus(),
      installPlugin: () => openBundledPlugin(pluginPath, (path) => shell.openPath(path)),
    },
    policy,
    dataDir,
    quit: () => app.quit(),
    ...(smoke ? { onSmokeReady: (info: SmokeReadyInfo) => smokeReadyListener?.(info) } : {}),
    log: report,
  });

  const applyStreamDeck = (enabled: boolean): void => {
    streamDeck.setEnabled(enabled).catch((error: unknown) => report('Stream Deck bridge', error));
  };
  store.subscribe((event) => {
    if (event.type === 'settings-changed') {
      windows.applySettings(event.settings);
      hotkeys.refresh();
      applyStreamDeck(event.settings.streamDeck.enabled);
    } else if (event.type === 'state-replaced') {
      windows.applySettings(event.state.settings);
      hotkeys.refresh();
      applyStreamDeck(event.state.settings.streamDeck.enabled);
    }
  });
  applyStreamDeck(store.getState().settings.streamDeck.enabled);
  windows.onMainActivity((activity) => hotkeys.handleMainActivity(activity));

  if (smoke) {
    const { runSmoke } = await import('./smoke');
    void runSmoke({
      store,
      windows,
      hotkeys,
      streamDeck,
      setReadyListener: (listener) => {
        smokeReadyListener = listener;
      },
      persist,
      dataDir,
      mainErrors,
    });
  } else {
    windows.createMainWindow();
    hotkeys.refresh();
  }

  return { windows, hotkeys, shiny, streamDeck, persist };
}

function start(smoke: boolean): void {
  const mainErrors: string[] = [];
  const record = (label: string, error: unknown): void => {
    report(label, error);
    if (mainErrors.length < MAX_RECORDED_ERRORS) {
      mainErrors.push(`${label}: ${describeError(error)}`);
    }
  };
  // A counter that runs beside a game must not die — or pop up a crash dialog over it —
  // because of one failed callback; state is saved continuously either way.
  process.on('uncaughtException', (error) => record('Uncaught exception', error));
  process.on('unhandledRejection', (reason) => record('Unhandled rejection', reason));

  let runtime: Runtime | null = null;

  app.on('second-instance', () => runtime?.windows.revealMain());
  app.on('activate', () => runtime?.windows.revealMain());
  // Closing the main window quits the app on every platform.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => runtime?.persist());
  app.on('will-quit', () => {
    runtime?.hotkeys.dispose();
    globalShortcut.unregisterAll();
    // Removes the pairing file, so the plugin shows "Offline" instead of retrying a dead port.
    runtime?.streamDeck.shutdown();
    runtime?.shiny.dispose();
    // The windows closed after `before-quit`; their final state is flushed here.
    runtime?.persist();
  });

  app
    .whenReady()
    .then(async () => {
      runtime = await launch(smoke, mainErrors);
    })
    .catch((error: unknown) => {
      report('Biolume could not start', error);
      if (smoke) {
        const result = {
          ok: false,
          steps: [{ name: 'bootstrap', ok: false, detail: describeError(error) }],
          consoleErrors: [],
          hotkeys: null,
        };
        process.stdout.write(`[smoke] ${JSON.stringify(result)}\n`, () => app.exit(1));
        return;
      }
      dialog.showErrorBox('Biolume could not start', describeError(error));
      app.exit(1);
    });
}

function main(): void {
  const smoke = isSmokeRun(process.argv);
  try {
    redirectUserData(smoke);
  } catch (error) {
    dialog.showErrorBox(
      'Biolume could not start',
      `The data folder could not be prepared: ${describeError(error)}`,
    );
    app.exit(1);
    return;
  }

  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

  // A second launch hands over to the running instance, which brings its window to the front.
  if (app.requestSingleInstanceLock()) start(smoke);
  else app.quit();
}

main();
