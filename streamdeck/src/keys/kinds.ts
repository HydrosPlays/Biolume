import type { BridgeAction } from '../../../src/shared/streamDeck';

/** The plugin's UUID; every action UUID is `${PLUGIN_UUID}.<kind>`. */
export const PLUGIN_UUID = 'app.biolume.streamdeck';

export type KeyKind =
  'counter' | 'increment' | 'decrement' | 'logphase' | 'shinyfound' | 'undo' | 'overlay';

export const KEY_KINDS: readonly KeyKind[] = [
  'counter',
  'increment',
  'decrement',
  'logphase',
  'shinyfound',
  'undo',
  'overlay',
];

/** What a press of each key asks the bridge to do. The counter key counts, like `increment`. */
export const KEY_ACTION: Record<KeyKind, BridgeAction> = {
  counter: 'increment',
  increment: 'increment',
  decrement: 'decrement',
  logphase: 'logPhase',
  shinyfound: 'shinyFound',
  undo: 'undo',
  overlay: 'toggleOverlay',
};

export function actionUuid(kind: KeyKind): string {
  return `${PLUGIN_UUID}.${kind}`;
}
