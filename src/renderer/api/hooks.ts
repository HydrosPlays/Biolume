/**
 * React bindings for the PokeAPI client. Components must render inside
 * `PokeApiProvider`.
 *
 * Errors are `PokeApiError`s — branch on `error.kind` (or show
 * `describePokeApiError(error)`); with no cached data and no connection the
 * hooks settle in `isError` with kind `offline` rather than loading forever.
 */
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import { withLocalLearnsets } from '@renderer/lib/localLearnsets';
import { findBySlug } from '@renderer/lib/species';
import { fetchPokemon, fetchSpecies, type PokemonDetail, type SpeciesDetail } from './pokeapi';
import { POKEAPI_QUERY_ROOT, queryClient } from './queryClient';

/**
 * Canonical cache identity of a Pokémon variety: its numeric `pokemon` id
 * whenever it can be worked out locally, so `usePokemon('vulpix-alola')`,
 * `usePokemon('10103')` and `usePokemon(10103)` share one cache entry (and one
 * request). Ids are also immune to upstream slug renames. Unknown slugs are
 * passed through lower-cased.
 */
export function resolvePokemonKey(idOrSlug: number | string): number | string {
  if (typeof idOrSlug === 'number') return idOrSlug;
  const text = idOrSlug.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  const ref = findBySlug(text);
  return ref ? (ref.form?.pokemonId ?? ref.species.id) : text;
}

export const pokeApiKeys = {
  /** Prefix of every PokeAPI query — for bulk invalidation. */
  all: [POKEAPI_QUERY_ROOT] as const,
  pokemon: (idOrSlug: number | string) =>
    [POKEAPI_QUERY_ROOT, 'pokemon', resolvePokemonKey(idOrSlug)] as const,
  species: (speciesId: number) => [POKEAPI_QUERY_ROOT, 'species', speciesId] as const,
};

/** Query options for one Pokémon variety; usable with `useQuery`, `prefetchQuery`, `ensureQueryData`, … */
export function pokemonQueryOptions(idOrSlug: number | string) {
  const key = resolvePokemonKey(idOrSlug);
  return queryOptions({
    queryKey: pokeApiKeys.pokemon(key),
    queryFn: ({ signal }): Promise<PokemonDetail> => fetchPokemon(key, { signal }),
  });
}

/** Query options for one species (National Dex number). */
export function speciesQueryOptions(speciesId: number) {
  return queryOptions({
    queryKey: pokeApiKeys.species(speciesId),
    queryFn: ({ signal }): Promise<SpeciesDetail> => fetchSpecies(speciesId, { signal }),
  });
}

function isUsableId(value: number | string | null | undefined): value is number | string {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Stats, abilities, sprites and the per-game movepool of one variety
 * (`TargetRef.pokemonId`, or a `pokemon` slug). Pass null to stay idle.
 */
export function usePokemon(idOrSlug: number | string | null): UseQueryResult<PokemonDetail> {
  const enabled = isUsableId(idOrSlug);
  return useQuery({
    ...pokemonQueryOptions(enabled ? idOrSlug : 0),
    enabled,
    // Fills in games PokeAPI has no learnsets for (Legends: Z-A) from bundled data.
    select: withLocalLearnsets,
  });
}

/**
 * Catch rate, gender ratio, egg data, flags and Pokédex text of a species
 * (`TargetRef.speciesId`). Pass null to stay idle.
 */
export function useSpeciesDetail(speciesId: number | null): UseQueryResult<SpeciesDetail> {
  const enabled = typeof speciesId === 'number' && isUsableId(speciesId);
  return useQuery({ ...speciesQueryOptions(enabled ? speciesId : 0), enabled });
}

/** Warms the cache for a variety; resolves when done and never rejects. */
export function prefetchPokemon(
  idOrSlug: number | string,
  client: QueryClient = queryClient,
): Promise<void> {
  if (!isUsableId(idOrSlug)) return Promise.resolve();
  return client.prefetchQuery(pokemonQueryOptions(idOrSlug));
}

/** Warms the cache for a species; resolves when done and never rejects. */
export function prefetchSpeciesDetail(
  speciesId: number,
  client: QueryClient = queryClient,
): Promise<void> {
  if (!isUsableId(speciesId)) return Promise.resolve();
  return client.prefetchQuery(speciesQueryOptions(speciesId));
}

/** Anything that identifies a hunt target — a `TargetRef`, a search result, … */
export interface PrefetchableTarget {
  pokemonId: number;
  speciesId?: number;
}

/** Warms both queries the analyzer needs for a target. Never rejects. */
export async function prefetchTarget(
  target: PrefetchableTarget,
  client: QueryClient = queryClient,
): Promise<void> {
  await Promise.all([
    prefetchPokemon(target.pokemonId, client),
    target.speciesId === undefined
      ? Promise.resolve()
      : prefetchSpeciesDetail(target.speciesId, client),
  ]);
}

/**
 * Returns a stable callback that prefetches a target with the nearest
 * provider's client — attach it to hover / focus of a search result so the
 * analyzer opens without a spinner.
 */
export function usePrefetchTarget(): (target: PrefetchableTarget) => void {
  const client = useQueryClient();
  return useCallback(
    (target: PrefetchableTarget) => {
      void prefetchTarget(target, client);
    },
    [client],
  );
}
