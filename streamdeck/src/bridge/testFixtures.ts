/** Shared test data for the plugin's unit tests. */
import type { BridgeHunt, BridgeState } from '../../../src/shared/streamDeck';

export const HUNT: BridgeHunt = {
  id: 'h1',
  name: 'Ralts hunt',
  status: 'active',
  count: 1234,
  total: 1500,
  step: 1,
  phaseNumber: 2,
  targetName: 'Ralts',
  shinySpriteUrl:
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/280.png',
};

export const STATE: BridgeState = {
  protocol: 1,
  hunt: HUNT,
  shinyFoundArmed: false,
  shinyFoundArmedUntil: null,
};

/** A syntactically valid pairing token (printable ASCII, 16+ characters). */
export const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
