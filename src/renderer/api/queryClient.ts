/**
 * TanStack Query setup for PokeAPI data.
 *
 * PokeAPI data is effectively immutable, so queries stay fresh for weeks and
 * the whole cache is persisted to IndexedDB (through `idb-keyval`), making a
 * previously viewed Pokémon available instantly and offline. Where IndexedDB
 * is unavailable (jsdom, a blocked or corrupted profile) the cache silently
 * degrades to memory-only.
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, type OmitKeyof } from '@tanstack/react-query';
import type {
  AsyncStorage,
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from '@tanstack/react-query-persist-client';
import { createStore, del, get, set } from 'idb-keyval';

/**
 * Version of the trimmed shapes in `pokeapi.ts` (`PokemonDetail`,
 * `SpeciesDetail`). It is the persisted cache's buster: bump it whenever those
 * shapes or the trimming rules change, and every stored entry is discarded on
 * the next launch instead of being read back in the old layout.
 */
export const DATA_VERSION = 1;

/** First element of every PokeAPI query key; only these queries are persisted. */
export const POKEAPI_QUERY_ROOT = 'pokeapi';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long PokeAPI data counts as fresh, stays in memory unused, and survives
 * on disk. "About a month" is the intent; 24 days is the longest delay a
 * 32-bit `setTimeout` can hold, which TanStack Query uses for `gcTime`.
 */
export const POKEAPI_CACHE_TTL_MS = 24 * DAY_MS;

/** Upper bound on persisted queries; the least recently updated are dropped first. */
export const MAX_PERSISTED_QUERIES = 500;

const IDB_DATABASE = 'biolume-pokeapi';
const IDB_STORE = 'query-cache';
const PERSIST_KEY = 'pokeapi-query-cache';
/** Disk writes are coalesced: the whole cache is serialised on every save. */
const PERSIST_THROTTLE_MS = 2_000;

export function createPokeApiQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: POKEAPI_CACHE_TTL_MS,
        gcTime: POKEAPI_CACHE_TTL_MS,
        // The fetch layer already retries with backoff and knows which failures are permanent.
        retry: false,
        refetchOnWindowFocus: false,
        // Failed (and therefore stale) queries are retried as soon as the connection returns.
        refetchOnReconnect: true,
        // Always run the fetcher once: cached data is served offline, and a
        // real failure surfaces as a typed `offline` error instead of a
        // query that stays paused forever.
        networkMode: 'offlineFirst',
      },
    },
  });
}

/** The app-wide client used by `PokeApiProvider` and the prefetch helpers. */
export const queryClient: QueryClient = createPokeApiQueryClient();

let warnedAboutStorage = false;

function reportStorageFailure(error: unknown): void {
  if (warnedAboutStorage) return;
  warnedAboutStorage = true;
  console.warn('[biolume] PokeAPI cache storage is unavailable; caching in memory only.', error);
}

/**
 * IndexedDB-backed storage for the persister, or undefined when IndexedDB
 * does not exist in this environment. Every operation swallows storage errors
 * (quota, a database deleted underneath us, …) — losing the cache must never
 * break the app.
 */
export function createCacheStorage(): AsyncStorage<string> | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  let store: ReturnType<typeof createStore>;
  try {
    store = createStore(IDB_DATABASE, IDB_STORE);
  } catch (error) {
    reportStorageFailure(error);
    return undefined;
  }
  return {
    getItem: async (key) => {
      try {
        return (await get<string>(key, store)) ?? null;
      } catch (error) {
        reportStorageFailure(error);
        return null;
      }
    },
    setItem: async (key, value) => {
      try {
        await set(key, value, store);
      } catch (error) {
        reportStorageFailure(error);
      }
    },
    removeItem: async (key) => {
      try {
        await del(key, store);
      } catch (error) {
        reportStorageFailure(error);
      }
    },
  };
}

/** Keeps the cache bounded: only the {@link MAX_PERSISTED_QUERIES} most recently updated queries are written. */
export function capPersistedClient(
  client: PersistedClient,
  maxQueries = MAX_PERSISTED_QUERIES,
): PersistedClient {
  const { queries } = client.clientState;
  if (queries.length <= maxQueries) return client;
  const newestFirst = [...queries].sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  return {
    ...client,
    clientState: { ...client.clientState, queries: newestFirst.slice(0, Math.max(0, maxQueries)) },
  };
}

export interface PokeApiPersisterOptions {
  /** Defaults to {@link createCacheStorage}; pass `undefined`-returning storage to stay in memory. */
  storage?: AsyncStorage<string> | undefined;
  /**
   * Restore from disk but never write. Used by the overlay window, which
   * shares the main window's IndexedDB and would otherwise overwrite its
   * newer cache with a stale copy.
   */
  readOnly?: boolean;
}

/**
 * The persister behind `PokeApiProvider`. Without usable storage it is a
 * no-op, which leaves the QueryClient working purely in memory.
 */
export function createPokeApiPersister(options: PokeApiPersisterOptions = {}): Persister {
  const storage = 'storage' in options ? options.storage : createCacheStorage();
  const persister = createAsyncStoragePersister({
    storage,
    key: PERSIST_KEY,
    throttleTime: PERSIST_THROTTLE_MS,
    serialize: (client) => JSON.stringify(capPersistedClient(client)),
  });
  if (!options.readOnly) return persister;
  return { ...persister, persistClient: () => undefined, removeClient: () => undefined };
}

export type PokeApiPersistOptions = OmitKeyof<PersistQueryClientOptions, 'queryClient'>;

export function createPersistOptions(persister: Persister): PokeApiPersistOptions {
  return {
    persister,
    maxAge: POKEAPI_CACHE_TTL_MS,
    buster: `v${DATA_VERSION}`,
    dehydrateOptions: {
      // Persist settled PokeAPI data only — never errors, in-flight or unrelated queries.
      shouldDehydrateQuery: (query) =>
        query.state.status === 'success' &&
        query.queryKey[0] === POKEAPI_QUERY_ROOT &&
        Date.now() - query.state.dataUpdatedAt < POKEAPI_CACHE_TTL_MS,
    },
  };
}

function isOverlayWindow(): boolean {
  // `window.biolume` is absent outside Electron (unit tests, Storybook-style previews).
  const bridge = (globalThis as { biolume?: { windowKind?: string } }).biolume;
  return bridge?.windowKind === 'overlay';
}

let defaultPersistOptions: PokeApiPersistOptions | null = null;

/** Persist options for the app-wide client, created on first use (opens IndexedDB). */
export function getPersistOptions(): PokeApiPersistOptions {
  defaultPersistOptions ??= createPersistOptions(
    createPokeApiPersister({ readOnly: isOverlayWindow() }),
  );
  return defaultPersistOptions;
}

/**
 * Drops every cached PokeAPI response, in memory and on disk — for a
 * "clear cached data" action. Queries in use refetch on their own.
 */
export async function clearPokeApiCache(client: QueryClient = queryClient): Promise<void> {
  await client.cancelQueries({ queryKey: [POKEAPI_QUERY_ROOT] });
  client.removeQueries({ queryKey: [POKEAPI_QUERY_ROOT], type: 'inactive' });
  await getPersistOptions().persister.removeClient();
  await client.invalidateQueries({ queryKey: [POKEAPI_QUERY_ROOT] });
}
