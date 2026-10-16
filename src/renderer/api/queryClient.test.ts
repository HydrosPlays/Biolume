import { dehydrate, QueryClient } from '@tanstack/react-query';
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  type AsyncStorage,
  type PersistedClient,
} from '@tanstack/react-query-persist-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DATA_VERSION,
  MAX_PERSISTED_QUERIES,
  POKEAPI_CACHE_TTL_MS,
  POKEAPI_QUERY_ROOT,
  capPersistedClient,
  clearPokeApiCache,
  createCacheStorage,
  createPersistOptions,
  createPokeApiPersister,
  createPokeApiQueryClient,
  getPersistOptions,
} from './queryClient';

const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'pokeapi-query-cache';

function memoryStorage(): AsyncStorage<string> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => Promise.resolve(data.get(key) ?? null),
    setItem: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

/** A persisted client holding one PokeAPI query per timestamp. */
function persistedClientWith(updatedAt: number[]): PersistedClient {
  const client = new QueryClient();
  updatedAt.forEach((time, index) => {
    client.setQueryData(
      [POKEAPI_QUERY_ROOT, 'pokemon', index + 1],
      { id: index + 1 },
      {
        updatedAt: time,
      },
    );
  });
  const clientState = dehydrate(client);
  client.clear();
  return { timestamp: Date.now(), buster: `v${DATA_VERSION}`, clientState };
}

const queryIds = (client: PersistedClient): unknown[] =>
  client.clientState.queries.map((query) => query.queryKey[2]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createPokeApiQueryClient', () => {
  it('treats PokeAPI data as long-lived and leaves retrying to the fetch layer', () => {
    const client = createPokeApiQueryClient();
    expect(client.getDefaultOptions().queries).toMatchObject({
      staleTime: POKEAPI_CACHE_TTL_MS,
      gcTime: POKEAPI_CACHE_TTL_MS,
      retry: false,
      refetchOnWindowFocus: false,
      networkMode: 'offlineFirst',
    });
  });

  it('keeps the TTL about a month, yet within what a 32-bit timer can hold', () => {
    expect(POKEAPI_CACHE_TTL_MS).toBeGreaterThanOrEqual(21 * DAY_MS);
    expect(POKEAPI_CACHE_TTL_MS).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('creates independent clients', () => {
    expect(createPokeApiQueryClient()).not.toBe(createPokeApiQueryClient());
  });
});

describe('cache storage', () => {
  it('is unavailable where IndexedDB does not exist (jsdom)', () => {
    expect(typeof indexedDB).toBe('undefined');
    expect(createCacheStorage()).toBeUndefined();
  });

  it('swallows IndexedDB failures and reports them once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('access denied');
      },
    });
    const storage = createCacheStorage();
    expect(storage).toBeDefined();
    await expect(storage?.getItem('k')).resolves.toBeNull();
    await expect(storage?.setItem('k', 'v')).resolves.toBeUndefined();
    await expect(storage?.removeItem('k')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('memory only');
  });
});

describe('createPokeApiPersister', () => {
  it('is a harmless no-op without storage (memory-only fallback)', async () => {
    const persister = createPokeApiPersister();
    await expect(Promise.resolve(persister.restoreClient())).resolves.toBeUndefined();
    await expect(
      Promise.resolve(persister.persistClient(persistedClientWith([1]))),
    ).resolves.toBeUndefined();
    await expect(Promise.resolve(persister.removeClient())).resolves.toBeUndefined();

    const explicit = createPokeApiPersister({ storage: undefined });
    await expect(Promise.resolve(explicit.restoreClient())).resolves.toBeUndefined();
  });

  it('saves, restores and removes through the storage', async () => {
    const storage = memoryStorage();
    const persister = createPokeApiPersister({ storage });
    const client = persistedClientWith([10, 20]);

    await persister.persistClient(client);
    expect([...storage.data.keys()]).toEqual([STORAGE_KEY]);
    expect(await persister.restoreClient()).toEqual(JSON.parse(JSON.stringify(client)));

    await persister.removeClient();
    expect(storage.data.size).toBe(0);
    expect(await persister.restoreClient()).toBeUndefined();
  });

  it('writes at most MAX_PERSISTED_QUERIES, dropping the oldest', async () => {
    const storage = memoryStorage();
    const persister = createPokeApiPersister({ storage });
    const times = Array.from({ length: MAX_PERSISTED_QUERIES + 7 }, (_, index) => index + 1);
    await persister.persistClient(persistedClientWith(times));

    const restored = await persister.restoreClient();
    expect(restored?.clientState.queries).toHaveLength(MAX_PERSISTED_QUERIES);
    const ids = restored ? queryIds(restored) : [];
    expect(ids).toContain(MAX_PERSISTED_QUERIES + 7); // newest kept
    expect(ids).not.toContain(7); // the seven oldest dropped
    expect(ids).toContain(8);
  });

  it('restores but never writes in read-only mode (overlay window)', async () => {
    const storage = memoryStorage();
    await createPokeApiPersister({ storage }).persistClient(persistedClientWith([1]));
    const saved = storage.data.get(STORAGE_KEY);

    const readOnly = createPokeApiPersister({ storage, readOnly: true });
    expect(queryIds((await readOnly.restoreClient()) as PersistedClient)).toEqual([1]);
    await readOnly.persistClient(persistedClientWith([1, 2, 3]));
    await readOnly.removeClient();
    expect(storage.data.get(STORAGE_KEY)).toBe(saved);
  });
});

describe('capPersistedClient', () => {
  it('returns the client untouched while under the cap', () => {
    const client = persistedClientWith([1, 2, 3]);
    expect(capPersistedClient(client, 3)).toBe(client);
    expect(capPersistedClient(client)).toBe(client);
  });

  it('keeps the most recently updated queries', () => {
    const client = persistedClientWith([50, 10, 40, 20, 30]);
    const capped = capPersistedClient(client, 3);
    expect(queryIds(capped)).toEqual([1, 3, 5]); // updated at 50, 40, 30
    expect(capped.buster).toBe(client.buster);
    expect(capped.timestamp).toBe(client.timestamp);
    expect(client.clientState.queries).toHaveLength(5); // input not mutated
    expect(capPersistedClient(client, 0).clientState.queries).toEqual([]);
  });
});

describe('createPersistOptions', () => {
  const options = createPersistOptions(createPokeApiPersister({ storage: undefined }));

  it('busts the cache with DATA_VERSION and expires it with the TTL', () => {
    expect(options.buster).toBe(`v${DATA_VERSION}`);
    expect(options.maxAge).toBe(POKEAPI_CACHE_TTL_MS);
  });

  it('persists only settled, fresh PokeAPI queries', async () => {
    const shouldDehydrate = options.dehydrateOptions?.shouldDehydrateQuery;
    if (!shouldDehydrate) throw new Error('shouldDehydrateQuery missing');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const find = (queryKey: unknown[]) => {
      const query = client.getQueryCache().find({ queryKey });
      if (!query) throw new Error(`query ${JSON.stringify(queryKey)} missing`);
      return query;
    };

    client.setQueryData([POKEAPI_QUERY_ROOT, 'pokemon', 1], { id: 1 });
    client.setQueryData(['settings'], { theme: 'abyss' });
    client.setQueryData(
      [POKEAPI_QUERY_ROOT, 'pokemon', 2],
      { id: 2 },
      {
        updatedAt: Date.now() - POKEAPI_CACHE_TTL_MS - 1_000,
      },
    );
    await client
      .fetchQuery({
        queryKey: [POKEAPI_QUERY_ROOT, 'pokemon', 3],
        queryFn: () => Promise.reject(new Error('offline')),
      })
      .catch(() => undefined);

    expect(shouldDehydrate(find([POKEAPI_QUERY_ROOT, 'pokemon', 1]))).toBe(true);
    expect(shouldDehydrate(find(['settings']))).toBe(false);
    expect(shouldDehydrate(find([POKEAPI_QUERY_ROOT, 'pokemon', 2]))).toBe(false);
    expect(shouldDehydrate(find([POKEAPI_QUERY_ROOT, 'pokemon', 3]))).toBe(false);
    client.clear();
  });

  it('round-trips a client through save and restore', async () => {
    const storage = memoryStorage();
    const persistOptions = createPersistOptions(createPokeApiPersister({ storage }));
    const source = createPokeApiQueryClient();
    source.setQueryData([POKEAPI_QUERY_ROOT, 'pokemon', 25], { id: 25, name: 'Pikachu' });
    source.setQueryData(['unrelated'], 'not persisted');
    await persistQueryClientSave({ queryClient: source, ...persistOptions });

    const restored = createPokeApiQueryClient();
    await persistQueryClientRestore({ queryClient: restored, ...persistOptions });
    expect(restored.getQueryData([POKEAPI_QUERY_ROOT, 'pokemon', 25])).toEqual({
      id: 25,
      name: 'Pikachu',
    });
    expect(restored.getQueryData(['unrelated'])).toBeUndefined();
    source.clear();
    restored.clear();
  });

  it('discards a cache written by another DATA_VERSION', async () => {
    const storage = memoryStorage();
    const persistOptions = createPersistOptions(createPokeApiPersister({ storage }));
    const source = createPokeApiQueryClient();
    source.setQueryData([POKEAPI_QUERY_ROOT, 'pokemon', 25], { id: 25 });
    await persistQueryClientSave({ queryClient: source, ...persistOptions, buster: 'v0' });
    expect(storage.data.size).toBe(1);

    const restored = createPokeApiQueryClient();
    await persistQueryClientRestore({ queryClient: restored, ...persistOptions });
    expect(restored.getQueryData([POKEAPI_QUERY_ROOT, 'pokemon', 25])).toBeUndefined();
    expect(storage.data.size).toBe(0); // stale layout removed from disk
    source.clear();
    restored.clear();
  });

  it('discards a cache older than the TTL', async () => {
    const storage = memoryStorage();
    const persistOptions = createPersistOptions(createPokeApiPersister({ storage }));
    const old = persistedClientWith([Date.now()]);
    storage.data.set(
      STORAGE_KEY,
      JSON.stringify({ ...old, timestamp: Date.now() - POKEAPI_CACHE_TTL_MS - DAY_MS }),
    );

    const restored = createPokeApiQueryClient();
    await persistQueryClientRestore({ queryClient: restored, ...persistOptions });
    expect(restored.getQueryCache().getAll()).toEqual([]);
    expect(storage.data.size).toBe(0);
    restored.clear();
  });
});

describe('getPersistOptions', () => {
  it('builds the default options once', () => {
    expect(getPersistOptions()).toBe(getPersistOptions());
    expect(getPersistOptions().buster).toBe(`v${DATA_VERSION}`);
  });
});

describe('clearPokeApiCache', () => {
  it('drops cached PokeAPI data and leaves other queries alone', async () => {
    const client = createPokeApiQueryClient();
    client.setQueryData([POKEAPI_QUERY_ROOT, 'pokemon', 1], { id: 1 });
    client.setQueryData([POKEAPI_QUERY_ROOT, 'species', 1], { id: 1 });
    client.setQueryData(['other'], 'keep');

    await clearPokeApiCache(client);
    expect(client.getQueryData([POKEAPI_QUERY_ROOT, 'pokemon', 1])).toBeUndefined();
    expect(client.getQueryData([POKEAPI_QUERY_ROOT, 'species', 1])).toBeUndefined();
    expect(client.getQueryData(['other'])).toBe('keep');
    client.clear();
  });
});
