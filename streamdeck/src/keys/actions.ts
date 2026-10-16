/**
 * The plugin's Stream Deck actions — one SingletonAction per manifest UUID,
 * each a thin adapter that hands its keys to the shared {@link KeyController}.
 */
import {
  SingletonAction,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from '@elgato/streamdeck';
import type { KeyController, KeyHandle } from './controller';
import { KEY_KINDS, actionUuid, type KeyKind } from './kinds';

/** The keys have no per-key settings (no property inspector). */
type NoSettings = Record<string, never>;

function handleFor(action: KeyAction<NoSettings>): KeyHandle {
  return {
    id: action.id,
    setImage: (image) => action.setImage(image),
    showOk: () => action.showOk(),
    showAlert: () => action.showAlert(),
  };
}

export class BiolumeKeyAction extends SingletonAction<NoSettings> {
  override readonly manifestId: string;
  readonly #kind: KeyKind;
  readonly #controller: KeyController;

  constructor(kind: KeyKind, controller: KeyController) {
    super();
    this.#kind = kind;
    this.#controller = controller;
    this.manifestId = actionUuid(kind);
  }

  override onWillAppear(ev: WillAppearEvent<NoSettings>): void {
    // Keypad only (see the manifest's Controllers); dials never reach here.
    if (ev.action.isKey()) this.#controller.appear(this.#kind, handleFor(ev.action));
  }

  override onWillDisappear(ev: WillDisappearEvent<NoSettings>): void {
    this.#controller.disappear(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<NoSettings>): Promise<void> {
    await this.#controller.press(this.#kind, handleFor(ev.action));
  }
}

export function createActions(controller: KeyController): BiolumeKeyAction[] {
  return KEY_KINDS.map((kind) => new BiolumeKeyAction(kind, controller));
}
