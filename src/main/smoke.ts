/**
 * `electron . --smoke` — the project's end-to-end check.
 *
 * Runs the real app against a throw-away userData directory without ever
 * showing a window: seeds a demo state, screenshots every view into `.smoke/`,
 * drives the `window.biolume` bridge from inside the renderer, exercises the
 * global hotkeys, the Stream Deck bridge over real HTTP, the overlay,
 * export / import and persistence, and finally
 * prints ONE line `[smoke] <json>` before exiting with 0 (ok), 1 (a step or a
 * renderer console error failed) or 2 (timeout).
 *
 * `main.ts` imports this module dynamically, so none of it is even loaded
 * outside a smoke run.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  app,
  BrowserWindow,
  globalShortcut,
  nativeImage,
  screen,
  type WebContents,
} from 'electron';
import { OVERLAY_SIZE_LIMITS, VIEW_IDS, type BiolumeApi } from '@shared/ipc';
import {
  STREAM_DECK_PAIRING_FILE,
  STREAM_DECK_PROTOCOL_VERSION,
  type BridgeActionResponse,
  type BridgeEvent,
  type BridgePairing,
  type BridgeState,
} from '@shared/streamDeck';
// The same asset windows.ts gives both windows; packaged, it is read from inside app.asar.
import windowIcon from '../../build/icon-256.png?asset';
import type {
  ExportDataset,
  ExportFormat,
  HotkeyAction,
  HotkeyActionEvent,
  HotkeyStatus,
  ShinyArmedEvent,
  StateEvent,
  StreamDeckStatus,
  WindowKind,
} from '@shared/types';
import { describeError, importFromFile, writeExportFile } from './dataFiles';
import { buildExport, parseImport } from './exportImport';
import { SHINY_HOLD_CHECK_MS } from './hotkeyController';
import { DUPLICATE_BINDING_ERROR, findRegistrationMismatches, REPEAT_GUARD_MS } from './hotkeyPlan';
import type { SmokeReadyInfo } from './ipcHandlers';
import {
  buildDemoState,
  countDistinctColors,
  DEMO_ACTIVE_HUNT_ID,
  isRemoteLoadFailure,
} from './smokeSupport';
import { createStorage, HUNTS_FILE, SESSIONS_FILE, SETTINGS_FILE } from './storage';
import type { AppStore } from './store';
import type { StreamDeckBridge } from './streamDeckBridge';
import { WINDOW_STATE_FILE } from './windowGeometry';
import type { WindowManager } from './windows';

export interface SmokeDeps {
  store: AppStore;
  windows: WindowManager;
  hotkeys: {
    getStatus(): HotkeyStatus;
    refresh(): HotkeyStatus;
    trigger(action: HotkeyAction, accelerator: string): void;
  };
  streamDeck: Pick<StreamDeckBridge, 'getStatus' | 'getState' | 'shutdown'>;
  /** Routes the renderers' `smokeReady` signal to the run; null detaches it. */
  setReadyListener(listener: ((info: SmokeReadyInfo) => void) | null): void;
  /** The same save the app performs on quit. */
  persist(): void;
  /** The throw-away userData directory of this run. */
  dataDir: string;
  /** Uncaught main-process errors, collected by `main.ts` since startup. */
  mainErrors: readonly string[];
}

interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

/** `BIOLUME_SMOKE_TOUR=1` adds review screenshots: every view page by page, every Log tab. */
const TOUR = process.env['BIOLUME_SMOKE_TOUR'] === '1';
const TIMEOUT_MS = TOUR ? 120_000 : 60_000;
const READY_TIMEOUT_MS = 15_000;
const VIEW_SETTLE_MS = 700;
/** How long the Target view's locations panel may take to load (PokeAPI games fetch it). */
const LOCATIONS_TIMEOUT_MS = 20_000;
const SMOKE_DIR_PREFIX = 'biolume-smoke-';
/** Temp directories of earlier runs are removed once they are this old. */
const STALE_DIR_MS = 30 * 60_000;

const EXPORTS: readonly (readonly [ExportDataset, ExportFormat])[] = [
  ['backup', 'json'],
  ['sessions', 'json'],
  ['sessions', 'csv'],
  ['phases', 'json'],
  ['phases', 'csv'],
  ['targets', 'json'],
  ['targets', 'csv'],
];

const BRIDGE_KEYS = [
  'data',
  'hotkeys',
  'hunts',
  'platform',
  'settings',
  'shell',
  'smokeReady',
  'state',
  'streamDeck',
  'versions',
  'window',
  'windowKind',
];

/** DOM ids of the settings view's sections, in page order. */
const SETTINGS_SECTIONS = [
  'settings-hotkeys',
  'settings-streamdeck',
  'settings-audio',
  'settings-overlay',
  'settings-general',
  'settings-data',
];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(25);
  }
}

/** Best effort: userData directories of earlier smoke runs pile up in the temp folder otherwise. */
function removeStaleRuns(current: string): void {
  try {
    const root = tmpdir();
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith(SMOKE_DIR_PREFIX)) continue;
      const directory = join(root, entry);
      if (directory === current) continue;
      try {
        if (Date.now() - statSync(directory).mtimeMs > STALE_DIR_MS) {
          rmSync(directory, { recursive: true, force: true });
        }
      } catch {
        // Still in use, or already gone.
      }
    }
  } catch {
    // The temp folder is not listable; nothing to clean.
  }
}

/** Runs `fn` inside the page with `window.biolume` as its first argument. */
function inPage<Args extends unknown[], Result>(
  contents: WebContents,
  fn: (api: BiolumeApi, ...args: Args) => Result | Promise<Result>,
  ...args: Args
): Promise<Result> {
  // The function is shipped as source text, so it must not use anything outside its own body.
  const code = `(${fn.toString()})(window.biolume, ...${JSON.stringify(args)})`;
  return contents.executeJavaScript(code, true) as Promise<Result>;
}

/** Runs in the main window: a tour of the bridge. Everything it returns is asserted in main. */
async function exerciseBridge(api: BiolumeApi, huntId: string) {
  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const rejection = async (call: () => Promise<unknown>): Promise<string | null> => {
    try {
      await call();
      return null;
    } catch (error) {
      return messageOf(error);
    }
  };
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const events: string[] = [];
  const unsubscribe = api.state.subscribe((event) => {
    events.push(
      event.type === 'hunt-changed'
        ? `hunt-changed:${event.change.kind}:${event.change.source}`
        : event.type,
    );
  });
  const windowStates: boolean[] = [];
  const stopWindowStates = api.window.onState((state) => windowStates.push(state.alwaysOnTop));

  const before = (await api.state.get()).hunts.find((hunt) => hunt.id === huntId) ?? null;
  if (before === null) {
    unsubscribe();
    stopWindowStates();
    return null;
  }
  const counted = await api.hunts.adjustCount(huntId, before.step * 3, 'ui');
  const lowered = await api.hunts.adjustCount(huntId, -before.step, 'ui');
  const logged = await api.hunts.logPhase(huntId, { speciesId: 228, speciesName: 'Houndour' });
  const undone = await api.hunts.undo(huntId);
  const settings = await api.settings.update({ audio: { volume: 0.25 } });
  const unknownHunt = await rejection(() => api.hunts.update('no-such-hunt', { name: 'x' }));
  const invalidDelta = await rejection(() => api.hunts.adjustCount(huntId, 1.5, 'ui'));
  const blockedHost = await rejection(() => api.shell.openExternal('https://example.com/'));
  const blockedScheme = await rejection(() => api.shell.openExternal('file:///C:/Windows/win.ini'));

  await api.window.setAlwaysOnTop(true);
  const pinned = (await api.window.getState()).alwaysOnTop;
  await api.window.setAlwaysOnTop(false);
  const windowState = await api.window.getState();

  // Pushed events travel on the same pipe as the replies, but leave a margin anyway.
  await pause(80);
  const eventsWhileSubscribed = [...events];
  unsubscribe();
  stopWindowStates();
  const afterUnsubscribe = await api.hunts.adjustCount(huntId, before.step, 'ui');
  await pause(80);

  return {
    windowKind: api.windowKind,
    platform: api.platform,
    versions: api.versions,
    before,
    counted,
    lowered,
    logged,
    undone,
    afterUnsubscribe,
    volume: settings.audio.volume,
    unknownHunt,
    invalidDelta,
    blockedHost,
    blockedScheme,
    pinned,
    windowState,
    windowStates,
    eventsWhileSubscribed,
    eventsAfterUnsubscribe: events.length - eventsWhileSubscribed.length,
    hotkeyStatus: await api.hotkeys.getStatus(),
    dataPath: await api.data.getPath(),
  };
}

/** Runs in the overlay window. */
async function describeOverlay(api: BiolumeApi) {
  return { windowKind: api.windowKind, state: await api.window.getState() };
}

/** Runs in the overlay window: asks for an absurd size, which main must clamp. */
function requestHugeOverlay(api: BiolumeApi): boolean {
  api.window.resizeOverlay({ width: 50_000, height: 50_000 });
  return true;
}

/** Runs in the overlay window: its own close button. */
function closeFromOverlay(api: BiolumeApi): boolean {
  api.window.close();
  return true;
}

// Plain page script: it pokes at browser globals the main-process typings do not know.
const SECURITY_PROBE = `(async () => {
  const opened = window.open('https://example.com/', '_blank');
  let permission;
  try {
    permission = (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch (error) {
    permission = 'unavailable';
  }
  return {
    nodeGlobals: ['require', 'process', 'module', 'Buffer', 'ipcRenderer'].filter(
      (name) => typeof globalThis[name] !== 'undefined',
    ),
    openedWindow: opened !== null,
    permission,
    bridgeKeys: Object.keys(window.biolume).sort(),
  };
})()`;

interface SecurityProbe {
  nodeGlobals: string[];
  openedWindow: boolean;
  permission: string;
  bridgeKeys: string[];
}

/**
 * Runs in the overlay window. `[data-overlay-root]` is the unscaled frame around the card — its
 * box is what the window has to hold — and `[data-overlay-scale]` inside it carries the CSS zoom.
 */
const MEASURE_OVERLAY = `(() => {
  const root = document.querySelector('[data-overlay-root]');
  const scaler = root === null ? null : root.querySelector('[data-overlay-scale]');
  if (root === null || scaler === null) return { found: false, cssZoom: 0, width: 0, height: 0 };
  const rect = root.getBoundingClientRect();
  return {
    found: true,
    cssZoom: Number(getComputedStyle(scaler).zoom),
    width: rect.width,
    height: rect.height,
  };
})()`;

interface OverlayMeasure {
  found: boolean;
  cssZoom: number;
  width: number;
  height: number;
}

const RECORD_HOTKEY_ACTIONS = `(() => {
  window.__smokeHotkeyActions = [];
  window.biolume.hotkeys.onAction((event) => window.__smokeHotkeyActions.push(event));
  return true;
})()`;

const RECORD_SHINY_ARMED = `(() => {
  window.__smokeShinyArmed = [];
  window.biolume.hunts.onShinyArmed((event) => window.__smokeShinyArmed.push(event));
  return true;
})()`;

const RECORD_STREAM_DECK_STATUS = `(() => {
  window.__smokeStreamDeckStatus = [];
  window.biolume.streamDeck.onStatus((status) => window.__smokeStreamDeckStatus.push(status));
  return true;
})()`;

/** Runs in the main window: Shiny Found through IPC, as the in-app hotkey does it. */
async function exerciseShinyFound(api: BiolumeApi, huntId: string) {
  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const first = await api.hunts.requestShinyFound(huntId, 'hotkey-local');
  const second = await api.hunts.requestShinyFound(huntId, 'hotkey-local');
  const undone = await api.hunts.undo(huntId);
  let unknownHunt: string | null = null;
  try {
    await api.hunts.requestShinyFound('no-such-hunt', 'hotkey-local');
  } catch (error) {
    unknownHunt = messageOf(error);
  }
  let badSource: string | null = null;
  try {
    await api.hunts.requestShinyFound(huntId, 'keyboard' as 'ui');
  } catch (error) {
    badSource = messageOf(error);
  }
  return {
    first: { completed: first.completed, armedUntil: first.armedUntil },
    second: { completed: second.completed, status: second.hunt.status },
    undone: undone?.status ?? null,
    unknownHunt,
    badSource,
    status: await api.streamDeck.getStatus(),
  };
}

interface BridgeReply {
  status: number;
  text: string;
}

const BRIDGE_TIMEOUT_MS = 3_000;

/** One request to the Stream Deck bridge, exactly as a plugin would send it. */
function bridgeCall(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/v1/state',
        headers: options.headers ?? {},
        agent: false,
        timeout: BRIDGE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${options.path ?? '/v1/state'} timed out`)));
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface BridgeEventStream {
  events: BridgeEvent[];
  /** The first event at index `after` or later that matches. */
  next(match: (event: BridgeEvent) => boolean, after?: number): Promise<BridgeEvent>;
  close(): void;
}

function openBridgeEvents(port: number, token: string): Promise<BridgeEventStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/events',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          req.destroy();
          reject(new Error(`GET /v1/events answered ${res.statusCode ?? 0}`));
          return;
        }
        let buffer = '';
        const events: BridgeEvent[] = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of block.split('\n')) {
              if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as BridgeEvent);
            }
          }
        });
        resolve({
          events,
          async next(match, after = 0) {
            let found: BridgeEvent | undefined;
            await until(
              () => (found = events.slice(after).find(match)) !== undefined,
              BRIDGE_TIMEOUT_MS,
              'a Stream Deck event',
            );
            return found as BridgeEvent;
          },
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export async function runSmoke(deps: SmokeDeps): Promise<void> {
  const { store, windows } = deps;
  const startedAt = Date.now();
  const outDir = join(process.cwd(), '.smoke');
  const steps: SmokeStep[] = [];
  const consoleErrors: string[] = [];
  const warnings: string[] = [];
  let hotkeys: HotkeyStatus | null = null;
  let finished = false;

  const finish = (code: 0 | 1 | 2): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    deps.setReadyListener(null);
    try {
      globalShortcut.unregisterAll();
    } catch {
      // Exiting anyway.
    }
    try {
      // `app.exit` skips `will-quit`, where the app normally removes its pairing file.
      deps.streamDeck.shutdown();
    } catch {
      // Exiting anyway.
    }
    const result = {
      ok: code === 0,
      steps,
      consoleErrors,
      hotkeys,
      warnings,
      mainErrors: [...deps.mainErrors],
      dataDir: deps.dataDir,
      durationMs: Date.now() - startedAt,
    };
    const exit = (): void => app.exit(code);
    // stdout may be an asynchronous pipe: leave only once the line is out.
    const fallback = setTimeout(exit, 1_500);
    process.stdout.write(`[smoke] ${JSON.stringify(result)}\n`, () => {
      clearTimeout(fallback);
      exit();
    });
  };

  const timeout = setTimeout(() => {
    steps.push({ name: 'timeout', ok: false, detail: `No result after ${TIMEOUT_MS / 1000} s` });
    finish(2);
  }, TIMEOUT_MS);

  const step = async (name: string, run: () => Promise<string> | string): Promise<boolean> => {
    if (finished) return false;
    try {
      const detail = await run();
      if (!finished) steps.push({ name, ok: true, detail });
      return true;
    } catch (error) {
      if (!finished) steps.push({ name, ok: false, detail: describeError(error) });
      return false;
    }
  };

  // ───────────────────────────── Renderer plumbing ─────────────────────────────

  const readySignals = new Map<WindowKind, SmokeReadyInfo>();
  const readyWaiters = new Map<WindowKind, (info: SmokeReadyInfo) => void>();
  deps.setReadyListener((info) => {
    readySignals.set(info.windowKind, info);
    readyWaiters.get(info.windowKind)?.(info);
  });

  const waitForReady = (kind: WindowKind): Promise<SmokeReadyInfo> =>
    new Promise((resolve, reject) => {
      const early = readySignals.get(kind);
      if (early !== undefined) {
        resolve(early);
        return;
      }
      const timer = setTimeout(() => {
        readyWaiters.delete(kind);
        reject(
          new Error(`The ${kind} renderer did not report ready within ${READY_TIMEOUT_MS} ms`),
        );
      }, READY_TIMEOUT_MS);
      readyWaiters.set(kind, (info) => {
        clearTimeout(timer);
        readyWaiters.delete(kind);
        resolve(info);
      });
    });

  const watch = (contents: WebContents, kind: WindowKind): void => {
    contents.on('console-message', (event) => {
      if (event.level !== 'error') return;
      const origin = event.sourceId === '' ? '' : ` (${event.sourceId}:${event.lineNumber})`;
      const entry = `[${kind}] ${event.message}${origin}`;
      // The machine may be offline; a sprite that does not load is not a broken app.
      if (isRemoteLoadFailure(event.message, event.sourceId)) warnings.push(entry);
      else consoleErrors.push(entry);
    });
    contents.on('preload-error', (_event, preloadPath, error) => {
      consoleErrors.push(`[${kind}] preload ${basename(preloadPath)} failed: ${error.message}`);
    });
    contents.on('render-process-gone', (_event, details) => {
      if (!finished) consoleErrors.push(`[${kind}] renderer process gone: ${details.reason}`);
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        consoleErrors.push(`[${kind}] failed to load ${url}: ${description} (${code})`);
      }
    });
    // A window that is never shown only composites while something captures it: without a
    // standing subscriber, transitions freeze between screenshots and every screenshot shows
    // what was drawn for the previous one. The frames themselves are not needed.
    try {
      contents.beginFrameSubscription(true, () => undefined);
    } catch (error) {
      warnings.push(`[${kind}] no frame subscription: ${describeError(error)}`);
    }
  };

  const capture = async (contents: WebContents, name: string): Promise<string> => {
    const image = await contents.capturePage();
    check(!image.isEmpty(), `${name}: capturePage returned an empty image`);
    const { width, height } = image.getSize();
    writeFileSync(join(outDir, name), image.toPNG());
    const colors = countDistinctColors(image.toBitmap());
    check(colors > 1, `${name}: the capture is a single flat colour — nothing was rendered`);
    return `${name} ${width}x${height}`;
  };

  const mainWindow = (): BrowserWindow => {
    const win = windows.getMainWindow();
    check(win !== null, 'The main window is gone');
    // The smoke run counts, logs phases and completes hunts; without this the
    // counter's feedback sounds would play through the speakers on every run.
    win.webContents.setAudioMuted(true);
    return win;
  };

  const activeHunt = () => {
    const hunt = store.getActiveHunt();
    check(hunt !== null, 'There is no active hunt');
    return hunt;
  };

  // ───────────────────────────── Steps ─────────────────────────────

  try {
    removeStaleRuns(deps.dataDir);
    mkdirSync(outDir, { recursive: true });
    // Screenshots of an earlier run must never pass for this one's.
    for (const file of readdirSync(outDir)) {
      if (file.endsWith('.png')) rmSync(join(outDir, file), { force: true });
    }

    await step('seed', () => {
      store.replaceState(buildDemoState(new Date(), store.getState().settings));
      const hunt = activeHunt();
      check(hunt.id === DEMO_ACTIVE_HUNT_ID, `Unexpected active hunt "${hunt.name}"`);
      check(hunt.target?.slug === 'gastly', 'The active hunt does not target Gastly');
      check(hunt.phases.length === 2, `Expected 2 seeded phases, found ${hunt.phases.length}`);
      const state = store.getState();
      return `${state.hunts.length} hunts, ${state.sessions.length} sessions, active "${hunt.name}" at ${hunt.priorCount + hunt.count}`;
    });

    const mainReady = await step('main-window', async () => {
      const win = windows.createMainWindow();
      watch(win.webContents, 'main');
      const info = await waitForReady('main');
      check(info.errors.length === 0, `The renderer reported: ${info.errors.join(' | ')}`);
      check(!win.isVisible(), 'The main window was shown during a smoke run');
      const icon = nativeImage.createFromPath(windowIcon);
      check(!icon.isEmpty(), `The window icon did not load from ${windowIcon}`);
      const { width, height } = win.getBounds();
      return `ready after ${Date.now() - startedAt} ms, ${width}x${height}, hidden, icon ${icon.getSize().width}px`;
    });

    if (mainReady) {
      for (const id of VIEW_IDS) {
        await step(`view:${id}`, async () => {
          const contents = mainWindow().webContents;
          await contents.executeJavaScript(`location.hash = ${JSON.stringify(`#/${id}`)}; true`);
          await delay(VIEW_SETTLE_MS);
          const hash: unknown = await contents.executeJavaScript('location.hash');
          check(
            typeof hash === 'string' && hash.startsWith(`#/${id}`),
            `The renderer left "#/${id}" for "${String(hash)}"`,
          );
          return capture(contents, `main-${id}.png`);
        });
      }

      await step('settings-layout', async () => {
        const win = mainWindow();
        const contents = win.webContents;
        await contents.executeJavaScript(`location.hash = '#/settings'; true`);
        await delay(VIEW_SETTLE_MS);
        const probe = (code: string): Promise<unknown> => contents.executeJavaScript(code, true);
        const ids = JSON.stringify(SETTINGS_SECTIONS);
        const missing = (await probe(
          `${ids}.filter((id) => document.getElementById(id) === null)`,
        )) as string[];
        check(missing.length === 0, `The settings view lacks ${missing.join(', ')}`);

        const shots: string[] = [];
        const scrollTo = async (id: string): Promise<void> => {
          await probe(`document.getElementById(${JSON.stringify(id)}).scrollIntoView(); true`);
          await delay(250);
        };
        for (const id of [
          'settings-streamdeck',
          'settings-audio',
          'settings-general',
          'settings-data',
        ]) {
          await scrollTo(id);
          shots.push(await capture(contents, `main-${id}.png`));
        }

        // The layout has to hold at the minimum window size: nothing may stick out sideways.
        const bounds = win.getBounds();
        const [minWidth = bounds.width, minHeight = bounds.height] = win.getMinimumSize();
        win.setBounds({ ...bounds, width: minWidth, height: minHeight });
        try {
          await delay(350);
          for (const id of SETTINGS_SECTIONS) {
            await scrollTo(id);
            const clipped = (await probe(
              `[...document.getElementById(${JSON.stringify(id)}).querySelectorAll('*')]
                .filter((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
                })
                .map((element) => element.className || element.tagName)
                .slice(0, 3)`,
            )) as string[];
            check(
              clipped.length === 0,
              `At ${minWidth}x${minHeight}, #${id} overflows the window: ${clipped.join(', ')}`,
            );
            if (
              id === 'settings-hotkeys' ||
              id === 'settings-streamdeck' ||
              id === 'settings-overlay'
            ) {
              shots.push(await capture(contents, `main-${id}-min.png`));
            }
          }
        } finally {
          win.setBounds(bounds);
          await delay(200);
        }
        return `${SETTINGS_SECTIONS.length} sections, fits ${minWidth}x${minHeight}; ${shots.join(', ')}`;
      });

      // Every other view at the minimum window size: the page itself must never scroll sideways.
      await step('views-min', async () => {
        const win = mainWindow();
        const contents = win.webContents;
        const bounds = win.getBounds();
        const [minWidth = bounds.width, minHeight = bounds.height] = win.getMinimumSize();
        win.setBounds({ ...bounds, width: minWidth, height: minHeight });
        try {
          for (const id of VIEW_IDS) {
            if (id === 'settings') continue;
            await contents.executeJavaScript(`location.hash = ${JSON.stringify(`#/${id}`)}; true`);
            await delay(VIEW_SETTLE_MS);
            const overflow: unknown = await contents.executeJavaScript(
              `Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth`,
            );
            check(
              typeof overflow === 'number' && overflow <= 1,
              `At ${minWidth}x${minHeight}, the ${id} view is ${String(overflow)} px wider than the window`,
            );
            await capture(contents, `main-${id}-min.png`);
          }
        } finally {
          win.setBounds(bounds);
          await delay(200);
        }
        return `${VIEW_IDS.length - 1} views fit ${minWidth}x${minHeight}`;
      });

      // The Target view's "In <game>" locations panel sits below the fold: wait for its data
      // (PokeAPI games load it over the network), then capture it scrolled into view.
      await step('target-locations', async () => {
        const win = mainWindow();
        const contents = win.webContents;
        const probe = (code: string): Promise<unknown> => contents.executeJavaScript(code, true);
        const PANEL = `document.querySelector('[data-panel="game-encounters"]')`;
        await contents.executeJavaScript(`location.hash = '#/target'; true`);
        await delay(VIEW_SETTLE_MS);

        const readState = async (): Promise<string | null> => {
          const state = await probe(`${PANEL}?.dataset.state ?? null`);
          return typeof state === 'string' ? state : null;
        };
        let state = await readState();
        const deadline = Date.now() + LOCATIONS_TIMEOUT_MS;
        while ((state === null || state === 'loading') && Date.now() < deadline) {
          await delay(200);
          state = await readState();
        }
        check(state !== null, 'The Target view shows no locations panel for the hunt’s game');
        check(state !== 'unsupported', 'The locations panel has no data source for this game');
        if (state === 'loading') {
          warnings.push(
            `[target-locations] still loading after ${LOCATIONS_TIMEOUT_MS / 1000} s (slow or no network)`,
          );
        } else if (state === 'error') {
          warnings.push('[target-locations] the panel shows its error state (offline?)');
        }

        // Nothing inside the panel may stick out of it sideways.
        const overflowing = async (): Promise<string[]> =>
          (await probe(
            `(() => {
              const panel = ${PANEL};
              const box = panel.getBoundingClientRect();
              return [...panel.querySelectorAll('*')]
                .filter((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1);
                })
                .map((element) => String(element.className || element.tagName))
                .slice(0, 3);
            })()`,
          )) as string[];

        const shots: string[] = [];
        const scrollPanel = async (block: 'start' | 'end'): Promise<void> => {
          await probe(`${PANEL}.scrollIntoView({ block: '${block}' }); true`);
          await delay(300);
        };
        await scrollPanel('start');
        const clipped = await overflowing();
        check(clipped.length === 0, `The locations panel overflows: ${clipped.join(', ')}`);
        shots.push(await capture(contents, 'main-target-locations.png'));
        const taller = (await probe(
          `${PANEL}.getBoundingClientRect().height > innerHeight * 0.8`,
        )) as boolean;
        if (taller) {
          await scrollPanel('end');
          shots.push(await capture(contents, 'main-target-locations-end.png'));
        }

        const bounds = win.getBounds();
        const [minWidth = bounds.width, minHeight = bounds.height] = win.getMinimumSize();
        win.setBounds({ ...bounds, width: minWidth, height: minHeight });
        try {
          await delay(350);
          await scrollPanel('start');
          const clippedMin = await overflowing();
          check(
            clippedMin.length === 0,
            `At ${minWidth}x${minHeight}, the locations panel overflows: ${clippedMin.join(', ')}`,
          );
          shots.push(await capture(contents, 'main-target-locations-min.png'));
        } finally {
          win.setBounds(bounds);
          await delay(200);
        }

        // Expanded: every location and fixed encounter, checked and captured at the list's end.
        const expanded = (await probe(
          `(() => {
            const buttons = [...${PANEL}.querySelectorAll('button[aria-expanded="false"]')];
            for (const button of buttons) button.click();
            return buttons.length;
          })()`,
        )) as number;
        if (expanded > 0) {
          await delay(300);
          const clippedAll = await overflowing();
          check(
            clippedAll.length === 0,
            `The expanded locations panel overflows: ${clippedAll.join(', ')}`,
          );
          await scrollPanel('end');
          shots.push(await capture(contents, 'main-target-locations-all.png'));
        }

        const summary = (await probe(
          `(() => {
            const panel = ${PANEL};
            return {
              title: panel.querySelector('h4')?.textContent ?? '',
              areas: panel.querySelectorAll('ul[aria-label="Locations"] > li').length,
              fixed: panel.querySelectorAll('ul[aria-label="Gifts, static encounters and trades"] > li').length,
            };
          })()`,
        )) as { title: string; areas: number; fixed: number };
        return `${state}: "${summary.title}", ${summary.areas} locations, ${summary.fixed} fixed; ${shots.join(', ')}`;
      });

      if (TOUR) {
        await step('tour', async () => {
          const contents = mainWindow().webContents;
          const probe = (code: string): Promise<unknown> => contents.executeJavaScript(code, true);
          let shots = 0;
          for (const id of VIEW_IDS) {
            await probe(`location.hash = ${JSON.stringify(`#/${id}`)}; true`);
            await delay(VIEW_SETTLE_MS);
            const pages = (await probe(`(() => {
              const scrollers = [...document.querySelectorAll('*')].filter((element) => {
                const overflowY = getComputedStyle(element).overflowY;
                return (overflowY === 'auto' || overflowY === 'scroll') &&
                  element.scrollHeight > element.clientHeight + 40;
              });
              scrollers.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
              window.__smokeScroller = scrollers[0] ?? null;
              const scroller = window.__smokeScroller;
              return scroller === null ? 1 : Math.ceil(scroller.scrollHeight / (scroller.clientHeight * 0.9));
            })()`)) as number;
            for (let page = 1; page < Math.min(pages, 6); page += 1) {
              await probe(
                `window.__smokeScroller.scrollTop = ${page} * window.__smokeScroller.clientHeight * 0.9; true`,
              );
              await delay(300);
              await capture(contents, `tour-${id}-${page + 1}.png`);
              shots += 1;
            }
          }
          await probe(`location.hash = '#/log'; true`);
          await delay(VIEW_SETTLE_MS);
          const tabs = (await probe(`document.querySelectorAll('[role="tab"]').length`)) as number;
          for (let index = 1; index < tabs; index += 1) {
            await probe(`document.querySelectorAll('[role="tab"]')[${index}].click(); true`);
            await delay(400);
            await capture(contents, `tour-log-tab${index + 1}.png`);
            shots += 1;
          }

          // The Hunt view's dialogs, then the summary of the completed demo hunt.
          await probe(`location.hash = '#/hunt'; true`);
          await delay(VIEW_SETTLE_MS);
          const press = (label: string): Promise<unknown> =>
            probe(`(() => {
              const wanted = ${JSON.stringify(label)};
              const button = [...document.querySelectorAll('button')].find(
                (element) =>
                  element.textContent.trim() === wanted || element.getAttribute('aria-label') === wanted,
              );
              button?.click();
              return button !== undefined;
            })()`);
          for (const [label, file] of [
            ['Log phase', 'tour-dialog-phase.png'],
            ['New hunt', 'tour-dialog-new-hunt.png'],
          ] as const) {
            check((await press(label)) === true, `The Hunt view has no "${label}" button`);
            await delay(500);
            check(
              (await probe(`document.querySelector('[aria-modal="true"]') !== null`)) === true,
              `"${label}" opened no dialog`,
            );
            await capture(contents, file);
            shots += 1;
            contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            await delay(200);
            contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            await delay(400);
            check(
              (await probe(`document.querySelector('[aria-modal="true"]') === null`)) === true,
              `Escape did not close the "${label}" dialog`,
            );
          }
          const completed = store.getState().hunts.find((hunt) => hunt.status === 'completed');
          if (completed !== undefined) {
            store.setActiveHunt(completed.id);
            await delay(VIEW_SETTLE_MS);
            await capture(contents, 'tour-hunt-completed.png');
            shots += 1;
            store.setActiveHunt(DEMO_ACTIVE_HUNT_ID);
            await delay(300);
          }
          return `${shots} extra screenshots`;
        });
      }

      await step('bridge', async () => {
        const contents = mainWindow().webContents;
        const seen: StateEvent[] = [];
        const stop = store.subscribe((event) => seen.push(event));
        let result: Awaited<ReturnType<typeof exerciseBridge>>;
        try {
          result = await inPage(contents, exerciseBridge, DEMO_ACTIVE_HUNT_ID);
        } finally {
          stop();
        }
        check(result !== null, 'state.get() did not contain the seeded hunt');
        const { before, counted, lowered, logged, undone, afterUnsubscribe } = result;
        const { step: size } = before;

        check(result.windowKind === 'main', `windowKind is "${result.windowKind}"`);
        check(result.platform === process.platform, `platform is "${result.platform}"`);
        check(
          result.versions.app === app.getVersion(),
          `versions.app is "${result.versions.app}", expected "${app.getVersion()}"`,
        );
        check(
          result.versions.electron === process.versions.electron,
          `versions.electron is "${result.versions.electron}"`,
        );
        check(result.dataPath === deps.dataDir, `data.getPath() returned "${result.dataPath}"`);

        check(counted.count === before.count + 3 * size, 'adjustCount(+3 steps) is off');
        check(lowered.count === counted.count - size, 'adjustCount(-1 step) is off');
        check(
          logged.phases.length === before.phases.length + 1 &&
            logged.count === 0 &&
            logged.priorCount === before.priorCount + lowered.count,
          'logPhase did not fold the count into a new phase',
        );
        check(
          undone !== null &&
            undone.phases.length === before.phases.length &&
            undone.count === lowered.count &&
            undone.priorCount === before.priorCount,
          'undo did not take the phase log back',
        );
        check(afterUnsubscribe.count === lowered.count + size, 'The last count is off');
        check(
          isDeepStrictEqual(store.getHunt(DEMO_ACTIVE_HUNT_ID), afterUnsubscribe),
          'The hunt returned to the renderer differs from the one in the store',
        );
        check(
          result.volume === 0.25 && store.getState().settings.audio.volume === 0.25,
          'settings.update did not reach the store',
        );

        check(
          result.unknownHunt !== null && result.unknownHunt.startsWith('Unknown hunt'),
          `An unknown hunt id gave: ${String(result.unknownHunt)}`,
        );
        check(
          result.invalidDelta !== null && result.invalidDelta.startsWith('Invalid count change'),
          `A fractional delta gave: ${String(result.invalidDelta)}`,
        );
        check(result.blockedHost !== null, 'openExternal accepted a host outside the allow-list');
        check(result.blockedScheme !== null, 'openExternal accepted a file: URL');

        const stateEvents = result.eventsWhileSubscribed.filter(
          (event) => event !== 'sessions-changed',
        );
        const expected = [
          'hunt-changed:increment:ui',
          'hunt-changed:decrement:ui',
          'hunt-changed:phase-logged:ui',
          'hunt-changed:undo:ui',
          'settings-changed',
        ];
        check(
          isDeepStrictEqual(stateEvents, expected),
          `state.subscribe saw [${stateEvents.join(', ')}]`,
        );
        check(
          result.eventsWhileSubscribed.includes('sessions-changed'),
          'Counting did not open a session',
        );
        check(
          result.eventsAfterUnsubscribe === 0,
          `${result.eventsAfterUnsubscribe} events arrived after unsubscribing`,
        );
        check(
          seen.filter((event) => event.type === 'hunt-changed').length === 5,
          'The store emitted an unexpected number of hunt changes',
        );

        check(result.pinned, 'window.setAlwaysOnTop(true) did not pin the main window');
        check(!result.windowState.alwaysOnTop, 'window.setAlwaysOnTop(false) did not unpin');
        check(
          result.windowState.kind === 'main' && !result.windowState.overlayOpen,
          `window.getState() returned ${JSON.stringify(result.windowState)}`,
        );
        check(
          isDeepStrictEqual(result.windowStates, [true, false]),
          `window.onState saw alwaysOnTop ${JSON.stringify(result.windowStates)}`,
        );
        check(
          isDeepStrictEqual(result.hotkeyStatus, deps.hotkeys.getStatus()),
          'hotkeys.getStatus() differs from the controller',
        );
        return `${result.eventsWhileSubscribed.length} events, clean rejections ("${result.unknownHunt}")`;
      });

      await step('security', async () => {
        const win = mainWindow();
        const contents = win.webContents;
        const probe = (await contents.executeJavaScript(SECURITY_PROBE, true)) as SecurityProbe;
        check(
          probe.nodeGlobals.length === 0,
          `Node globals leak into the page: ${probe.nodeGlobals.join(', ')}`,
        );
        check(!probe.openedWindow, 'window.open() was allowed');
        check(probe.permission !== 'granted', 'A permission check was granted');
        check(
          isDeepStrictEqual(probe.bridgeKeys, BRIDGE_KEYS),
          `window.biolume exposes [${probe.bridgeKeys.join(', ')}]`,
        );

        const url = contents.getURL();
        await contents.executeJavaScript(`location.href = 'https://example.com/'; true`, true);
        await delay(300);
        check(contents.getURL() === url, `The page navigated away to ${contents.getURL()}`);
        const alive: unknown = await contents.executeJavaScript('typeof window.biolume');
        check(alive === 'object', 'The bridge is gone after a blocked navigation');
        check(
          BrowserWindowCount() === 1,
          `${BrowserWindowCount()} windows exist after window.open()`,
        );
        return `no node globals, window.open denied, navigation blocked, permission "${probe.permission}"`;
      });
    }

    await step('hotkeys', () => {
      const status = deps.hotkeys.refresh();
      check(status.mode === 'active', `Expected mode "active" while hidden, got "${status.mode}"`);
      const bindings = store.getState().settings.hotkeys.bindings;
      const configured = Object.values(bindings).reduce((sum, list) => sum + list.length, 0);
      check(
        status.registrations.length === configured,
        `${status.registrations.length} registrations for ${configured} bindings`,
      );
      // Per key combination: a duplicate binding is unregistered, yet its key is held by its owner.
      const outOfSync = (candidate: HotkeyStatus): string[] =>
        findRegistrationMismatches(candidate, (accelerator) =>
          globalShortcut.isRegistered(accelerator),
        );
      check(
        outOfSync(status).length === 0,
        `The reported registrations do not match the OS: ${outOfSync(status).join('; ')}`,
      );
      check(isDeepStrictEqual(deps.hotkeys.refresh(), status), 'refresh() is not idempotent');

      store.updateSettings({ hotkeys: { globalEnabled: false } });
      const disabled = deps.hotkeys.getStatus();
      check(disabled.mode === 'disabled', `Disabling gave mode "${disabled.mode}"`);
      check(
        status.registrations.every((entry) => !globalShortcut.isRegistered(entry.accelerator)),
        'A shortcut stayed registered after global hotkeys were switched off',
      );

      const first = status.registrations[0];
      check(first !== undefined, 'There are no default bindings to test with');
      store.updateSettings({
        hotkeys: {
          globalEnabled: true,
          bindings: { undo: [first.accelerator], logPhase: ['Biolume+Not+A+Key'] },
        },
      });
      const edited = deps.hotkeys.getStatus();
      const duplicate = edited.registrations.find((entry) => entry.action === 'undo');
      const malformed = edited.registrations.find((entry) => entry.action === 'logPhase');
      check(
        duplicate?.registered === false && duplicate.error === DUPLICATE_BINDING_ERROR,
        `A duplicate binding was reported as ${JSON.stringify(duplicate)}`,
      );
      check(
        malformed?.registered === false && typeof malformed.error === 'string',
        `A malformed accelerator was reported as ${JSON.stringify(malformed)}`,
      );
      check(edited.mode === 'active', `Re-enabling gave mode "${edited.mode}"`);
      check(
        outOfSync(edited).length === 0,
        `Re-enabling left the OS out of sync: ${outOfSync(edited).join('; ')}`,
      );
      // The key that is bound twice still belongs to its first action.
      const owner = edited.registrations.find(
        (entry) => entry.accelerator === first.accelerator && entry.action === first.action,
      );
      check(
        owner?.registered === first.registered &&
          globalShortcut.isRegistered(first.accelerator) === first.registered,
        `The duplicate took "${first.accelerator}" away from "${first.action}"`,
      );

      store.updateSettings({ hotkeys: { bindings: { undo: [], logPhase: [] } } });
      hotkeys = deps.hotkeys.getStatus();
      check(
        isDeepStrictEqual(hotkeys, status),
        'Restoring the bindings did not restore the status',
      );
      check(
        outOfSync(hotkeys).length === 0,
        `Restoring the bindings left the OS out of sync: ${outOfSync(hotkeys).join('; ')}`,
      );

      const summary = hotkeys.registrations.map(
        (entry) => `${entry.accelerator}=${entry.registered ? 'ok' : (entry.error ?? 'failed')}`,
      );
      return `${hotkeys.mode}: ${summary.join(', ')}`;
    });

    await step('hotkey-actions', async () => {
      const contents = mainReady ? mainWindow().webContents : null;
      if (contents !== null) await contents.executeJavaScript(RECORD_HOTKEY_ACTIONS, true);
      const sources: string[] = [];
      const stop = store.subscribe((event) => {
        if (event.type === 'hunt-changed') sources.push(event.change.source);
      });
      try {
        const start = activeHunt();
        // The controller's own entry point — exactly what a registered shortcut calls.
        deps.hotkeys.trigger('increment', 'smoke-increment');
        deps.hotkeys.trigger('increment', 'smoke-increment');
        check(
          activeHunt().count === start.count + start.step,
          'A repeat within the guard interval was counted (or the first press was not)',
        );
        await delay(REPEAT_GUARD_MS + 40);
        deps.hotkeys.trigger('increment', 'smoke-increment');
        check(
          activeHunt().count === start.count + 2 * start.step,
          'A second press was not counted',
        );
        deps.hotkeys.trigger('decrement', 'smoke-decrement');
        check(activeHunt().count === start.count + start.step, 'The decrement hotkey did nothing');
        deps.hotkeys.trigger('logPhase', 'smoke-log-phase');
        const logged = activeHunt();
        const phase = logged.phases.at(-1);
        check(
          logged.phases.length === start.phases.length + 1 &&
            phase?.speciesId === null &&
            phase.speciesName === '',
          'The quick-log hotkey did not add an unidentified phase',
        );
        deps.hotkeys.trigger('undo', 'smoke-undo');
        check(
          activeHunt().phases.length === start.phases.length,
          'The undo hotkey did not take the phase back',
        );
        check(
          sources.length === 5 && sources.every((source) => source === 'hotkey-global'),
          `Hotkey changes were attributed to [${sources.join(', ')}]`,
        );

        if (contents === null) return 'store only (no renderer)';
        await delay(120);
        const actions = (await contents.executeJavaScript(
          'window.__smokeHotkeyActions',
        )) as HotkeyActionEvent[];
        check(
          isDeepStrictEqual(
            actions.map((event) => event.action),
            ['increment', 'increment', 'decrement', 'logPhase', 'undo'],
          ),
          `hotkeys.onAction saw [${actions.map((event) => event.action).join(', ')}]`,
        );
        check(
          actions.every((event) => event.huntId === start.id),
          'A hotkey action event names the wrong hunt',
        );
        check(
          actions.find((event) => event.action === 'logPhase')?.phaseId === phase.id,
          'The quick-log event does not carry the phase id',
        );
        return `${actions.length} action events, auto-repeat ignored`;
      } finally {
        stop();
      }
    });

    await step('streamdeck-bridge', async () => {
      const status = deps.streamDeck.getStatus();
      check(
        status.enabled && status.listening && status.port !== null && status.error === null,
        `The bridge is not listening: ${JSON.stringify(status)}`,
      );
      const pairing = JSON.parse(
        readFileSync(join(deps.dataDir, STREAM_DECK_PAIRING_FILE), 'utf8'),
      ) as BridgePairing;
      check(
        pairing.protocol === STREAM_DECK_PROTOCOL_VERSION &&
          pairing.port === status.port &&
          pairing.pid === process.pid &&
          pairing.app === app.getVersion() &&
          /^[A-Za-z0-9_-]{43}$/.test(pairing.token),
        'The pairing file does not describe the running bridge',
      );
      const { port, token } = pairing;
      const authorized = { Authorization: `Bearer ${token}` };

      const anonymous = await bridgeCall(port, {});
      check(anonymous.status === 401, `GET /v1/state without a token answered ${anonymous.status}`);
      const fromPage = await bridgeCall(port, {
        headers: { ...authorized, Origin: 'https://example.com' },
      });
      check(fromPage.status === 403, `A request with an Origin header got ${fromPage.status}`);
      const rebound = await bridgeCall(port, {
        headers: { ...authorized, Host: `evil.example:${port}` },
      });
      check(rebound.status === 403, `A foreign Host header got ${rebound.status}`);

      const start = activeHunt();
      check(start.status === 'active', `The active hunt is ${start.status}`);
      const stateReply = await bridgeCall(port, { headers: authorized });
      check(stateReply.status === 200, `GET /v1/state answered ${stateReply.status}`);
      const state = JSON.parse(stateReply.text) as BridgeState;
      check(
        state.hunt?.id === start.id &&
          state.hunt.count === start.count &&
          state.hunt.total === start.priorCount + start.count &&
          state.hunt.phaseNumber === start.phases.length + 1 &&
          !state.shinyFoundArmed,
        `GET /v1/state does not match the store: ${stateReply.text}`,
      );

      const contents = mainReady ? mainWindow().webContents : null;
      if (contents !== null) await contents.executeJavaScript(RECORD_SHINY_ARMED, true);
      const sources: string[] = [];
      const stop = store.subscribe((event) => {
        if (event.type === 'hunt-changed') {
          sources.push(`${event.change.kind}:${event.change.source}`);
        }
      });
      const stream = await openBridgeEvents(port, token);
      try {
        const first = await stream.next(() => true);
        check(
          first.type === 'state' && first.state.hunt?.id === start.id,
          `The first event was ${JSON.stringify(first)}`,
        );
        await until(
          () => deps.streamDeck.getStatus().clients === 1,
          BRIDGE_TIMEOUT_MS,
          'the event stream to count as a client',
        );

        const act = async (action: string): Promise<BridgeActionResponse> => {
          const reply = await bridgeCall(port, {
            method: 'POST',
            path: '/v1/action',
            headers: { ...authorized, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          });
          check(reply.status === 200, `POST ${action} answered ${reply.status}: ${reply.text}`);
          return JSON.parse(reply.text) as BridgeActionResponse;
        };

        const counted = await act('increment');
        const afterCount = activeHunt().count;
        check(
          counted.ok &&
            afterCount === start.count + start.step &&
            counted.state.hunt?.count === afterCount,
          `increment: ok=${counted.ok}, store ${start.count} -> ${afterCount}`,
        );
        await stream.next(
          (event) => event.type === 'state' && event.state.hunt?.count === afterCount,
        );
        await stream.next((event) => event.type === 'action' && event.action === 'increment');

        // Show the Hunt view so the armed confirmation and the "Stream Deck" chip get captured.
        if (contents !== null) {
          await contents.executeJavaScript(`location.hash = '#/hunt'; true`);
          await delay(VIEW_SETTLE_MS);
        }
        const armed = await act('shinyFound');
        check(
          armed.ok && armed.state.shinyFoundArmed && activeHunt().status === 'active',
          `The first Shiny Found press did not just arm: ${JSON.stringify(armed)}`,
        );
        await stream.next((event) => event.type === 'state' && event.state.shinyFoundArmed);
        let armedShot = '';
        if (contents !== null) {
          // Well inside SHINY_CONFIRM_WINDOW_MS, so the confirming press below still counts.
          await delay(350);
          armedShot = await capture(contents, 'main-hunt-armed.png');
        }
        const confirmed = await act('shinyFound');
        check(
          confirmed.ok &&
            confirmed.state.hunt?.status === 'completed' &&
            activeHunt().status === 'completed',
          `The second Shiny Found press did not complete the hunt: ${JSON.stringify(confirmed)}`,
        );
        const refused = await act('increment');
        check(
          !refused.ok && typeof refused.message === 'string',
          'Counting on a completed hunt was not refused',
        );
        const reopened = await act('undo');
        check(
          reopened.ok && activeHunt().status === 'active' && activeHunt().completedAt === null,
          'Undo did not take the Shiny Found back',
        );
        const uncounted = await act('undo');
        check(
          uncounted.ok && activeHunt().count === start.count,
          'Undo did not take the count back',
        );

        // The global hotkey takes the same two presses.
        deps.hotkeys.trigger('shinyFound', 'smoke-shiny-found');
        check(activeHunt().status === 'active', 'One Shiny Found hotkey press completed the hunt');
        await delay(REPEAT_GUARD_MS + 40);
        deps.hotkeys.trigger('shinyFound', 'smoke-shiny-found');
        // The confirming press waits out the held-key check before it counts.
        check(activeHunt().status === 'active', 'The confirming press skipped the held-key check');
        await delay(SHINY_HOLD_CHECK_MS + 60);
        check(
          activeHunt().status === 'completed',
          'Two Shiny Found hotkey presses did not complete',
        );
        deps.hotkeys.trigger('undo', 'smoke-undo');
        check(activeHunt().status === 'active', 'The undo hotkey did not take Shiny Found back');

        check(
          isDeepStrictEqual(sources, [
            'increment:streamdeck',
            'completed:streamdeck',
            'undo:streamdeck',
            'undo:streamdeck',
            'completed:hotkey-global',
            'undo:hotkey-global',
          ]),
          `The bridge's changes were recorded as [${sources.join(', ')}]`,
        );

        if (contents === null) return `port ${port}; store only (no renderer)`;
        const viaIpc = await inPage(contents, exerciseShinyFound, start.id);
        check(
          !viaIpc.first.completed && viaIpc.first.armedUntil !== null,
          'requestShinyFound did not arm on the first call',
        );
        check(
          viaIpc.second.completed && viaIpc.second.status === 'completed',
          'requestShinyFound did not complete on the second call',
        );
        check(viaIpc.undone === 'active', 'hunts.undo did not reopen the hunt');
        check(
          viaIpc.unknownHunt?.startsWith('Unknown hunt') === true,
          `An unknown hunt gave: ${String(viaIpc.unknownHunt)}`,
        );
        check(
          viaIpc.badSource?.startsWith('Invalid counter source') === true,
          `A bad source gave: ${String(viaIpc.badSource)}`,
        );
        check(
          viaIpc.status.listening && viaIpc.status.port === port,
          `streamDeck.getStatus() in the renderer: ${JSON.stringify(viaIpc.status)}`,
        );
        await delay(120);
        const armedEvents = (await contents.executeJavaScript(
          'window.__smokeShinyArmed',
        )) as ShinyArmedEvent[];
        const summary = armedEvents.map(
          (event) => `${event.armedUntil === null ? 'clear' : 'armed'}:${event.source}`,
        );
        check(
          isDeepStrictEqual(summary, [
            'armed:streamdeck',
            'clear:streamdeck',
            'armed:hotkey-global',
            'clear:hotkey-global',
            'armed:hotkey-local',
            'clear:hotkey-local',
          ]) && armedEvents.every((event) => event.huntId === start.id),
          `hunts.onShinyArmed saw [${summary.join(', ')}]`,
        );
        return `port ${port}: 401 without token, 403 for Origin / foreign Host; state, SSE, increment, Shiny Found x2 + undo via HTTP, hotkey and IPC; plugin bundled: ${status.pluginBundled}; ${armedShot}`;
      } finally {
        stop();
        stream.close();
        await until(
          () => deps.streamDeck.getStatus().clients === 0,
          BRIDGE_TIMEOUT_MS,
          'the event stream to close',
        ).catch(() => warnings.push('[streamdeck-bridge] the event stream was not cleaned up'));
      }
    });

    // settings.streamDeck.enabled starts and stops the bridge live, and the renderer hears of it.
    await step('streamdeck-toggle', async () => {
      const contents = mainReady ? mainWindow().webContents : null;
      if (contents !== null) await contents.executeJavaScript(RECORD_STREAM_DECK_STATUS, true);
      const pairingPath = join(deps.dataDir, STREAM_DECK_PAIRING_FILE);
      const before = JSON.parse(readFileSync(pairingPath, 'utf8')) as BridgePairing;

      store.updateSettings({ streamDeck: { enabled: false } });
      await until(
        () => !deps.streamDeck.getStatus().listening,
        BRIDGE_TIMEOUT_MS,
        'the bridge to stop',
      );
      const off = deps.streamDeck.getStatus();
      check(!off.enabled && off.port === null, `Switched off: ${JSON.stringify(off)}`);
      check(!existsSync(pairingPath), 'The pairing file outlived the bridge');

      store.updateSettings({ streamDeck: { enabled: true } });
      await until(
        () => deps.streamDeck.getStatus().listening,
        BRIDGE_TIMEOUT_MS,
        'the bridge to restart',
      );
      check(existsSync(pairingPath), 'Restarting did not write the pairing file again');
      const after = JSON.parse(readFileSync(pairingPath, 'utf8')) as BridgePairing;
      // Every listening period gets a fresh token; the previous one must be worthless.
      check(after.token !== before.token, 'Restarting the bridge kept its old token');
      check(after.port === deps.streamDeck.getStatus().port, 'The pairing file names another port');
      const reply = await bridgeCall(after.port, {
        headers: { Authorization: `Bearer ${after.token}` },
      });
      check(reply.status === 200, `After the restart GET /v1/state answered ${reply.status}`);
      const replay = await bridgeCall(after.port, {
        headers: { Authorization: `Bearer ${before.token}` },
      });
      check(replay.status === 401, `The token from before the restart answered ${replay.status}`);

      if (contents === null) return `restarted on port ${after.port} (no renderer)`;
      await delay(120);
      const seen = (await contents.executeJavaScript(
        'window.__smokeStreamDeckStatus',
      )) as StreamDeckStatus[];
      const listening = seen.map((status) => status.listening);
      check(
        listening.includes(false) && listening.at(-1) === true,
        `streamDeck.onStatus saw listening ${JSON.stringify(listening)}`,
      );
      return `off and on again via settings, port ${before.port} -> ${after.port}, ${seen.length} status events in the renderer`;
    });

    await step('overlay', async () => {
      readySignals.delete('overlay');
      windows.setOverlayOpen(true);
      const overlay = windows.getOverlayWindow();
      check(overlay !== null, 'setOverlayOpen(true) did not create the overlay window');
      watch(overlay.webContents, 'overlay');
      const info = await waitForReady('overlay');
      check(info.errors.length === 0, `The overlay reported: ${info.errors.join(' | ')}`);
      await delay(VIEW_SETTLE_MS);
      const shot = await capture(overlay.webContents, 'overlay.png');

      check(
        windows.getStateInfo('main').overlayOpen,
        'The main window is not told the overlay is open',
      );
      check(overlay.isAlwaysOnTop(), 'The overlay is not always on top');
      check(!overlay.isResizable() && !overlay.isMaximizable(), 'The overlay can be resized');
      check(!overlay.isVisible(), 'The overlay was shown during a smoke run');

      const described = await inPage(overlay.webContents, describeOverlay);
      check(
        described.windowKind === 'overlay',
        `The overlay's windowKind is "${described.windowKind}"`,
      );
      check(
        described.state.kind === 'overlay' && described.state.overlayOpen,
        `The overlay's window state is ${JSON.stringify(described.state)}`,
      );

      const onScreen = (): boolean => {
        const bounds = overlay.getBounds();
        const { workArea } = screen.getDisplayMatching(bounds);
        return (
          bounds.x >= workArea.x &&
          bounds.y >= workArea.y &&
          bounds.x + bounds.width <= workArea.x + workArea.width &&
          bounds.y + bounds.height <= workArea.y + workArea.height
        );
      };
      check(onScreen(), `The overlay opened off-screen at ${JSON.stringify(overlay.getBounds())}`);

      // The overlay scale is CSS zoom inside the overlay's own document. Chromium's page zoom is
      // shared by every window of an origin, so main must never zoom either window.
      const pageZoom = (): string =>
        [overlay, windows.getMainWindow()]
          .map((win) => (win === null ? 1 : win.webContents.getZoomFactor()).toFixed(2))
          .join(' / ');
      const measure = async (): Promise<OverlayMeasure> =>
        (await overlay.webContents.executeJavaScript(MEASURE_OVERLAY, true)) as OverlayMeasure;
      const unscaled = await measure();
      check(
        unscaled.found,
        'The overlay renders no [data-overlay-root] / [data-overlay-scale] element',
      );
      check(
        Math.abs(unscaled.cssZoom - 1) < 0.01,
        `At scale 1 the overlay's CSS zoom is ${unscaled.cssZoom}`,
      );
      const natural = overlay.getBounds();

      store.updateSettings({ overlay: { scale: 1.25, clickThrough: true } });
      await delay(400);
      check(
        pageZoom() === '1.00 / 1.00',
        `The overlay scale leaked into the page zoom (${pageZoom()})`,
      );
      const scaled = await measure();
      check(
        Math.abs(scaled.cssZoom - 1.25) < 0.01,
        `The overlay's CSS zoom is ${scaled.cssZoom}, expected 1.25`,
      );
      // The card's width is fixed; click-through adds its lock hint, so the height may only grow.
      check(
        Math.abs(scaled.width - unscaled.width * 1.25) <= 2 &&
          scaled.height >= unscaled.height * 1.25 - 2,
        `The overlay content went from ${unscaled.width}x${unscaled.height} to ${scaled.width}x${scaled.height} at scale 1.25`,
      );
      const grown = overlay.getBounds();
      check(
        grown.width >= Math.floor(OVERLAY_SIZE_LIMITS.width.min * 1.25) &&
          grown.width <= Math.ceil(OVERLAY_SIZE_LIMITS.width.max * 1.25),
        `At scale 1.25 the overlay is ${grown.width} px wide`,
      );
      // The window follows the content: it holds the scaled card with at most a few pixels to spare.
      check(
        grown.width >= Math.floor(scaled.width) &&
          grown.height >= Math.floor(scaled.height) &&
          grown.width - scaled.width <= 4 &&
          grown.height - scaled.height <= 4,
        `The ${grown.width}x${grown.height} window does not fit its ${scaled.width}x${scaled.height} content`,
      );
      check(
        grown.width > natural.width && grown.height > natural.height,
        `Scale 1.25 did not grow the window (${natural.width}x${natural.height} to ${grown.width}x${grown.height})`,
      );
      store.updateSettings({ overlay: { scale: 1, clickThrough: false } });
      await delay(300);
      check(
        pageZoom() === '1.00 / 1.00',
        `Resetting the scale changed the page zoom (${pageZoom()})`,
      );

      await inPage(overlay.webContents, requestHugeOverlay);
      await delay(200);
      const bounds = overlay.getBounds();
      check(
        bounds.width <= OVERLAY_SIZE_LIMITS.width.max &&
          bounds.height <= OVERLAY_SIZE_LIMITS.height.max &&
          bounds.width >= OVERLAY_SIZE_LIMITS.width.min &&
          bounds.height >= OVERLAY_SIZE_LIMITS.height.min,
        `resizeOverlay was not clamped: ${bounds.width}x${bounds.height}`,
      );
      check(onScreen(), `The resized overlay is off-screen at ${JSON.stringify(bounds)}`);

      // Its frame is destroyed while this script is still answering, so the result is not awaited.
      inPage(overlay.webContents, closeFromOverlay).catch(() => undefined);
      await until(() => windows.getOverlayWindow() === null, 3_000, 'the overlay to close itself');
      check(!windows.getStateInfo('main').overlayOpen, 'The overlay still counts as open');
      check(windows.getMainWindow() !== null, 'Closing the overlay took the main window with it');
      return `${shot}, scaled by CSS with the page zoom untouched, clamped to ${bounds.width}x${bounds.height}, closed from its own window`;
    });

    await step('exports', async () => {
      const directory = join(deps.dataDir, 'smoke-exports');
      mkdirSync(directory, { recursive: true });
      const written: string[] = [];
      for (const [dataset, format] of EXPORTS) {
        const built = buildExport(store.getState(), { dataset, format }, new Date());
        check(built.records > 0, `${dataset}.${format} is empty`);
        const parsed = parseImport(built.content);
        check(
          parsed.dataset === dataset && parsed.errors.length === 0,
          `${dataset}.${format} does not read back: ${parsed.errors.join(' | ')}`,
        );
        const saved = await writeExportFile(built, join(directory, built.defaultFileName));
        check(
          saved.error === undefined && saved.filePath !== null,
          `${dataset}.${format}: ${saved.error}`,
        );
        check(
          readFileSync(saved.filePath, 'utf8') === built.content,
          `${dataset}.${format} changed on its way to disk`,
        );
        written.push(`${dataset}.${format}(${built.records})`);
      }

      let refused = false;
      try {
        buildExport(store.getState(), { dataset: 'backup', format: 'csv' }, new Date());
      } catch {
        refused = true;
      }
      check(refused, 'A CSV backup was not refused');

      // Round trip through real files: merging its own exports must not invent or lose anything.
      const before = store.getState();
      const sessionsCsv = buildExport(before, { dataset: 'sessions', format: 'csv' }, new Date());
      const sessionsFile = join(directory, 'roundtrip-sessions.csv');
      await writeExportFile(sessionsCsv, sessionsFile);
      const merged = await importFromFile(store, sessionsFile, 'merge');
      check(
        merged.dataset === 'sessions' &&
          merged.errors.length === 0 &&
          merged.imported.sessions === 0,
        `Re-importing the sessions CSV gave ${JSON.stringify(merged)}`,
      );
      check(store.getState() === before, 'A no-op import replaced the state');

      const backup = buildExport(before, { dataset: 'backup', format: 'json' }, new Date());
      const backupFile = join(directory, 'roundtrip-backup.json');
      await writeExportFile(backup, backupFile);
      const restored = await importFromFile(store, backupFile, 'replace');
      check(
        restored.dataset === 'backup' && restored.errors.length === 0,
        `Restoring the backup gave ${JSON.stringify(restored)}`,
      );
      check(
        isDeepStrictEqual(store.getState(), before),
        'Restoring a backup of the current state changed the state',
      );
      const missing = await importFromFile(store, join(directory, 'missing.json'), 'merge');
      check(
        !missing.canceled && missing.dataset === null && missing.errors.length === 1,
        'A missing import file was not reported as an error',
      );
      return written.join(', ');
    });

    await step('persistence', () => {
      deps.persist();
      for (const file of [SETTINGS_FILE, HUNTS_FILE, SESSIONS_FILE, WINDOW_STATE_FILE]) {
        JSON.parse(readFileSync(join(deps.dataDir, file), 'utf8'));
      }
      const reloaded = createStorage(deps.dataDir).loadState();
      check(
        isDeepStrictEqual(reloaded, store.getState()),
        'The state read back from disk differs from the state in memory',
      );
      return `settings, hunts, sessions and window state written to ${deps.dataDir}`;
    });
  } catch (error) {
    steps.push({ name: 'smoke', ok: false, detail: describeError(error) });
  }

  const ok =
    steps.length > 0 &&
    steps.every((entry) => entry.ok) &&
    consoleErrors.length === 0 &&
    deps.mainErrors.length === 0;
  finish(ok ? 0 : 1);
}

function BrowserWindowCount(): number {
  return app.isReady() ? BrowserWindow.getAllWindows().length : 0;
}
