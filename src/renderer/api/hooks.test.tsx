import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { persistQueryClientSave, type AsyncStorage } from '@tanstack/react-query-persist-client';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import speciesFixture from './__fixtures__/pokemon-species-vulpix.json';
import vulpixFixture from './__fixtures__/pokemon-vulpix-alola.json';
import {
  pokeApiKeys,
  pokemonQueryOptions,
  prefetchPokemon,
  prefetchSpeciesDetail,
  prefetchTarget,
  resolvePokemonKey,
  speciesQueryOptions,
  usePokemon,
  usePrefetchTarget,
  useSpeciesDetail,
} from './hooks';
import { isPokeApiError, trimPokemon, type PokemonDetail } from './pokeapi';
import { PokeApiProvider } from './provider';
import {
  POKEAPI_CACHE_TTL_MS,
  createPersistOptions,
  createPokeApiPersister,
  createPokeApiQueryClient,
  queryClient as appQueryClient,
} from './queryClient';

const API = 'https://pokeapi.co/api/v2';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Routes PokeAPI urls to the recorded fixtures; everything else is a 404. */
const fetchMock = vi.fn<typeof fetch>((input) => {
  const url = String(input);
  if (url === `${API}/pokemon/10103`) return Promise.resolve(json(vulpixFixture));
  if (url === `${API}/pokemon-species/37`) return Promise.resolve(json(speciesFixture));
  return Promise.resolve(json({ status: 404, message: 'Not Found' }, 404));
});

const requestedUrls = (): string[] => fetchMock.mock.calls.map((call) => String(call[0]));

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PokeApiProvider
      client={client}
      persistOptions={createPersistOptions(createPokeApiPersister({ storage: undefined }))}
    >
      {children}
    </PokeApiProvider>
  );
}

beforeEach(() => {
  client = createPokeApiQueryClient();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolvePokemonKey', () => {
  it('maps every spelling of a known variety to its numeric id', () => {
    expect(resolvePokemonKey(10103)).toBe(10103);
    expect(resolvePokemonKey('10103')).toBe(10103);
    expect(resolvePokemonKey('vulpix-alola')).toBe(10103);
    expect(resolvePokemonKey('  Vulpix-Alola ')).toBe(10103);
    expect(resolvePokemonKey('deoxys')).toBe(386);
    expect(resolvePokemonKey('deoxys-normal')).toBe(386);
  });

  it('passes unknown slugs through lower-cased', () => {
    expect(resolvePokemonKey('Venusaur-Mega')).toBe('venusaur-mega');
  });
});

describe('query keys and options', () => {
  it('namespaces keys under the PokeAPI root', () => {
    expect(pokeApiKeys.all).toEqual(['pokeapi']);
    expect(pokeApiKeys.pokemon('vulpix-alola')).toEqual(['pokeapi', 'pokemon', 10103]);
    expect(pokeApiKeys.species(37)).toEqual(['pokeapi', 'species', 37]);
  });

  it('builds reusable query options', async () => {
    expect(pokemonQueryOptions('vulpix-alola').queryKey).toEqual(['pokeapi', 'pokemon', 10103]);
    expect(speciesQueryOptions(37).queryKey).toEqual(['pokeapi', 'species', 37]);
    const detail = await client.fetchQuery(pokemonQueryOptions(10103));
    expect(detail.name).toBe('Alolan Vulpix');
  });
});

describe('usePokemon', () => {
  it('loads and trims a Pokémon', async () => {
    const { result } = renderHook(() => usePokemon(10103), { wrapper });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.name).toBe('Alolan Vulpix');
    expect(result.current.data?.moves['sword-shield']?.levelUp[0]).toEqual({
      slug: 'powder-snow',
      level: 1,
    });
    expect(requestedUrls()).toEqual([`${API}/pokemon/10103`]);
  });

  it('requests by id and shares one cache entry between a slug and its id', async () => {
    const bySlug = renderHook(() => usePokemon('vulpix-alola'), { wrapper });
    await waitFor(() => expect(bySlug.result.current.isSuccess).toBe(true));
    const byId = renderHook(() => usePokemon(10103), { wrapper });
    await waitFor(() => expect(byId.result.current.isSuccess).toBe(true));
    expect(byId.result.current.data).toBe(bySlug.result.current.data);
    expect(requestedUrls()).toEqual([`${API}/pokemon/10103`]);
  });

  it('stays idle without an id', async () => {
    for (const nothing of [null, '', '   ', 0, -1]) {
      const { result, unmount } = renderHook(() => usePokemon(nothing), { wrapper });
      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(result.current.isPending).toBe(true);
      expect(result.current.data).toBeUndefined();
      unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('switches targets when the id changes', async () => {
    const { result, rerender } = renderHook(({ id }: { id: number | null }) => usePokemon(id), {
      wrapper,
      initialProps: { id: null as number | null },
    });
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ id: 10103 });
    await waitFor(() => expect(result.current.data?.id).toBe(10103));
  });

  it('surfaces a typed not-found error without retrying', async () => {
    const { result } = renderHook(() => usePokemon(99999), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const { error } = result.current;
    expect(isPokeApiError(error) && error.kind).toBe('not-found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('settles as offline instead of hanging when there is no connection', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const { result } = renderHook(() => usePokemon(10103), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const { error } = result.current;
    expect(isPokeApiError(error) && error.kind).toBe('offline');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves cached data without a request', async () => {
    const cached = { id: 10103, name: 'Alolan Vulpix' } as PokemonDetail;
    client.setQueryData(pokeApiKeys.pokemon(10103), cached);
    const { result } = renderHook(() => usePokemon('vulpix-alola'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useSpeciesDetail', () => {
  it('loads and trims a species', async () => {
    const { result } = renderHook(() => useSpeciesDetail(37), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ id: 37, captureRate: 190, genus: 'Fox Pokémon' });
    expect(requestedUrls()).toEqual([`${API}/pokemon-species/37`]);
  });

  it('stays idle without an id', async () => {
    const { result } = renderHook(() => useSpeciesDetail(null), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('prefetch helpers', () => {
  it('warm the cache so the hook renders without another request', async () => {
    await prefetchPokemon('vulpix-alola', client);
    expect(client.getQueryData<PokemonDetail>(pokeApiKeys.pokemon(10103))?.id).toBe(10103);
    const { result } = renderHook(() => usePokemon(10103), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prefetch both queries of a target', async () => {
    await prefetchTarget({ pokemonId: 10103, speciesId: 37 }, client);
    expect(requestedUrls().sort()).toEqual([`${API}/pokemon-species/37`, `${API}/pokemon/10103`]);
    expect(client.getQueryData(pokeApiKeys.species(37))).toBeDefined();

    fetchMock.mockClear();
    await prefetchTarget({ pokemonId: 10103 }, client);
    await prefetchSpeciesDetail(37, client);
    expect(fetchMock).not.toHaveBeenCalled(); // already cached
  });

  it('never reject, even when the request fails or the id is unusable', async () => {
    await expect(prefetchPokemon(99999, client)).resolves.toBeUndefined();
    await expect(prefetchSpeciesDetail(99999, client)).resolves.toBeUndefined();
    await expect(prefetchPokemon('', client)).resolves.toBeUndefined();
    await expect(prefetchSpeciesDetail(0, client)).resolves.toBeUndefined();
    await expect(
      prefetchTarget({ pokemonId: 99999, speciesId: 99999 }, client),
    ).resolves.toBeUndefined();
  });

  it('usePrefetchTarget returns a stable callback bound to the provider client', async () => {
    const { result, rerender } = renderHook(() => usePrefetchTarget(), { wrapper });
    const prefetch = result.current;
    rerender();
    expect(result.current).toBe(prefetch);

    prefetch({ pokemonId: 10103, speciesId: 37 });
    await waitFor(() => {
      expect(client.getQueryData(pokeApiKeys.pokemon(10103))).toBeDefined();
      expect(client.getQueryData(pokeApiKeys.species(37))).toBeDefined();
    });
  });
});

describe('PokeApiProvider', () => {
  it('defaults to the app-wide query client and renders its children', async () => {
    function Probe() {
      return <span>{useQueryClient() === appQueryClient ? 'app client' : 'other client'}</span>;
    }
    render(
      <PokeApiProvider>
        <Probe />
      </PokeApiProvider>,
    );
    expect(await screen.findByText('app client')).toBeDefined();
  });

  it('restores the persisted cache before a hook can fetch, keeping the long lifetime', async () => {
    const stored = new Map<string, string>();
    const storage: AsyncStorage<string> = {
      getItem: (key) => Promise.resolve(stored.get(key) ?? null),
      setItem: (key, value) => {
        stored.set(key, value);
        return Promise.resolve();
      },
      removeItem: (key) => {
        stored.delete(key);
        return Promise.resolve();
      },
    };
    const persistOptions = createPersistOptions(createPokeApiPersister({ storage }));

    // An earlier launch cached Alolan Vulpix.
    const earlier = createPokeApiQueryClient();
    earlier.setQueryData(pokeApiKeys.pokemon(10103), trimPokemon(vulpixFixture));
    await persistQueryClientSave({ queryClient: earlier, ...persistOptions });
    earlier.clear();
    expect(stored.size).toBe(1);

    const { result } = renderHook(() => usePokemon('vulpix-alola'), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PokeApiProvider client={client} persistOptions={persistOptions}>
          {children}
        </PokeApiProvider>
      ),
    });
    // Queries wait for the restore instead of racing it with a request.
    expect(result.current.fetchStatus).toBe('idle');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.name).toBe('Alolan Vulpix');
    expect(result.current.data?.moves['sword-shield']?.levelUp).toHaveLength(12);
    expect(fetchMock).not.toHaveBeenCalled();

    // A restored entry must not fall back to TanStack's five-minute garbage collection.
    const query = client.getQueryCache().find({ queryKey: pokeApiKeys.pokemon(10103) });
    expect(query?.gcTime).toBe(POKEAPI_CACHE_TTL_MS);
    expect(query?.isStale()).toBe(false);
  });
});
