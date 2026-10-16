import { describe, expect, it } from 'vitest';
import { SseLimitError, SseParser, type SseMessage } from './sse';

function collect(options?: ConstructorParameters<typeof SseParser>[1]): {
  parser: SseParser;
  messages: SseMessage[];
} {
  const messages: SseMessage[] = [];
  const parser = new SseParser((message) => messages.push(message), options);
  return { parser, messages };
}

const STREAM =
  ': ping\n\n' +
  'data: {"type":"state"}\n\n' +
  'event: custom\nid: 7\ndata: first\ndata: second\n\n' +
  ': ping\n' +
  'data:no-space\n\n' +
  'data\n\n' +
  'data: ünïcödé ✨\n\n';

const EXPECTED: SseMessage[] = [
  { event: 'message', data: '{"type":"state"}', lastEventId: null },
  { event: 'custom', data: 'first\nsecond', lastEventId: '7' },
  { event: 'message', data: 'no-space', lastEventId: '7' },
  { event: 'message', data: '', lastEventId: '7' },
  { event: 'message', data: 'ünïcödé ✨', lastEventId: '7' },
];

describe('SseParser', () => {
  it('parses a whole stream: comments, multi-line data, event / id fields, missing colon or space', () => {
    const { parser, messages } = collect();
    parser.feed(STREAM);
    expect(messages).toEqual(EXPECTED);
  });

  it('gives the same result however the bytes are split (every split point)', () => {
    const bytes = new TextEncoder().encode(STREAM);
    for (let cut = 1; cut < bytes.length; cut++) {
      const { parser, messages } = collect();
      parser.feed(bytes.subarray(0, cut));
      parser.feed(bytes.subarray(cut));
      expect(messages, `split at byte ${cut}`).toEqual(EXPECTED);
    }
  });

  it('copes with one byte at a time, including multi-byte characters', () => {
    const { parser, messages } = collect();
    for (const byte of new TextEncoder().encode(STREAM)) parser.feed(Uint8Array.of(byte));
    expect(messages).toEqual(EXPECTED);
  });

  it('accepts CRLF and lone CR line endings, also when a CRLF is split across chunks', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    const cr = STREAM.replace(/\n/g, '\r');
    for (const stream of [crlf, cr]) {
      const whole = collect();
      whole.parser.feed(stream);
      expect(whole.messages).toEqual(EXPECTED);

      for (let cut = 1; cut < stream.length; cut++) {
        const split = collect();
        split.parser.feed(stream.slice(0, cut));
        split.parser.feed(stream.slice(cut));
        expect(split.messages, `split at ${cut}`).toEqual(EXPECTED);
      }
    }
  });

  it('does not dispatch a message until its blank line arrives', () => {
    const { parser, messages } = collect();
    parser.feed('data: partial\n');
    expect(messages).toEqual([]);
    parser.feed('\n');
    expect(messages).toHaveLength(1);
  });

  it('ignores a leading BOM, unknown fields and retry hints', () => {
    const { parser, messages } = collect();
    parser.feed('\ufeffretry: 10\nfoo: bar\ndata: x\n\n');
    expect(messages).toEqual([{ event: 'message', data: 'x', lastEventId: null }]);
  });

  it('dispatches nothing for an event-only block, and resets the event name afterwards', () => {
    const { parser, messages } = collect();
    parser.feed('event: lonely\n\ndata: x\n\n');
    expect(messages).toEqual([{ event: 'message', data: 'x', lastEventId: null }]);
  });

  it('throws SseLimitError for an over-long line, even before its line ending arrives', () => {
    const { parser } = collect({ maxLineLength: 64 });
    expect(() => parser.feed(`data: ${'x'.repeat(100)}`)).toThrow(SseLimitError);
    const other = collect({ maxLineLength: 64 });
    expect(() => other.parser.feed(`data: ${'x'.repeat(100)}\n`)).toThrow(SseLimitError);
  });

  it('throws SseLimitError when the data lines of one message add up too much', () => {
    const { parser } = collect({ maxLineLength: 1000, maxMessageLength: 100 });
    expect(() => {
      for (let i = 0; i < 20; i++) parser.feed(`data: ${'y'.repeat(20)}\n`);
    }).toThrow(SseLimitError);
  });

  it('starts clean after reset()', () => {
    const { parser, messages } = collect();
    parser.feed('data: half');
    parser.reset();
    parser.feed('data: whole\n\n');
    expect(messages).toEqual([{ event: 'message', data: 'whole', lastEventId: null }]);
  });
});
