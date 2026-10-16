/**
 * Live end-to-end check of the *bundled* plugin against a *running* Biolume:
 *
 *   fake Stream Deck app (WebSocket)  <->  node bin/plugin.js  <->  real Biolume bridge
 *
 * Unlike scripts/smoke.mjs (which fakes Biolume too), this talks to a real app,
 * so start one first with its own data folder — never your real hunts:
 *
 *   set BIOLUME_USER_DATA=C:\some\temp\dir  (seed it with an active hunt)
 *   npx electron .
 *   node streamdeck/scripts/e2e-live.mjs C:\some\temp\dir [--wait-offline 60 [--wait-restart 60]]
 *
 * The plugin finds the bridge through the pairing file in that folder, exactly
 * as it does under Stream Deck. Every key press is cross-checked against the
 * app with an independent `GET /v1/state`, and the hunt is put back the way it
 * was (Undo for the Shiny Found and each count). With `--wait-offline N` it then
 * waits up to N seconds for Biolume to be closed and for the keys to show
 * "Offline"; with `--wait-restart N` also for Biolume to be started again (new
 * token) and the keys to come back on their own. The token is read for those
 * checks but never printed.
 */
import { spawn } from 'node:child_process';
import console from 'node:console';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SD_PLUGIN = join(PLUGIN_ROOT, 'app.biolume.streamdeck.sdPlugin');
const UUID = 'app.biolume.streamdeck';
const DEVICE = 'E2E-DECK';
const STEP_TIMEOUT_MS = 8_000;
const PAIRING_FILE = 'streamdeck-bridge.json';

const args = process.argv.slice(2);
const userDataArg = args.find((arg) => !arg.startsWith('--'));
if (!userDataArg) {
  console.error(
    'Usage: node streamdeck/scripts/e2e-live.mjs <BIOLUME_USER_DATA dir> [--wait-offline <s> [--wait-restart <s>]]',
  );
  process.exit(2);
}
const userData = resolve(userDataArg);
const waitIndex = args.indexOf('--wait-offline');
const waitOfflineS = waitIndex >= 0 ? Number(args[waitIndex + 1] ?? 60) : 0;
const restartIndex = args.indexOf('--wait-restart');
const waitRestartS = restartIndex >= 0 ? Number(args[restartIndex + 1] ?? 60) : 0;

// ───────────────────────────── Independent view of the app ─────────────────────────────

function pairing() {
  return JSON.parse(readFileSync(join(userData, PAIRING_FILE), 'utf8'));
}

/** GET /v1/state straight from the bridge (not through the plugin). */
function appState() {
  const { port, token } = pairing();
  return new Promise((resolveState, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/state',
        headers: { Authorization: `Bearer ${token}` },
        agent: false,
        timeout: 5_000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`GET /v1/state answered ${res.statusCode}`));
          else resolveState(JSON.parse(body));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('GET /v1/state timed out')));
    req.on('error', reject);
    req.end();
  });
}

// ───────────────────────────── Fake Stream Deck app ─────────────────────────────

const received = [];
const waiters = [];
let socket = null;

const host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((ready) => host.once('listening', ready));
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
/** The newest face the plugin drew on a key. */
const lastFace = (kind) => {
  for (let i = received.length - 1; i >= 0; i--) {
    const message = received[i];
    if (message.context === `${kind}-ctx` && message.event === 'setImage') return face(message);
  }
  return '';
};

function expectMessage(description, predicate, since = 0) {
  const earlier = received.slice(since).find(predicate);
  if (earlier) return Promise.resolve(earlier);
  return new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for: ${description}`)),
      STEP_TIMEOUT_MS,
    );
    const check = (message) => {
      if (predicate(message)) {
        clearTimeout(timer);
        done(message);
      } else {
        waiters.push(check);
      }
    };
    waiters.push(check);
  });
}

const KINDS = ['counter', 'increment', 'decrement', 'logphase', 'shinyfound', 'undo', 'overlay'];
const key = (kind) => ({
  action: `${UUID}.${kind}`,
  context: `${kind}-ctx`,
  device: DEVICE,
  payload: {
    controller: 'Keypad',
    coordinates: { column: KINDS.indexOf(kind) % 5, row: Math.floor(KINDS.indexOf(kind) / 5) },
    isInMultiAction: false,
    settings: {},
    state: 0,
  },
});
const press = (kind) => send({ event: 'keyDown', ...key(kind) });
const faceOf = (kind, needle) => (m) => m.context === `${kind}-ctx` && face(m).includes(needle);

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
  devices: [{ id: DEVICE, name: 'E2E Deck', size: { columns: 5, rows: 3 }, type: 0 }],
  plugin: { uuid: UUID, version: '0.1.0.0' },
};

const work = mkdtempSync(join(tmpdir(), 'biolume-sd-e2e-'));
const pluginDir = join(work, 'plugin.sdPlugin');
cpSync(SD_PLUGIN, pluginDir, { recursive: true, filter: (src) => basename(src) !== 'logs' });

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

let checks = 0;
const ok = (message) => {
  checks++;
  console.log(`  ok  ${message}`);
};
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let failed = false;
try {
  await expectMessage('registration', (m) => m.event === 'registerPlugin' && m.uuid === UUID);
  ok('plugin registered with the fake Stream Deck app');

  const start = await appState();
  assert(start.hunt !== null, 'Biolume has no active hunt — seed one first');
  assert(start.hunt.status === 'active', `the active hunt is ${start.hunt.status}`);
  const { step } = start.hunt;
  console.log(
    `      app: "${start.hunt.name}" (${start.hunt.targetName ?? 'no target'}), count ${start.hunt.count}, ` +
      `step ${step}, phase ${start.hunt.phaseNumber}`,
  );

  for (const kind of KINDS) send({ event: 'willAppear', ...key(kind) });
  await expectMessage(
    `counter showing ${start.hunt.count}`,
    faceOf('counter', `>${start.hunt.count}</text>`),
  );
  await expectMessage('increment label', faceOf('increment', `>+${step}</text>`));
  await expectMessage(
    'log phase label',
    faceOf('logphase', `>Phase ${start.hunt.phaseNumber}</text>`),
  );
  ok(
    `connected through the pairing file: counter key shows ${start.hunt.count}, +${step}, Phase ${start.hunt.phaseNumber}`,
  );

  let mark = received.length;
  press('counter');
  await expectMessage(
    'counter +1 step',
    faceOf('counter', `>${start.hunt.count + step}</text>`),
    mark,
  );
  let now = await appState();
  assert(now.hunt.count === start.hunt.count + step, `app count is ${now.hunt.count}`);
  ok(`counter key press: app count ${start.hunt.count} -> ${now.hunt.count}, key face followed`);

  mark = received.length;
  press('increment');
  await expectMessage(
    'showOk on increment',
    (m) => m.event === 'showOk' && m.context === 'increment-ctx',
    mark,
  );
  await expectMessage(
    'counter +2 steps',
    faceOf('counter', `>${start.hunt.count + 2 * step}</text>`),
    mark,
  );
  now = await appState();
  assert(now.hunt.count === start.hunt.count + 2 * step, `app count is ${now.hunt.count}`);
  ok(`increment key: showOk, app count ${now.hunt.count}`);

  mark = received.length;
  press('shinyfound');
  await expectMessage('Confirm? on Shiny Found', faceOf('shinyfound', 'Confirm?'), mark);
  now = await appState();
  assert(
    now.shinyFoundArmed && now.hunt.status === 'active',
    'first Shiny Found press did not just arm',
  );
  const left = now.shinyFoundArmedUntil - Date.now();
  ok(
    `Shiny Found press 1: key shows "Confirm?", app armed (${Math.round(left)} ms left), hunt still active`,
  );

  mark = received.length;
  press('shinyfound');
  await expectMessage('Found! on Shiny Found', faceOf('shinyfound', '>Found!</text>'), mark);
  now = await appState();
  assert(now.hunt.status === 'completed' && !now.shinyFoundArmed, `hunt is ${now.hunt.status}`);
  ok('Shiny Found press 2: app hunt completed, key shows "Found!"');

  mark = received.length;
  press('increment');
  await expectMessage(
    'showAlert on a completed hunt',
    (m) => m.event === 'showAlert' && m.context === 'increment-ctx',
    mark,
  );
  now = await appState();
  assert(now.hunt.count === start.hunt.count + 2 * step, 'a completed hunt was counted');
  ok('increment on the completed hunt is refused (showAlert), count unchanged');

  mark = received.length;
  press('undo');
  await expectMessage(
    'Shiny Found key back to normal',
    (m) =>
      m.context === 'shinyfound-ctx' &&
      m.event === 'setImage' &&
      !face(m).includes('Found!') &&
      !face(m).includes('Confirm?'),
    mark,
  );
  now = await appState();
  assert(now.hunt.status === 'active', `undo left the hunt ${now.hunt.status}`);
  mark = received.length;
  press('undo');
  await expectMessage(
    'counter -1 step',
    faceOf('counter', `>${start.hunt.count + step}</text>`),
    mark,
  );
  mark = received.length;
  press('undo');
  await expectMessage('counter back', faceOf('counter', `>${start.hunt.count}</text>`), mark);
  now = await appState();
  assert(
    now.hunt.status === 'active' && now.hunt.count === start.hunt.count,
    `after undo: ${JSON.stringify(now.hunt)}`,
  );
  ok(`undo x3: hunt active again at ${now.hunt.count}`);

  if (waitOfflineS > 0) {
    console.log(`      close Biolume now (waiting up to ${waitOfflineS} s for "Offline")`);
    mark = received.length;
    const deadline = Date.now() + waitOfflineS * 1000;
    while (!KINDS.every((kind) => lastFace(kind).includes('>Offline</text>'))) {
      if (Date.now() > deadline) throw new Error('the keys never all showed "Offline"');
      await new Promise((done) => setTimeout(done, 200));
    }
    ok(`Biolume closed: all ${KINDS.length} keys show "Offline"`);
    mark = received.length;
    press('increment');
    await expectMessage(
      'showAlert while offline',
      (m) => m.event === 'showAlert' && m.context === 'increment-ctx',
      mark,
    );
    ok('pressing a key while Biolume is closed shows an alert');

    if (waitRestartS > 0) {
      console.log(`      start Biolume again (waiting up to ${waitRestartS} s for the keys)`);
      const until = Date.now() + waitRestartS * 1000;
      while (!lastFace('counter').includes(`>${start.hunt.count}</text>`)) {
        if (Date.now() > until) throw new Error('the keys never came back online');
        await new Promise((done) => setTimeout(done, 200));
      }
      const again = await appState();
      mark = received.length;
      press('increment');
      await expectMessage(
        'count after the restart',
        faceOf('counter', `>${again.hunt.count + step}</text>`),
        mark,
      );
      mark = received.length;
      press('undo');
      await expectMessage(
        'undo after the restart',
        faceOf('counter', `>${again.hunt.count}</text>`),
        mark,
      );
      ok(
        `Biolume restarted (new token, port ${pairing().port}): keys online again, +1 and undo work`,
      );
    }
  }
} catch (error) {
  failed = true;
  console.error(`\nE2E failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Plugin output:\n${pluginOutput || '(none)'}`);
} finally {
  plugin.kill();
  await new Promise((done) => (plugin.exitCode !== null ? done() : plugin.once('exit', done)));
  host.close();
  rmSync(work, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log(`Live E2E passed (${checks} checks).`);
