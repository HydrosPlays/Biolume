import { useState, type CSSProperties } from 'react';
import { cx } from './internal/cx';
import styles from './Sprite.module.css';

type SpriteSource = string | null | undefined;

export interface SpriteProps {
  /**
   * Image URL, or an ordered list of candidates. Each is tried in turn when
   * the previous one fails to load (shiny sprite → default sprite → …); null /
   * empty entries are skipped. When none loads, a silhouette is shown.
   */
  src: SpriteSource | readonly SpriteSource[];
  /** Text alternative — the Pokémon's name. Pass `""` when the name is printed next to the sprite. */
  alt: string;
  /** Rendered box in px (square). Default 64. */
  size?: number;
  /** Gold sparkles and glow: this is a shiny. */
  shiny?: boolean;
  /** Nearest-neighbour scaling for pixel-art sprites. Default true; turn off for official artwork. */
  pixelated?: boolean;
  /** Native lazy loading for long lists. Default `lazy`. */
  loading?: 'lazy' | 'eager';
  className?: string;
  style?: CSSProperties;
}

/** Four-point sparkle, drawn on a 10×10 grid. */
const SPARKLE_PATH = 'M5 0 6.2 3.8 10 5 6.2 6.2 5 10 3.8 6.2 0 5 3.8 3.8Z';

/**
 * A Pokémon sprite that never shows a broken image: fallbacks are tried in
 * order and a neutral silhouette stands in when nothing loads (or while
 * offline with a cold cache).
 */
export function Sprite({
  src,
  alt,
  size = 64,
  shiny = false,
  pixelated = true,
  loading = 'lazy',
  className,
  style,
}: SpriteProps) {
  const candidates = (
    Array.isArray(src) ? (src as readonly SpriteSource[]) : [src as SpriteSource]
  ).filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== '');
  const signature = candidates.join('\n');

  // Progress through the candidate list, reset whenever the list itself changes.
  const [progress, setProgress] = useState({ signature, failed: 0, loaded: false });
  const current =
    progress.signature === signature ? progress : { signature, failed: 0, loaded: false };
  const url = candidates[current.failed];

  return (
    <span
      className={cx(styles.sprite, shiny && styles.shiny, className)}
      style={{ width: size, height: size, ...style }}
      data-state={url === undefined ? 'missing' : current.loaded ? 'loaded' : 'loading'}
    >
      {url === undefined ? (
        <svg
          className={styles.silhouette}
          viewBox="0 0 48 48"
          role={alt === '' ? undefined : 'img'}
          aria-label={alt === '' ? undefined : alt}
          aria-hidden={alt === '' ? true : undefined}
        >
          {/* A generic creature: round head, two ears. Deliberately not any real species. */}
          <path d="M24 7c-2.9 0-5.4 1.5-7.3 3.5-2-2.3-4.8-3.9-7-3.2-2.4.8-1.8 5.5.5 9.5-2.5 3.4-4 7.6-4 12C6.2 37.3 13.9 42 24 42s17.8-4.7 17.8-13.2c0-4.4-1.5-8.6-4-12 2.3-4 2.9-8.7.5-9.5-2.2-.7-5 .9-7 3.2C29.4 8.5 26.9 7 24 7Z" />
          <circle className={styles.eye} cx="17.5" cy="25" r="2.2" />
          <circle className={styles.eye} cx="30.5" cy="25" r="2.2" />
        </svg>
      ) : (
        <img
          key={url}
          className={cx(styles.image, pixelated && styles.pixelated)}
          src={url}
          alt={alt}
          width={size}
          height={size}
          loading={loading}
          decoding="async"
          draggable={false}
          onLoad={() => setProgress({ signature, failed: current.failed, loaded: true })}
          onError={() => setProgress({ signature, failed: current.failed + 1, loaded: false })}
        />
      )}
      {shiny ? (
        <svg className={styles.sparkles} viewBox="0 0 48 48" aria-hidden="true">
          <path className={styles.sparkle} d={SPARKLE_PATH} transform="translate(34 4)" />
          <path
            className={styles.sparkle}
            d={SPARKLE_PATH}
            transform="translate(3 12) scale(0.7)"
          />
          <path
            className={styles.sparkle}
            d={SPARKLE_PATH}
            transform="translate(36 32) scale(0.55)"
          />
        </svg>
      ) : null}
    </span>
  );
}
