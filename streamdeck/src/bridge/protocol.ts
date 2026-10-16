/**
 * Runtime validation of everything that reaches the plugin from outside: the
 * pairing file and the bridge's HTTP / SSE payloads. Every byte is treated as
 * hostile — another local process could be squatting the port — so values are
 * checked field by field, strings are stripped of control characters and
 * capped, and anything unexpected is rejected rather than coerced.
 *
 * No Stream Deck SDK imports here, so it can be unit-tested in plain Node.
 */
import {
  BRIDGE_ACTIONS,
  STREAM_DECK_PROTOCOL_VERSION,
  type BridgeAction,
  type BridgeActionResponse,
  type BridgeEvent,
  type BridgeHunt,
  type BridgePairing,
  type BridgeState,
} from '../../../src/shared/streamDeck';

/** Longest hunt / target name kept (the key face shows far fewer characters). */
export const MAX_NAME_LENGTH = 120;
const MAX_ID_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 300;
const MAX_URL_LENGTH = 2_048;
const MAX_APP_VERSION_LENGTH = 64;
/** Counts are capped at 99,999,999 by the app; allow headroom, but stay a safe integer. */
const MAX_COUNT = 1_000_000_000_000;
/** Tokens travel in an HTTP header: printable ASCII only, so CR / LF can never be injected. */
const TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * C0 / C1 controls, zero-width characters, line / paragraph separators, bidi
 * embeddings, overrides and isolates, and the BOM: nothing a key face should
 * ever render. Inclusive code-point ranges.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isUnsafe(codePoint: number): boolean {
  return UNSAFE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/** A display string: unsafe characters removed, whitespace collapsed, capped at `max` code points. */
export function cleanText(value: string, max: number): string {
  let cleaned = '';
  for (const char of value) {
    cleaned += isUnsafe(char.codePointAt(0) ?? 0) ? ' ' : char;
  }
  const points = Array.from(cleaned.replace(/\s+/g, ' ').trim());
  return points.length > max ? points.slice(0, max).join('').trimEnd() : points.join('');
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' ? cleanText(value, max) : null;
}

function nullableText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  const result = text(value, max);
  return result === null ? undefined : result === '' ? null : result;
}

function integer(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;
}

export function isBridgeAction(value: unknown): value is BridgeAction {
  return typeof value === 'string' && (BRIDGE_ACTIONS as readonly string[]).includes(value);
}

const HUNT_STATUSES: readonly BridgeHunt['status'][] = ['active', 'completed', 'archived'];

export function parseHunt(value: unknown): BridgeHunt | null {
  if (!isRecord(value)) return null;
  const id = typeof value['id'] === 'string' ? value['id'] : null;
  if (id === null || id === '' || id.length > MAX_ID_LENGTH) return null;
  const name = text(value['name'], MAX_NAME_LENGTH);
  const status = HUNT_STATUSES.find((candidate) => candidate === value['status']);
  const count = integer(value['count'], 0, MAX_COUNT);
  const total = integer(value['total'], 0, MAX_COUNT);
  const step = integer(value['step'], 1, MAX_COUNT);
  const phaseNumber = integer(value['phaseNumber'], 1, MAX_COUNT);
  const targetName = nullableText(value['targetName'], MAX_NAME_LENGTH);
  const spriteRaw = value['shinySpriteUrl'];
  const shinySpriteUrl =
    spriteRaw === null
      ? null
      : typeof spriteRaw === 'string' && spriteRaw.length <= MAX_URL_LENGTH
        ? spriteRaw
        : undefined;
  if (
    name === null ||
    status === undefined ||
    count === null ||
    total === null ||
    step === null ||
    phaseNumber === null ||
    targetName === undefined ||
    shinySpriteUrl === undefined
  ) {
    return null;
  }
  return { id, name, status, count, total, step, phaseNumber, targetName, shinySpriteUrl };
}

export function parseState(value: unknown): BridgeState | null {
  if (!isRecord(value) || value['protocol'] !== STREAM_DECK_PROTOCOL_VERSION) return null;
  const huntRaw = value['hunt'];
  const hunt = huntRaw === null ? null : parseHunt(huntRaw);
  if (huntRaw !== null && hunt === null) return null;
  const armed = value['shinyFoundArmed'];
  if (typeof armed !== 'boolean') return null;
  const untilRaw = value['shinyFoundArmedUntil'];
  const until =
    untilRaw === null
      ? null
      : typeof untilRaw === 'number' && Number.isFinite(untilRaw) && untilRaw >= 0
        ? untilRaw
        : undefined;
  if (until === undefined) return null;
  return {
    protocol: STREAM_DECK_PROTOCOL_VERSION,
    hunt,
    shinyFoundArmed: armed && until !== null,
    shinyFoundArmedUntil: armed ? until : null,
  };
}

function optionalMessage(value: unknown): { message?: string } {
  const message = text(value, MAX_MESSAGE_LENGTH);
  return message ? { message } : {};
}

/** One `data:` payload of the event stream; null for malformed or unknown events (ignored). */
export function parseEventData(data: string): BridgeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value['type'] === 'state') {
    const state = parseState(value['state']);
    return state ? { type: 'state', state } : null;
  }
  if (value['type'] === 'action') {
    const action = value['action'];
    const ok = value['ok'];
    if (!isBridgeAction(action) || typeof ok !== 'boolean') return null;
    return { type: 'action', action, ok, ...optionalMessage(value['message']) };
  }
  return null;
}

export function parseActionResponse(value: unknown): BridgeActionResponse | null {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return null;
  const state = parseState(value['state']);
  if (!state) return null;
  return { ok: value['ok'], ...optionalMessage(value['message']), state };
}

export type PairingParse =
  | { kind: 'ok'; pairing: BridgePairing }
  | { kind: 'incompatible'; protocol: number }
  | { kind: 'invalid'; reason: string };

/** The pairing document Biolume writes into its userData folder. */
export function parsePairing(raw: string): PairingParse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!isRecord(value)) return { kind: 'invalid', reason: 'not an object' };
  const protocol = value['protocol'];
  if (typeof protocol !== 'number') return { kind: 'invalid', reason: 'no protocol version' };
  if (protocol !== STREAM_DECK_PROTOCOL_VERSION) return { kind: 'incompatible', protocol };
  const port = integer(value['port'], 1, 65_535);
  if (port === null) return { kind: 'invalid', reason: 'bad port' };
  const token = value['token'];
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return { kind: 'invalid', reason: 'bad token' };
  }
  const pid = integer(value['pid'], 1, 0x7fff_ffff);
  if (pid === null) return { kind: 'invalid', reason: 'bad pid' };
  const app = text(value['app'], MAX_APP_VERSION_LENGTH) ?? '';
  return {
    kind: 'ok',
    pairing: { protocol: STREAM_DECK_PROTOCOL_VERSION, port, token, pid, app },
  };
}

/** Two pairings address the same bridge instance (same process, port and token). */
export function samePairing(a: BridgePairing | null, b: BridgePairing | null): boolean {
  if (a === null || b === null) return a === b;
  return a.port === b.port && a.token === b.token && a.pid === b.pid;
}
