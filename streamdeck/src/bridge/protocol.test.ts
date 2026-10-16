import { describe, expect, it } from 'vitest';
import {
  cleanText,
  parseActionResponse,
  parseEventData,
  parseHunt,
  parsePairing,
  parseState,
  samePairing,
} from './protocol';
import { HUNT, STATE, TOKEN } from './testFixtures';

describe('parseState / parseHunt', () => {
  it('accepts a well-formed state and drops unknown fields', () => {
    expect(parseState({ ...STATE, extra: 1, hunt: { ...HUNT, secret: 'x' } })).toEqual(STATE);
    expect(parseState({ ...STATE, hunt: null })).toEqual({ ...STATE, hunt: null });
  });

  it('rejects another protocol version and malformed fields', () => {
    expect(parseState({ ...STATE, protocol: 2 })).toBeNull();
    expect(parseState({ ...STATE, shinyFoundArmed: 'yes' })).toBeNull();
    expect(parseState({ ...STATE, shinyFoundArmedUntil: 'soon' })).toBeNull();
    expect(parseState({ ...STATE, hunt: { ...HUNT, count: -1 } })).toBeNull();
    expect(parseState({ ...STATE, hunt: { ...HUNT, count: 1.5 } })).toBeNull();
    expect(parseState({ ...STATE, hunt: { ...HUNT, count: Number.MAX_VALUE } })).toBeNull();
    expect(parseState({ ...STATE, hunt: { ...HUNT, step: 0 } })).toBeNull();
    expect(parseState({ ...STATE, hunt: { ...HUNT, status: 'deleted' } })).toBeNull();
    expect(parseState({ ...STATE, hunt: { ...HUNT, id: '' } })).toBeNull();
    expect(parseState({ ...STATE, hunt: { ...HUNT, name: 42 } })).toBeNull();
    expect(parseState({ ...STATE, hunt: { ...HUNT, shinySpriteUrl: 42 } })).toBeNull();
    expect(parseState([STATE])).toBeNull();
    expect(parseState(null)).toBeNull();
  });

  it('never reports "armed" without a deadline', () => {
    expect(parseState({ ...STATE, shinyFoundArmed: true, shinyFoundArmedUntil: null })).toEqual({
      ...STATE,
      shinyFoundArmed: false,
      shinyFoundArmedUntil: null,
    });
    expect(
      parseState({ ...STATE, shinyFoundArmed: true, shinyFoundArmedUntil: 1_700_000_000_000 }),
    ).toMatchObject({ shinyFoundArmed: true, shinyFoundArmedUntil: 1_700_000_000_000 });
  });

  it('cleans names: control and bidi characters go, length is capped', () => {
    const hunt = parseHunt({
      ...HUNT,
      name: 'Evil\u0000\u202e name\n\twith\u200b junk',
      targetName: 'x'.repeat(500),
    });
    expect(hunt?.name).toBe('Evil name with junk');
    expect(hunt?.targetName).toHaveLength(120);
    expect(parseHunt({ ...HUNT, targetName: '   ' })?.targetName).toBeNull();
  });

  it('cleanText caps by code points, not UTF-16 units', () => {
    expect(cleanText('✨✨✨✨', 2)).toBe('✨✨');
    expect(cleanText('😀😀😀', 2)).toBe('😀😀');
  });
});

describe('parseEventData', () => {
  it('parses state and action events', () => {
    expect(parseEventData(JSON.stringify({ type: 'state', state: STATE }))).toEqual({
      type: 'state',
      state: STATE,
    });
    expect(
      parseEventData(
        JSON.stringify({ type: 'action', action: 'shinyFound', ok: true, message: 'Press again' }),
      ),
    ).toEqual({ type: 'action', action: 'shinyFound', ok: true, message: 'Press again' });
  });

  it('returns null for junk, unknown event types and unknown actions', () => {
    expect(parseEventData('not json')).toBeNull();
    expect(parseEventData('null')).toBeNull();
    expect(parseEventData('"state"')).toBeNull();
    expect(parseEventData(JSON.stringify({ type: 'telemetry' }))).toBeNull();
    expect(parseEventData(JSON.stringify({ type: 'state', state: { protocol: 1 } }))).toBeNull();
    expect(
      parseEventData(JSON.stringify({ type: 'action', action: 'rm -rf', ok: true })),
    ).toBeNull();
    expect(
      parseEventData(JSON.stringify({ type: 'action', action: 'undo', ok: 'yes' })),
    ).toBeNull();
    expect(parseEventData('{"__proto__":{"polluted":true},"type":"x"}')).toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('parseActionResponse', () => {
  it('needs ok and a valid state', () => {
    expect(parseActionResponse({ ok: true, state: STATE })).toEqual({ ok: true, state: STATE });
    expect(parseActionResponse({ ok: false, message: 'No active hunt', state: STATE })).toEqual({
      ok: false,
      message: 'No active hunt',
      state: STATE,
    });
    expect(parseActionResponse({ ok: true })).toBeNull();
    expect(parseActionResponse({ state: STATE })).toBeNull();
    expect(parseActionResponse({ error: 'unauthorized' })).toBeNull();
  });
});

describe('parsePairing', () => {
  const pairing = { protocol: 1, port: 47637, token: TOKEN, pid: 4242, app: '0.1.0' };

  it('accepts the pairing document', () => {
    expect(parsePairing(JSON.stringify(pairing))).toEqual({ kind: 'ok', pairing });
  });

  it('flags another protocol version as incompatible', () => {
    expect(parsePairing(JSON.stringify({ ...pairing, protocol: 2 }))).toEqual({
      kind: 'incompatible',
      protocol: 2,
    });
  });

  it('rejects anything malformed', () => {
    for (const bad of [
      '',
      '{',
      '[]',
      JSON.stringify({ ...pairing, protocol: '1' }),
      JSON.stringify({ ...pairing, port: 0 }),
      JSON.stringify({ ...pairing, port: 70000 }),
      JSON.stringify({ ...pairing, port: '47637' }),
      JSON.stringify({ ...pairing, token: 'short' }),
      JSON.stringify({ ...pairing, token: `${TOKEN}\r\nX-Injected: 1` }),
      JSON.stringify({ ...pairing, token: `${TOKEN} space` }),
      JSON.stringify({ ...pairing, pid: 0 }),
      JSON.stringify({ ...pairing, pid: 1.5 }),
    ]) {
      expect(parsePairing(bad).kind, bad).toBe('invalid');
    }
  });

  it('samePairing compares port, token and pid', () => {
    const a = { protocol: 1 as const, port: 1, token: TOKEN, pid: 2, app: 'x' };
    expect(samePairing(a, { ...a, app: 'y' })).toBe(true);
    expect(samePairing(a, { ...a, port: 3 })).toBe(false);
    expect(samePairing(a, { ...a, token: `${TOKEN}x` })).toBe(false);
    expect(samePairing(a, null)).toBe(false);
    expect(samePairing(null, null)).toBe(true);
  });
});
