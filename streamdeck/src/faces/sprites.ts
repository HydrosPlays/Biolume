/**
 * Downloads the target's shiny sprite for the counter key and keeps it as a
 * PNG data URL to embed in the SVG face.
 *
 * The URL comes from the bridge, i.e. from another process, so it is not
 * trusted: only `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/…png`
 * — where Biolume's sprites live — is fetched, without following redirects,
 * size-capped, and the bytes must be a PNG. Failures are remembered for a while
 * so a broken URL is not re-fetched on every render.
 *
 * The branch is pinned on purpose: raw.githubusercontent.com also serves any
 * commit of any *fork* under the parent's path (`/PokeAPI/sprites/<sha>/…`), so
 * allowing every ref would let whoever crafted a hunt (an imported backup, say)
 * feed Stream Deck's image decoder a PNG of their own.
 */
import { readBoundedBytes } from '../bridge/http';

const SPRITE_HOST = 'raw.githubusercontent.com';
const SPRITE_PATH_PREFIX = '/PokeAPI/sprites/master/sprites/';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True for the sprite URLs the plugin is willing to download. */
export function isAllowedSpriteUrl(raw: string): boolean {
  if (raw.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === SPRITE_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname.startsWith(SPRITE_PATH_PREFIX) &&
    !url.pathname.includes('..') &&
    url.pathname.toLowerCase().endsWith('.png')
  );
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export interface SpriteCacheOptions {
  fetch?: typeof fetch;
  /** Called after a sprite finished downloading, so faces can be redrawn. */
  onLoad?: (url: string) => void;
  /**
   * Largest sprite accepted (default 64 KiB). PokeAPI pixel sprites are ~1–3 KiB; the
   * whole face, sprite included, is re-sent to Stream Deck on every count change, so
   * big renders are skipped (the key shows the target's name instead).
   */
  maxBytes?: number;
  /** Sprites kept in memory (default 24). */
  maxEntries?: number;
  timeoutMs?: number;
  /** How long a failed URL is left alone before another try (default 5 min). */
  retryAfterMs?: number;
  now?: () => number;
}

type Entry =
  { kind: 'ready'; dataUrl: string } | { kind: 'loading' } | { kind: 'failed'; at: number };

export class SpriteCache {
  readonly #fetch: typeof fetch;
  readonly #onLoad: (url: string) => void;
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #timeoutMs: number;
  readonly #retryAfterMs: number;
  readonly #now: () => number;
  /** Insertion-ordered: re-inserted on use, so the first key is the least recently used. */
  readonly #entries = new Map<string, Entry>();

  constructor(options: SpriteCacheOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#onLoad = options.onLoad ?? (() => undefined);
    this.#maxBytes = options.maxBytes ?? 64 * 1024;
    this.#maxEntries = Math.max(1, options.maxEntries ?? 24);
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#retryAfterMs = options.retryAfterMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The sprite as a data URL when it is cached; otherwise null — and a download
   * starts in the background (`onLoad` fires when it lands).
   */
  get(url: string | null): string | null {
    if (url === null || !isAllowedSpriteUrl(url)) return null;
    const entry = this.#entries.get(url);
    if (entry?.kind === 'ready') {
      this.#entries.delete(url);
      this.#entries.set(url, entry);
      return entry.dataUrl;
    }
    if (entry?.kind === 'loading') return null;
    if (entry?.kind === 'failed' && this.#now() - entry.at < this.#retryAfterMs) return null;
    this.#entries.set(url, { kind: 'loading' });
    void this.#load(url);
    return null;
  }

  async #load(url: string): Promise<void> {
    try {
      const response = await this.#fetch(url, {
        redirect: 'error',
        headers: { Accept: 'image/png' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await readBoundedBytes(response, this.#maxBytes);
      if (!isPng(bytes)) throw new Error('not a PNG');
      this.#store(url, {
        kind: 'ready',
        dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      });
      this.#onLoad(url);
    } catch {
      this.#store(url, { kind: 'failed', at: this.#now() });
    }
  }

  #store(url: string, entry: Entry): void {
    this.#entries.delete(url);
    this.#entries.set(url, entry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}
