import { useId } from 'react';
import { Star } from 'lucide-react';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import type { Hunt } from '@shared/types';
import { Button, Tooltip } from '@renderer/components/ui';
import { useShinyConfirmation } from '@renderer/hooks/useShinyConfirmation';
import { useSettings } from '@renderer/store';
import { completeHunt } from './huntActions';
import styles from './hunt.module.css';

const CONFIRM_SECONDS = Math.round(SHINY_CONFIRM_WINDOW_MS / 1000);

/** A ring that empties over the confirmation window, with the seconds left inside. */
function CountdownRing({ fraction, seconds }: { fraction: number; seconds: number }) {
  return (
    <span className={styles.countdown} data-testid="shiny-countdown" aria-hidden="true">
      <svg className={styles.countdownSvg} viewBox="0 0 20 20">
        <circle className={styles.countdownTrack} cx="10" cy="10" r="8" />
        <circle
          className={styles.countdownArc}
          cx="10"
          cy="10"
          r="8"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset={1 - fraction}
        />
      </svg>
      <span className={styles.countdownDigit}>{seconds}</span>
    </span>
  );
}

/**
 * "Shiny found!" in the Hunt view. A click completes the hunt directly (and
 * offers Undo). When a hotkey or the Stream Deck has armed Shiny Found for
 * this hunt, the button pulses gold with a ring counting the confirmation
 * window down and asks for the second press.
 */
export function ShinyFoundButton({ hunt }: { hunt: Hunt }) {
  const confirmation = useShinyConfirmation(hunt.id);
  const shortcut = useSettings().hotkeys.bindings.shinyFound[0];
  const hintId = useId();
  const armed = confirmation !== null;

  return (
    <div className={styles.shinyFound} data-armed={armed ? '' : undefined}>
      <span className={styles.shinyGlow} aria-hidden="true" />
      <Tooltip
        content={`Your target appeared. From a hotkey or the Stream Deck it takes two presses within ${CONFIRM_SECONDS} s.`}
        shortcut={shortcut}
        placement="bottom"
        delay={600}
      >
        <Button
          variant="shiny"
          fullWidth
          leadingIcon={
            confirmation !== null ? (
              <CountdownRing fraction={confirmation.fraction} seconds={confirmation.seconds} />
            ) : (
              <Star />
            )
          }
          aria-describedby={armed ? hintId : undefined}
          onClick={() => void completeHunt(hunt)}
        >
          Shiny found!
        </Button>
      </Tooltip>
      {/* Always mounted, so screen readers announce the prompt when it appears. */}
      <p id={hintId} className={styles.shinyHint} role="status">
        {confirmation !== null ? (
          <>
            Press again to confirm
            <span className={styles.shinyHintTime} aria-hidden="true">
              {' '}
              · {confirmation.seconds} s
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
