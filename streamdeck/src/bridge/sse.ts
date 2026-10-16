/**
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation").
 *
 * Feed it raw byte chunks exactly as they come off the socket: chunks may end
 * in the middle of a line, in the middle of a CRLF pair or even inside a
 * multi-byte UTF-8 character. Lines may end in LF, CRLF or a lone CR; `data:`
 * lines accumulate (joined with LF) until a blank line dispatches the message;
 * `:` comment lines (the bridge's `: ping` keep-alives) are skipped.
 *
 * Hostile-input guards: a line or message larger than the configured limits
 * throws {@link SseLimitError} instead of growing the buffer without bound;
 * the caller drops the connection.
 */

export interface SseMessage {
  /** The `event:` field, or `message` when the server sent none. */
  event: string;
  /** All `data:` lines of the message, joined with `\n`. */
  data: string;
  /** The last `id:` seen on the stream (persists across messages), or null. */
  lastEventId: string | null;
}

export interface SseParserOptions {
  /** Longest single line accepted, in UTF-16 code units (default 64 KiB). */
  maxLineLength?: number;
  /** Largest accumulated `data` of one message, in UTF-16 code units (default 256 KiB). */
  maxMessageLength?: number;
}

export class SseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseLimitError';
  }
}

const DEFAULT_MAX_LINE = 64 * 1024;
const DEFAULT_MAX_MESSAGE = 256 * 1024;

export class SseParser {
  readonly #onMessage: (message: SseMessage) => void;
  readonly #maxLine: number;
  readonly #maxMessage: number;
  readonly #decoder = new TextDecoder('utf-8');
  #buffer = '';
  #data: string[] = [];
  #dataLength = 0;
  #event = '';
  #lastEventId: string | null = null;
  /** The previous chunk ended in CR: a leading LF of the next one completes that CRLF. */
  #skipLeadingLf = false;
  #atStreamStart = true;

  constructor(onMessage: (message: SseMessage) => void, options: SseParserOptions = {}) {
    this.#onMessage = onMessage;
    this.#maxLine = options.maxLineLength ?? DEFAULT_MAX_LINE;
    this.#maxMessage = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE;
  }

  /** Feeds bytes (decoded as streaming UTF-8) or an already decoded string. */
  feed(chunk: Uint8Array | string): void {
    let text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    if (this.#atStreamStart && text.length > 0) {
      this.#atStreamStart = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.#skipLeadingLf && text.length > 0) {
      this.#skipLeadingLf = false;
      if (text.charCodeAt(0) === 0x0a) text = text.slice(1);
    }
    this.#buffer += text;

    let start = 0;
    const buffer = this.#buffer;
    for (let i = 0; i < buffer.length; i++) {
      const code = buffer.charCodeAt(i);
      if (code !== 0x0a && code !== 0x0d) continue;
      this.#line(buffer.slice(start, i));
      if (code === 0x0d) {
        if (i + 1 < buffer.length) {
          if (buffer.charCodeAt(i + 1) === 0x0a) i++;
        } else {
          this.#skipLeadingLf = true;
        }
      }
      start = i + 1;
    }
    this.#buffer = buffer.slice(start);
    if (this.#buffer.length > this.#maxLine) {
      throw new SseLimitError(`SSE line longer than ${this.#maxLine} characters`);
    }
  }

  /** Forgets any partial line / message, e.g. before reusing the parser for a new connection. */
  reset(): void {
    this.#buffer = '';
    this.#data = [];
    this.#dataLength = 0;
    this.#event = '';
    this.#lastEventId = null;
    this.#skipLeadingLf = false;
    this.#atStreamStart = true;
    this.#decoder.decode();
  }

  #line(line: string): void {
    if (line.length > this.#maxLine) {
      throw new SseLimitError(`SSE line longer than ${this.#maxLine} characters`);
    }
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.charCodeAt(0) === 0x3a /* ':' */) return;

    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20 /* ' ' */) value = value.slice(1);

    switch (field) {
      case 'data':
        this.#dataLength += value.length + 1;
        if (this.#dataLength > this.#maxMessage) {
          throw new SseLimitError(`SSE message larger than ${this.#maxMessage} characters`);
        }
        this.#data.push(value);
        break;
      case 'event':
        this.#event = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.#lastEventId = value;
        break;
      default:
        // `retry` and unknown fields are ignored: reconnection timing is the client's own.
        break;
    }
  }

  #dispatch(): void {
    const data = this.#data;
    const event = this.#event;
    this.#data = [];
    this.#dataLength = 0;
    this.#event = '';
    if (data.length === 0) return;
    this.#onMessage({
      event: event === '' ? 'message' : event,
      data: data.join('\n'),
      lastEventId: this.#lastEventId,
    });
  }
}
