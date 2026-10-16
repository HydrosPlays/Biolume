import OverlayView from '@renderer/components/OverlayView';
import { useLocalHotkeys } from '@renderer/hooks/useLocalHotkeys';
import { useMotionPreference } from '@renderer/hooks/useReducedMotion';
import { useAppStore } from '@renderer/store/appStore';
import { ViewErrorBoundary } from './ViewErrorBoundary';

/** Hotkeys for the case where the overlay itself holds focus (main then reports `app-focused`). */
function OverlayServices() {
  useLocalHotkeys();
  return null;
}

/**
 * Root of the mini-overlay window: the store mirror and `OverlayView`, nothing
 * else — no shell, no ambient background, no audio (the main window plays
 * sounds, so they never double up). The document stays transparent.
 */
export function OverlayRoot() {
  const ready = useAppStore((state) => state.ready);
  useMotionPreference();

  if (!ready) return null;
  return (
    <ViewErrorBoundary name="Mini-overlay" silent>
      <OverlayServices />
      <div data-view-ready="overlay">
        <OverlayView />
      </div>
    </ViewErrorBoundary>
  );
}
