import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@renderer/store/uiStore';
import { makeHunt, makeSettings, makeTarget, renderWithProviders } from '@renderer/test';
import { AppShell } from './AppShell';
import { ViewErrorBoundary } from './ViewErrorBoundary';
import { VIEWS } from './views';

/*
 * The shell is tested against stub views: the real ones are owned by other
 * modules, need PokeAPI data, and are free to change their headings.
 */
const { stubView } = vi.hoisted(() => ({
  stubView: (title: string) => async () => {
    const { createElement } = await import('react');
    return { default: () => createElement('h1', null, title) };
  },
}));
vi.mock('@renderer/components/Counter', stubView('Hunt'));
vi.mock('@renderer/components/TargetSearch', stubView('Target'));
vi.mock('@renderer/components/OddsEngine', stubView('Odds'));
vi.mock('@renderer/components/SandwichHelper', stubView('Sandwiches'));
vi.mock('@renderer/components/LogView', stubView('Log'));
vi.mock('@renderer/components/SettingsView', stubView('Settings'));
vi.mock('@renderer/components/PhaseDialog', async () => {
  const { createElement } = await import('react');
  const { useUiStore: store } = await import('@renderer/store/uiStore');
  return {
    default: function PhaseDialogStub() {
      const dialog = store((state) => state.phaseDialog);
      if (!dialog.open) return null;
      return createElement('div', {
        role: 'dialog',
        'aria-label': dialog.phaseId === undefined ? 'Log a phase' : 'Identify phase',
      });
    },
  };
});

function Boom(): never {
  throw new Error('view exploded');
}

describe('AppShell', () => {
  it('renders the title bar, the six views in the sidebar and the hunt view by default', async () => {
    await renderWithProviders(<AppShell />, { hosts: false });

    expect(screen.getByText('Biolume')).not.toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Views' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent?.replace(/Ctrl.*$/, ''))).toEqual([
      'Hunt',
      'Target',
      'Odds',
      'Sandwiches',
      'Log',
      'Settings',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      VIEWS.map((view) => `#/${view.id}`),
    );
    expect(links[0]?.getAttribute('aria-current')).toBe('page');

    expect(await screen.findByRole('heading', { level: 1, name: 'Hunt' })).not.toBeNull();
    expect(window.location.hash).toBe('#/hunt');
  });

  it('switches views when location.hash changes and marks the active link', async () => {
    await renderWithProviders(<AppShell />, { hosts: false, view: 'odds' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Odds' })).not.toBeNull();

    act(() => {
      window.location.hash = '#/settings';
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).not.toBeNull();
    expect(screen.getByRole('link', { name: /Settings/ }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: /Odds/ }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('main').getAttribute('data-view')).toBe('settings');

    act(() => {
      window.location.hash = '#/unknown-view';
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Hunt' })).not.toBeNull();
  });

  it('navigates with Ctrl+digit', async () => {
    await renderWithProviders(<AppShell />, { hosts: false });
    await screen.findByRole('heading', { level: 1, name: 'Hunt' });

    fireEvent.keyDown(window, { code: 'Digit4', key: '4', ctrlKey: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sandwiches' })).not.toBeNull();
  });

  it('shows the active hunt with its live count in the title bar', async () => {
    const hunt = makeHunt({ name: 'Shiny Ralts', count: 1234, target: makeTarget() });
    const { mock, user } = await renderWithProviders(<AppShell />, {
      hosts: false,
      view: 'log',
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    const chip = screen.getByRole('button', { name: 'Active hunt: Shiny Ralts, 1,234 encounters' });
    expect(chip.textContent).toContain('1,234');

    await act(async () => {
      await mock.api.hunts.adjustCount(hunt.id, 1, 'hotkey-global');
    });
    expect(
      screen.getByRole('button', { name: /Active hunt: Shiny Ralts, 1,235 encounters/ }),
    ).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /Active hunt/ }));
    expect(window.location.hash).toBe('#/hunt');
  });

  it('wires the window controls to the bridge', async () => {
    const { mock, user } = await renderWithProviders(<AppShell />, { hosts: false });

    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(mock.api.window.minimize).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Maximize' }));
    expect(mock.api.window.toggleMaximize).toHaveBeenCalledTimes(1);
    // The fake main process reports the new state; the button follows it.
    expect(screen.getByRole('button', { name: 'Restore' })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(mock.api.window.close).toHaveBeenCalledTimes(1);
  });

  it('toggles the mini-overlay and the pin, reflecting the state main reports', async () => {
    const { mock, user } = await renderWithProviders(<AppShell />, { hosts: false });

    const overlay = screen.getByRole('button', { name: 'Open mini-overlay' });
    expect(overlay.getAttribute('aria-pressed')).toBe('false');
    await user.click(overlay);
    expect(mock.api.window.setOverlayOpen).toHaveBeenCalledWith(true);
    expect(
      screen.getByRole('button', { name: 'Close mini-overlay' }).getAttribute('aria-pressed'),
    ).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Keep window on top' }));
    expect(mock.api.window.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Unpin window' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('explains every hotkey mode in the status pill', async () => {
    const { mock } = await renderWithProviders(<AppShell />, { hosts: false });

    expect(
      screen.getByRole('button', {
        name: /Hotkeys: Global hotkeys paused while Biolume is focused/,
      }),
    ).not.toBeNull();

    mock.setHotkeyStatus({ mode: 'active', registrations: [] });
    expect(screen.getByRole('button', { name: /Hotkeys: Global hotkeys are live/ })).not.toBeNull();

    mock.setHotkeyStatus({
      mode: 'active',
      registrations: [
        { action: 'increment', accelerator: 'Space', registered: false, error: 'in use' },
      ],
    });
    expect(
      screen.getByRole('button', { name: /Hotkeys: 1 global hotkey unavailable/ }),
    ).not.toBeNull();

    mock.setHotkeyStatus({ mode: 'disabled', registrations: [] });
    expect(screen.getByRole('button', { name: /Hotkeys: Global hotkeys are off/ })).not.toBeNull();

    mock.setHotkeyStatus({ mode: 'capturing', registrations: [] });
    expect(screen.getByRole('button', { name: /Hotkeys: Recording a key binding/ })).not.toBeNull();
  });

  it('counts with the in-app hotkey and opens the phase dialog host', async () => {
    const hunt = makeHunt();
    const { mock } = await renderWithProviders(<AppShell />, {
      hosts: false,
      biolume: {
        hunts: [hunt],
        activeHuntId: hunt.id,
        settings: makeSettings({ hotkeys: { bindings: { logPhase: ['F8'] } } }),
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Hunt' });

    fireEvent.keyDown(document.body, { code: 'NumpadAdd', key: '+' });
    await vi.waitFor(() =>
      expect(mock.api.hunts.adjustCount).toHaveBeenCalledWith(hunt.id, 1, 'hotkey-local'),
    );

    fireEvent.keyDown(document.body, { code: 'F8', key: 'F8' });
    expect(await screen.findByRole('dialog', { name: 'Log a phase' })).not.toBeNull();
    expect(useUiStore.getState().phaseDialog).toEqual({ open: true, huntId: hunt.id });
  });

  it('offers to identify a phase that was quick-logged by a global hotkey', async () => {
    const hunt = makeHunt();
    const { mock, user } = await renderWithProviders(<AppShell />, {
      hosts: false,
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    mock.fireHotkeyAction({
      action: 'logPhase',
      accelerator: 'F8',
      huntId: hunt.id,
      phaseId: 'phase-7',
    });
    await user.click(await screen.findByRole('button', { name: 'Identify' }));

    expect(useUiStore.getState().phaseDialog).toEqual({
      open: true,
      huntId: hunt.id,
      phaseId: 'phase-7',
    });
    expect(await screen.findByRole('dialog', { name: 'Identify phase' })).not.toBeNull();
  });

  it('shows a boot screen until the store is ready, and a retry when loading failed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { mock, user } = await renderWithProviders(<AppShell />, {
      hosts: false,
      initStore: false,
    });

    expect(screen.getByRole('status', { name: 'Loading Biolume' })).not.toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();

    mock.api.state.get.mockRejectedValueOnce(new Error('state.json is corrupt'));
    const { initStore } = await import('@renderer/store/appStore');
    await act(async () => {
      await initStore().catch(() => undefined);
    });
    expect(screen.getByRole('alert').textContent).toContain('state.json is corrupt');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('navigation', { name: 'Views' })).not.toBeNull();
    consoleError.mockRestore();
  });
});

describe('ViewErrorBoundary', () => {
  it('contains a crash, shows a themed fallback and can retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = true;
    function Flaky() {
      if (broken) return <Boom />;
      return <p>Recovered</p>;
    }
    const { user } = await renderWithProviders(
      <>
        <p>Shell still here</p>
        <ViewErrorBoundary name="Odds">
          <Flaky />
        </ViewErrorBoundary>
      </>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Odds ran into a problem');
    expect(alert.textContent).toContain('view exploded');
    expect(screen.getByText('Shell still here')).not.toBeNull();

    broken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered')).not.toBeNull();
    consoleError.mockRestore();
  });

  it('renders nothing in silent mode', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = await renderWithProviders(
      <ViewErrorBoundary name="Phase dialog" silent>
        <Boom />
      </ViewErrorBoundary>,
      { hosts: false },
    );
    expect(container.textContent).toBe('');
    consoleError.mockRestore();
  });
});
