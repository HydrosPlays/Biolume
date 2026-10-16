import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { ViewId } from '@shared/ipc';
import { ConfirmHost } from '@renderer/components/ui/confirm';
import { ToastRegion } from '@renderer/components/ui/Toast';
import { viewHref } from '@renderer/hooks/useView';
import { initStore } from '@renderer/store/appStore';
import { installMockBiolume, type MockBiolume, type MockBiolumeOptions } from './mockBiolume';
import './setup';

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /**
   * Seed for the fake main process (`{ hunts, activeHuntId, settings, … }`), or
   * a controller already created with `installMockBiolume`. Default: empty state.
   */
  biolume?: MockBiolumeOptions | MockBiolume;
  /** Load the store from the fake bridge before rendering. Default true; false leaves it un-booted. */
  initStore?: boolean;
  /** Open on this view (sets `location.hash`) for components that read `useView()`. */
  view?: ViewId;
  /** Mount the toast region and confirm host. Default true; pass false when rendering the AppShell, which has its own. */
  hosts?: boolean;
  /** Query client for PokeAPI hooks. Default: a fresh one with retries off. */
  queryClient?: QueryClient;
}

export interface RenderWithProvidersResult extends RenderResult {
  /** Controller of the fake `window.biolume` (state, emit, spies). */
  mock: MockBiolume;
  /** A `userEvent` session bound to this render. */
  user: UserEvent;
  queryClient: QueryClient;
}

function isController(value: MockBiolumeOptions | MockBiolume | undefined): value is MockBiolume {
  return value !== undefined && 'api' in value && 'emit' in value;
}

/** A query client suited to tests: no retries, no refetch surprises, nothing shared between tests. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

/**
 * Renders a component the way the app hosts it: against a fake main process
 * with the store already following it, inside a React Query provider, with
 * the toast region and confirm host mounted.
 *
 *   const { user, mock } = await renderWithProviders(<Counter />, {
 *     biolume: { hunts: [hunt], activeHuntId: hunt.id },
 *   });
 *   await user.click(screen.getByRole('button', { name: /count/i }));
 *   expect(mock.api.hunts.adjustCount).toHaveBeenCalledWith(hunt.id, 1, 'ui');
 *
 * Asynchronous because the store boots through the (fake) IPC bridge first.
 */
export async function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): Promise<RenderWithProvidersResult> {
  const {
    biolume,
    initStore: boot = true,
    view,
    hosts = true,
    queryClient,
    ...renderOptions
  } = options;

  const mock = isController(biolume) ? biolume : installMockBiolume(biolume);
  if (view !== undefined) window.location.hash = viewHref(view);
  if (boot) await initStore();

  const client = queryClient ?? createTestQueryClient();
  const user = userEvent.setup();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        {children}
        {hosts ? (
          <>
            <ConfirmHost />
            <ToastRegion />
          </>
        ) : null}
      </QueryClientProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...renderOptions }), mock, user, queryClient: client };
}
