import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { initStore } from './store/appStore';
import './styles/base.css';

const { windowKind } = window.biolume;

/** Everything that went wrong so far — reported to the smoke test with the ready signal. */
const errors: string[] = [];

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  return typeof reason === 'string' ? reason : String(reason);
}

window.addEventListener('error', (event) => {
  errors.push(event.message || describe(event.error));
});
window.addEventListener('unhandledrejection', (event) => {
  errors.push(`Unhandled rejection: ${describe(event.reason)}`);
});

const container = document.getElementById('root');
if (!container) throw new Error('Biolume: #root element missing from index.html');

// Read by base.css: the overlay document must stay transparent.
document.documentElement.dataset.window = windowKind;

/** The overlay never downloads the shell, and the main window never downloads the overlay. */
async function loadRoot(): Promise<ReactNode> {
  if (windowKind === 'overlay') {
    const { OverlayRoot } = await import('./components/layout/OverlayRoot');
    return <OverlayRoot />;
  }
  const { default: App } = await import('./App');
  return <App />;
}

const VIEW_READY_TIMEOUT_MS = 4000;

/**
 * Resolves once a frame has been painted — after the first real view has
 * rendered when `awaitView` is set (its chunk is loaded lazily).
 */
function firstPaint(awaitView: boolean): Promise<void> {
  return new Promise((resolve) => {
    const deadline = awaitView ? performance.now() + VIEW_READY_TIMEOUT_MS : 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const poll = (): void => {
      if (document.querySelector('[data-view-ready]') || performance.now() > deadline) {
        requestAnimationFrame(() => requestAnimationFrame(finish));
        // Hidden windows are not guaranteed to produce frames.
        window.setTimeout(finish, 250);
        return;
      }
      window.setTimeout(poll, 30);
    };
    poll();
  });
}

async function start(root: HTMLElement): Promise<void> {
  const reactRoot = createRoot(root);
  // Ask main for the snapshot while the UI chunk is still loading.
  const storeLoaded = initStore().then(
    () => true,
    (error: unknown) => {
      // The UI shows its own error screen from `store.loadError`; record it for the smoke test.
      errors.push(`Store failed to load: ${describe(error)}`);
      return false;
    },
  );
  reactRoot.render(<StrictMode>{await loadRoot()}</StrictMode>);
  await firstPaint(await storeLoaded);
  window.biolume.smokeReady({ windowKind, errors: [...errors] });
}

void start(container).catch((error: unknown) => {
  errors.push(`Renderer failed to start: ${describe(error)}`);
  window.biolume.smokeReady({ windowKind, errors: [...errors] });
});
