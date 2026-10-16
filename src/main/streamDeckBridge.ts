/**
 * The local bridge the Biolume Stream Deck plugin talks to. Implements the
 * protocol in `@shared/streamDeck` with `node:http` alone:
 *
 *   GET  /v1/state    the active hunt as a BridgeState
 *   GET  /v1/events   Server-Sent Events: a `state` event first, then one after every
 *                     change the plugin can see, an `action` event after every bridge
 *                     action, and a `: ping` comment every 15 s
 *   POST /v1/action   { action } -> BridgeActionResponse
 *
 * This is a door into the app for other local processes, so every request is
 * treated as hostile until proven otherwise:
 *   - the server listens on 127.0.0.1 only;
 *   - a request carrying an `Origin` header (any web page) is refused (403), and so is
 *     a `Host` other than 127.0.0.1:<port> / localhost:<port> (DNS rebinding, 403);
 *   - every request needs `Authorization: Bearer <token>`; the token is 32 random bytes,
 *     made afresh every time the bridge starts listening, and compared in constant time
 *     (401). A token therefore never outlives the port it was issued for: one that leaked
 *     to whatever grabbed the port after a stop (or sits in a pairing file that could not
 *     be removed) is worthless once the bridge is back;
 *   - bodies are capped at 4 KB and validated with zod (400); headers, slow requests,
 *     open event streams and unread stream buffers are capped too;
 *   - sockets that have not yet presented the token are few and short-lived: header
 *     timeouts are enforced every second, and past {@link MAX_UNAUTHENTICATED_SOCKETS}
 *     the oldest is dropped, so idle connections from another local process can never
 *     use up the connection slots the plugin needs;
 *   - no CORS headers are ever sent.
 *
 * Pairing: while listening, the port and token are written atomically to
 * `STREAM_DECK_PAIRING_FILE` in userData (owner-only where the OS supports
 * file modes; `%APPDATA%` is per-user on Windows). The file is removed when the
 * bridge stops or the app quits. The token is never logged.
 *
 * This module must stay free of `electron` imports so it can be unit-tested.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import {
  BRIDGE_ACTIONS,
  STREAM_DECK_DEFAULT_PORT,
  STREAM_DECK_PAIRING_FILE,
  STREAM_DECK_PROTOCOL_VERSION,
  type BridgeAction,
  type BridgeActionResponse,
  type BridgeEvent,
  type BridgeHunt,
  type BridgePairing,
  type BridgeState,
} from '@shared/streamDeck';
import { huntTotal, type Hunt, type StreamDeckStatus } from '@shared/types';
import { describeError } from './dataFiles';
import type { ShinyConfirm } from './shinyConfirm';
import type { AppStore } from './store';
import { truncate } from './validation';

type Logger = (message: string, detail?: unknown) => void;

export const BRIDGE_HOST = '127.0.0.1';
export const MAX_ACTION_BODY_BYTES = 4 * 1024;
export const MAX_EVENT_STREAMS = 8;
export const PING_INTERVAL_MS = 15_000;
/** A stream whose client stopped reading is dropped once this much is waiting for it. */
const MAX_STREAM_BACKLOG_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
/**
 * Sockets that have not presented the token yet. Past this many the oldest is dropped,
 * so a local process holding idle connections open cannot lock the plugin out: the
 * plugin's own connection is always the newest and authenticates within milliseconds.
 */
export const MAX_UNAUTHENTICATED_SOCKETS = 16;
/** A hard ceiling for file handles; only authenticated (same-user) clients can get near it. */
const MAX_CONNECTIONS = 128;
const HEADERS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Node checks the timeouts above only this often (its default is 30 s, which made them moot). */
const TIMEOUT_CHECK_INTERVAL_MS = 1_000;
const MAX_MESSAGE_LENGTH = 200;

/** Windows' indexer and virus scanners briefly hold files open; a rename then fails with these. */
const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const PAIRING_WRITE_ATTEMPTS = 4;

export interface StreamDeckBridgeOptions {
  store: Pick<AppStore, 'getActiveHunt' | 'adjustCount' | 'undo' | 'logPhase' | 'subscribe'>;
  shiny: Pick<ShinyConfirm, 'request' | 'armedUntil' | 'subscribe'>;
  toggleOverlay(): void;
  /** Biolume's userData directory; the pairing file is written there. */
  pairingDir: string;
  /** Written into the pairing file. */
  appVersion: string;
  /** Preferred port (default {@link STREAM_DECK_DEFAULT_PORT}); 0 lets the OS pick one. */
  port?: number;
  /** Whether the `.streamDeckPlugin` installer ships with this build (default: false). */
  isPluginBundled?: () => boolean;
  /** Written into the pairing file (default `process.pid`). */
  pid?: number;
  pingIntervalMs?: number;
  maxStreams?: number;
  /** How long a client may take to send its request headers (default 5 s; tests shorten it). */
  headersTimeoutMs?: number;
  /** How long a client may take to send its whole request (default 10 s; tests shorten it). */
  requestTimeoutMs?: number;
  log?: Logger;
}

export interface StreamDeckBridge {
  /**
   * Starts or stops the server to match `settings.streamDeck.enabled`. Calls are
   * serialised; the promise settles once this one has been applied.
   */
  setEnabled(enabled: boolean): Promise<StreamDeckStatus>;
  getStatus(): StreamDeckStatus;
  /** Called with the new status whenever any of its fields changes. */
  onStatus(listener: (status: StreamDeckStatus) => void): () => void;
  /** What `GET /v1/state` answers right now. */
  getState(): BridgeState;
  /** Synchronous teardown for quit: removes the pairing file, drops every connection. */
  shutdown(): void;
}

// ───────────────────────────── Pure helpers ─────────────────────────────

const actionRequestSchema = z.object({
  action: z.custom<BridgeAction>(
    (value) => typeof value === 'string' && (BRIDGE_ACTIONS as readonly string[]).includes(value),
    `expected one of ${BRIDGE_ACTIONS.join(', ')}`,
  ),
});

export function toBridgeHunt(hunt: Hunt): BridgeHunt {
  return {
    id: hunt.id,
    name: hunt.name,
    status: hunt.status,
    count: hunt.count,
    total: huntTotal(hunt),
    step: hunt.step,
    phaseNumber: hunt.phases.length + 1,
    targetName: hunt.target?.name ?? null,
    shinySpriteUrl: hunt.target?.shinySpriteUrl ?? null,
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** The bearer token of an `Authorization` header, or null when it is missing or malformed. */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined || header.length > 512) return null;
  const match = /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)[ ]*$/i.exec(header);
  return match?.[1] ?? null;
}

/** `Host` must name this server on the loopback interface, by IP or as `localhost`. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  return value === `${BRIDGE_HOST}:${port}` || value === `localhost:${port}`;
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address === '::1';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Encodes one event as an SSE frame. JSON escapes line breaks, so it is always one `data:` line. */
export function sseFrame(event: BridgeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

type BodyResult = { kind: 'ok'; text: string } | { kind: 'too-large' } | { kind: 'aborted' };

function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) {
      resolve({ kind: 'too-large' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        settle({ kind: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ kind: 'aborted' }));
    req.on('close', () => settle({ kind: 'aborted' }));
  });
}

// ───────────────────────────── The bridge ─────────────────────────────

export function createStreamDeckBridge(options: StreamDeckBridgeOptions): StreamDeckBridge {
  const { store, shiny } = options;
  const log = options.log ?? (() => undefined);
  const preferredPort = options.port ?? STREAM_DECK_DEFAULT_PORT;
  const pingIntervalMs = Math.max(10, options.pingIntervalMs ?? PING_INTERVAL_MS);
  const maxStreams = Math.max(1, options.maxStreams ?? MAX_EVENT_STREAMS);
  const pid = options.pid ?? process.pid;
  const pairingPath = join(options.pairingDir, STREAM_DECK_PAIRING_FILE);
  const headersTimeoutMs = Math.max(50, options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS);
  // Node refuses a request timeout shorter than the headers timeout.
  const requestTimeoutMs = Math.max(
    headersTimeoutMs,
    options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  /**
   * The current token, made afresh by every start and dropped by every stop: it is only
   * ever valid while this bridge holds the port it was issued for. The plugin re-reads
   * the pairing file after a 401 or a dropped stream, so a new token costs it nothing.
   */
  let token: string | null = null;
  let tokenDigest: Buffer | null = null;

  let enabled = false;
  let server: Server | null = null;
  let port: number | null = null;
  let error: string | null = null;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const sockets = new Set<Socket>();
  /** Sockets that have not presented the token yet, oldest first. */
  const unauthenticated = new Set<Socket>();
  /** Open event streams, with the state (as JSON) each one was sent last. */
  const streams = new Map<ServerResponse, string>();
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const statusListeners = new Set<(status: StreamDeckStatus) => void>();
  let lastStatusJson: string | null = null;

  // ─── State and status ───

  const getState = (): BridgeState => {
    const hunt = store.getActiveHunt();
    const until = hunt === null ? null : shiny.armedUntil(hunt.id);
    return {
      protocol: STREAM_DECK_PROTOCOL_VERSION,
      hunt: hunt === null ? null : toBridgeHunt(hunt),
      shinyFoundArmed: until !== null,
      shinyFoundArmedUntil: until,
    };
  };

  const pluginBundled = (): boolean => {
    try {
      return options.isPluginBundled?.() ?? false;
    } catch {
      return false;
    }
  };

  const getStatus = (): StreamDeckStatus => ({
    enabled,
    listening: server !== null && port !== null,
    port,
    clients: streams.size,
    pluginBundled: pluginBundled(),
    error,
  });

  const publishStatus = (): void => {
    const status = getStatus();
    const json = JSON.stringify(status);
    if (json === lastStatusJson) return;
    lastStatusJson = json;
    for (const listener of [...statusListeners]) {
      try {
        listener(status);
      } catch (failure) {
        log('A Stream Deck status listener failed', failure);
      }
    }
  };

  // ─── Event streams ───

  const write = (res: ServerResponse, text: string): void => {
    if (res.writableEnded || res.destroyed) return;
    if (res.writableLength > MAX_STREAM_BACKLOG_BYTES) {
      // The client stopped reading; dropping it beats buffering without end.
      res.destroy();
      return;
    }
    res.write(text);
  };

  const pushToStreams = (text: string): void => {
    for (const res of [...streams.keys()]) write(res, text);
  };

  const stateFrame = (json: string): string => `data: {"type":"state","state":${json}}\n\n`;

  /** Sends the current state to every stream that has not seen it yet. */
  const pushState = (): void => {
    if (streams.size === 0) return;
    let json: string;
    try {
      json = JSON.stringify(getState());
    } catch (failure) {
      log('Could not build the Stream Deck state', failure);
      return;
    }
    for (const [res, sent] of [...streams]) {
      if (sent === json) continue;
      streams.set(res, json);
      write(res, stateFrame(json));
    }
  };

  const stopPing = (): void => {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
  };

  const startPing = (): void => {
    if (pingTimer !== null) return;
    pingTimer = setInterval(() => pushToStreams(': ping\n\n'), pingIntervalMs);
    pingTimer.unref();
  };

  const stopFollowingStore = store.subscribe(() => pushState());
  const stopFollowingShiny = shiny.subscribe(() => pushState());

  // ─── Responses ───

  const sendJson = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(text)),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // A refused request is the last one its connection gets to make.
      ...(status >= 400 ? { Connection: 'close' } : {}),
      ...headers,
    });
    res.end(text);
  };

  const refuse = (
    res: ServerResponse,
    status: number,
    message: string,
    headers?: Record<string, string>,
  ): void => sendJson(res, status, { ok: false, error: message }, headers);

  // ─── Actions ───

  const runAction = (action: BridgeAction): { ok: boolean; message?: string } => {
    if (action === 'toggleOverlay') {
      options.toggleOverlay();
      return { ok: true, message: 'Mini-overlay toggled' };
    }
    const hunt = store.getActiveHunt();
    if (hunt === null) return { ok: false, message: 'No active hunt — pick one in Biolume' };

    // Undo also works on a completed hunt: it is how a Shiny Found is taken back.
    if (action === 'undo') {
      return store.undo(hunt.id, 'streamdeck') === null
        ? { ok: false, message: 'Nothing to undo' }
        : { ok: true, message: 'Undone' };
    }
    if (hunt.status !== 'active') {
      return {
        ok: false,
        message: `"${hunt.name}" is ${hunt.status} — reopen it in Biolume to keep hunting`,
      };
    }
    switch (action) {
      case 'increment':
        store.adjustCount(hunt.id, hunt.step, 'streamdeck');
        return { ok: true };
      case 'decrement':
        if (hunt.count === 0) return { ok: false, message: 'The count is already 0' };
        store.adjustCount(hunt.id, -hunt.step, 'streamdeck');
        return { ok: true };
      case 'logPhase': {
        // Unidentified, like the global hotkey's quick-log; the user names it in Biolume.
        const { hunt: logged } = store.logPhase(hunt.id, {
          speciesId: null,
          speciesName: '',
          source: 'streamdeck',
        });
        return {
          ok: true,
          message: `Phase ${logged.phases.length} logged — identify it in Biolume`,
        };
      }
      case 'shinyFound': {
        const result = shiny.request(hunt.id, 'streamdeck');
        return result.completed
          ? { ok: true, message: 'Shiny found! Hunt completed — Undo takes it back' }
          : { ok: true, message: 'Press again to confirm Shiny Found' };
      }
    }
  };

  const handleAction = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req, MAX_ACTION_BODY_BYTES);
    if (body.kind === 'aborted') {
      res.destroy();
      return;
    }
    if (body.kind === 'too-large') {
      refuse(res, 400, `The request body is larger than ${MAX_ACTION_BODY_BYTES} bytes`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.text);
    } catch {
      refuse(res, 400, 'The request body is not JSON');
      return;
    }
    const parsed = actionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      refuse(
        res,
        400,
        `Invalid action request: expected { "action": one of ${BRIDGE_ACTIONS.join(', ')} }`,
      );
      return;
    }

    const { action } = parsed.data;
    let outcome: { ok: boolean; message?: string };
    try {
      outcome = runAction(action);
    } catch (failure) {
      // A refusal from the store (a full phase log, …): reported, never a 500.
      outcome = { ok: false, message: truncate(describeError(failure), MAX_MESSAGE_LENGTH) };
    }
    const response: BridgeActionResponse = { ...outcome, state: getState() };
    sendJson(res, 200, response);
    pushToStreams(
      sseFrame(
        outcome.message === undefined
          ? { type: 'action', action, ok: outcome.ok }
          : { type: 'action', action, ok: outcome.ok, message: outcome.message },
      ),
    );
  };

  const openStream = (req: IncomingMessage, res: ServerResponse): void => {
    if (streams.size >= maxStreams) {
      refuse(res, 503, 'Too many open event streams', { 'Retry-After': '5' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    req.socket.setNoDelay(true);
    // The first event is always the full state.
    const json = JSON.stringify(getState());
    streams.set(res, json);
    const close = (): void => {
      if (!streams.delete(res)) return;
      if (streams.size === 0) stopPing();
      publishStatus();
    };
    res.on('close', close);
    res.on('error', close);
    write(res, stateFrame(json));
    startPing();
    publishStatus();
  };

  // ─── Routing ───

  const ROUTES: ReadonlyMap<string, string> = new Map([
    ['/v1/state', 'GET'],
    ['/v1/events', 'GET'],
    ['/v1/action', 'POST'],
  ]);

  const isAuthorized = (header: string | undefined): boolean => {
    const presented = readBearerToken(header);
    if (presented === null || tokenDigest === null) return false;
    // Digests have a fixed length, so the comparison leaks neither content nor length.
    return timingSafeEqual(digest(presented), tokenDigest);
  };

  const route = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isLoopback(req.socket.remoteAddress)) {
      req.socket.destroy();
      return;
    }
    if (req.headers.origin !== undefined) {
      refuse(res, 403, 'Requests from web pages are not accepted');
      return;
    }
    const localPort = req.socket.localPort ?? -1;
    if (!isAllowedHost(req.headers.host, localPort)) {
      refuse(res, 403, 'Unexpected Host header');
      return;
    }
    if (!isAuthorized(req.headers.authorization)) {
      refuse(res, 401, 'Missing or wrong token — re-read the pairing file', {
        'WWW-Authenticate': 'Bearer',
      });
      return;
    }
    // Proven: from now on this socket is never dropped to make room for others.
    unauthenticated.delete(req.socket);
    const path = (req.url ?? '').split('?', 1)[0] ?? '';
    const method = ROUTES.get(path);
    if (method === undefined) {
      refuse(res, 404, 'Not found');
      return;
    }
    if (req.method !== method) {
      refuse(res, 405, `Use ${method}`, { Allow: method });
      return;
    }
    switch (path) {
      case '/v1/state':
        sendJson(res, 200, getState());
        return;
      case '/v1/events':
        openStream(req, res);
        return;
      default:
        handleAction(req, res).catch((failure: unknown) => {
          log('A Stream Deck action failed', failure);
          refuse(res, 500, 'Internal error');
        });
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      route(req, res);
    } catch (failure) {
      log('A Stream Deck request failed', failure);
      if (res.headersSent) res.destroy();
      else refuse(res, 500, 'Internal error');
    }
  };

  // ─── Server lifecycle ───

  const createHttpServer = (): Server => {
    const created = createServer(
      {
        maxHeaderSize: MAX_HEADER_BYTES,
        headersTimeout: headersTimeoutMs,
        requestTimeout: requestTimeoutMs,
        connectionsCheckingInterval: Math.min(TIMEOUT_CHECK_INTERVAL_MS, headersTimeoutMs),
        requireHostHeader: true,
      },
      handle,
    );
    created.maxConnections = MAX_CONNECTIONS;
    created.on('connection', (socket: Socket) => {
      sockets.add(socket);
      unauthenticated.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
        unauthenticated.delete(socket);
      });
      // Too many strangers: the one that has been silent longest makes room.
      if (unauthenticated.size > MAX_UNAUTHENTICATED_SOCKETS) {
        const oldest = unauthenticated.values().next().value;
        if (oldest !== undefined) {
          unauthenticated.delete(oldest);
          oldest.destroy();
        }
      }
    });
    created.on('clientError', (_failure, socket: Socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    return created;
  };

  const listen = (candidate: Server, onPort: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (failure: Error): void => {
        candidate.off('listening', onListening);
        reject(failure);
      };
      const onListening = (): void => {
        candidate.off('error', onError);
        resolve((candidate.address() as AddressInfo).port);
      };
      candidate.once('error', onError);
      candidate.once('listening', onListening);
      candidate.listen({ port: onPort, host: BRIDGE_HOST });
    });

  /** The preferred port, else any free one the OS hands out. */
  const listenWithFallback = async (): Promise<{ server: Server; port: number }> => {
    const first = createHttpServer();
    try {
      return { server: first, port: await listen(first, preferredPort) };
    } catch (failure) {
      if (preferredPort === 0) throw failure;
      log(
        `Stream Deck bridge: port ${preferredPort} is not available (${errorCode(failure) ?? describeError(failure)}), using another one`,
      );
    }
    const second = createHttpServer();
    return { server: second, port: await listen(second, 0) };
  };

  const writePairing = async (onPort: number, issued: string): Promise<void> => {
    const pairing: BridgePairing = {
      protocol: STREAM_DECK_PROTOCOL_VERSION,
      port: onPort,
      token: issued,
      pid,
      app: options.appVersion,
    };
    const text = `${JSON.stringify(pairing, null, 2)}\n`;
    for (let attempt = 1; ; attempt += 1) {
      const temp = `${pairingPath}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        renameSync(temp, pairingPath);
        try {
          chmodSync(pairingPath, 0o600);
        } catch {
          // Best effort; Windows has no POSIX modes (userData is per-user there anyway).
        }
        return;
      } catch (failure) {
        try {
          unlinkSync(temp);
        } catch {
          // Never created, or already renamed.
        }
        const code = errorCode(failure);
        if (
          attempt >= PAIRING_WRITE_ATTEMPTS ||
          code === undefined ||
          !TRANSIENT_FS_CODES.has(code)
        ) {
          throw failure;
        }
        await pause(25 * attempt);
      }
    }
  };

  /**
   * Written by this process: it holds the current token, or this pid (a file an earlier
   * stop of this run could not remove). The single-instance lock is keyed by userData,
   * so no other live Biolume can own a file here with the same pid.
   */
  const isOwnPairing = (raw: unknown): boolean =>
    typeof raw === 'object' &&
    raw !== null &&
    (('pid' in raw && raw.pid === pid) ||
      (token !== null && 'token' in raw && raw.token === token));

  /**
   * Removes the pairing file — only when it is ours, so another instance's file survives.
   * 'locked' when Windows briefly held it open (an indexer or virus scanner).
   */
  const removePairingOnce = (): 'done' | 'locked' => {
    try {
      const raw: unknown = JSON.parse(readFileSync(pairingPath, 'utf8'));
      if (isOwnPairing(raw)) unlinkSync(pairingPath);
      return 'done';
    } catch (failure) {
      const code = errorCode(failure);
      if (code === 'ENOENT') return 'done';
      if (code !== undefined && TRANSIENT_FS_CODES.has(code)) return 'locked';
      log('Could not remove the Stream Deck pairing file', failure);
      return 'done';
    }
  };

  /** Retries a locked file for a moment. One left behind anyway names a token that is about to die. */
  const removePairing = async (): Promise<void> => {
    for (let attempt = 1; removePairingOnce() === 'locked'; attempt += 1) {
      if (attempt >= PAIRING_WRITE_ATTEMPTS) {
        log('Could not remove the Stream Deck pairing file: it stayed locked');
        return;
      }
      await pause(25 * attempt);
    }
  };

  const issueToken = (): string => {
    const issued = randomBytes(32).toString('base64url');
    token = issued;
    tokenDigest = digest(issued);
    return issued;
  };

  const revokeToken = (): void => {
    token = null;
    tokenDigest = null;
  };

  const dropConnections = (): void => {
    stopPing();
    for (const res of streams.keys()) res.destroy();
    streams.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    unauthenticated.clear();
  };

  const closeServer = (target: Server): Promise<void> =>
    new Promise((resolve) => {
      target.close(() => resolve());
      target.closeAllConnections();
    });

  const start = async (): Promise<void> => {
    error = null;
    let opened: { server: Server; port: number };
    try {
      opened = await listenWithFallback();
    } catch (failure) {
      error = `Could not open a local port: ${describeError(failure)}`;
      log(`Stream Deck bridge: ${error}`);
      return;
    }
    if (disposed) {
      // The app quit while the port was opening: no pairing file may outlive it.
      await closeServer(opened.server);
      return;
    }
    server = opened.server;
    port = opened.port;
    // A new token for every listening period; nobody can know it before the file is written.
    const issued = issueToken();
    try {
      await writePairing(opened.port, issued);
    } catch (failure) {
      error = `Could not write the pairing file: ${describeError(failure)}`;
      log(`Stream Deck bridge: ${error}`);
      revokeToken();
      dropConnections();
      await closeServer(opened.server);
      server = null;
      port = null;
      return;
    }
    if (disposed) {
      // Quit while the file was being written (shutdown already closed the server).
      removePairingOnce();
      return;
    }
    log(`Stream Deck bridge listening on ${BRIDGE_HOST}:${opened.port}`);
  };

  const stop = async (): Promise<void> => {
    const current = server;
    // The file goes first, so the plugin never finds it naming a port nobody holds.
    await removePairing();
    revokeToken();
    dropConnections();
    server = null;
    port = null;
    if (current !== null) await closeServer(current);
  };

  const apply = async (next: boolean): Promise<StreamDeckStatus> => {
    if (disposed) return getStatus();
    enabled = next;
    if (next && server === null) {
      // Also retries after an earlier failure (any later settings change lands here).
      error = null;
      publishStatus();
      await start();
      // Quit while the port was being opened.
      if (disposed && server !== null) await stop();
    } else if (!next) {
      error = null;
      if (server !== null) await stop();
    }
    publishStatus();
    return getStatus();
  };

  return {
    setEnabled(next) {
      const result = queue.then(() => apply(next));
      queue = result.catch((failure: unknown) => log('The Stream Deck bridge failed', failure));
      return result;
    },

    getStatus,

    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },

    getState,

    shutdown() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      stopFollowingStore();
      stopFollowingShiny();
      if (removePairingOnce() === 'locked') {
        log('Could not remove the Stream Deck pairing file: it was locked');
      }
      revokeToken();
      dropConnections();
      const current = server;
      server = null;
      port = null;
      if (current !== null) {
        current.close();
        current.closeAllConnections();
      }
      statusListeners.clear();
    },
  };
}
