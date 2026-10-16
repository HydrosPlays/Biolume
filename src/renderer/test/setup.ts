/**
 * Shared test environment for renderer tests. Imported for its side effects by
 * `@renderer/test` (so any test using the helpers gets it), and safe to list
 * under `setupFiles` as well.
 *
 * Vitest runs with `globals: false`, which disables Testing Library's own
 * auto-cleanup and act-environment setup — both are wired up here, together
 * with a reset of every piece of module-level state the platform keeps.
 */
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';
import { resetKeyboardCapture } from '@renderer/hooks/useKeyboardCapture';
import { disposeAudio } from '@renderer/lib/audio';
import { resetStore } from '@renderer/store/appStore';
import { resetUiStore } from '@renderer/store/uiStore';
import { resetFactorySequence } from './factories';
import { uninstallMockBiolume } from './mockBiolume';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom has no canvas backend; without this stub every getContext() call logs a "not implemented" error.
  if (typeof HTMLCanvasElement !== 'undefined') {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  }
});

afterEach(() => {
  cleanup();
  resetStore();
  resetUiStore();
  resetKeyboardCapture();
  disposeAudio();
  uninstallMockBiolume();
  resetFactorySequence();
  if (typeof window !== 'undefined' && window.location.hash !== '') {
    window.history.replaceState(null, '', window.location.pathname);
  }
});
