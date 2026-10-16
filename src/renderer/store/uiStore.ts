/**
 * Renderer-local UI state: the phase dialog and the toast queue. Unlike
 * `useAppStore`, nothing here is mirrored from the main process.
 */
import { create } from 'zustand';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  /** Runs when the button is pressed; the toast is dismissed afterwards. */
  onClick: () => void;
}

export interface ToastOptions {
  /** Stable id: showing a toast whose id is already on screen replaces it instead of stacking. */
  id?: string;
  /** Secondary line under the title. */
  description?: string;
  /** Optional action button, e.g. Undo. */
  action?: ToastAction;
  /** Milliseconds before auto-dismiss; `0` keeps the toast until dismissed. Defaults per tone. */
  duration?: number;
}

export interface ToastItem {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss; `0` = sticky. */
  duration: number;
  /** Changes when a toast is replaced through its id, so the region restarts its timer. */
  revision: number;
}

export interface PhaseDialogState {
  open: boolean;
  /** Hunt the phase belongs to; null while closed. */
  huntId: string | null;
  /** Set to edit / identify an already logged phase; absent to log a new one. */
  phaseId?: string;
}

export interface UiState {
  phaseDialog: PhaseDialogState;
  /** Oldest first. */
  toasts: ToastItem[];
  openPhaseDialog: (target: { huntId: string; phaseId?: string }) => void;
  closePhaseDialog: () => void;
  /** Adds (or replaces, by id) a toast and returns its id. Prefer the `toast` helpers. */
  pushToast: (tone: ToastTone, title: string, options?: ToastOptions) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

/** Toasts kept on screen at once; older ones are dropped first. */
export const MAX_TOASTS = 4;

const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 3200,
  info: 4200,
  warning: 6000,
  error: 7000,
};
/** Extra reading / reaction time when a toast carries an action button. */
const ACTION_BONUS_MS = 3000;

const CLOSED_PHASE_DIALOG: PhaseDialogState = { open: false, huntId: null };

let toastSequence = 0;

export const useUiStore = create<UiState>()((set) => ({
  phaseDialog: CLOSED_PHASE_DIALOG,
  toasts: [],

  openPhaseDialog: ({ huntId, phaseId }) =>
    set({
      phaseDialog: phaseId === undefined ? { open: true, huntId } : { open: true, huntId, phaseId },
    }),

  closePhaseDialog: () => set({ phaseDialog: CLOSED_PHASE_DIALOG }),

  pushToast: (tone, title, options = {}) => {
    toastSequence += 1;
    const id = options.id ?? `toast-${toastSequence}`;
    const duration =
      options.duration ?? DEFAULT_DURATION[tone] + (options.action ? ACTION_BONUS_MS : 0);
    const item: ToastItem = {
      id,
      tone,
      title,
      duration: Math.max(0, duration),
      revision: toastSequence,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.action === undefined ? {} : { action: options.action }),
    };
    set((state) => {
      const existing = state.toasts.findIndex((entry) => entry.id === id);
      if (existing !== -1) {
        // Replace in place so a repeating message does not jump around the stack.
        return { toasts: state.toasts.map((entry, index) => (index === existing ? item : entry)) };
      }
      return { toasts: [...state.toasts, item].slice(-MAX_TOASTS) };
    });
    return id;
  },

  dismissToast: (id) =>
    set((state) => {
      const toasts = state.toasts.filter((entry) => entry.id !== id);
      return toasts.length === state.toasts.length ? state : { toasts };
    }),

  clearToasts: () => set({ toasts: [] }),
}));

/**
 * Imperative toast API, usable from anywhere (components, actions, effects):
 *
 *   toast.success('Phase logged', { action: { label: 'Undo', onClick: undo } });
 *
 * Every `show` method returns the toast id.
 */
export const toast = {
  success: (title: string, options?: ToastOptions): string =>
    useUiStore.getState().pushToast('success', title, options),
  error: (title: string, options?: ToastOptions): string =>
    useUiStore.getState().pushToast('error', title, options),
  info: (title: string, options?: ToastOptions): string =>
    useUiStore.getState().pushToast('info', title, options),
  warning: (title: string, options?: ToastOptions): string =>
    useUiStore.getState().pushToast('warning', title, options),
  dismiss: (id: string): void => useUiStore.getState().dismissToast(id),
  clear: (): void => useUiStore.getState().clearToasts(),
} as const;

/** Restores the initial UI state (tests). */
export function resetUiStore(): void {
  useUiStore.setState({ phaseDialog: CLOSED_PHASE_DIALOG, toasts: [] });
}
