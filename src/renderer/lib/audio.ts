/**
 * Synthesised audio feedback — Web Audio only, no sample files.
 *
 * Four packs give the counter a different voice:
 *   - `sonar`  — a soft sine ping that glides down, with a faint echo
 *   - `bubble` — a round "bloop" that sweeps upward like a rising bubble
 *   - `click`  — a dry mechanical tick (filtered noise + a short body tone)
 *   - `chime`  — a small glassy bell with inharmonic partials
 *
 * Increments stay under ~150 ms and are pitched slightly differently on every
 * play, so counting quickly sounds alive rather than like a machine gun.
 */
import type { AudioSettings, SoundPack } from '@shared/types';

export type SoundKind = 'increment' | 'decrement' | 'phase' | 'complete' | 'milestone' | 'error';

export const SOUND_KINDS: readonly SoundKind[] = [
  'increment',
  'decrement',
  'phase',
  'complete',
  'milestone',
  'error',
];

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

interface Engine {
  context: AudioContext;
  /** Everything routes through here so one compressor tames stacked rapid counts. */
  output: AudioNode;
  noise: AudioBuffer;
}

interface ToneSpec {
  type: OscillatorType;
  /** Hz at the start of the note. */
  frequency: number;
  /** Hz the pitch glides to by the end of the note (exponential). */
  glideTo?: number;
  /** Seconds after the sound's start time. */
  delay?: number;
  attack: number;
  decay: number;
  /** Peak level, 0–1, before the master volume. */
  level: number;
}

interface NoiseSpec {
  delay?: number;
  decay: number;
  level: number;
  filter: BiquadFilterType;
  filterFrequency: number;
}

/** Ignore a second identical sound inside this window (two windows relaying one event, key bounce). */
const MIN_REPEAT_INTERVAL_MS = 18;
/** A sound that had to wait this long for a suspended context to wake is no longer worth playing. */
const STALE_AFTER_MS = 250;
/** ± fraction of pitch randomisation applied to count sounds (≈ ±45 cents). */
const PITCH_JITTER = 0.026;
const SILENCE = 0.0001;

let engine: Engine | null = null;
let unavailable = false;
const lastPlayedAt = new Map<SoundKind, number>();

function resolveConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as Window & {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Whether this environment can synthesise sound at all. */
export function isAudioSupported(): boolean {
  return !unavailable && resolveConstructor() !== null;
}

function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * 0.25);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    data[index] = Math.random() * 2 - 1;
  }
  return buffer;
}

function getEngine(): Engine | null {
  if (engine) return engine;
  if (unavailable) return null;
  const Constructor = resolveConstructor();
  if (!Constructor) {
    unavailable = true;
    return null;
  }
  try {
    const context = new Constructor({ latencyHint: 'interactive' });
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.12;
    compressor.connect(context.destination);
    engine = { context, output: compressor, noise: createNoiseBuffer(context) };
    return engine;
  } catch {
    // No output device, or the context limit was hit — stay silent for this session.
    unavailable = true;
    return null;
  }
}

/**
 * Creates / resumes the audio context. Call from a user gesture (first click or
 * key press) so playback is never blocked by an autoplay policy.
 */
export function primeAudio(): void {
  const current = getEngine();
  if (current && current.context.state === 'suspended') {
    void current.context.resume().catch(() => undefined);
  }
}

/** Releases the audio context (tests, hot reload). The next `playSound` recreates it. */
export function disposeAudio(): void {
  const current = engine;
  engine = null;
  unavailable = false;
  lastPlayedAt.clear();
  if (current && current.context.state !== 'closed') {
    void current.context.close().catch(() => undefined);
  }
}

function jitter(amount: number): number {
  return 1 + (Math.random() * 2 - 1) * amount;
}

function scheduleTone(
  current: Engine,
  destination: AudioNode,
  start: number,
  spec: ToneSpec,
): void {
  const { context } = current;
  const begin = start + (spec.delay ?? 0);
  const end = begin + spec.attack + spec.decay;

  const oscillator = context.createOscillator();
  oscillator.type = spec.type;
  oscillator.frequency.setValueAtTime(spec.frequency, begin);
  if (spec.glideTo !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(spec.glideTo, 1), end);
  }

  const envelope = context.createGain();
  envelope.gain.setValueAtTime(SILENCE, begin);
  envelope.gain.exponentialRampToValueAtTime(Math.max(spec.level, SILENCE), begin + spec.attack);
  envelope.gain.exponentialRampToValueAtTime(SILENCE, end);

  oscillator.connect(envelope);
  envelope.connect(destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    envelope.disconnect();
  };
  oscillator.start(begin);
  oscillator.stop(end + 0.02);
}

function scheduleNoise(
  current: Engine,
  destination: AudioNode,
  start: number,
  spec: NoiseSpec,
): void {
  const { context } = current;
  const begin = start + (spec.delay ?? 0);
  const end = begin + spec.decay;

  const source = context.createBufferSource();
  source.buffer = current.noise;
  const filter = context.createBiquadFilter();
  filter.type = spec.filter;
  filter.frequency.value = spec.filterFrequency;
  filter.Q.value = 1.1;

  const envelope = context.createGain();
  envelope.gain.setValueAtTime(Math.max(spec.level, SILENCE), begin);
  envelope.gain.exponentialRampToValueAtTime(SILENCE, end);

  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(destination);
  source.onended = () => {
    source.disconnect();
    filter.disconnect();
    envelope.disconnect();
  };
  source.start(begin);
  source.stop(end + 0.02);
}

interface Voice {
  tones: ToneSpec[];
  noise?: NoiseSpec[];
}

/** One count tick. `direction` +1 for increments, −1 for decrements (lower, falling). */
function countVoice(pack: SoundPack, direction: 1 | -1): Voice {
  const pitch = jitter(PITCH_JITTER) * (direction === 1 ? 1 : 0.72);
  switch (pack) {
    case 'sonar':
      return {
        tones: [
          {
            type: 'sine',
            frequency: 930 * pitch,
            glideTo: 760 * pitch,
            attack: 0.004,
            decay: 0.115,
            level: 0.5,
          },
          // The echo: quieter, a touch lower, as if returning from the deep.
          {
            type: 'sine',
            frequency: 760 * pitch,
            glideTo: 700 * pitch,
            delay: 0.07,
            attack: 0.006,
            decay: 0.07,
            level: 0.11,
          },
        ],
      };
    case 'bubble':
      return {
        tones: [
          direction === 1
            ? {
                type: 'sine',
                frequency: 310 * pitch,
                glideTo: 940 * pitch,
                attack: 0.006,
                decay: 0.085,
                level: 0.55,
              }
            : {
                type: 'sine',
                frequency: 820 * pitch,
                glideTo: 300 * pitch,
                attack: 0.006,
                decay: 0.095,
                level: 0.5,
              },
        ],
      };
    case 'click':
      return {
        tones: [
          {
            type: 'triangle',
            frequency: 1850 * pitch,
            glideTo: 900 * pitch,
            attack: 0.001,
            decay: 0.028,
            level: 0.3,
          },
        ],
        noise: [
          {
            decay: 0.022,
            level: 0.34,
            filter: 'bandpass',
            filterFrequency: direction === 1 ? 3400 : 2100,
          },
        ],
      };
    case 'chime': {
      const fundamental = (direction === 1 ? 1318.5 : 987.8) * jitter(PITCH_JITTER / 2);
      return {
        tones: [
          { type: 'sine', frequency: fundamental, attack: 0.003, decay: 0.14, level: 0.36 },
          { type: 'sine', frequency: fundamental * 2.76, attack: 0.002, decay: 0.07, level: 0.1 },
          {
            type: 'triangle',
            frequency: fundamental * 5.4,
            attack: 0.001,
            decay: 0.03,
            level: 0.04,
          },
        ],
      };
    }
  }
}

/** Oscillator colour for the melodic cues, so they still belong to the chosen pack. */
function melodicType(pack: SoundPack): OscillatorType {
  return pack === 'click' || pack === 'chime' ? 'triangle' : 'sine';
}

function note(
  type: OscillatorType,
  frequency: number,
  delay: number,
  decay: number,
  level: number,
): ToneSpec {
  return { type, frequency, delay, attack: 0.008, decay, level };
}

function voiceFor(kind: SoundKind, pack: SoundPack): Voice {
  const type = melodicType(pack);
  switch (kind) {
    case 'increment':
      return countVoice(pack, 1);
    case 'decrement':
      return countVoice(pack, -1);
    case 'phase':
      // A rising fourth with an airy overtone: something rare surfaced.
      return {
        tones: [
          note(type, 659.3, 0, 0.22, 0.34),
          note(type, 880, 0.11, 0.34, 0.36),
          note('sine', 1760, 0.11, 0.26, 0.07),
        ],
      };
    case 'milestone':
      return {
        tones: [note(type, 784, 0, 0.16, 0.26), note(type, 1174.7, 0.09, 0.3, 0.28)],
      };
    case 'complete':
      // The shiny sparkle: a major arpeggio up two octaves with a shimmer on top.
      return {
        tones: [
          note(type, 523.3, 0, 0.3, 0.3),
          note(type, 659.3, 0.08, 0.3, 0.3),
          note(type, 784, 0.16, 0.32, 0.3),
          note(type, 1046.5, 0.24, 0.42, 0.32),
          note(type, 1318.5, 0.32, 0.6, 0.3),
          note('sine', 2637, 0.34, 0.7, 0.09),
          note('sine', 3136, 0.42, 0.62, 0.06),
        ],
        noise: [
          { delay: 0.3, decay: 0.38, level: 0.045, filter: 'highpass', filterFrequency: 6200 },
        ],
      };
    case 'error':
      return {
        tones: [
          {
            type: 'triangle',
            frequency: 233,
            glideTo: 196,
            attack: 0.006,
            decay: 0.11,
            level: 0.34,
          },
          {
            type: 'triangle',
            frequency: 174.6,
            glideTo: 146.8,
            delay: 0.1,
            attack: 0.006,
            decay: 0.15,
            level: 0.34,
          },
        ],
      };
  }
}

/** Slider position (0–1) → gain. Squared so the lower half of the slider is actually useful. */
function masterGain(volume: number): number {
  const clamped = Math.min(Math.max(Number.isFinite(volume) ? volume : 0, 0), 1);
  return clamped * clamped;
}

/**
 * Plays one feedback sound. A no-op when audio is disabled, the volume is zero
 * or Web Audio is unavailable; never throws. Returns whether a sound was
 * accepted for playback.
 */
export function playSound(kind: SoundKind, audio: AudioSettings): boolean {
  if (!audio.enabled) return false;
  const gain = masterGain(audio.volume);
  if (gain <= 0) return false;

  const nowMs = clock();
  const previous = lastPlayedAt.get(kind);
  if (previous !== undefined && nowMs - previous < MIN_REPEAT_INTERVAL_MS) return false;

  const current = getEngine();
  if (!current) return false;

  const { context } = current;
  const { pack } = audio;
  if (context.state === 'suspended') {
    // Wake the context first. If it only wakes much later (a policy waiting for the
    // first user gesture), the moment has passed: stale sounds are dropped, not replayed.
    context.resume().then(
      () => {
        if (clock() - nowMs <= STALE_AFTER_MS) emit(current, kind, pack, gain);
      },
      () => undefined,
    );
  } else {
    emit(current, kind, pack, gain);
  }
  lastPlayedAt.set(kind, nowMs);
  return true;
}

function clock(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** Builds and schedules the node graph for one sound. Never throws. */
function emit(current: Engine, kind: SoundKind, pack: SoundPack, gain: number): void {
  try {
    const { context } = current;
    const master = context.createGain();
    master.gain.value = gain;
    master.connect(current.output);

    const start = context.currentTime + 0.004;
    const voice = voiceFor(kind, pack);
    let tail = 0;
    for (const tone of voice.tones) {
      scheduleTone(current, master, start, tone);
      tail = Math.max(tail, (tone.delay ?? 0) + tone.attack + tone.decay);
    }
    for (const burst of voice.noise ?? []) {
      scheduleNoise(current, master, start, burst);
      tail = Math.max(tail, (burst.delay ?? 0) + burst.decay);
    }
    // Detach the per-sound bus once its last node has rung out.
    window.setTimeout(() => master.disconnect(), Math.ceil((tail + 0.25) * 1000));
  } catch {
    // A context that died mid-session (device unplugged) must never break counting.
  }
}
