/**
 * Biolume for Stream Deck — entry point (bundled to bin/plugin.js).
 *
 * Wires the SDK-free parts together: the bridge client (talks to the running
 * Biolume app over 127.0.0.1), the sprite cache and the key controller, then
 * registers one Stream Deck action per key type and connects to Stream Deck.
 */
import { homedir } from 'node:os';
import streamDeck from '@elgato/streamdeck';
import { BridgeClient } from './bridge/client';
import { pairingFilePath } from './bridge/pairing';
import { SpriteCache } from './faces/sprites';
import { createActions } from './keys/actions';
import { KeyController } from './keys/controller';

streamDeck.logger.setLevel('info');
const logger = streamDeck.logger.createScope('Biolume');

const pairingFile = pairingFilePath({
  platform: process.platform,
  env: process.env,
  homedir: homedir(),
});
logger.info(`Looking for Biolume's pairing file at ${pairingFile}`);

const bridge = new BridgeClient({ pairingFile, logger });
const sprites = new SpriteCache({ onLoad: () => controller.refresh() });
const controller = new KeyController({ bridge, sprites, logger });

for (const action of createActions(controller)) {
  streamDeck.actions.registerAction(action);
}

// After sleep the old stream is usually dead without anyone noticing: reconnect at once.
streamDeck.system.onSystemDidWakeUp(() => bridge.reconnectNow());

bridge.start();
await streamDeck.connect();
