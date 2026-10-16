import type { CSSProperties } from 'react';
import { cx } from './internal/cx';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  /** Width (px or CSS length). Default `100%`. */
  width?: number | string;
  /** Height (px or CSS length). Default `1em` — one line of the surrounding text. */
  height?: number | string;
  /** `text` (rounded line), `block` (panel-like), `circle` (sprite / avatar). Default `text`. */
  shape?: 'text' | 'block' | 'circle';
  /** Render this many stacked text lines; the last one is shortened. */
  lines?: number;
  className?: string;
  style?: CSSProperties;
}

/** Loading placeholder with a slow shimmer. Purely decorative: pair it with `aria-busy` on the region. */
export function Skeleton({
  width,
  height,
  shape = 'text',
  lines,
  className,
  style,
}: SkeletonProps) {
  if (lines !== undefined && lines > 1) {
    return (
      <span className={cx(styles.stack, className)} style={style} aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => (
          <span
            key={index}
            className={cx(styles.skeleton, styles.text)}
            style={{
              width: index === lines - 1 ? '62%' : (width ?? '100%'),
              height: height ?? '1em',
            }}
          />
        ))}
      </span>
    );
  }

  return (
    <span
      className={cx(styles.skeleton, styles[shape], className)}
      style={{
        width: width ?? (shape === 'circle' ? height : '100%'),
        height: height ?? '1em',
        ...style,
      }}
      aria-hidden="true"
    />
  );
}
