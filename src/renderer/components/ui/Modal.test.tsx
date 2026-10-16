import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { isKeyboardCaptured } from '@renderer/hooks/useKeyboardCapture';
import '@renderer/test';
import { Button } from './Button';
import { confirm, ConfirmHost } from './confirm';
import { Modal, type ModalProps } from './Modal';
import { Select } from './Select';
import { TextField } from './TextField';

function Harness(props: Partial<ModalProps> & { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <button type="button">Outside</button>
      <Modal
        open={open}
        title="Log a phase"
        description="A shiny that is not your target."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary">Save</Button>
          </>
        }
        {...props}
        onClose={() => {
          props.onClose?.();
          setOpen(false);
        }}
      >
        {props.children ?? <TextField aria-label="Species" />}
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('renders nothing while closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a labelled, described modal dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    const dialog = screen.getByRole('dialog', { name: 'Log a phase' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('dialog', { description: 'A shiny that is not your target.' })).toBe(
      dialog,
    );
  });

  it('moves focus into the body on open and restores it on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open dialog' });

    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Species' }));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    const close = screen.getByRole('button', { name: 'Close dialog' });
    const species = screen.getByRole('textbox', { name: 'Species' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const save = screen.getByRole('button', { name: 'Save' });

    expect(document.activeElement).toBe(species);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(save);
    // Wraps from the last focusable to the first.
    await user.tab();
    expect(document.activeElement).toBe(close);
    // …and backwards from the first to the last.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(save);
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Outside' }));
  });

  it('pulls focus back in when it has escaped the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }));
  });

  it('honours data-autofocus and initialFocusRef', async () => {
    const user = userEvent.setup();
    render(
      <Harness>
        <TextField aria-label="First" />
        <TextField aria-label="Second" data-autofocus="" />
      </Harness>,
    );
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Second' }));
  });

  it('closes on scrim click and on the close button, but not on clicks inside', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await user.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    const layer = screen.getByRole('dialog').parentElement as HTMLElement;
    await user.click(layer);
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('can refuse to close on scrim click or Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} closeOnScrim={false} closeOnEscape={false} />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    await user.click(screen.getByRole('dialog').parentElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('holds the keyboard while open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(isKeyboardCaptured()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(isKeyboardCaptured()).toBe(true);
    await user.keyboard('{Escape}');
    expect(isKeyboardCaptured()).toBe(false);
  });

  it('lets an open Select inside it consume Escape first', async () => {
    const user = userEvent.setup();
    render(
      <Harness>
        <Select
          aria-label="Species"
          value="a"
          onChange={() => undefined}
          options={[
            { value: 'a', label: 'Abra' },
            { value: 'b', label: 'Bulbasaur' },
          ]}
        />
      </Harness>,
    );
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    await user.keyboard('{ArrowDown}');
    const listbox = screen.getByRole('listbox');
    // The popup is portalled into the modal's own layer, above the dialog.
    expect(screen.getByRole('dialog').parentElement?.contains(listbox)).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog')).not.toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('submits as a form when onSubmit is given', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    await user.keyboard('Zigzagoon{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('only lets the topmost of stacked modals react to Escape', async () => {
    const user = userEvent.setup();
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Modal open title="Outer" onClose={closeOuter}>
          <TextField aria-label="Outer field" />
        </Modal>
        <Modal open title="Inner" onClose={closeInner}>
          <TextField aria-label="Inner field" />
        </Modal>
      </>,
    );

    await user.keyboard('{Escape}');
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });
});

describe('confirm', () => {
  it('resolves true when confirmed and false when cancelled', async () => {
    const user = userEvent.setup();
    render(<ConfirmHost />);

    let result: Promise<boolean> = Promise.resolve(false);
    act(() => {
      result = confirm({
        title: 'Delete this hunt?',
        message: 'Its phases go with it.',
        confirmLabel: 'Delete',
        tone: 'danger',
      });
    });
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this hunt?' });
    expect(screen.getByRole('alertdialog', { description: 'Its phases go with it.' })).toBe(dialog);
    // Destructive confirmations start on the safe choice.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(result).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    act(() => {
      result = confirm({ title: 'Reset settings?' });
    });
    await screen.findByRole('alertdialog', { name: 'Reset settings?' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
    await user.keyboard('{Escape}');
    await expect(result).resolves.toBe(false);
  });

  it('queues requests and shows them one at a time', async () => {
    const user = userEvent.setup();
    render(<ConfirmHost />);

    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = confirm({ title: 'First?' });
      second = confirm({ title: 'Second?' });
    });

    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(first).resolves.toBe(true);

    await screen.findByRole('alertdialog', { name: 'Second?' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(second).resolves.toBe(false);
  });

  it('cancels pending requests when the host goes away', async () => {
    const { unmount } = render(<ConfirmHost />);
    let result: Promise<boolean> = Promise.resolve(true);
    act(() => {
      result = confirm({ title: 'Still there?' });
    });
    unmount();
    await expect(result).resolves.toBe(false);
  });
});
