import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from 'react';
import { cx } from './internal/cx';
import { mergeRefs } from './internal/dom';
import styles from './ScrollArea.module.css';

export interface ScrollAreaProps extends ComponentProps<'div'> {
  /** Caps the height (px or any CSS length); content beyond it scrolls. Omit to fill a flex parent. */
  maxHeight?: number | string;
  /** Fade the top / bottom edges while more content is hidden beyond them. Default true. */
  fade?: boolean;
  /** Class for the outer (non-scrolling) frame; `className` goes to the scrolling viewport. */
  frameClassName?: string;
}

/**
 * A vertical scroll container with soft edge fades that tell the user there is
 * more above or below. Keyboard-scrollable (focusable when it overflows); give
 * it an `aria-label` when its purpose is not obvious from a nearby heading.
 */
export function ScrollArea({
  maxHeight,
  fade = true,
  frameClassName,
  className,
  children,
  style,
  onScroll,
  ref,
  ...rest
}: ScrollAreaProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false, overflowing: false });

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top = viewport.scrollTop > 1;
    const bottom = viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1;
    const overflowing = viewport.scrollHeight > viewport.clientHeight + 1;
    setEdges((previous) =>
      previous.top === top && previous.bottom === bottom && previous.overflowing === overflowing
        ? previous
        : { top, bottom, overflowing },
    );
  }, []);

  useEffect(() => {
    measure();
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    for (const child of Array.from(viewport.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, children]);

  const frameStyle: CSSProperties | undefined = maxHeight === undefined ? undefined : { maxHeight };

  return (
    <div
      className={cx(styles.frame, frameClassName)}
      style={frameStyle}
      data-fade-top={(fade && edges.top) || undefined}
      data-fade-bottom={(fade && edges.bottom) || undefined}
    >
      <div
        {...rest}
        ref={mergeRefs(viewportRef, ref)}
        className={cx(styles.viewport, className)}
        style={style}
        tabIndex={rest.tabIndex ?? (edges.overflowing ? 0 : undefined)}
        role={rest.role ?? (rest['aria-label'] ? 'region' : undefined)}
        onScroll={(event) => {
          measure();
          onScroll?.(event);
        }}
      >
        {children}
      </div>
    </div>
  );
}
