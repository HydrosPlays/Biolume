import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  type ComponentType,
  type LazyExoticComponent,
} from 'react';
import { CircleX, RotateCcw } from 'lucide-react';
import type { ViewId } from '@shared/ipc';
import { Button, ConfirmHost, EmptyState, Skeleton, ToastRegion } from '@renderer/components/ui';
import { useCounterFeedback } from '@renderer/hooks/useCounterFeedback';
import { useGlobalHotkeyEvents } from '@renderer/hooks/useGlobalHotkeyEvents';
import { isKeyboardCaptured } from '@renderer/hooks/useKeyboardCapture';
import { useLocalHotkeys } from '@renderer/hooks/useLocalHotkeys';
import { useMotionPreference } from '@renderer/hooks/useReducedMotion';
import { useView } from '@renderer/hooks/useView';
import { useViewShortcuts } from '@renderer/hooks/useViewShortcuts';
import { initStore, useAppStore, useWindowState } from '@renderer/store/appStore';
import { AmbientBackground } from './AmbientBackground';
import { Logo } from './Logo';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { ViewErrorBoundary } from './ViewErrorBoundary';
import { getViewMeta } from './views';
import styles from './AppShell.module.css';

/** Each view is its own chunk: the counter is interactive before the odds charts have parsed. */
const VIEW_COMPONENTS: Record<ViewId, LazyExoticComponent<ComponentType>> = {
  hunt: lazy(() => import('@renderer/components/Counter')),
  target: lazy(() => import('@renderer/components/TargetSearch')),
  odds: lazy(() => import('@renderer/components/OddsEngine')),
  sandwich: lazy(() => import('@renderer/components/SandwichHelper')),
  log: lazy(() => import('@renderer/components/LogView')),
  settings: lazy(() => import('@renderer/components/SettingsView')),
};

const PhaseDialog = lazy(() => import('@renderer/components/PhaseDialog'));

function ViewFallback() {
  return (
    <div className={styles.viewLoading} aria-busy="true" aria-label="Loading view">
      <Skeleton width={220} height={30} />
      <Skeleton width={340} height={14} />
      <Skeleton shape="block" height={180} />
      <Skeleton shape="block" height={120} />
    </div>
  );
}

/** Shown until the first snapshot arrives from the main process — and when it cannot be loaded. */
function BootScreen({ error }: { error: string | null }) {
  if (error !== null) {
    return (
      <div className={styles.boot} role="alert">
        <EmptyState
          tone="danger"
          icon={<CircleX />}
          title="Biolume could not load your data"
          description={error}
          action={
            <Button
              variant="primary"
              leadingIcon={<RotateCcw />}
              onClick={() => void initStore().catch(() => undefined)}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className={styles.boot} role="status" aria-label="Loading Biolume">
      <Logo size={44} />
    </div>
  );
}

function ViewOutlet({ view }: { view: ViewId }) {
  const mainRef = useRef<HTMLElement | null>(null);
  const firstRender = useRef(true);
  const View = VIEW_COMPONENTS[view];
  const meta = getViewMeta(view);

  // Send keyboard and screen-reader focus to the new view — but never away from an open dialog.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!isKeyboardCaptured()) mainRef.current?.focus({ preventScroll: true });
  }, [view]);

  return (
    <main
      ref={mainRef}
      id="view"
      className={styles.main}
      tabIndex={-1}
      aria-label={meta.label}
      data-view={view}
    >
      <ViewErrorBoundary key={view} name={meta.label}>
        <Suspense fallback={<ViewFallback />}>
          {/* `data-view-ready` appears once the lazy chunk has rendered; main.tsx waits for it. */}
          <div className={styles.view} data-view-ready={view}>
            <View />
          </div>
        </Suspense>
      </ViewErrorBoundary>
    </main>
  );
}

/** Hooks that must only run once the store mirrors the main process. */
function ShellServices() {
  useLocalHotkeys();
  useCounterFeedback();
  useGlobalHotkeyEvents();
  useViewShortcuts();
  return null;
}

/**
 * The main window: title bar, sidebar, the current view, and the hosts for
 * everything global — toasts, confirmations, the phase dialog, in-app hotkeys
 * and audio feedback.
 */
export function AppShell() {
  const [view] = useView();
  const ready = useAppStore((state) => state.ready);
  const loadError = useAppStore((state) => state.loadError);
  const windowState = useWindowState();
  useMotionPreference();

  return (
    <div
      className={styles.shell}
      data-maximized={windowState.maximized}
      data-focused={windowState.focused}
    >
      <AmbientBackground />
      <TitleBar />
      {ready ? (
        <>
          <ShellServices />
          <Sidebar view={view} />
          <ViewOutlet view={view} />
          <ViewErrorBoundary name="Phase dialog" silent>
            <Suspense fallback={null}>
              <PhaseDialog />
            </Suspense>
          </ViewErrorBoundary>
        </>
      ) : (
        <BootScreen error={loadError} />
      )}
      <ConfirmHost />
      <ToastRegion />
    </div>
  );
}
