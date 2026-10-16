/**
 * End-to-end smoke test of the *bundled* plugin (bin/plugin.js) with the real
 * Stream Deck SDK inside it, before it is packed:
 *
 *   fake Stream Deck app (WebSocket)  <->  node bin/plugin.js  <->  fake Biolume bridge (HTTP + SSE)
 *
 * It starts the plugin the way Stream Deck does (`-port -pluginUUID
 * -registerEvent -info`), with BIOLUME_USER_DATA pointing at a temp folder that
 * holds a pairing file, shows it a few keys and presses them, and checks the
 * key faces and feedback that come back. Run by scripts/pack.mjs; standalone:
 *
 *   node streamdeck/scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import console from 'node:console';
import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SD_PLUGIN = join(PLUGIN_ROOT, 'app.biolume.streamdeck.sdPlugin');
const UUID = 'app.biolume.streamdeck';
const TOKEN = 'smoke-test-token-0123456789abcdef';
const DEVICE = 'SMOKE-DECK';
const STEP_TIMEOUT_MS = 8_000;

const work = mkdtempSync(join(tmpdir(), 'biolume-sd-smoke-'));
const userData = join(work, 'userData');
const pluginDir = join(work, 'plugin.sdPlugin');
// A copy, so the SDK's logs/ folder lands in the temp dir rather than the source tree.
cpSync(SD_PLUGIN, pluginDir, { recursive: true, filter: (src) => basename(src) !== 'logs' });

// ───────────────────────────── Fake Biolume bridge ─────────────────────────────

let count = 1234;
let armedUntil = null;
const actions = [];
const streams = new Set();
const state = () => ({
  protocol: 1,
  hunt: {
    id: 'smoke',
    name: 'Smoke hunt',
    status: 'active',
    count,
    total: count,
    step: 1,
    phaseNumber: 1,
    targetName: 'Ralts',
    shinySpriteUrl: null,
  },
  shinyFoundArmed: armedUntil !== null,
  shinyFoundArmedUntil: armedUntil,
});
const broadcast = () => {
  for (const res of streams)
    res.write(`data: ${JSON.stringify({ type: 'state', state: state() })}\n\n`);
};

const bridge = createServer((req, res) => {
  if (req.headers.origin !== undefined || req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    streams.add(res);
    res.on('close', () => streams.delete(res));
    res.write(`data: ${JSON.stringify({ type: 'state', state: state() })}\n\n`);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/action') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { action } = JSON.parse(body);
      actions.push(action);
      if (action === 'increment') count++;
      if (action === 'shinyFound') armedUntil = Date.now() + 3_000;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: state() }));
      broadcast();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
const bridgePort = bridge.address().port;
const pairingFile = join(userData, 'streamdeck-bridge.json');
mkdirSync(userData, { recursive: true });
writeFileSync(
  pairingFile,
  JSON.stringify({ protocol: 1, port: bridgePort, token: TOKEN, pid: process.pid, app: 'smoke' }),
  // Owner-only, like Biolume's own file: the plugin refuses group/other-writable ones on POSIX.
  { mode: 0o600 },
);

// ───────────────────────────── Fake Stream Deck app ─────────────────────────────

/** Every message the plugin sent, in order. */
const received = [];
/** @type {((message: any) => void)[]} */
const waiters = [];
let socket = null;

const host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => host.once('listening', resolve));
host.on('connection', (ws) => {
  socket = ws;
  ws.on('message', (data) => {
    const message = JSON.parse(String(data));
    received.push(message);
    for (const waiter of waiters.splice(0)) waiter(message);
  });
});

const send = (message) => socket.send(JSON.stringify(message));
const face = (message) =>
  message.event === 'setImage' && typeof message.payload?.image === 'string'
    ? decodeURIComponent(message.payload.image.replace(/^data:image\/svg\+xml,/, ''))
    : '';

/** Resolves with the first message (already received or future) matching `predicate`. */
function expectMessage(description, predicate, since = 0) {
  const earlier = received.slice(since).find(predicate);
  if (earlier) return Promise.resolve(earlier);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for: ${description}`)),
      STEP_TIMEOUT_MS,
    );
    const check = (message) => {
      if (predicate(message)) {
        clearTimeout(timer);
        resolve(message);
      } else {
        waiters.push(check);
      }
    };
    waiters.push(check);
  });
}

const key = (kind, column) => ({
  action: `${UUID}.${kind}`,
  context: `${kind}-ctx`,
  device: DEVICE,
  payload: {
    controller: 'Keypad',
    coordinates: { column, row: 0 },
    isInMultiAction: false,
    settings: {},
    state: 0,
  },
});

const info = {
  application: {
    font: 'Segoe UI',
    language: 'en',
    platform: process.platform === 'darwin' ? 'mac' : 'windows',
    platformVersion: '10',
    version: '7.1.0.0',
  },
  colors: {
    buttonMouseOverBackgroundColor: '#464646FF',
    buttonPressedBackgroundColor: '#303030FF',
    buttonPressedBorderColor: '#646464FF',
    buttonPressedTextColor: '#969696FF',
    highlightColor: '#0078FFFF',
  },
  devicePixelRatio: 2,
  devices: [{ id: DEVICE, name: 'Smoke Deck', size: { columns: 5, rows: 3 }, type: 0 }],
  plugin: { uuid: UUID, version: '0.1.0.0' },
};

const plugin = spawn(
  process.execPath,
  [
    join(pluginDir, 'bin', 'plugin.js'),
    '-port',
    String(host.address().port),
    '-pluginUUID',
    UUID,
    '-registerEvent',
    'registerPlugin',
    '-info',
    JSON.stringify(info),
  ],
  { cwd: pluginDir, env: { ...process.env, BIOLUME_USER_DATA: userData }, stdio: 'pipe' },
);
let pluginOutput = '';
plugin.stdout.on('data', (chunk) => (pluginOutput += chunk));
plugin.stderr.on('data', (chunk) => (pluginOutput += chunk));

const steps = [];
const step = (name) => {
  steps.push(name);
  console.log(`  ok  ${name}`);
};

let failed = false;
try {
  await expectMessage('registration', (m) => m.event === 'registerPlugin' && m.uuid === UUID);
  step('plugin registered with Stream Deck');

  for (const [kind, column] of [
    ['counter', 0],
    ['increment', 1],
    ['shinyfound', 2],
  ]) {
    send({ event: 'willAppear', ...key(kind, column) });
  }
  await expectMessage(
    'counter key showing 1234',
    (m) => m.context === 'counter-ctx' && face(m).includes('>1234</text>'),
  );
  step('counter key shows the live count from the bridge');

  let mark = received.length;
  send({ event: 'keyDown', ...key('counter', 0) });
  await expectMessage(
    'counter key showing 1235',
    (m) => m.context === 'counter-ctx' && face(m).includes('>1235</text>'),
    mark,
  );
  if (actions.at(-1) !== 'increment') throw new Error(`bridge got ${actions.at(-1)}`);
  step('pressing the counter key counts (+1) and the face follows');

  mark = received.length;
  send({ event: 'keyDown', ...key('increment', 1) });
  await expectMessage(
    'showOk on the increment key',
    (m) => m.event === 'showOk' && m.context === 'increment-ctx',
    mark,
  );
  step('increment key confirms with showOk');

  mark = received.length;
  send({ event: 'keyDown', ...key('shinyfound', 2) });
  await expectMessage(
    'Confirm? on the shiny key',
    (m) => m.context === 'shinyfound-ctx' && face(m).includes('Confirm?'),
    mark,
  );
  step('first Shiny Found press arms it ("Confirm?")');
  if (received.slice(mark).some((m) => m.event === 'showOk' || m.event === 'showAlert')) {
    throw new Error('arming Shiny Found must not flash showOk / showAlert');
  }
  if (received.some((m) => m.context === 'counter-ctx' && m.event === 'showOk')) {
    throw new Error('the counter key must not flash showOk');
  }

  mark = received.length;
  for (const res of streams) res.destroy();
  bridge.closeAllConnections();
  await new Promise((resolve) => bridge.close(resolve));
  unlinkSync(pairingFile);
  await expectMessage(
    'Offline on the counter key',
    (m) => m.context === 'counter-ctx' && face(m).includes('>Offline</text>'),
    mark,
  );
  step('every key shows "Offline" once Biolume is gone');

  mark = received.length;
  send({ event: 'keyDown', ...key('increment', 1) });
  await expectMessage(
    'showAlert while offline',
    (m) => m.event === 'showAlert' && m.context === 'increment-ctx',
    mark,
  );
  step('pressing a key while offline shows an alert');
} catch (error) {
  failed = true;
  console.error(`\nSmoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Plugin output:\n${pluginOutput || '(none)'}`);
} finally {
  plugin.kill();
  await new Promise((resolve) =>
    plugin.exitCode !== null ? resolve() : plugin.once('exit', resolve),
  );
  host.close();
  bridge.closeAllConnections();
  bridge.close();
  rmSync(work, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log(`Smoke test passed (${steps.length} checks).`);
