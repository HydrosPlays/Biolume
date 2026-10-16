/**
 * Stream Deck bridge protocol — shared by the main process
 * (`src/main/streamDeckBridge.ts`) and the Elgato Stream Deck plugin
 * (`streamdeck/`). Keep it free of runtime imports so both can bundle it.
 *
 * Transport: plain HTTP on 127.0.0.1 only (never another interface).
 *   GET  /v1/state    -> {@link BridgeState}
 *   GET  /v1/events   -> Server-Sent Events: one {@link BridgeEvent} per `data:` line;
 *                        the first event is always a full `state`. A `: ping`
 *                        comment every 15 s keeps idle connections alive.
 *   POST /v1/action   body {@link BridgeActionRequest} -> {@link BridgeActionResponse}
 *
 * Security: every request must carry `Authorization: Bearer <token>`. Requests
 * that carry an `Origin` header are rejected, so web pages open in a browser
 * cannot drive the app even if they guess the port. Bodies are capped and
 * validated.
 *
 * Pairing: on start the main process writes {@link BridgePairing} to
 * {@link STREAM_DECK_PAIRING_FILE} inside Biolume's per-user data folder
 * (`%APPDATA%\Biolume` on Windows, `~/Library/Application Support/Biolume` on
 * macOS) and removes it on quit. The plugin runs as the same user and reads it
 * from there, so no setup is needed. A fresh token is issued every time the
 * bridge starts listening (app start, or the setting switched back on) and is
 * revoked when it stops, so the plugin re-reads the file after a 401 or a
 * refused connection.
 */

export const STREAM_DECK_PROTOCOL_VERSION = 1;

/** File name of the pairing document in Biolume's userData folder. */
export const STREAM_DECK_PAIRING_FILE = 'streamdeck-bridge.json';

/** Preferred port; the bridge falls back to a free port when it is taken. */
export const STREAM_DECK_DEFAULT_PORT = 47_637;

/** Shiny Found from a Stream Deck key or hotkey: the first press arms it, a second press within this window confirms. */
export const SHINY_CONFIRM_WINDOW_MS = 3_000;

export type BridgeAction =
  'increment' | 'decrement' | 'undo' | 'logPhase' | 'shinyFound' | 'toggleOverlay';

export const BRIDGE_ACTIONS: readonly BridgeAction[] = [
  'increment',
  'decrement',
  'undo',
  'logPhase',
  'shinyFound',
  'toggleOverlay',
];

export interface BridgePairing {
  protocol: typeof STREAM_DECK_PROTOCOL_VERSION;
  port: number;
  token: string;
  /** Process id of the Biolume instance that wrote the file (lets the plugin detect a stale file). */
  pid: number;
  /** Biolume's version. */
  app: string;
}

/** The active hunt, as the plugin shows it on keys. */
export interface BridgeHunt {
  id: string;
  name: string;
  status: 'active' | 'completed' | 'archived';
  /** Encounters in the current phase. */
  count: number;
  /** Encounters across all phases. */
  total: number;
  step: number;
  /** Number of the current phase (1 + phases logged). */
  phaseNumber: number;
  targetName: string | null;
  /** HTTPS URL of the target's shiny sprite (the plugin may fetch and draw it). */
  shinySpriteUrl: string | null;
}

export interface BridgeState {
  protocol: typeof STREAM_DECK_PROTOCOL_VERSION;
  hunt: BridgeHunt | null;
  /** Shiny Found waiting for its confirming second press. */
  shinyFoundArmed: boolean;
  /** Epoch ms when the pending confirmation expires; null when not armed. */
  shinyFoundArmedUntil: number | null;
}

export type BridgeEvent =
  | { type: 'state'; state: BridgeState }
  /** Fired after every action, whichever client sent it (so every key can flash feedback). */
  | { type: 'action'; action: BridgeAction; ok: boolean; message?: string };

export interface BridgeActionRequest {
  action: BridgeAction;
}

export interface BridgeActionResponse {
  ok: boolean;
  /** Human-readable outcome, e.g. "Press again to confirm Shiny Found" or why the action was refused. */
  message?: string;
  state: BridgeState;
}
