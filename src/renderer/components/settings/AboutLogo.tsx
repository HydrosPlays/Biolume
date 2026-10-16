import logo from '@renderer/assets/logo.png';
import styles from './AboutLogo.module.css';

/** Intrinsic size of src/renderer/assets/logo.png (scripts/resize-images.mjs). */
const LOGO_WIDTH = 960;
const LOGO_HEIGHT = 601;

/** The Biolume wordmark at the head of the About block, floating in a soft pool of light. */
export function AboutLogo() {
  return (
    <div className={styles.brand}>
      <img
        className={styles.logo}
        src={logo}
        width={LOGO_WIDTH}
        height={LOGO_HEIGHT}
        alt="Biolume"
        draggable={false}
      />
    </div>
  );
}
