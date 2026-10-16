import { useEffect, type ReactNode } from 'react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { create } from 'zustand';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmOptions {
  /** The question, e.g. "Delete this hunt?". */
  title: string;
  /** Consequences in a sentence or two. */
  message?: ReactNode;
  /** Label of the confirming button. Default "Confirm" ("Delete" reads better for deletions). */
  confirmLabel?: string;
  /** Label of the dismissing button. Default "Cancel". */
  cancelLabel?: string;
  /** `danger` styles the dialog as destructive and puts initial focus on Cancel. Default `default`. */
  tone?: 'default' | 'danger';
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  queue: ConfirmRequest[];
}

const useConfirmStore = create<ConfirmState>()(() => ({ queue: [] }));

let sequence = 0;
let mountedHosts = 0;

function settle(id: number, confirmed: boolean): void {
  const request = useConfirmStore.getState().queue.find((entry) => entry.id === id);
  if (!request) return;
  useConfirmStore.setState((state) => ({ queue: state.queue.filter((entry) => entry.id !== id) }));
  request.resolve(confirmed);
}

/**
 * Asks the user to confirm, in a themed dialog. Resolves true when confirmed
 * and false when cancelled or dismissed (Escape, scrim, ×).
 *
 *   if (await confirm({ title: 'Reset the counter?', tone: 'danger', confirmLabel: 'Reset' })) { … }
 *
 * Needs a mounted {@link ConfirmHost} (the app shell and `renderWithProviders`
 * both mount one). Requests queue up and are shown one at a time. For
 * destructive operations prefer `actions.confirmDestructive`, which honours
 * the "ask before deleting" setting.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (mountedHosts === 0) {
    // No host (e.g. the overlay window): fall back to the native prompt rather than hanging forever.
    console.warn('[biolume] confirm() called without a mounted <ConfirmHost />');
    const native = typeof window.confirm === 'function' ? window.confirm(options.title) : false;
    return Promise.resolve(native === true);
  }
  return new Promise<boolean>((resolve) => {
    sequence += 1;
    const request: ConfirmRequest = { ...options, id: sequence, resolve };
    useConfirmStore.setState((state) => ({ queue: [...state.queue, request] }));
  });
}

/** Renders the dialogs requested through {@link confirm}. Mount exactly once per window. */
export function ConfirmHost() {
  const request = useConfirmStore((state) => state.queue[0]);

  useEffect(() => {
    mountedHosts += 1;
    return () => {
      mountedHosts -= 1;
      if (mountedHosts > 0) return;
      // Nobody is left to answer: treat every pending request as cancelled.
      const { queue } = useConfirmStore.getState();
      useConfirmStore.setState({ queue: [] });
      for (const pending of queue) pending.resolve(false);
    };
  }, []);

  if (!request) return null;
  const danger = request.tone === 'danger';
  const cancel = (): void => settle(request.id, false);

  return (
    <Modal
      key={request.id}
      open
      role="alertdialog"
      size="sm"
      tone={danger ? 'danger' : 'default'}
      icon={danger ? <TriangleAlert /> : <CircleAlert />}
      title={request.title}
      description={request.message}
      hideCloseButton
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel} {...(danger ? { 'data-autofocus': '' } : {})}>
            {request.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => settle(request.id, true)}
            {...(danger ? {} : { 'data-autofocus': '' })}
          >
            {request.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    />
  );
}
