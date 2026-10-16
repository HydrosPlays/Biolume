import type { ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { getPersistOptions, queryClient, type PokeApiPersistOptions } from './queryClient';

export interface PokeApiProviderProps {
  children: ReactNode;
  /** Defaults to the app-wide client; tests pass a fresh one. */
  client?: QueryClient;
  /** Defaults to the IndexedDB-backed options (memory-only where IndexedDB is missing). */
  persistOptions?: PokeApiPersistOptions;
}

/**
 * Makes the PokeAPI query cache available to `usePokemon` / `useSpeciesDetail`
 * and restores it from IndexedDB on mount. Queries wait for the restore to
 * finish before fetching (`useIsRestoring()` is true meanwhile), so data that
 * is already on disk is never requested again.
 */
export function PokeApiProvider({ children, client, persistOptions }: PokeApiProviderProps) {
  return (
    <PersistQueryClientProvider
      client={client ?? queryClient}
      persistOptions={persistOptions ?? getPersistOptions()}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
