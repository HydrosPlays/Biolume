import { useRef, type CSSProperties } from 'react';
import { Lock, Maximize2, Minus, Plus, Radar, Sparkles } from 'lucide-react';
import { Sprite } from '@renderer/components/ui';
import { formatAccelerator } from '@renderer/lib/accelerator';
import { formatCount } from '@renderer/lib/format';
import { actions, useActiveHunt, useLastChange, useSettings } from '@renderer/store';
import {
  clampOverlayOpacity,
  clampOverlayScale,
  countSize,
  overlayOddsLine,
  overlayPhaseLine,
  overlaySprites,
  overlayState,
  overlayTitle,
} from './overlay/overlayModel';
import styles from './overlay/OverlayView.module.css';
import { useOverlayAutosize } from './overlay/useOverlayAutosize';

const STATUS_LABEL = { completed: 'Shiny found', archived: 'Archived' } as const;

/**
 * The mini-overlay window's entire UI: a compact floating counter for playing
 * side by side with a game. It is mounted without the app shell, on a
 * transparent document, once the store is ready (see `layout/OverlayRoot.tsx`).
 *
 * The card is the window's drag handle; every button opts out of dragging.
 * `settings.overlay.scale` is applied here as CSS zoom — never as page zoom,
 * which Chromium shares with the main window — and the unscaled content size
 * is reported to the main process, which sizes the window around it.
 */
export default function OverlayView() {
  const hunt = useActiveHunt();
  const settings = useSettings();
  const lastChange = useLastChange();
  const frameRef = useRef<HTMLDivElement>(null);

  const { overlay } = settings;
  const scale = clampOverlayScale(overlay.scale);
  useOverlayAutosize(frameRef, scale);

  const state = overlayState(hunt);
  const cardStyle = {
    '--overlay-alpha': `${Math.round(clampOverlayOpacity(overlay.opacity) * 100)}%`,
  } as CSSProperties;

  const toggleKey = settings.hotkeys.bindings.toggleOverlay[0];
  const lockHint =
    toggleKey === undefined
      ? 'Click-through · turn off in Settings'
      : `Click-through · ${formatAccelerator(toggleKey).join(' + ')} closes`;

  const backButton = (
    <button
      type="button"
      className={styles.button}
      data-variant="ghost"
      aria-label="Back to Biolume"
      onClick={() => void actions.setOverlayOpen(false)}
    >
      <Maximize2 size={13} aria-hidden="true" />
    </button>
  );

  const lockLine = overlay.clickThrough ? (
    <p className={styles.lock}>
      <Lock size={10} aria-hidden="true" />
      <span>{lockHint}</span>
    </p>
  ) : null;

  let body;
  if (hunt === null) {
    body = (
      <>
        <span className={styles.orb} aria-hidden="true">
          <Radar size={20} />
        </span>
        <div className={styles.main}>
          <div className={styles.header}>
            <span className={styles.name}>No active hunt</span>
            {backButton}
          </div>
          <p className={styles.line}>Pick a hunt in Biolume to count it here.</p>
          {lockLine}
        </div>
      </>
    );
  } else {
    const countable = hunt.status === 'active';
    const count = formatCount(hunt.count);
    const sprites = overlaySprites(hunt.target);
    const oddsLine = overlay.showOdds ? overlayOddsLine(hunt) : null;
    const direction =
      lastChange !== null && lastChange.huntId === hunt.id && lastChange.change.delta < 0
        ? 'down'
        : 'up';

    body = (
      <>
        {overlay.showSprite ? (
          <Sprite
            className={styles.sprite}
            src={sprites}
            alt=""
            size={56}
            shiny={state === 'completed'}
            loading="eager"
          />
        ) : null}
        <div className={styles.main}>
          <div className={styles.header}>
            <span className={styles.name}>{overlayTitle(hunt)}</span>
            {backButton}
          </div>

          <div className={styles.countRow}>
            <span className={styles.countBox} data-size={countSize(hunt.count)}>
              {/* Re-keyed on every change, so the pulse replays from its first frame. */}
              <span
                key={`${hunt.id}:${hunt.count}:${hunt.priorCount}`}
                className={styles.count}
                data-direction={direction}
                data-value={count}
                aria-label={`${count} encounters`}
              >
                {count}
              </span>
            </span>
            <span className={styles.steppers}>
              <button
                type="button"
                className={styles.button}
                aria-label={`Subtract ${formatCount(hunt.step)}`}
                disabled={!countable || hunt.count <= 0}
                onClick={() => void actions.decrementHunt(hunt, 'overlay')}
              >
                <Minus size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={styles.button}
                data-variant="primary"
                aria-label={`Add ${formatCount(hunt.step)}`}
                disabled={!countable}
                onClick={() => void actions.incrementHunt(hunt, 'overlay')}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </span>
          </div>

          {state === 'completed' || state === 'archived' ? (
            <p className={styles.status}>
              {state === 'completed' ? <Sparkles size={11} aria-hidden="true" /> : null}
              <span>{STATUS_LABEL[state]}</span>
            </p>
          ) : null}
          {oddsLine !== null ? <p className={styles.line}>{oddsLine}</p> : null}
          {overlay.showPhase ? <p className={styles.line}>{overlayPhaseLine(hunt)}</p> : null}
          {lockLine}
        </div>
      </>
    );
  }

  return (
    <div ref={frameRef} className={styles.frame} data-overlay-root>
      <div className={styles.scaler} data-overlay-scale style={{ zoom: scale }}>
        <section
          className={styles.card}
          data-state={state}
          data-locked={overlay.clickThrough || undefined}
          style={cardStyle}
          aria-label="Biolume mini-overlay"
        >
          {body}
        </section>
      </div>
    </div>
  );
}
