import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isKeyboardCaptured } from '@renderer/hooks';
import { makeSettings, renderWithProviders } from '@renderer/test';
import { HotkeysSection } from './HotkeysSection';

function row(action: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-action="${action}"]`);
  if (element === null) throw new Error(`No row for "${action}"`);
  return element;
}

describe('HotkeysSection', () => {
  it('records a shortcut: suspends the hotkeys, saves the combination, hands them back', async () => {
    const { user, mock } = await renderWithProviders(<HotkeysSection />);

    await user.click(within(row('increment')).getByRole('button', { name: /add shortcut/i }));
    expect(mock.api.hotkeys.setCapturing).toHaveBeenLastCalledWith(true);
    expect(isKeyboardCaptured()).toBe(true);
    expect(document.activeElement).toBe(
      within(row('increment')).getByRole('group', { name: /recording/i }),
    );

    await user.keyboard('{F9}');
    expect(mock.api.settings.update).toHaveBeenCalledWith({
      hotkeys: { bindings: { increment: ['numadd', 'F9'] } },
    });
    expect(mock.api.hotkeys.setCapturing).toHaveBeenLastCalledWith(false);
    expect(isKeyboardCaptured()).toBe(false);
    expect(mock.getState().settings.hotkeys.bindings.increment).toEqual(['numadd', 'F9']);
  });

  it('lists Shiny Found with its two-press hint and records F13–F24 for it', async () => {
    const { user, mock } = await renderWithProviders(<HotkeysSection />);

    const shiny = within(row('shinyFound'));
    expect(shiny.getByText('Shiny found (press twice)')).toBeTruthy();
    expect(shiny.getByText(/press it twice within 3 s/)).toBeTruthy();
    expect(shiny.getByText('Not bound')).toBeTruthy();
    // Every action in HOTKEY_ACTIONS has its row.
    expect(document.querySelectorAll('[data-action]')).toHaveLength(6);

    await user.click(shiny.getByRole('button', { name: /add shortcut/i }));
    // What Stream Deck's Hotkey action sends for F16.
    await user.keyboard('{F16}');
    expect(mock.api.settings.update).toHaveBeenCalledWith({
      hotkeys: { bindings: { shinyFound: ['F16'] } },
    });
    await waitFor(() => expect(shiny.getByText('F16')).toBeTruthy());
  });

  it('refuses a combination another action owns and keeps recording until Esc', async () => {
    const { user, mock } = await renderWithProviders(<HotkeysSection />);

    await user.click(within(row('undo')).getByRole('button', { name: /add shortcut/i }));
    // Ctrl+Shift+B toggles the mini-overlay by default.
    await user.keyboard('{Control>}{Shift>}b{/Shift}{/Control}');
    expect(screen.getByRole('alert').textContent).toContain(
      'Ctrl + Shift + B is already bound to “Toggle mini-overlay”',
    );
    expect(mock.api.settings.update).not.toHaveBeenCalled();
    expect(mock.api.hotkeys.setCapturing).toHaveBeenLastCalledWith(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mock.api.settings.update).not.toHaveBeenCalled();
    expect(mock.api.hotkeys.setCapturing).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(
      within(row('undo')).getByRole('button', { name: /add shortcut/i }),
    );
  });

  it('stops recording when focus leaves, and when the section goes away', async () => {
    const { user, mock, unmount } = await renderWithProviders(<HotkeysSection />);

    await user.click(within(row('undo')).getByRole('button', { name: /add shortcut/i }));
    await user.click(screen.getByRole('switch', { name: /global hotkeys/i }));
    expect(screen.queryByRole('group', { name: /recording/i })).toBeNull();
    expect(mock.api.hotkeys.setCapturing).toHaveBeenLastCalledWith(false);

    await user.click(within(row('undo')).getByRole('button', { name: /add shortcut/i }));
    expect(mock.api.hotkeys.setCapturing).toHaveBeenLastCalledWith(true);
    unmount();
    expect(mock.api.hotkeys.setCapturing).toHaveBeenLastCalledWith(false);
    expect(isKeyboardCaptured()).toBe(false);
  });

  it('caps an action at three shortcuts and warns about a bare key', async () => {
    const { mock } = await renderWithProviders(<HotkeysSection />, {
      biolume: {
        settings: makeSettings({
          hotkeys: { bindings: { increment: ['numadd', 'Space', 'F9'] } },
        }),
        hotkeyStatus: {
          mode: 'app-focused',
          registrations: [
            { action: 'increment', accelerator: 'numadd', registered: true },
            { action: 'increment', accelerator: 'Space', registered: true },
            {
              action: 'increment',
              accelerator: 'F9',
              registered: false,
              error: 'In use by another application or reserved by the system',
            },
          ],
        },
      },
    });

    const increment = within(row('increment'));
    expect(
      increment.getByRole<HTMLButtonElement>('button', { name: /maximum of 3 shortcuts/i })
        .disabled,
    ).toBe(true);
    expect(increment.getByText(/captured system-wide and will not reach your game/)).not.toBeNull();
    expect(increment.getByText(/Not registered: In use by another application/)).not.toBeNull();
    expect(screen.getByText(/Paused while Biolume is focused\./)).not.toBeNull();
    expect(mock.api.settings.update).not.toHaveBeenCalled();
  });
});
