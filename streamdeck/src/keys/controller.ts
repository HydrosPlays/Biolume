/**
 * Turns bridge snapshots into key faces and key presses into bridge actions.
 *
 * Works on a minimal {@link KeyHandle} instead of the SDK's action classes so it
 * can be tested without Stream Deck; src/keys/actions.ts adapts the SDK.
 */
import { SHINY_CONFIRM_WINDOW_MS, type BridgeAction } from '../../../src/shared/streamDeck';
import type { ActionOutcome, BridgeLogger, BridgeSnapshot } from '../bridge/client';
import { renderKey, svgDataUrl, type KeyView } from '../faces/render';
import { KEY_ACTION, type KeyKind } from './kinds';

/** One visible key instance (the SDK's KeyAction fits). */
export interface KeyHandle {
  /** Stream Deck's context id of this key instance. */
  readonly id: string;
  setImage(image: string): Promise<void>;
  showOk(): Promise<void>;
  showAlert(): Promise<void>;
}

/** What the controller needs from the bridge client. */
export interface BridgeLike {
  readonly snapshot: BridgeSnapshot;
  onChange(listener: (snapshot: BridgeSnapshot) => void): () => void;
  sendAction(action: BridgeAction): Promise<ActionOutcome>;
  reconnectNow(): void;
}

export interface SpriteSource {
  get(url: string | null): string | null;
}

export interface KeyControllerOptions {
  bridge: BridgeLike;
  sprites?: SpriteSource;
  now?: () => number;
  logger?: BridgeLogger;
  /** Redraw interval of the Shiny Found countdown (default 250 ms). */
  tickMs?: number;
}

interface VisibleKey {
  kind: KeyKind;
  handle: KeyHandle;
  /** Last image sent, so unchanged faces are not re-sent. */
  image: string | null;
}

export class KeyController {
  readonly #bridge: BridgeLike;
  readonly #sprites: SpriteSource | null;
  readonly #now: () => number;
  readonly #log: BridgeLogger | null;
  readonly #tickMs: number;
  readonly #keys = new Map<string, VisibleKey>();
  readonly #unsubscribe: () => void;
  #ticker: ReturnType<typeof setInterval> | null = null;

  constructor(options: KeyControllerOptions) {
    this.#bridge = options.bridge;
    this.#sprites = options.sprites ?? null;
    this.#now = options.now ?? Date.now;
    this.#log = options.logger ?? null;
    this.#tickMs = options.tickMs ?? 250;
    this.#unsubscribe = this.#bridge.onChange(() => this.refresh());
  }

  /** A key became visible (startup, page / folder / profile switch). */
  appear(kind: KeyKind, handle: KeyHandle): void {
    const key: VisibleKey = { kind, handle, image: null };
    this.#keys.set(handle.id, key);
    this.#render(key);
    this.#syncTicker();
  }

  disappear(id: string): void {
    this.#keys.delete(id);
    this.#syncTicker();
  }

  /** Redraws every visible key (faces that did not change are skipped). */
  refresh(): void {
    for (const key of this.#keys.values()) this.#render(key);
    this.#syncTicker();
  }

  /**
   * A key was pressed. Feedback: an alert when Biolume is unreachable or refused
   * the action; otherwise a check mark — except on the counter key, whose
   * changing number is the feedback (a check mark would hide it), and on the
   * first Shiny Found press, whose face switches to "Confirm?" instead.
   */
  async press(kind: KeyKind, handle: KeyHandle): Promise<void> {
    const action = KEY_ACTION[kind];
    const outcome = await this.#bridge.sendAction(action);
    if (outcome.offline) {
      this.#log?.info(`${action}: Biolume is not reachable`);
      await this.#quietly(handle.showAlert());
      return;
    }
    if (!outcome.ok) {
      this.#log?.info(`${action} refused: ${outcome.message ?? 'no reason given'}`);
      await this.#quietly(handle.showAlert());
      return;
    }
    if (kind === 'counter') return;
    if (kind === 'shinyfound' && outcome.state?.shinyFoundArmed) return;
    await this.#quietly(handle.showOk());
  }

  dispose(): void {
    this.#unsubscribe();
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
    this.#keys.clear();
  }

  // ───────────────────────────── Internals ─────────────────────────────

  #view(kind: KeyKind): KeyView {
    const snapshot = this.#bridge.snapshot;
    if (snapshot.status === 'offline') return { connection: 'offline' };
    if (snapshot.status === 'incompatible') return { connection: 'incompatible' };
    const { state } = snapshot;
    const armed = kind === 'shinyfound' ? this.#armedRemaining() : null;
    const sprite =
      kind === 'counter' && this.#sprites
        ? this.#sprites.get(state.hunt?.shinySpriteUrl ?? null)
        : null;
    return {
      connection: 'online',
      hunt: state.hunt,
      armed:
        armed === null ? null : { remainingMs: armed, fraction: armed / SHINY_CONFIRM_WINDOW_MS },
      sprite,
    };
  }

  /**
   * Ms left of a pending Shiny Found confirmation, or null. Judged on the local
   * clock (Biolume runs on the same machine) so the key drops "Confirm?" on
   * time even if the expiry event is late; capped at the window so a bogus
   * deadline can never pin it.
   */
  #armedRemaining(): number | null {
    const snapshot = this.#bridge.snapshot;
    if (snapshot.status !== 'online') return null;
    const { shinyFoundArmed, shinyFoundArmedUntil } = snapshot.state;
    if (!shinyFoundArmed || shinyFoundArmedUntil === null) return null;
    const remaining = Math.min(shinyFoundArmedUntil - this.#now(), SHINY_CONFIRM_WINDOW_MS);
    return remaining > 0 ? remaining : null;
  }

  #render(key: VisibleKey): void {
    let image: string;
    try {
      image = svgDataUrl(renderKey(key.kind, this.#view(key.kind)));
    } catch (error) {
      this.#log?.error(`Rendering the ${key.kind} key failed: ${String(error)}`);
      return;
    }
    if (image === key.image) return;
    key.image = image;
    void this.#quietly(key.handle.setImage(image));
  }

  /** Runs the countdown redraw only while a confirmation is pending and a Shiny Found key is visible. */
  #syncTicker(): void {
    const needed =
      this.#armedRemaining() !== null &&
      [...this.#keys.values()].some((key) => key.kind === 'shinyfound');
    if (needed && this.#ticker === null) {
      this.#ticker = setInterval(() => {
        for (const key of this.#keys.values()) {
          if (key.kind === 'shinyfound') this.#render(key);
        }
        this.#syncTicker();
      }, this.#tickMs);
    } else if (!needed && this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
  }

  async #quietly(promise: Promise<void>): Promise<void> {
    try {
      await promise;
    } catch (error) {
      this.#log?.debug(`Stream Deck request failed: ${String(error)}`);
    }
  }
}
