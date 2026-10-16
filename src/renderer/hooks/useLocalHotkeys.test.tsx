import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Hunt } from '@shared/types';
import { initStore, useAppStore } from '@renderer/store/appStore';
import { useUiStore } from '@renderer/store/uiStore';
import {
  installMockBiolume,
  makeHunt,
  makeSettings,
  type MockBiolume,
  type MockBiolumeOptions,
} from '@renderer/test';
import { captureKeyboard } from './useKeyboardCapture';
import { isEditableTarget, useLocalHotkeys } from './useLocalHotkeys';

const NUM_PLUS = { code: 'NumpadAdd', key: '+' };
const NUM_MINUS = { code: 'NumpadSubtract', key: '-' };

/** Lets the async action behind a hotkey run to completion. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function setup(options: MockBiolumeOptions = {}): Promise<{ mock: MockBiolume; hunt: Hunt }> {
  const hunt = makeHunt({ step: 2 });
  const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id, ...options });
  await initStore();
  renderHook(() => useLocalHotkeys());
  return { mock, hunt };
}

describe('useLocalHotkeys', () => {
  it('counts by the hunt step with source hotkey-local', async () => {
    const { mock, hunt } = await setup();

    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();
    expect(mock.api.hunts.adjustCount).toHaveBeenCalledWith(hunt.id, 2, 'hotkey-local');
    expect(useAppStore.getState().hunts[0]?.count).toBe(2);

    fireEvent.keyDown(document.body, NUM_MINUS);
    await settle();
    expect(mock.api.hunts.adjustCount).toHaveBeenLastCalledWith(hunt.id, -2, 'hotkey-local');
    expect(useAppStore.getState().hunts[0]?.count).toBe(0);
  });

  it('consumes the key so a focused button is not activated as well', async () => {
    await setup({ settings: makeSettings({ hotkeys: { bindings: { increment: ['Space'] } } }) });
    render(<button type="button">Elsewhere</button>);
    const button = screen.getByRole('button', { name: 'Elsewhere' });
    button.focus();

    const down = fireEvent.keyDown(button, { code: 'Space', key: ' ' });
    const up = fireEvent.keyUp(button, { code: 'Space', key: ' ' });

    // fireEvent returns false when preventDefault() was called.
    expect(down).toBe(false);
    expect(up).toBe(false);
  });

  it('ignores auto-repeat', async () => {
    const { mock } = await setup();

    fireEvent.keyDown(document.body, NUM_PLUS);
    fireEvent.keyDown(document.body, { ...NUM_PLUS, repeat: true });
    fireEvent.keyDown(document.body, { ...NUM_PLUS, repeat: true });
    await settle();

    expect(mock.api.hunts.adjustCount).toHaveBeenCalledTimes(1);
  });

  it('ignores keys typed into editable targets', async () => {
    const { mock } = await setup({
      settings: makeSettings({ hotkeys: { bindings: { increment: ['Space', 'numadd'] } } }),
    });
    render(
      <>
        <input aria-label="Name" />
        <textarea aria-label="Notes" />
        <select aria-label="Game">
          <option>SV</option>
        </select>
        <div contentEditable suppressContentEditableWarning aria-label="Rich">
          <span data-testid="inner">text</span>
        </div>
        <div data-hotkeys="off">
          <button type="button">Recorder</button>
        </div>
      </>,
    );

    const targets = [
      screen.getByLabelText('Name'),
      screen.getByLabelText('Notes'),
      screen.getByLabelText('Game'),
      screen.getByTestId('inner'),
      screen.getByRole('button', { name: 'Recorder' }),
    ];
    for (const target of targets) {
      const notPrevented = fireEvent.keyDown(target, { code: 'Space', key: ' ' });
      expect(notPrevented).toBe(true);
      fireEvent.keyDown(target, NUM_PLUS);
    }
    await settle();

    expect(mock.api.hunts.adjustCount).not.toHaveBeenCalled();
  });

  it('stands down while a widget holds the keyboard or main is capturing', async () => {
    const { mock } = await setup();

    const release = captureKeyboard();
    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();
    expect(mock.api.hunts.adjustCount).not.toHaveBeenCalled();
    release();

    mock.setHotkeyStatus({ mode: 'capturing', registrations: [] });
    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();
    expect(mock.api.hunts.adjustCount).not.toHaveBeenCalled();

    mock.setHotkeyStatus({ mode: 'app-focused', registrations: [] });
    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();
    expect(mock.api.hunts.adjustCount).toHaveBeenCalledTimes(1);
  });

  it('requires the exact modifiers of the binding', async () => {
    const { mock } = await setup();

    fireEvent.keyDown(document.body, { ...NUM_PLUS, ctrlKey: true });
    fireEvent.keyDown(document.body, { code: 'KeyB', key: 'b', ctrlKey: true });
    await settle();
    expect(mock.api.hunts.adjustCount).not.toHaveBeenCalled();
    expect(mock.api.window.setOverlayOpen).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { code: 'KeyB', key: 'B', ctrlKey: true, shiftKey: true });
    await settle();
    expect(mock.api.window.setOverlayOpen).toHaveBeenCalledWith(true);
  });

  it('runs undo and opens the phase dialog', async () => {
    const { mock, hunt } = await setup({
      settings: makeSettings({
        hotkeys: { bindings: { undo: ['CommandOrControl+Z'], logPhase: ['F8'] } },
      }),
    });

    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();
    fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', ctrlKey: true });
    await settle();
    expect(mock.api.hunts.undo).toHaveBeenCalledWith(hunt.id);
    expect(useAppStore.getState().hunts[0]?.count).toBe(0);

    fireEvent.keyDown(document.body, { code: 'F8', key: 'F8' });
    await settle();
    expect(useUiStore.getState().phaseDialog).toEqual({ open: true, huntId: hunt.id });
    expect(mock.api.hunts.logPhase).not.toHaveBeenCalled();
  });

  it('quick-logs a phase from the overlay window, which has no dialog', async () => {
    const { mock, hunt } = await setup({
      windowKind: 'overlay',
      settings: makeSettings({ hotkeys: { bindings: { logPhase: ['F8'] } } }),
    });

    fireEvent.keyDown(document.body, { code: 'F8', key: 'F8' });
    await settle();

    expect(mock.api.hunts.logPhase).toHaveBeenCalledWith(hunt.id, {
      speciesId: null,
      speciesName: '',
      source: 'hotkey-local',
    });
    expect(useUiStore.getState().phaseDialog.open).toBe(false);
  });

  it('asks for Shiny Found with confirmation — never completes on one press', async () => {
    const F16 = { code: 'F16', key: 'F16' };
    const { mock, hunt } = await setup({
      settings: makeSettings({ hotkeys: { bindings: { shinyFound: ['F16'] } } }),
    });

    fireEvent.keyDown(document.body, F16);
    await settle();
    expect(mock.api.hunts.requestShinyFound).toHaveBeenCalledWith(hunt.id, 'hotkey-local');
    expect(mock.api.hunts.complete).not.toHaveBeenCalled();
    expect(useAppStore.getState().hunts[0]?.status).toBe('active');
    expect(useAppStore.getState().shinyArmed[hunt.id]).toMatchObject({ source: 'hotkey-local' });

    // Holding the key auto-repeats: that must not confirm.
    fireEvent.keyDown(document.body, { ...F16, repeat: true });
    await settle();
    expect(mock.api.hunts.requestShinyFound).toHaveBeenCalledTimes(1);

    // A real second press does.
    fireEvent.keyDown(document.body, F16);
    await settle();
    expect(mock.api.hunts.requestShinyFound).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().hunts[0]?.status).toBe('completed');
    expect(useAppStore.getState().shinyArmed).toEqual({});
    expect(mock.api.hunts.complete).not.toHaveBeenCalled();
  });

  it('does not ask again for a hunt that is already complete', async () => {
    const hunt = makeHunt({ status: 'completed' });
    const mock = installMockBiolume({
      hunts: [hunt],
      activeHuntId: hunt.id,
      settings: makeSettings({ hotkeys: { bindings: { shinyFound: ['F16'] } } }),
    });
    await initStore();
    renderHook(() => useLocalHotkeys());

    fireEvent.keyDown(document.body, { code: 'F16', key: 'F16' });
    await settle();
    expect(mock.api.hunts.requestShinyFound).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts[0]).toMatchObject({
      tone: 'info',
      title: 'Shiny already found',
    });
  });

  it('answers F13–F24, the keys Stream Deck’s Hotkey action sends', async () => {
    const { mock, hunt } = await setup({
      settings: makeSettings({
        hotkeys: { bindings: { increment: ['F13'], decrement: ['F24'] } },
      }),
    });

    fireEvent.keyDown(document.body, { code: 'F13', key: 'F13' });
    await settle();
    expect(mock.api.hunts.adjustCount).toHaveBeenLastCalledWith(hunt.id, 2, 'hotkey-local');
    fireEvent.keyDown(document.body, { code: 'F24', key: 'F24' });
    await settle();
    expect(mock.api.hunts.adjustCount).toHaveBeenLastCalledWith(hunt.id, -2, 'hotkey-local');
  });

  it('explains itself when there is no active hunt', async () => {
    const mock = installMockBiolume();
    await initStore();
    renderHook(() => useLocalHotkeys());

    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();

    expect(mock.api.hunts.adjustCount).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts[0]).toMatchObject({
      tone: 'info',
      title: 'No active hunt',
    });
  });

  it('detaches when disabled or unmounted', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    const { rerender, unmount } = renderHook(({ enabled }) => useLocalHotkeys({ enabled }), {
      initialProps: { enabled: false },
    });

    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();
    expect(mock.api.hunts.adjustCount).not.toHaveBeenCalled();

    rerender({ enabled: true });
    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();
    expect(mock.api.hunts.adjustCount).toHaveBeenCalledTimes(1);

    unmount();
    fireEvent.keyDown(document.body, NUM_PLUS);
    await settle();
    expect(mock.api.hunts.adjustCount).toHaveBeenCalledTimes(1);
  });
});

describe('isEditableTarget', () => {
  it('recognises text entry elements and opt-out containers', () => {
    render(
      <>
        <input data-testid="input" />
        <input type="checkbox" data-testid="checkbox" />
        <textarea data-testid="textarea" />
        <select data-testid="select" />
        <div role="textbox" data-testid="aria-textbox" />
        <div role="spinbutton" data-testid="spinbutton" />
        <div contentEditable="false" data-testid="not-editable" />
        <button type="button" data-testid="button" />
        <button
          type="button"
          role="combobox"
          aria-expanded="false"
          aria-controls="x"
          data-testid="select-trigger"
        />
      </>,
    );

    for (const id of ['input', 'checkbox', 'textarea', 'select', 'aria-textbox', 'spinbutton']) {
      expect(isEditableTarget(screen.getByTestId(id)), id).toBe(true);
    }
    // A closed Select trigger is a button: bindings keep working while it merely has focus.
    for (const id of ['not-editable', 'button', 'select-trigger']) {
      expect(isEditableTarget(screen.getByTestId(id)), id).toBe(false);
    }
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });
});
