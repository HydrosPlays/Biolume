/**
 * Client for Biolume's local Stream Deck bridge (see src/shared/streamDeck.ts).
 *
 *  - Finds the bridge through the pairing file; a file whose pid is gone is stale.
 *  - Watches that file, so a Biolume (re)start — new token, maybe a new port — is
 *    picked up at once instead of on the next retry.
 *  - Holds one `GET /v1/events` Server-Sent-Events stream open; the first event
 *    is a full state, later ones keep it current. Missing keep-alive pings for
 *    `idleTimeoutMs` count as a dead connection (sleep / resume, half-open TCP).
 *  - Reconnects with capped exponential backoff.
 *  - Sends key presses as `POST /v1/action`.
 *
 * Every request goes to 127.0.0.1 only, carries `Authorization: Bearer <token>`
 * and no `Origin` header (Node's fetch never adds one). The token is never
 * logged. Everything that comes back is validated (./protocol.ts) and size-capped.
 *
 * Deliberately free of Stream Deck SDK imports so it can be tested against a
 * fake HTTP server.
 */
import { watch } from 'node:fs';
import path from 'node:path';
import type {
  BridgeAction,
  BridgeActionRequest,
  BridgeEvent,
  BridgePairing,
  BridgeState,
} from '../../../src/shared/streamDeck';
import { Backoff } from './backoff';
import { discardBody, readBoundedText } from './http';
import { readPairing as readPairingFile, type PairingRead } from './pairing';
import { isBridgeAction, parseActionResponse, parseEventData, samePairing } from './protocol';
import { SseParser } from './sse';

/** The bridge only ever listens on the loopback interface. */
export const BRIDGE_HOST = '127.0.0.1';

export type OfflineReason =
  /** No pairing file: Biolume is not running, or the bridge is switched off in its settings. */
  | 'no-pairing'
  /** The pairing file outlived its Biolume process. */
  | 'stale'
  | 'invalid-pairing'
  /** Pairing found, but nothing answered on its port (or the stream dropped). */
  | 'unreachable'
  /** The bridge refused the token (the pairing file is about to be rewritten). */
  | 'unauthorized'
  /** Something answered, but not with the bridge protocol. */
  | 'protocol';

export type BridgeSnapshot =
  | { status: 'online'; state: BridgeState; app: string }
  | { status: 'offline'; reason: OfflineReason }
  /** Biolume speaks another bridge protocol version: one of the two needs updating. */
  | { status: 'incompatible' };

export interface ActionOutcome {
  ok: boolean;
  /** The bridge's explanation, e.g. "Press again to confirm Shiny Found". */
  message?: string;
  /** Biolume could not be reached at all. */
  offline: boolean;
  /** Fresh state from the bridge's answer, when it sent a valid one. */
  state: BridgeState | null;
}

/** The subset of a logger the client uses (the SDK's logger fits). */
export interface BridgeLogger {
  debug(...data: unknown[]): unknown;
  info(...data: unknown[]): unknown;
  warn(...data: unknown[]): unknown;
  error(...data: unknown[]): unknown;
}

/**
 * Starts watching `file` for changes; returns a function that stops watching,
 * or null when the watch could not be set up (e.g. the folder does not exist yet).
 * `onError` reports a watcher that died, so the client can set up a new one.
 */
export type PairingWatcher = (
  file: string,
  onChange: () => void,
  onError: () => void,
) => (() => void) | null;

export interface BridgeClientOptions {
  /** Absolute path of the pairing file (see ./pairing.ts). */
  pairingFile: string;
  fetch?: typeof fetch;
  readPairing?: (file: string) => Promise<PairingRead>;
  watchPairing?: PairingWatcher;
  backoff?: Backoff;
  /** No bytes (not even a ping) for this long drops the stream. Default 45 s (3 missed pings). */
  idleTimeoutMs?: number;
  /** Per-press request timeout. Default 5 s. */
  actionTimeoutMs?: number;
  /**
   * After a working stream drops, keys keep their last state this long before
   * showing "Offline", so a quick reconnect (token rotation, bridge restart)
   * does not flicker. Default 1.5 s.
   */
  offlineGraceMs?: number;
  /** Debounce for bursts of file-system events. Default 100 ms. */
  watchDebounceMs?: number;
  /** Cap on a `/v1/action` answer. Default 64 KiB. */
  maxResponseBytes?: number;
  logger?: BridgeLogger;
}

const SILENT_LOGGER: BridgeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Default {@link PairingWatcher}: `fs.watch` on the folder (the file itself may not exist yet, and atomic renames break file watches). */
export const watchPairingFolder: PairingWatcher = (file, onChange, onError) => {
  const name = path.basename(file).toLowerCase();
  try {
    const watcher = watch(path.dirname(file), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString().toLowerCase() === name) onChange();
    });
    watcher.on('error', () => {
      watcher.close();
      onError();
    });
    return () => watcher.close();
  } catch {
    return null;
  }
};

interface ActiveConnection {
  pairing: BridgePairing;
  controller: AbortController;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

export class BridgeClient {
  readonly #file: string;
  readonly #fetch: typeof fetch;
  readonly #readPairing: (file: string) => Promise<PairingRead>;
  readonly #watchPairing: PairingWatcher;
  readonly #backoff: Backoff;
  readonly #idleTimeoutMs: number;
  readonly #actionTimeoutMs: number;
  readonly #offlineGraceMs: number;
  readonly #watchDebounceMs: number;
  readonly #maxResponseBytes: number;
  readonly #log: BridgeLogger;

  readonly #changeListeners = new Set<(snapshot: BridgeSnapshot) => void>();
  readonly #eventListeners = new Set<(event: BridgeEvent) => void>();

  #snapshot: BridgeSnapshot = { status: 'offline', reason: 'no-pairing' };
  #running = false;
  #active: ActiveConnection | null = null;
  #wake: (() => void) | null = null;
  #unwatch: (() => void) | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;
  #graceReason: OfflineReason = 'unreachable';
  #loopDone: Promise<void> | null = null;

  constructor(options: BridgeClientOptions) {
    this.#file = options.pairingFile;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#readPairing = options.readPairing ?? ((file) => readPairingFile(file));
    this.#watchPairing = options.watchPairing ?? watchPairingFolder;
    this.#backoff = options.backoff ?? new Backoff();
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? 5_000;
    this.#offlineGraceMs = options.offlineGraceMs ?? 1_500;
    this.#watchDebounceMs = options.watchDebounceMs ?? 100;
    this.#maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
    this.#log = options.logger ?? SILENT_LOGGER;
  }

  get snapshot(): BridgeSnapshot {
    return this.#snapshot;
  }

  /** Called with every new snapshot (each state event, and online / offline transitions). */
  onChange(listener: (snapshot: BridgeSnapshot) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Every valid bridge event, including `action` events caused by other clients or hotkeys. */
  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loopDone = this.#loop();
  }

  /** Stops reconnecting and closes the stream; resolves once the loop has wound down. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#active?.controller.abort();
    this.#wake?.();
    this.#unwatch?.();
    this.#unwatch = null;
    for (const timer of [this.#debounceTimer, this.#graceTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#debounceTimer = null;
    this.#graceTimer = null;
    await this.#loopDone;
    this.#loopDone = null;
  }

  /** Skip the remaining backoff and try now (key pressed while offline, system woke up…). */
  reconnectNow(): void {
    this.#backoff.reset();
    this.#wake?.();
  }

  /** Sends one key press. Never throws: failures come back as `{ ok: false }`. */
  async sendAction(action: BridgeAction): Promise<ActionOutcome> {
    if (!isBridgeAction(action)) {
      return { ok: false, offline: false, message: 'Unknown action', state: null };
    }
    let pairing = this.#active?.pairing ?? null;
    if (pairing === null) {
      const read = await this.#readPairing(this.#file);
      if (read.kind !== 'ok') {
        this.reconnectNow();
        return { ok: false, offline: true, state: null };
      }
      pairing = read.pairing;
    }

    const request: BridgeActionRequest = { action };
    let response: Response;
    try {
      response = await this.#fetch(this.#url(pairing, '/v1/action'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pairing.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(request),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#actionTimeoutMs),
      });
    } catch (error) {
      this.#log.warn(`Action ${action} failed: ${describeError(error)}`);
      this.reconnectNow();
      return { ok: false, offline: true, state: null };
    }

    if (response.status === 401 || response.status === 403) {
      discardBody(response);
      this.#log.warn(`Action ${action} refused: HTTP ${response.status} (pairing out of date)`);
      this.reconnectNow();
      return { ok: false, offline: true, state: null };
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(response, this.#maxResponseBytes));
    } catch {
      body = undefined;
    }
    const parsed = parseActionResponse(body);
    if (!parsed) {
      this.#log.warn(`Action ${action}: unexpected answer (HTTP ${response.status})`);
      return { ok: false, offline: false, message: 'Unexpected answer', state: null };
    }
    return {
      ok: parsed.ok && response.ok,
      offline: false,
      state: parsed.state,
      ...(parsed.message === undefined ? {} : { message: parsed.message }),
    };
  }

  // ───────────────────────────── Connection loop ─────────────────────────────

  async #loop(): Promise<void> {
    while (this.#running) {
      this.#ensureWatcher();
      let healthy = false;
      try {
        healthy = await this.#session();
      } catch (error) {
        this.#log.error(`Bridge session crashed: ${describeError(error)}`);
      }
      if (!this.#running) break;
      if (healthy) this.#backoff.reset();
      await this.#wait(this.#backoff.next());
    }
  }

  /** One connection attempt; resolves when it ends. True when it delivered a valid state. */
  async #session(): Promise<boolean> {
    const read = await this.#readPairing(this.#file);
    if (!this.#running) return false;
    if (read.kind !== 'ok') {
      if (read.kind === 'incompatible') {
        if (this.#snapshot.status !== 'incompatible') {
          this.#log.warn(`Biolume speaks bridge protocol ${read.protocol}; this plugin needs 1`);
          this.#setSnapshot({ status: 'incompatible' });
        }
      } else {
        if (read.kind === 'invalid') this.#log.debug(`Pairing file unusable: ${read.reason}`);
        this.#setOffline(
          read.kind === 'missing'
            ? 'no-pairing'
            : read.kind === 'stale'
              ? 'stale'
              : 'invalid-pairing',
        );
      }
      return false;
    }

    const { pairing } = read;
    const controller = new AbortController();
    this.#active = { pairing, controller };
    let healthy = false;
    let failure: OfflineReason = 'unreachable';
    try {
      failure = await this.#stream(pairing, controller, () => {
        healthy = true;
      });
    } catch (error) {
      if (this.#running) {
        const why = controller.signal.aborted ? controller.signal.reason : error;
        this.#log.info(`Bridge connection ended: ${describeError(why)}`);
      }
    } finally {
      controller.abort();
      if (this.#active?.controller === controller) this.#active = null;
    }

    if (this.#running) {
      if (healthy) this.#setOfflineAfterGrace(failure);
      else this.#setOffline(failure);
    }
    return healthy;
  }

  /**
   * Opens `/v1/events` and pumps it until it ends. Resolves with the reason to
   * show if it ended without an error being thrown; `onState` marks the
   * session healthy. Aborting `controller` (idle watchdog, pairing change,
   * stop) makes it throw.
   */
  async #stream(
    pairing: BridgePairing,
    controller: AbortController,
    onState: () => void,
  ): Promise<OfflineReason> {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => controller.abort(new Error('idle timeout')),
        this.#idleTimeoutMs,
      );
    };

    try {
      armIdle();
      const response = await this.#fetch(this.#url(pairing, '/v1/events'), {
        headers: {
          Authorization: `Bearer ${pairing.token}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        discardBody(response);
        this.#log.warn(`Bridge refused the pairing token (HTTP ${response.status})`);
        return 'unauthorized';
      }
      const type = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!response.ok || !response.body || !type.startsWith('text/event-stream')) {
        discardBody(response);
        this.#log.warn(`Bridge answered HTTP ${response.status} (${type || 'no content type'})`);
        return 'protocol';
      }

      this.#log.info(`Connected to Biolume ${pairing.app} on port ${pairing.port}`);
      const parser = new SseParser((message) => {
        const event = parseEventData(message.data);
        if (!event) {
          this.#log.debug('Ignored a malformed or unknown bridge event');
          return;
        }
        if (event.type === 'state') {
          onState();
          this.#backoff.reset();
          this.#setSnapshot({ status: 'online', state: event.state, app: pairing.app });
        }
        this.#emitEvent(event);
      });
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          parser.feed(value);
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
      this.#log.info('Bridge closed the event stream');
      return 'unreachable';
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  #url(pairing: BridgePairing, route: string): string {
    return `http://${BRIDGE_HOST}:${pairing.port}${route}`;
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.#wake === done) this.#wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wake = done;
    });
  }

  // ───────────────────────────── Pairing file watch ─────────────────────────────

  #ensureWatcher(): void {
    if (this.#unwatch || !this.#running) return;
    this.#unwatch = this.#watchPairing(
      this.#file,
      () => this.#pairingTouched(),
      () => {
        this.#unwatch = null;
      },
    );
  }

  #pairingTouched(): void {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#recheckPairing();
    }, this.#watchDebounceMs);
  }

  async #recheckPairing(): Promise<void> {
    if (!this.#running) return;
    const read = await this.#readPairing(this.#file);
    if (!this.#running || read.kind !== 'ok') return;
    const active = this.#active;
    if (active && samePairing(active.pairing, read.pairing)) return;
    if (active) {
      this.#log.info('Pairing changed (Biolume restarted?); reconnecting');
      active.controller.abort(new Error('pairing changed'));
    }
    this.reconnectNow();
  }

  // ───────────────────────────── Snapshot ─────────────────────────────

  #setOffline(reason: OfflineReason): void {
    if (this.#graceTimer) {
      // Still inside the grace period after a working stream dropped: remember why, decide later.
      this.#graceReason = reason;
      return;
    }
    const current = this.#snapshot;
    if (current.status === 'offline' && current.reason === reason) return;
    this.#setSnapshot({ status: 'offline', reason });
  }

  /**
   * A working stream dropped: keep showing the last state for `offlineGraceMs`.
   * A state arriving meanwhile cancels the grace; otherwise the latest failure
   * reason is shown when it runs out.
   */
  #setOfflineAfterGrace(reason: OfflineReason): void {
    if (this.#offlineGraceMs <= 0) {
      this.#setOffline(reason);
      return;
    }
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#graceReason = reason;
    this.#graceTimer = setTimeout(() => {
      this.#graceTimer = null;
      if (this.#running) this.#setOffline(this.#graceReason);
    }, this.#offlineGraceMs);
  }

  #setSnapshot(snapshot: BridgeSnapshot): void {
    if (this.#graceTimer) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
    this.#snapshot = snapshot;
    for (const listener of this.#changeListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#log.error(`Snapshot listener failed: ${describeError(error)}`);
      }
    }
  }

  #emitEvent(event: BridgeEvent): void {
    for (const listener of this.#eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.#log.error(`Event listener failed: ${describeError(error)}`);
      }
    }
  }
}
