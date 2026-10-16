import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeAction, BridgeState } from '../../../src/shared/streamDeck';
import type { ActionOutcome, BridgeSnapshot } from '../bridge/client';
import { HUNT, STATE } from '../bridge/testFixtures';
import { KeyController, type BridgeLike, type KeyHandle } from './controller';

class FakeBridge implements BridgeLike {
  snapshot: BridgeSnapshot = { status: 'offline', reason: 'no-pairing' };
  readonly sent: BridgeAction[] = [];
  outcome: ActionOutcome = { ok: true, offline: false, state: STATE };
  reconnects = 0;
  #listeners = new Set<(snapshot: BridgeSnapshot) => void>();

  onChange(listener: (snapshot: BridgeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async sendAction(action: BridgeAction): Promise<ActionOutcome> {
    this.sent.push(action);
    return this.outcome;
  }

  reconnectNow(): void {
    this.reconnects++;
  }

  set(snapshot: BridgeSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }

  online(state: BridgeState = STATE): void {
    this.set({ status: 'online', state, app: 'test' });
  }
}

class FakeKey implements KeyHandle {
  readonly images: string[] = [];
  oks = 0;
  alerts = 0;
  constructor(readonly id: string) {}
  async setImage(image: string): Promise<void> {
    this.images.push(image);
  }
  async showOk(): Promise<void> {
    this.oks++;
  }
  async showAlert(): Promise<void> {
    this.alerts++;
  }
  /** The last face, decoded back to SVG markup. */
  get face(): string {
    const last = this.images.at(-1) ?? '';
    return decodeURIComponent(last.slice('data:image/svg+xml,'.length));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('KeyController — faces', () => {
  it('draws a key as soon as it appears, and redraws on every bridge change', () => {
    const bridge = new FakeBridge();
    const controller = new KeyController({ bridge });
    const key = new FakeKey('k1');
    controller.appear('counter', key);
    expect(key.face).toContain('>Offline</text>');

    bridge.online();
    expect(key.face).toContain('>1234</text>');
    bridge.online({ ...STATE, hunt: { ...HUNT, count: 1235 } });
    expect(key.face).toContain('>1235</text>');
    expect(key.images).toHaveLength(3);
  });

  it('does not resend an unchanged face', () => {
    const bridge = new FakeBridge();
    bridge.online();
    const controller = new KeyController({ bridge });
    const key = new FakeKey('k1');
    controller.appear('increment', key);
    bridge.online({ ...STATE, hunt: { ...HUNT, count: 99 } }); // the increment face shows the step, not the count
    controller.refresh();
    expect(key.images).toHaveLength(1);
  });

  it('stops drawing keys that disappeared, and everything after dispose()', () => {
    const bridge = new FakeBridge();
    const controller = new KeyController({ bridge });
    const a = new FakeKey('a');
    const b = new FakeKey('b');
    controller.appear('undo', a);
    controller.appear('overlay', b);
    controller.disappear('a');
    bridge.online();
    expect(a.images).toHaveLength(1);
    expect(b.images).toHaveLength(2);
    controller.dispose();
    bridge.set({ status: 'offline', reason: 'unreachable' });
    expect(b.images).toHaveLength(2);
  });

  it('puts the downloaded sprite on the counter key only', () => {
    const bridge = new FakeBridge();
    bridge.online();
    const sprites = { get: vi.fn(() => 'data:image/png;base64,AAAA') };
    const controller = new KeyController({ bridge, sprites });
    const counter = new FakeKey('c');
    const undo = new FakeKey('u');
    controller.appear('counter', counter);
    controller.appear('undo', undo);
    expect(counter.face).toContain('xlink:href="data:image/png;base64,AAAA"');
    expect(sprites.get).toHaveBeenCalledWith(HUNT.shinySpriteUrl);
    expect(undo.face).not.toContain('<image');
  });

  it('counts the Shiny Found confirmation down and drops it when it expires', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const bridge = new FakeBridge();
    bridge.online({ ...STATE, shinyFoundArmed: true, shinyFoundArmedUntil: 1_003_000 });
    const controller = new KeyController({ bridge, tickMs: 100 });
    const key = new FakeKey('s');
    controller.appear('shinyfound', key);
    expect(key.face).toContain('>Confirm?</text>');
    expect(key.face).toContain('>3</text>');

    vi.advanceTimersByTime(1_100);
    expect(key.face).toContain('>2</text>');
    vi.advanceTimersByTime(2_000);
    expect(key.face).not.toContain('Confirm?');
    expect(key.face).toContain('>Shiny!</text>');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never shows a countdown longer than the confirmation window', () => {
    vi.useFakeTimers({ now: 0 });
    const bridge = new FakeBridge();
    bridge.online({ ...STATE, shinyFoundArmed: true, shinyFoundArmedUntil: 10_000_000 });
    const controller = new KeyController({ bridge });
    const key = new FakeKey('s');
    controller.appear('shinyfound', key);
    expect(key.face).toContain('>3</text>');
    controller.dispose();
  });
});

describe('KeyController — presses', () => {
  it('maps each key to its bridge action', async () => {
    const bridge = new FakeBridge();
    bridge.online();
    const controller = new KeyController({ bridge });
    const key = new FakeKey('k');
    for (const kind of [
      'counter',
      'increment',
      'decrement',
      'logphase',
      'shinyfound',
      'undo',
      'overlay',
    ] as const) {
      await controller.press(kind, key);
    }
    expect(bridge.sent).toEqual([
      'increment',
      'increment',
      'decrement',
      'logPhase',
      'shinyFound',
      'undo',
      'toggleOverlay',
    ]);
  });

  it('confirms with a check mark, except on the counter key', async () => {
    const bridge = new FakeBridge();
    bridge.online();
    const controller = new KeyController({ bridge });
    const counter = new FakeKey('c');
    const increment = new FakeKey('i');
    await controller.press('counter', counter);
    await controller.press('increment', increment);
    expect(counter.oks).toBe(0);
    expect(increment.oks).toBe(1);
    expect(counter.alerts + increment.alerts).toBe(0);
  });

  it('shows an alert when Biolume refuses or cannot be reached', async () => {
    const bridge = new FakeBridge();
    const controller = new KeyController({ bridge });
    const key = new FakeKey('k');
    bridge.outcome = { ok: false, offline: true, state: null };
    await controller.press('counter', key);
    bridge.outcome = { ok: false, offline: false, message: 'No active hunt', state: STATE };
    await controller.press('undo', key);
    expect(key.alerts).toBe(2);
    expect(key.oks).toBe(0);
  });

  it('arms Shiny Found silently, and confirms the second press', async () => {
    const bridge = new FakeBridge();
    bridge.online();
    const controller = new KeyController({ bridge });
    const key = new FakeKey('s');
    bridge.outcome = {
      ok: true,
      offline: false,
      message: 'Press again to confirm Shiny Found',
      state: { ...STATE, shinyFoundArmed: true, shinyFoundArmedUntil: Date.now() + 3_000 },
    };
    await controller.press('shinyfound', key);
    expect(key.oks + key.alerts).toBe(0);

    bridge.outcome = {
      ok: true,
      offline: false,
      state: { ...STATE, hunt: { ...HUNT, status: 'completed' } },
    };
    await controller.press('shinyfound', key);
    expect(key.oks).toBe(1);
    controller.dispose();
  });

  it('survives a Stream Deck that rejects its requests', async () => {
    const bridge = new FakeBridge();
    bridge.online();
    const controller = new KeyController({ bridge });
    const broken: KeyHandle = {
      id: 'x',
      setImage: () => Promise.reject(new Error('gone')),
      showOk: () => Promise.reject(new Error('gone')),
      showAlert: () => Promise.reject(new Error('gone')),
    };
    controller.appear('increment', broken);
    await expect(controller.press('increment', broken)).resolves.toBeUndefined();
  });
});
