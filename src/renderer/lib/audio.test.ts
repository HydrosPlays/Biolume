import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOUND_PACKS } from '@shared/defaults';
import type { AudioSettings } from '@shared/types';
import { disposeAudio, isAudioSupported, playSound, primeAudio, SOUND_KINDS } from './audio';

const settings: AudioSettings = { enabled: true, volume: 0.5, pack: 'sonar', milestoneChime: true };

function param() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
}

function node() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

/** Just enough of the Web Audio graph to observe what gets scheduled. */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 10;
  sampleRate = 8000;
  destination = node();
  oscillators: {
    type: string;
    frequency: ReturnType<typeof param>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  noiseSources = 0;
  gains: { gain: ReturnType<typeof param> }[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator() {
    const oscillator = {
      ...node(),
      type: 'sine',
      frequency: param(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    const gain = { ...node(), gain: param() };
    this.gains.push(gain);
    return gain;
  }

  createDynamicsCompressor() {
    return {
      ...node(),
      threshold: param(),
      knee: param(),
      ratio: param(),
      attack: param(),
      release: param(),
    };
  }

  createBiquadFilter() {
    return { ...node(), type: 'lowpass', frequency: param(), Q: param() };
  }

  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }

  createBufferSource() {
    this.noiseSources += 1;
    return { ...node(), buffer: null, start: vi.fn(), stop: vi.fn(), onended: null };
  }
}

function context(): FakeAudioContext {
  const instance = FakeAudioContext.instances.at(-1);
  if (!instance) throw new Error('no AudioContext was created');
  return instance;
}

describe('playSound', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });
  afterEach(() => {
    disposeAudio();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Moves the debounce clock forward so consecutive plays are not swallowed. */
  let clock = 0;
  const tick = (): void => {
    clock += 1000;
    vi.mocked(performance.now).mockReturnValue(clock);
  };

  it('creates the context lazily and reuses it', () => {
    expect(isAudioSupported()).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(0);

    tick();
    expect(playSound('increment', settings)).toBe(true);
    tick();
    expect(playSound('decrement', settings)).toBe(true);

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(context().oscillators.length).toBeGreaterThan(1);
  });

  it('schedules every kind in every pack', () => {
    for (const pack of SOUND_PACKS) {
      for (const kind of SOUND_KINDS) {
        tick();
        const before = FakeAudioContext.instances.at(-1)?.oscillators.length ?? 0;
        expect(playSound(kind, { ...settings, pack }), `${pack}/${kind}`).toBe(true);
        const scheduled = context().oscillators.slice(before);
        expect(scheduled.length, `${pack}/${kind}`).toBeGreaterThan(0);
        for (const oscillator of scheduled) {
          expect(oscillator.start).toHaveBeenCalledTimes(1);
          expect(oscillator.stop).toHaveBeenCalledTimes(1);
        }
      }
    }
  });

  it('keeps increments short', () => {
    for (const pack of SOUND_PACKS) {
      tick();
      const before = FakeAudioContext.instances.at(-1)?.oscillators.length ?? 0;
      playSound('increment', { ...settings, pack });
      const start = context().currentTime;
      for (const oscillator of context().oscillators.slice(before)) {
        const stopAt = oscillator.stop.mock.calls[0]?.[0] as number;
        expect(stopAt - start, pack).toBeLessThan(0.2);
      }
    }
  });

  it('varies the pitch of consecutive count sounds', () => {
    const pitches = new Set<number>();
    for (let index = 0; index < 12; index += 1) {
      tick();
      const before = FakeAudioContext.instances.at(-1)?.oscillators.length ?? 0;
      playSound('increment', settings);
      const first = context().oscillators[before];
      pitches.add(first?.frequency.setValueAtTime.mock.calls[0]?.[0] as number);
    }
    expect(pitches.size).toBeGreaterThan(6);
    for (const pitch of pitches) {
      expect(pitch).toBeGreaterThan(930 * 0.97);
      expect(pitch).toBeLessThan(930 * 1.03);
    }
  });

  it('sounds different per pack', () => {
    const signature = (pack: AudioSettings['pack']): string => {
      tick();
      const before = FakeAudioContext.instances.at(-1)?.oscillators.length ?? 0;
      const noiseBefore = FakeAudioContext.instances.at(-1)?.noiseSources ?? 0;
      playSound('increment', { ...settings, pack });
      const voices = context().oscillators.slice(before);
      return `${voices.map((voice) => voice.type).join('+')}|noise:${context().noiseSources - noiseBefore}|n:${voices.length}`;
    };
    // Bubble sweeps up while sonar glides down — same shape, opposite direction.
    expect(
      new Set(['sonar', 'click', 'chime'].map((pack) => signature(pack as AudioSettings['pack'])))
        .size,
    ).toBe(3);

    tick();
    const before = context().oscillators.length;
    playSound('increment', { ...settings, pack: 'bubble' });
    const bubble = context().oscillators[before];
    const from = bubble?.frequency.setValueAtTime.mock.calls[0]?.[0] as number;
    const to = bubble?.frequency.exponentialRampToValueAtTime.mock.calls[0]?.[0] as number;
    expect(to).toBeGreaterThan(from);
  });

  it('applies the master volume and stays silent when disabled or muted', () => {
    tick();
    expect(playSound('increment', { ...settings, enabled: false })).toBe(false);
    tick();
    expect(playSound('increment', { ...settings, volume: 0 })).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);

    tick();
    playSound('increment', { ...settings, volume: 0.5 });
    // The first gain node created for a sound is its master bus.
    expect(context().gains[0]?.gain.value).toBeCloseTo(0.25);
  });

  it('swallows an immediate duplicate of the same sound', () => {
    tick();
    expect(playSound('increment', settings)).toBe(true);
    expect(playSound('increment', settings)).toBe(false);
    expect(playSound('decrement', settings)).toBe(true);
  });

  it('resumes a suspended context', () => {
    tick();
    playSound('increment', settings);
    context().state = 'suspended';
    tick();
    playSound('increment', settings);
    expect(context().resume).toHaveBeenCalledTimes(1);

    context().state = 'suspended';
    primeAudio();
    expect(context().resume).toHaveBeenCalledTimes(2);
  });

  it('is a safe no-op when Web Audio is unavailable or construction fails', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(isAudioSupported()).toBe(false);
    tick();
    expect(playSound('increment', settings)).toBe(false);
    expect(() => primeAudio()).not.toThrow();

    disposeAudio();
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('no output device');
        }
      },
    );
    tick();
    expect(playSound('complete', settings)).toBe(false);
    expect(isAudioSupported()).toBe(false);
  });
});
