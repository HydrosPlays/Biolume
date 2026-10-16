import icon128 from '@renderer/assets/icon-128.png';
import icon22 from '@renderer/assets/icon-22.png';
import icon32 from '@renderer/assets/icon-32.png';
import icon44 from '@renderer/assets/icon-44.png';
import icon64 from '@renderer/assets/icon-64.png';
import { cx } from '@renderer/components/ui/internal/cx';
import styles from './Logo.module.css';

export interface LogoProps {
  /** Mark size in CSS px. Default 20. */
  size?: number;
  /** Let the mark breathe (a slow halo pulse). Default true. */
  alive?: boolean;
  /**
   * Accessible name. Leave it out where "Biolume" is already written next to the mark
   * (the title bar) or the container is labelled (the boot screen): the mark is then decorative.
   */
  label?: string;
  className?: string;
}

/**
 * Pre-scaled copies of build/icon.png (scripts/resize-images.mjs); the browser picks one per
 * size and DPI, so the 22 px title-bar mark is drawn pixel for pixel at 100 % and 200 %.
 */
const SRC_SET = [
  `${icon22} 22w`,
  `${icon32} 32w`,
  `${icon44} 44w`,
  `${icon64} 64w`,
  `${icon128} 128w`,
].join(', ');

/** The Biolume mark: the app icon — a glowing map pin with a shiny sparkle — in a soft halo. */
export function Logo({ size = 20, alive = true, label, className }: LogoProps) {
  return (
    <span
      className={cx(styles.logo, alive && styles.alive, className)}
      style={{ width: size, height: size }}
      {...(label === undefined ? { 'aria-hidden': true } : {})}
    >
      <img
        className={styles.mark}
        src={icon64}
        srcSet={SRC_SET}
        sizes={`${size}px`}
        width={size}
        height={size}
        alt={label ?? ''}
        draggable={false}
      />
    </span>
  );
}
