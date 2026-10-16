import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings } from '@shared/defaults';
import {
  SHINY_CONFIRM_WINDOW_MS,
  STREAM_DECK_PAIRING_FILE,
  type BridgeActionResponse,
  type BridgeEvent,
  type BridgePairing,
  type BridgeState,
} from '@shared/streamDeck';
import type { AppState, StateEvent, StreamDeckStatus, TargetRef } from '@shared/types';
import { createShinyConfirm, type ConfirmTimers } from './shinyConfirm';
import { createAppStore, type AppStore, type StatePersistence } from './store';
import {
  createStreamDeckBridge,
  isAllowedHost,
  MAX_UNAUTHENTICATED_SOCKETS,
  readBearerToken,
  type StreamDeckBridge,
  type StreamDeckBridgeOptions,
} from './streamDeckBridge';

const START = Date.UTC(2026, 9, 15, 20, 0, 0);

const GASTLY: TargetRef = {
  speciesId: 92,
  pokemonId: 92,
  slug: 'gastly',
  name: 'Gastly',
  types: ['ghost', 'poison'],
  spriteUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/92.png',
  shinySpriteUrl:
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/92.png',
};

// ───────────────────────────── Harness ─────────────────────────────

function createManualTime() {
  let ms = START;
  let nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: ConfirmTimers = {
    set(callback, delay) {
      nextId += 1;
      pending.set(nextId, { at: ms + delay, callback });
      return nextId;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    now: () => ms,
    timers,
    advance(by: number) {
      const target = ms + by;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > target) break;
        pending.delete(id);
        ms = timer.at;
        timer.callback();
      }
      ms = target;
    },
  };
}

interface Harness {
  store: AppStore;
  bridge: StreamDeckBridge;
  dir: string;
  time: ReturnType<typeof createManualTime>;
  toggles: { overlay: number };
  statuses: StreamDeckStatus[];
  changes: StateEvent[];
  huntId: string;
}

const harnesses: Harness[] = [];
const blockers: { close(): void }[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.bridge.shutdown();
    rmSync(harness.dir, { recursive: true, force: true });
  }
  for (const blocker of blockers.splice(0)) blocker.close();
});

async function setup(
  overrides: Partial<StreamDeckBridgeOptions> = {},
  options: { start?: boolean } = {},
): Promise<Harness> {
  const initial: AppState = {
    settings: createDefaultSettings(),
    hunts: [],
    activeHuntId: null,
    sessions: [],
  };
  const persistence: StatePersistence = {
    loadState: () => initial,
    saveSettings: () => undefined,
    saveHunts: () => undefined,
    saveSessions: () => undefined,
    flushSync: () => undefined,
  };
  const time = createManualTime();
  let nextId = 0;
  const store = createAppStore(persistence, {
    now: () => new Date(time.now()),
    idGenerator: () => `id-${(nextId += 1)}`,
  });
  const hunt = store.createHunt({ name: 'Gastly — night outbreak', target: GASTLY, step: 3 });
  const shiny = createShinyConfirm({ store, now: time.now, timers: time.timers });
  const dir = mkdtempSync(join(tmpdir(), 'biolume-bridge-test-'));
  const toggles = { overlay: 0 };
  const bridge = createStreamDeckBridge({
    store,
    shiny,
    toggleOverlay: () => {
      toggles.overlay += 1;
    },
    pairingDir: dir,
    appVersion: '9.8.7',
    port: 0,
    pid: 4242,
    isPluginBundled: () => true,
    ...overrides,
  });
  const statuses: StreamDeckStatus[] = [];
  bridge.onStatus((status) => statuses.push(status));
  const changes: StateEvent[] = [];
  store.subscribe((event) => changes.push(event));
  const harness: Harness = {
    store,
    bridge,
    dir,
    time,
    toggles,
    statuses,
    changes,
    huntId: hunt.id,
  };
  harnesses.push(harness);
  if (options.start !== false) await bridge.setEnabled(true);
  return harness;
}

function readPairing(dir: string): BridgePairing {
  return JSON.parse(readFileSync(join(dir, STREAM_DECK_PAIRING_FILE), 'utf8')) as BridgePairing;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

interface RequestOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send the body chunked, without a Content-Length. */
  chunked?: boolean;
  setHost?: boolean;
}

function call(port: number, options: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/v1/state',
        headers: options.headers ?? {},
        agent: false,
        setHost: options.setHost ?? true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    // The server may answer and close before an oversized body is fully sent.
    req.on('error', reject);
    if (options.body !== undefined) {
      if (options.chunked === true) {
        const body = Buffer.from(options.body);
        for (let offset = 0; offset < body.length; offset += 1_000) {
          req.write(body.subarray(offset, offset + 1_000));
        }
      } else {
        req.setHeader('Content-Length', Buffer.byteLength(options.body));
        req.write(options.body);
      }
    }
    req.end();
  });
}

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function act(port: number, token: string, action: string): Promise<BridgeActionResponse> {
  const reply = await call(port, {
    method: 'POST',
    path: '/v1/action',
    headers: auth(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action }),
  });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.text) as BridgeActionResponse;
}

interface EventStream {
  status: number;
  headers: IncomingHttpHeaders;
  events: BridgeEvent[];
  pings: number;
  /** Resolves with the first event (from the start of the stream) that matches. */
  next(match: (event: BridgeEvent) => boolean, after?: number): Promise<BridgeEvent>;
  waitForPing(): Promise<void>;
  closed: Promise<void>;
  close(): void;
}

function openEvents(port: number, token: string): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/events',
        headers: auth(token, { Accept: 'text/event-stream' }),
        agent: false,
      },
      (res) => {
        let buffer = '';
        const waiters = new Set<() => void>();
        let closedResolve: () => void = () => undefined;
        const closed = new Promise<void>((done) => {
          closedResolve = done;
        });
        const stream: EventStream = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          events: [],
          pings: 0,
          next(match, after = 0) {
            return new Promise((found, fail) => {
              const check = (): boolean => {
                const hit = stream.events.slice(after).find(match);
                if (hit === undefined) return false;
                waiters.delete(waiter);
                found(hit);
                return true;
              };
              const waiter = (): void => {
                check();
              };
              if (check()) return;
              waiters.add(waiter);
              setTimeout(() => {
                waiters.delete(waiter);
                fail(new Error('Timed out waiting for an event'));
              }, 2_000);
            });
          },
          waitForPing() {
            const seen = stream.pings;
            return new Promise((found, fail) => {
              const waiter = (): void => {
                if (stream.pings > seen) {
                  waiters.delete(waiter);
                  found();
                }
              };
              waiters.add(waiter);
              setTimeout(() => fail(new Error('No ping')), 2_000);
            });
          },
          closed,
          close: () => req.destroy(),
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of block.split('\n')) {
              if (line.startsWith('data: '))
                stream.events.push(JSON.parse(line.slice(6)) as BridgeEvent);
              else if (line.startsWith(':')) stream.pings += 1;
            }
          }
          for (const waiter of [...waiters]) waiter();
        });
        res.on('close', () => closedResolve());
        resolve(stream);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Raw TCP connections that send nothing (a slowloris client). */
function openIdleSockets(port: number, count: number): Promise<Socket[]> {
  return Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<Socket>((resolve, reject) => {
          const socket = connect(port, '127.0.0.1', () => resolve(socket));
          // Dropped by the server: expected.
          socket.on('error', () => undefined);
          socket.once('error', reject);
          // Read (and ignore) whatever the server answers, so its close is noticed.
          socket.resume();
        }),
    ),
  );
}

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// ───────────────────────────── Tests ─────────────────────────────

describe('stream deck bridge helpers', () => {
  it('reads bearer tokens strictly', () => {
    expect(readBearerToken('Bearer abc-DEF_123')).toBe('abc-DEF_123');
    expect(readBearerToken('bearer abc')).toBe('abc');
    expect(readBearerToken(undefined)).toBeNull();
    expect(readBearerToken('Basic abc')).toBeNull();
    expect(readBearerToken('Bearer')).toBeNull();
    expect(readBearerToken('Bearer a b')).toBeNull();
    expect(readBearerToken(`Bearer ${'a'.repeat(600)}`)).toBeNull();
  });

  it('accepts only loopback Host headers for its own port', () => {
    expect(isAllowedHost('127.0.0.1:4000', 4000)).toBe(true);
    expect(isAllowedHost('LOCALHOST:4000', 4000)).toBe(true);
    expect(isAllowedHost('127.0.0.1:4001', 4000)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 4000)).toBe(false);
    expect(isAllowedHost('evil.example:4000', 4000)).toBe(false);
    expect(isAllowedHost('localhost.evil.example:4000', 4000)).toBe(false);
    expect(isAllowedHost(undefined, 4000)).toBe(false);
    // Alternate spellings of loopback are not what the plugin sends, and are refused.
    for (const host of [
      '[::1]:4000',
      '[::ffff:127.0.0.1]:4000',
      '127.1:4000',
      '0x7f000001:4000',
      '2130706433:4000',
      '127.0.0.1.:4000',
      'localhost.:4000',
      'evil.localhost:4000',
      '127.0.0.1:04000',
      '127.0.0.1:4000:4000',
      '127.0.0.1:4000@evil.example',
      '',
    ]) {
      expect(isAllowedHost(host, 4000)).toBe(false);
    }
  });
});

describe('createStreamDeckBridge', () => {
  it('listens on 127.0.0.1 and writes the pairing file', async () => {
    const { bridge, dir, statuses } = await setup();
    const status = bridge.getStatus();
    expect(status).toMatchObject({
      enabled: true,
      listening: true,
      clients: 0,
      pluginBundled: true,
      error: null,
    });
    expect(status.port).toBeGreaterThan(0);
    expect(statuses.at(-1)).toEqual(status);

    const pairing = readPairing(dir);
    expect(pairing).toEqual({
      protocol: 1,
      port: status.port,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
      pid: 4242,
      app: '9.8.7',
    });
    // No temp files are left behind.
    expect(existsSync(join(dir, STREAM_DECK_PAIRING_FILE))).toBe(true);
  });

  it('is reachable on 127.0.0.1 only, not over IPv6 loopback or any network interface', async () => {
    const { dir } = await setup();
    const { port } = readPairing(dir);
    const others = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address);
    for (const host of ['::1', ...others]) {
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = connect({ port, host }, () => {
            socket.destroy();
            resolve();
          });
          socket.on('error', reject);
          // An adapter that swallows the SYN is just as unreachable.
          socket.setTimeout(1_000, () => socket.destroy(new Error('timed out')));
        }),
      ).rejects.toThrow();
    }
  });

  it('answers GET /v1/state with the active hunt and no CORS headers', async () => {
    const { bridge, dir, store, huntId } = await setup();
    store.adjustCount(huntId, 9, 'ui');
    store.logPhase(huntId, { speciesId: 353, speciesName: 'Shuppet', source: 'ui' });
    store.adjustCount(huntId, 4, 'ui');
    const { port, token } = readPairing(dir);

    const reply = await call(port, { headers: auth(token) });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    const state = JSON.parse(reply.text) as BridgeState;
    expect(state).toEqual({
      protocol: 1,
      hunt: {
        id: huntId,
        name: 'Gastly — night outbreak',
        status: 'active',
        count: 4,
        total: 13,
        step: 3,
        phaseNumber: 2,
        targetName: 'Gastly',
        shinySpriteUrl: GASTLY.shinySpriteUrl,
      },
      shinyFoundArmed: false,
      shinyFoundArmedUntil: null,
    });
    expect(state).toEqual(bridge.getState());

    // `localhost` is as good as the IP.
    const byName = await call(port, { headers: auth(token, { Host: `localhost:${port}` }) });
    expect(byName.status).toBe(200);
  });

  it('rejects requests without the right token, from web pages and with a foreign Host', async () => {
    const { dir } = await setup();
    const { port, token } = readPairing(dir);
    const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

    for (const headers of [
      {} as Record<string, string>,
      { Authorization: `Bearer ${wrong}` },
      { Authorization: `Basic ${token}` },
      { Authorization: token },
      { Authorization: 'Bearer ' },
    ]) {
      const reply = await call(port, { headers });
      expect(reply.status).toBe(401);
      expect(reply.headers['www-authenticate']).toBe('Bearer');
      expect(reply.text).not.toContain(token);
    }
    // Unauthenticated callers learn nothing about routes either.
    expect((await call(port, { path: '/nope' })).status).toBe(401);

    for (const origin of [
      'https://evil.example',
      'null',
      '',
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]) {
      const reply = await call(port, { headers: auth(token, { Origin: origin }) });
      expect(reply.status).toBe(403);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
    const preflight = await call(port, {
      method: 'OPTIONS',
      path: '/v1/action',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(403);

    for (const host of [
      `evil.example:${port}`,
      '127.0.0.1',
      `127.0.0.1:${port + 1}`,
      `localhost.evil.example:${port}`,
    ]) {
      const reply = await call(port, { headers: auth(token, { Host: host }) });
      expect(reply.status).toBe(403);
    }
    // HTTP/1.1 without any Host header is refused by the HTTP layer itself.
    expect((await call(port, { headers: auth(token), setHost: false })).status).toBe(400);
  });

  it('answers unknown paths with 404 and wrong methods with 405', async () => {
    const { dir } = await setup();
    const { port, token } = readPairing(dir);
    for (const path of ['/', '/v1', '/v2/state', '/v1/state/', '/v1/STATE', '/v1/../v1/state']) {
      expect((await call(port, { path, headers: auth(token) })).status).toBe(404);
    }
    // A query string does not change the route.
    expect((await call(port, { path: '/v1/state?x=1', headers: auth(token) })).status).toBe(200);

    for (const [method, path, allow] of [
      ['POST', '/v1/state', 'GET'],
      ['DELETE', '/v1/events', 'GET'],
      ['GET', '/v1/action', 'POST'],
      ['PUT', '/v1/action', 'POST'],
    ] as const) {
      const reply = await call(port, { method, path, headers: auth(token) });
      expect(reply.status).toBe(405);
      expect(reply.headers['allow']).toBe(allow);
    }
  });

  it('rejects oversized, non-JSON and invalid action bodies with 400', async () => {
    const { dir, store, huntId } = await setup();
    const { port, token } = readPairing(dir);
    const post = (body: string, chunked = false): Promise<Reply> =>
      call(port, {
        method: 'POST',
        path: '/v1/action',
        headers: auth(token, { 'Content-Type': 'application/json' }),
        body,
        chunked,
      });

    const padded = JSON.stringify({ action: 'increment', pad: 'x'.repeat(5_000) });
    expect((await post(padded)).status).toBe(400);
    expect((await post(padded, true)).status).toBe(400);
    for (const body of [
      '',
      'increment',
      '{"action":',
      '[]',
      'null',
      '{}',
      '{"action":"explode"}',
      '{"action":["increment"]}',
      '{"action":"__proto__"}',
      '{"__proto__":{"action":"increment"}}',
    ]) {
      const reply = await post(body);
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.text)).toMatchObject({ ok: false });
    }
    expect(store.getHunt(huntId)?.count).toBe(0);

    // Unknown extra fields are ignored, and a body just under the cap is fine.
    const extra = JSON.stringify({ action: 'increment', context: 'x'.repeat(3_000) });
    expect((await post(extra, true)).status).toBe(200);
    expect(store.getHunt(huntId)?.count).toBe(3);
  });

  it('applies count, phase and undo actions to the active hunt as the Stream Deck', async () => {
    const { dir, store, huntId, changes } = await setup();
    const { port, token } = readPairing(dir);

    const up = await act(port, token, 'increment');
    expect(up.ok).toBe(true);
    expect(up.state.hunt?.count).toBe(3);
    expect(store.getHunt(huntId)?.count).toBe(3);
    await act(port, token, 'increment');
    const down = await act(port, token, 'decrement');
    expect(down).toMatchObject({ ok: true, state: { hunt: { count: 3, total: 3 } } });

    const logged = await act(port, token, 'logPhase');
    expect(logged.ok).toBe(true);
    expect(logged.message).toMatch(/Phase 1 logged/);
    expect(logged.state.hunt).toMatchObject({ count: 0, total: 3, phaseNumber: 2 });
    const phase = store.getHunt(huntId)?.phases.at(-1);
    expect(phase).toMatchObject({ speciesId: null, speciesName: '', encounters: 3 });

    const undone = await act(port, token, 'undo');
    expect(undone).toMatchObject({ ok: true, state: { hunt: { count: 3, phaseNumber: 1 } } });

    const sources = changes.flatMap((event) =>
      event.type === 'hunt-changed' ? [`${event.change.kind}:${event.change.source}`] : [],
    );
    expect(sources).toEqual([
      'increment:streamdeck',
      'increment:streamdeck',
      'decrement:streamdeck',
      'phase-logged:streamdeck',
      'undo:streamdeck',
    ]);

    await act(port, token, 'undo');
    await act(port, token, 'undo');
    await act(port, token, 'undo');
    const nothing = await act(port, token, 'undo');
    expect(nothing).toMatchObject({ ok: false, message: 'Nothing to undo' });
    const floor = await act(port, token, 'decrement');
    expect(floor).toMatchObject({ ok: false, message: 'The count is already 0' });
  });

  it('needs two Shiny Found presses, refuses counting afterwards and lets undo take it back', async () => {
    const { dir, store, huntId, time } = await setup();
    const { port, token } = readPairing(dir);

    const armed = await act(port, token, 'shinyFound');
    expect(armed.ok).toBe(true);
    expect(armed.message).toBe('Press again to confirm Shiny Found');
    expect(armed.state).toMatchObject({
      shinyFoundArmed: true,
      shinyFoundArmedUntil: START + SHINY_CONFIRM_WINDOW_MS,
      hunt: { status: 'active' },
    });
    expect(store.getHunt(huntId)?.status).toBe('active');

    time.advance(SHINY_CONFIRM_WINDOW_MS - 10);
    const confirmed = await act(port, token, 'shinyFound');
    expect(confirmed.ok).toBe(true);
    expect(confirmed.state).toMatchObject({
      shinyFoundArmed: false,
      shinyFoundArmedUntil: null,
      hunt: { status: 'completed' },
    });
    expect(store.getHunt(huntId)?.status).toBe('completed');

    for (const action of ['increment', 'decrement', 'logPhase', 'shinyFound']) {
      const refused = await act(port, token, action);
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/is completed — reopen it in Biolume/);
    }

    const undone = await act(port, token, 'undo');
    expect(undone).toMatchObject({ ok: true, state: { hunt: { status: 'active' } } });
    expect(store.getHunt(huntId)?.completedAt).toBeNull();

    // A press that expires never completes anything.
    await act(port, token, 'shinyFound');
    time.advance(SHINY_CONFIRM_WINDOW_MS);
    const fresh = await act(port, token, 'shinyFound');
    expect(fresh.state.shinyFoundArmed).toBe(true);
    expect(store.getHunt(huntId)?.status).toBe('active');
  });

  it('reports a missing hunt and store refusals as ok: false, never as a 500', async () => {
    const { dir, store } = await setup();
    const { port, token } = readPairing(dir);
    store.setActiveHunt(null);
    for (const action of ['increment', 'decrement', 'undo', 'logPhase', 'shinyFound']) {
      const reply = await act(port, token, action);
      expect(reply).toEqual({
        ok: false,
        message: 'No active hunt — pick one in Biolume',
        state: { protocol: 1, hunt: null, shinyFoundArmed: false, shinyFoundArmedUntil: null },
      });
    }
  });

  it('turns an exception from the store into a readable refusal', async () => {
    const failing = await setup({}, { start: false });
    const real = failing.store;
    const bridge = createStreamDeckBridge({
      store: {
        getActiveHunt: () => real.getActiveHunt(),
        adjustCount: () => {
          throw new Error('Hunt "Gastly" already has the maximum of 5000 phases');
        },
        undo: (id, source) => real.undo(id, source),
        logPhase: (id, input) => real.logPhase(id, input),
        subscribe: (listener) => real.subscribe(listener),
      },
      shiny: createShinyConfirm({ store: real }),
      toggleOverlay: () => undefined,
      pairingDir: failing.dir,
      appVersion: '1.0.0',
      port: 0,
    });
    harnesses.push({ ...failing, bridge });
    await bridge.setEnabled(true);
    const { port, token } = readPairing(failing.dir);
    const reply = await act(port, token, 'increment');
    expect(reply.ok).toBe(false);
    expect(reply.message).toBe('Hunt "Gastly" already has the maximum of 5000 phases');
  });

  it('toggles the overlay without needing a hunt', async () => {
    const { dir, store, toggles } = await setup();
    const { port, token } = readPairing(dir);
    store.setActiveHunt(null);
    const reply = await act(port, token, 'toggleOverlay');
    expect(reply.ok).toBe(true);
    expect(toggles.overlay).toBe(1);
  });

  it('streams the state first, then a state event per change and an action event per action', async () => {
    const { bridge, dir, store, huntId, time } = await setup({ pingIntervalMs: 30 });
    const { port, token } = readPairing(dir);
    const stream = await openEvents(port, token);
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream');
    expect(stream.headers['access-control-allow-origin']).toBeUndefined();

    const first = await stream.next(() => true);
    expect(first).toEqual({ type: 'state', state: bridge.getState() });
    await until(() => bridge.getStatus().clients === 1, 'the stream to count as a client');

    // A change made elsewhere (the Hunt view) reaches the Stream Deck too.
    store.adjustCount(huntId, 5, 'ui');
    const changed = await stream.next(
      (event) => event.type === 'state' && event.state.hunt?.count === 5,
    );
    expect(changed.type).toBe('state');

    const before = stream.events.length;
    await act(port, token, 'increment');
    const action = await stream.next((event) => event.type === 'action', before);
    expect(action).toEqual({ type: 'action', action: 'increment', ok: true });
    await stream.next((event) => event.type === 'state' && event.state.hunt?.count === 8, before);

    // Session bookkeeping changes nothing the plugin shows, so it sends nothing.
    const quiet = stream.events.length;
    store.updateSettings({ audio: { volume: 0.1 } });
    expect(stream.events.length).toBe(quiet);

    // Arming, and the expiry, are pushed as state events.
    const armedAt = stream.events.length;
    await act(port, token, 'shinyFound');
    await stream.next((event) => event.type === 'state' && event.state.shinyFoundArmed, armedAt);
    const actionEvent = await stream.next((event) => event.type === 'action', armedAt);
    expect(actionEvent).toEqual({
      type: 'action',
      action: 'shinyFound',
      ok: true,
      message: 'Press again to confirm Shiny Found',
    });
    const expiredAt = stream.events.length;
    time.advance(SHINY_CONFIRM_WINDOW_MS);
    await stream.next((event) => event.type === 'state' && !event.state.shinyFoundArmed, expiredAt);

    // A refused action is announced as well.
    store.setActiveHunt(null);
    const refusedAt = stream.events.length;
    await act(port, token, 'increment');
    expect(await stream.next((event) => event.type === 'action', refusedAt)).toEqual({
      type: 'action',
      action: 'increment',
      ok: false,
      message: 'No active hunt — pick one in Biolume',
    });

    await stream.waitForPing();
    stream.close();
    await until(() => bridge.getStatus().clients === 0, 'the stream to be cleaned up');
  });

  it('caps the number of open event streams', async () => {
    const { bridge, dir } = await setup({ maxStreams: 2 });
    const { port, token } = readPairing(dir);
    const one = await openEvents(port, token);
    const two = await openEvents(port, token);
    await until(() => bridge.getStatus().clients === 2, 'two clients');
    const refused = await call(port, { path: '/v1/events', headers: auth(token) });
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('5');
    one.close();
    await until(() => bridge.getStatus().clients === 1, 'one client');
    const three = await openEvents(port, token);
    expect(three.status).toBe(200);
    two.close();
    three.close();
    await until(() => bridge.getStatus().clients === 0, 'no clients');
  });

  it('stops and restarts live with a new token, dropping open streams', async () => {
    const { bridge, dir, statuses } = await setup();
    const first = readPairing(dir);
    const stream = await openEvents(first.port, first.token);
    await stream.next(() => true);

    const stopped = await bridge.setEnabled(false);
    expect(stopped).toMatchObject({ enabled: false, listening: false, port: null, clients: 0 });
    expect(existsSync(join(dir, STREAM_DECK_PAIRING_FILE))).toBe(false);
    await stream.closed;
    await expect(call(first.port, { headers: auth(first.token) })).rejects.toThrow();
    expect(statuses.at(-1)).toEqual(stopped);

    const restarted = await bridge.setEnabled(true);
    expect(restarted.listening).toBe(true);
    const second = readPairing(dir);
    expect(second.token).not.toBe(first.token);
    expect((await call(second.port, { headers: auth(second.token) })).status).toBe(200);
  });

  // Regression: the token used to live for the whole app run. Whatever grabbed the freed
  // port while the bridge was off (another user's process: loopback is shared) collected
  // it from the plugin — e.g. from a pairing file Windows would not let us delete — and
  // could then drive Biolume on whatever port the bridge came back on.
  it('never honours a token from an earlier listening period', async () => {
    const { bridge, dir, store, huntId } = await setup();
    const leaked = readPairing(dir).token;

    await bridge.setEnabled(false);
    await bridge.setEnabled(true);
    const { port, token } = readPairing(dir);
    expect(token).not.toBe(leaked);

    const replay = await call(port, {
      method: 'POST',
      path: '/v1/action',
      headers: auth(leaked, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'increment' }),
    });
    expect(replay.status).toBe(401);
    expect((await call(port, { headers: auth(leaked) })).status).toBe(401);
    expect(store.getHunt(huntId)?.count).toBe(0);
    expect((await call(port, { headers: auth(token) })).status).toBe(200);
  });

  // Regression: Node checked `headersTimeout` only every 30 s and the bridge refused new
  // sockets past 64, so any local process (another user's included) could hold 64 silent
  // connections and keep the plugin out indefinitely.
  it('cannot be locked out by idle connections that never authenticate', async () => {
    const { bridge, dir, store, huntId } = await setup();
    const { port, token } = readPairing(dir);
    const stream = await openEvents(port, token);
    await stream.next(() => true);

    const idle = await openIdleSockets(port, 80);
    const closed = (): number => idle.filter((socket) => socket.destroyed).length;
    // Everything beyond the cap is dropped, oldest first; the stream is never touched.
    await until(
      () => closed() >= idle.length - MAX_UNAUTHENTICATED_SOCKETS,
      'idle sockets to be dropped',
    );
    expect(idle.slice(-MAX_UNAUTHENTICATED_SOCKETS).every((socket) => !socket.destroyed)).toBe(
      true,
    );

    // The plugin still gets through, on new connections and on its open stream.
    expect((await call(port, { headers: auth(token) })).status).toBe(200);
    expect((await act(port, token, 'increment')).ok).toBe(true);
    await stream.next((event) => event.type === 'state' && event.state.hunt?.count === 3);
    expect(store.getHunt(huntId)?.count).toBe(3);
    expect(bridge.getStatus().clients).toBe(1);
    for (const socket of idle) socket.destroy();
    stream.close();
  });

  it('closes connections that do not finish their headers in time, but not event streams', async () => {
    const { dir } = await setup({
      headersTimeoutMs: 150,
      requestTimeoutMs: 300,
      pingIntervalMs: 50,
    });
    const { port, token } = readPairing(dir);
    const stream = await openEvents(port, token);
    await stream.next(() => true);

    const [silent, partial] = await openIdleSockets(port, 2);
    partial?.write(`GET /v1/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    const started = Date.now();
    await until(() => silent?.destroyed === true && partial?.destroyed === true, 'the timeouts');
    expect(Date.now() - started).toBeLessThan(1_500);

    // The event stream outlives every request timeout and keeps receiving pings.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await stream.waitForPing();
    stream.close();
  });

  it('settles rapid toggles in order', async () => {
    const { bridge, dir } = await setup({}, { start: false });
    const results = await Promise.all([
      bridge.setEnabled(true),
      bridge.setEnabled(false),
      bridge.setEnabled(true),
    ]);
    expect(results.map((status) => status.listening)).toEqual([true, false, true]);
    expect(bridge.getStatus().listening).toBe(true);
    expect(existsSync(join(dir, STREAM_DECK_PAIRING_FILE))).toBe(true);
  });

  it('falls back to a free port when the preferred one is taken', async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    const { bridge, dir } = await setup({ port: taken });
    const status = bridge.getStatus();
    expect(status.listening).toBe(true);
    expect(status.port).not.toBe(taken);
    expect(readPairing(dir).port).toBe(status.port);
  });

  it('reports an error instead of listening when the pairing file cannot be written', async () => {
    const missing = join(tmpdir(), `biolume-bridge-missing-${process.pid}-${Date.now()}`, 'x');
    const { bridge } = await setup({ pairingDir: missing }, { start: false });
    const status = await bridge.setEnabled(true);
    expect(status).toMatchObject({ enabled: true, listening: false, port: null, clients: 0 });
    expect(status.error).toMatch(/^Could not write the pairing file/);
    // Switching it off clears the error.
    expect((await bridge.setEnabled(false)).error).toBeNull();
  });

  it('removes only its own pairing file', async () => {
    const { bridge, dir } = await setup();
    const path = join(dir, STREAM_DECK_PAIRING_FILE);
    const foreign = { ...readPairing(dir), token: 'someone-else', pid: 1 };
    writeFileSync(path, JSON.stringify(foreign));
    await bridge.setEnabled(false);
    expect(readPairing(dir).token).toBe('someone-else');
  });

  it('cleans up a pairing file of its own that an earlier stop could not remove', async () => {
    const { bridge, dir } = await setup();
    const path = join(dir, STREAM_DECK_PAIRING_FILE);
    const earlier = readPairing(dir);
    await bridge.setEnabled(false);
    // As if Windows had kept the file locked during that stop: same process, older token.
    writeFileSync(path, JSON.stringify(earlier));
    bridge.shutdown();
    expect(existsSync(path)).toBe(false);
  });

  it('removes the pairing file and closes everything on shutdown', async () => {
    const { bridge, dir } = await setup();
    const { port, token } = readPairing(dir);
    const stream = await openEvents(port, token);
    bridge.shutdown();
    expect(existsSync(join(dir, STREAM_DECK_PAIRING_FILE))).toBe(false);
    await stream.closed;
    expect(bridge.getStatus().listening).toBe(false);
    // Inert afterwards.
    expect((await bridge.setEnabled(true)).listening).toBe(false);
  });
});
