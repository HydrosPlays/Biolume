import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, BridgeState } from '../../../src/shared/streamDeck';
import { Backoff } from './backoff';
import { BridgeClient, type BridgeClientOptions, type BridgeSnapshot } from './client';
import { HUNT, STATE, TOKEN } from './testFixtures';

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

type ActionReply = { status: number; body: string; contentType?: string };

/** A stand-in for Biolume's bridge (src/main/streamDeckBridge.ts), following src/shared/streamDeck.ts. */
class FakeBridge {
  readonly requests: RecordedRequest[] = [];
  readonly streams = new Set<ServerResponse>();
  state: BridgeState = STATE;
  /** How /v1/events answers: a real stream, or something else entirely. */
  eventsMode: 'sse' | 'json' = 'sse';
  /** Send the initial state when a stream opens. */
  greet = true;
  actionReply: (action: unknown) => ActionReply = () => ({
    status: 200,
    body: JSON.stringify({ ok: true, state: this.state }),
  });
  #server: Server | null = null;

  constructor(public token: string = TOKEN) {}

  get port(): number {
    return (this.#server?.address() as AddressInfo).port;
  }

  get eventConnections(): number {
    return this.requests.filter((r) => r.url === '/v1/events').length;
  }

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
    const server = this.#server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#server = null;
  }

  /** Sends one event to every open stream. */
  emit(event: BridgeEvent): void {
    this.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  write(raw: string): void {
    for (const stream of this.streams) stream.write(raw);
  }

  dropStreams(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  pairing(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      protocol: 1,
      port: this.port,
      token: this.token,
      pid: process.pid,
      app: '0.1.0-test',
      ...overrides,
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const record: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    this.requests.push(record);

    if (req.headers.origin !== undefined) {
      res.writeHead(403).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/events') {
      if (this.eventsMode === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(this.state));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.flushHeaders();
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      if (this.greet)
        res.write(`data: ${JSON.stringify({ type: 'state', state: this.state })}\n\n`);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/action') {
      let action: unknown;
      try {
        action = (JSON.parse(record.body) as { action?: unknown }).action;
      } catch {
        action = null;
      }
      const reply = this.actionReply(action);
      res
        .writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'application/json' })
        .end(reply.body);
      return;
    }
    res.writeHead(404).end();
  }
}

let dir: string;
let pairingFile: string;
const bridges: FakeBridge[] = [];
const clients: BridgeClient[] = [];

async function startBridge(token?: string): Promise<FakeBridge> {
  const bridge = new FakeBridge(token);
  await bridge.listen();
  bridges.push(bridge);
  return bridge;
}

function startClient(options: Partial<BridgeClientOptions> = {}): BridgeClient {
  const client = new BridgeClient({
    pairingFile,
    backoff: new Backoff({ initialMs: 20, maxMs: 120, jitter: 0 }),
    offlineGraceMs: 0,
    watchDebounceMs: 10,
    ...options,
  });
  clients.push(client);
  client.start();
  return client;
}

function online(client: BridgeClient): Extract<BridgeSnapshot, { status: 'online' }> {
  const snapshot = client.snapshot;
  if (snapshot.status !== 'online') throw new Error(`not online: ${JSON.stringify(snapshot)}`);
  return snapshot;
}

const WAIT = { timeout: 4_000, interval: 10 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'biolume-sd-client-'));
  pairingFile = join(dir, 'streamdeck-bridge.json');
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await rm(dir, { recursive: true, force: true });
});

describe('BridgeClient — event stream', () => {
  it('connects with the bearer token and no Origin header, and goes online with the first state', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient();

    await vi.waitFor(() => expect(online(client).state).toEqual(STATE), WAIT);
    expect(online(client).app).toBe('0.1.0-test');
    const request = bridge.requests[0];
    expect(request?.url).toBe('/v1/events');
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.origin).toBeUndefined();
    expect(request?.headers.accept).toBe('text/event-stream');
  });

  it('follows state events, ignoring pings and malformed or unknown events', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient();
    const events: BridgeEvent[] = [];
    client.onEvent((event) => events.push(event));
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), WAIT);

    bridge.write(': ping\n\n');
    bridge.write('data: {not json\n\n');
    bridge.write(`data: ${JSON.stringify({ type: 'state', state: { protocol: 1 } })}\n\n`);
    bridge.write(`data: ${JSON.stringify({ type: 'future-thing', x: 1 })}\n\n`);
    bridge.emit({ type: 'action', action: 'increment', ok: true });
    // One event split across writes, mid-JSON and mid-line ending.
    const next = `data: ${JSON.stringify({ type: 'state', state: { ...STATE, hunt: { ...HUNT, count: 1235 } } })}\r\n\r\n`;
    bridge.write(next.slice(0, 25));
    await new Promise((resolve) => setTimeout(resolve, 30));
    bridge.write(next.slice(25, next.length - 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    bridge.write(next.slice(next.length - 1));

    await vi.waitFor(() => expect(online(client).state.hunt?.count).toBe(1235), WAIT);
    expect(events.map((event) => event.type)).toEqual(['state', 'action', 'state']);
    expect(bridge.eventConnections).toBe(1);
  });

  it('stays offline with "no-pairing" until Biolume writes its pairing file, then connects', async () => {
    const client = startClient({
      backoff: new Backoff({ initialMs: 5_000, maxMs: 5_000, jitter: 0 }),
    });
    await vi.waitFor(
      () => expect(client.snapshot).toEqual({ status: 'offline', reason: 'no-pairing' }),
      WAIT,
    );

    // The backoff is long here, so only the file watcher can make this quick.
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), {
      ...WAIT,
      timeout: 3_000,
    });
  });

  it('treats a pairing file of a dead process as stale and never contacts its port', async () => {
    const bridge = await startBridge();
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    await writeFile(pairingFile, bridge.pairing({ pid: child.pid }));
    const client = startClient();

    await vi.waitFor(
      () => expect(client.snapshot).toEqual({ status: 'offline', reason: 'stale' }),
      WAIT,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bridge.requests).toHaveLength(0);
  });

  it('reports "unreachable" when nothing listens on the paired port', async () => {
    const bridge = await startBridge();
    const pairing = bridge.pairing();
    await bridge.close();
    await writeFile(pairingFile, pairing);
    const client = startClient();
    await vi.waitFor(
      () => expect(client.snapshot).toEqual({ status: 'offline', reason: 'unreachable' }),
      WAIT,
    );
  });

  it('reports a refused token, and recovers when the pairing file is rewritten', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing({ token: 'x'.repeat(32) }));
    const client = startClient();
    await vi.waitFor(
      () => expect(client.snapshot).toEqual({ status: 'offline', reason: 'unauthorized' }),
      WAIT,
    );

    await writeFile(pairingFile, bridge.pairing());
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), WAIT);
  });

  it('flags another protocol version as incompatible', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing({ protocol: 2 }));
    const client = startClient();
    await vi.waitFor(() => expect(client.snapshot).toEqual({ status: 'incompatible' }), WAIT);
    expect(bridge.requests).toHaveLength(0);
  });

  it('refuses an answer that is not an event stream', async () => {
    const bridge = await startBridge();
    bridge.eventsMode = 'json';
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient();
    await vi.waitFor(
      () => expect(client.snapshot).toEqual({ status: 'offline', reason: 'protocol' }),
      WAIT,
    );
  });

  it('reconnects with backoff after the stream drops', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient();
    const statuses: string[] = [];
    client.onChange((snapshot) => statuses.push(snapshot.status));
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), WAIT);

    bridge.state = { ...STATE, hunt: { ...HUNT, count: 9 } };
    bridge.dropStreams();
    await vi.waitFor(() => expect(online(client).state.hunt?.count).toBe(9), WAIT);
    expect(bridge.eventConnections).toBe(2);
    expect(statuses).toContain('offline');
  });

  it('keeps the last state through a quick reconnect when a grace period is set', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient({ offlineGraceMs: 1_000 });
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), WAIT);
    const statuses: string[] = [];
    client.onChange((snapshot) => statuses.push(snapshot.status));

    bridge.dropStreams();
    await vi.waitFor(() => expect(bridge.eventConnections).toBe(2), WAIT);
    await vi.waitFor(() => expect(statuses).toContain('online'), WAIT);
    expect(statuses).not.toContain('offline');
  });

  it('moves to the new port and token when Biolume restarts', async () => {
    const first = await startBridge();
    await writeFile(pairingFile, first.pairing());
    const client = startClient();
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), WAIT);

    const second = await startBridge('second-token-0123456789abcdef');
    second.state = { ...STATE, hunt: { ...HUNT, count: 77 } };
    await writeFile(pairingFile, second.pairing());

    await vi.waitFor(() => expect(online(client).state.hunt?.count).toBe(77), WAIT);
    await vi.waitFor(() => expect(first.streams.size).toBe(0), WAIT);
    expect(second.requests[0]?.headers.authorization).toBe('Bearer second-token-0123456789abcdef');
  });

  it('drops a stream that goes silent (no pings) and opens a new one', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient({ idleTimeoutMs: 150 });
    await vi.waitFor(() => expect(bridge.eventConnections).toBeGreaterThanOrEqual(2), WAIT);
    expect(client.snapshot.status).not.toBe('incompatible');
  });

  it('pings keep an idle stream open', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    startClient({ idleTimeoutMs: 200 });
    await vi.waitFor(() => expect(bridge.streams.size).toBe(1), WAIT);
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      bridge.write(': ping\n\n');
    }
    expect(bridge.eventConnections).toBe(1);
  });

  it('drops a stream that floods an endless line instead of buffering it', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient();
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), WAIT);

    bridge.write(`data: ${'x'.repeat(200 * 1024)}`);
    await vi.waitFor(() => expect(bridge.eventConnections).toBeGreaterThanOrEqual(2), WAIT);
  });

  it('closes the stream on stop()', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient();
    await vi.waitFor(() => expect(bridge.streams.size).toBe(1), WAIT);
    await client.stop();
    await vi.waitFor(() => expect(bridge.streams.size).toBe(0), WAIT);
  });
});

describe('BridgeClient — actions', () => {
  it('POSTs the action as JSON with the token and no Origin, and returns the answer', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient();
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), WAIT);

    const armed: BridgeState = {
      ...STATE,
      shinyFoundArmed: true,
      shinyFoundArmedUntil: Date.now() + 3_000,
    };
    bridge.actionReply = () => ({
      status: 200,
      body: JSON.stringify({
        ok: true,
        message: 'Press again to confirm Shiny Found',
        state: armed,
      }),
    });
    const outcome = await client.sendAction('shinyFound');

    expect(outcome).toEqual({
      ok: true,
      offline: false,
      message: 'Press again to confirm Shiny Found',
      state: armed,
    });
    const post = bridge.requests.find((request) => request.method === 'POST');
    expect(post?.url).toBe('/v1/action');
    expect(JSON.parse(post?.body ?? '')).toEqual({ action: 'shinyFound' });
    expect(post?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post?.headers['content-type']).toBe('application/json');
    expect(post?.headers.origin).toBeUndefined();
  });

  it('works before the stream is up, reading the pairing file itself', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = new BridgeClient({ pairingFile });
    expect((await client.sendAction('increment')).ok).toBe(true);
  });

  it('passes on refusals, and treats junk answers as failures', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = startClient();
    await vi.waitFor(() => expect(client.snapshot.status).toBe('online'), WAIT);

    bridge.actionReply = () => ({
      status: 409,
      body: JSON.stringify({
        ok: false,
        message: 'No active hunt',
        state: { ...STATE, hunt: null },
      }),
    });
    expect(await client.sendAction('increment')).toMatchObject({
      ok: false,
      offline: false,
      message: 'No active hunt',
    });

    bridge.actionReply = () => ({
      status: 200,
      body: '<html>hello</html>',
      contentType: 'text/html',
    });
    expect(await client.sendAction('increment')).toEqual({
      ok: false,
      offline: false,
      message: 'Unexpected answer',
      state: null,
    });

    // A 2xx body claiming success with a broken state is not trusted either.
    bridge.actionReply = () => ({
      status: 200,
      body: JSON.stringify({ ok: true, state: { protocol: 9 } }),
    });
    expect((await client.sendAction('undo')).ok).toBe(false);

    // An oversized answer is cut off, not buffered.
    bridge.actionReply = () => ({
      status: 200,
      body: `{"ok":true,"pad":"${'x'.repeat(100_000)}"}`,
    });
    expect((await client.sendAction('undo')).ok).toBe(false);
  });

  it('reports offline when the token is refused or nothing is running', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing({ token: 'y'.repeat(32) }));
    const client = new BridgeClient({ pairingFile });
    expect(await client.sendAction('increment')).toEqual({ ok: false, offline: true, state: null });

    await rm(pairingFile);
    expect(await client.sendAction('increment')).toEqual({ ok: false, offline: true, state: null });
  });

  it('refuses actions outside the protocol without sending anything', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    const client = new BridgeClient({ pairingFile });
    const outcome = await client.sendAction('format-disk' as never);
    expect(outcome.ok).toBe(false);
    expect(bridge.requests).toHaveLength(0);
  });

  it('times out a hanging bridge', async () => {
    const bridge = await startBridge();
    await writeFile(pairingFile, bridge.pairing());
    bridge.actionReply = () => {
      throw new Error('never answers');
    };
    const hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    try {
      await writeFile(
        pairingFile,
        bridge.pairing({ port: (hanging.address() as AddressInfo).port }),
      );
      const client = new BridgeClient({ pairingFile, actionTimeoutMs: 150 });
      const started = Date.now();
      expect(await client.sendAction('increment')).toEqual({
        ok: false,
        offline: true,
        state: null,
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
});
