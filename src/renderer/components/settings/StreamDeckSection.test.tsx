import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createInitialStreamDeckStatus } from '@renderer/store';
import { makeSettings, renderWithProviders } from '@renderer/test';
import { StreamDeckSection, summarizeBridge } from './StreamDeckSection';

const status = (): string => screen.getByTestId('stream-deck-status').textContent ?? '';

describe('summarizeBridge', () => {
  const base = createInitialStreamDeckStatus();

  it('describes every state of the bridge', () => {
    expect(summarizeBridge(base, false)).toMatchObject({ badge: 'Off', tone: 'neutral' });
    expect(summarizeBridge({ ...base, enabled: true }, true)).toMatchObject({
      badge: 'Starting',
    });
    expect(
      summarizeBridge({ ...base, enabled: true, listening: true, port: 47_637 }, true),
    ).toMatchObject({
      badge: 'Listening',
      text: 'Listening on 127.0.0.1:47637 · waiting for the Stream Deck plugin.',
    });
    expect(
      summarizeBridge({ ...base, enabled: true, listening: true, port: 47_637, clients: 2 }, true),
    ).toMatchObject({
      badge: 'Connected',
      tone: 'ok',
      text: expect.stringContaining('2 Stream Deck connections'),
    });
    expect(
      summarizeBridge({ ...base, enabled: true, error: 'Port 47637 is in use' }, true),
    ).toMatchObject({
      badge: 'Error',
      tone: 'danger',
      text: 'Not listening: Port 47637 is in use',
    });
  });
});

describe('StreamDeckSection', () => {
  it('shows the live bridge status and switches the bridge', async () => {
    const { user, mock } = await renderWithProviders(<StreamDeckSection />, {
      biolume: { streamDeckStatus: { port: 47_640 } },
    });

    expect(status()).toContain('Listening on 127.0.0.1:47640');
    expect(status()).toContain('waiting for the Stream Deck plugin');

    mock.setStreamDeckStatus({ clients: 1 });
    expect(status()).toContain('1 Stream Deck connection');

    await user.click(screen.getByRole('switch', { name: 'Stream Deck bridge' }));
    expect(mock.api.settings.update).toHaveBeenCalledWith({ streamDeck: { enabled: false } });
    await waitFor(() => expect(status()).toContain('The bridge is off'));
  });

  it('shows why the bridge is not listening', async () => {
    await renderWithProviders(<StreamDeckSection />, {
      biolume: {
        streamDeckStatus: { listening: false, port: null, error: 'Could not bind 127.0.0.1' },
      },
    });
    expect(status()).toBe('Not listening: Could not bind 127.0.0.1');
  });

  it('installs the bundled plugin', async () => {
    const { user, mock } = await renderWithProviders(<StreamDeckSection />);

    await user.click(screen.getByRole('button', { name: 'Install Stream Deck plugin' }));
    expect(mock.api.streamDeck.installPlugin).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Stream Deck plugin installer opened')).toBeTruthy();
  });

  it('explains why the installer is unavailable when the build does not bundle it', async () => {
    await renderWithProviders(<StreamDeckSection />, {
      biolume: { streamDeckStatus: { pluginBundled: false } },
    });
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Install Stream Deck plugin',
    });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).not.toBeNull();
    expect(screen.getByText(/does not include the plugin installer/)).toBeTruthy();
  });

  it('lists the plugin keys and explains the two-press Shiny Found', async () => {
    await renderWithProviders(<StreamDeckSection />);
    for (const key of [
      'Counter',
      'Increment',
      'Decrement',
      'Log Phase',
      'Shiny Found',
      'Undo',
      'Toggle Overlay',
    ]) {
      expect(screen.getByText(key)).toBeTruthy();
    }
    expect(screen.getByText('Shiny Found takes two presses.')).toBeTruthy();
  });

  it('binds F13–F16 next to the existing shortcuts in one click', async () => {
    const { user, mock } = await renderWithProviders(<StreamDeckSection />);

    await user.click(screen.getByRole('button', { name: 'Bind F13–F16' }));
    expect(mock.api.settings.update).toHaveBeenCalledWith({
      hotkeys: {
        bindings: {
          increment: ['numadd', 'F13'],
          decrement: ['numsub', 'F14'],
          logPhase: ['F15'],
          shinyFound: ['F16'],
        },
      },
    });
    expect(await screen.findByText('Stream Deck hotkeys bound')).toBeTruthy();
    const preset = screen.getByRole('list', { name: 'Stream Deck hotkey preset' });
    await waitFor(() => expect(within(preset).getAllByText('Bound')).toHaveLength(4));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'F13–F16 are bound' }).disabled,
    ).toBe(true);
  });

  it('leaves a key another action owns alone and says so', async () => {
    const { user, mock } = await renderWithProviders(<StreamDeckSection />, {
      biolume: { settings: makeSettings({ hotkeys: { bindings: { undo: ['F15'] } } }) },
    });

    expect(screen.getByText(/F15 already belongs to “Undo last action”/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Bind F13–F16' }));
    const patch = mock.api.settings.update.mock.calls[0]?.[0];
    expect(patch?.hotkeys?.bindings).toEqual({
      increment: ['numadd', 'F13'],
      decrement: ['numsub', 'F14'],
      shinyFound: ['F16'],
    });
    expect(await screen.findByText('Some Stream Deck hotkeys were not bound')).toBeTruthy();
    expect(mock.getState().settings.hotkeys.bindings.undo).toEqual(['F15']);
  });

  it('warns that the keys only work in-app while global hotkeys are off', async () => {
    await renderWithProviders(<StreamDeckSection />, {
      biolume: { settings: makeSettings({ hotkeys: { globalEnabled: false } }) },
    });
    expect(screen.getByText(/these keys only work while Biolume has focus/)).toBeTruthy();
  });
});
