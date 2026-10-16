import { describe, expect, it, vi } from 'vitest';
import { SpriteCache, isAllowedSpriteUrl } from './sprites';

const URL_OK =
  'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/280.png';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeFetch(respond: () => Response) {
  return vi.fn<typeof fetch>(async () => respond());
}

describe('isAllowedSpriteUrl', () => {
  it('accepts PokeAPI sprite PNGs on raw.githubusercontent.com', () => {
    expect(isAllowedSpriteUrl(URL_OK)).toBe(true);
    expect(
      isAllowedSpriteUrl(
        'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/shiny/280.png',
      ),
    ).toBe(true);
  });

  it.each([
    'http://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/280.png',
    'https://raw.githubusercontent.com:8443/PokeAPI/sprites/x.png',
    'https://user:pw@raw.githubusercontent.com/PokeAPI/sprites/x.png',
    'https://raw.githubusercontent.com.evil.test/PokeAPI/sprites/x.png',
    'https://evil.test/PokeAPI/sprites/x.png',
    'https://raw.githubusercontent.com/someone/else/x.png',
    'https://raw.githubusercontent.com/PokeAPI/sprites/../../someone/x.png',
    'https://raw.githubusercontent.com/PokeAPI/sprites/x.svg',
    'https://raw.githubusercontent.com/PokeAPI/sprites/x.png?redirect=1',
    // Regression: GitHub serves commits pushed to any fork under the parent repo's path,
    // so only the master branch is PokeAPI's own content.
    'https://raw.githubusercontent.com/PokeAPI/sprites/3f1c0e5a9b8d7c6e5f4a3b2c1d0e9f8a7b6c5d4e/sprites/pokemon/shiny/280.png',
    'https://raw.githubusercontent.com/PokeAPI/sprites/some-branch/sprites/pokemon/shiny/280.png',
    'https://raw.githubusercontent.com/PokeAPI/sprites/refs/heads/master/sprites/pokemon/shiny/280.png',
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/%2e%2e/%2e%2e/3f1c0e5a/x.png',
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/..%2F..%2F3f1c0e5a/x.png',
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/x.png',
    'file:///C:/Windows/win.ini',
    'http://127.0.0.1:47637/v1/state',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isAllowedSpriteUrl(url)).toBe(false);
  });
});

describe('SpriteCache', () => {
  it('downloads once, then serves a PNG data URL', async () => {
    const fetch = fakeFetch(() => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));
    const onLoad = vi.fn();
    const cache = new SpriteCache({ fetch, onLoad });

    expect(cache.get(URL_OK)).toBeNull();
    expect(cache.get(URL_OK)).toBeNull();
    await vi.waitFor(() => expect(onLoad).toHaveBeenCalledWith(URL_OK));
    expect(cache.get(URL_OK)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('never fetches URLs outside the allow-list', () => {
    const fetch = fakeFetch(() => new Response(PNG));
    const cache = new SpriteCache({ fetch });
    expect(cache.get('https://evil.test/x.png')).toBeNull();
    expect(cache.get(null)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects non-PNG bodies, errors and oversized files, and waits before retrying', async () => {
    let now = 0;
    for (const respond of [
      () => new Response('<html>not an image</html>'),
      () => new Response('nope', { status: 404 }),
      () => new Response(new Uint8Array(100_000)),
    ]) {
      const fetch = fakeFetch(respond);
      const cache = new SpriteCache({
        fetch,
        now: () => now,
        retryAfterMs: 1_000,
      });
      cache.get(URL_OK);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cache.get(URL_OK)).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      now += 1_500;
      cache.get(URL_OK);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it('evicts the least recently used sprite', async () => {
    const fetch = fakeFetch(() => new Response(PNG));
    const loaded: string[] = [];
    const cache = new SpriteCache({ fetch, maxEntries: 2, onLoad: (url) => loaded.push(url) });
    const urls = [1, 2, 3].map((n) => URL_OK.replace('280', String(n)));
    for (const url of urls) {
      cache.get(url);
      await vi.waitFor(() => expect(loaded).toContain(url));
    }
    expect(cache.get(urls[2] ?? '')).not.toBeNull();
    expect(cache.get(urls[1] ?? '')).not.toBeNull();
    expect(cache.get(urls[0] ?? '')).toBeNull(); // evicted: fetched again
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
