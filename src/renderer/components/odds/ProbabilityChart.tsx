import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { formatCount, formatPercent } from '@renderer/lib/format';
import type { CurvePoint } from '@renderer/lib/probability';
import {
  areaPath,
  countTicks,
  formatAxisCount,
  labelAnchor,
  linePath,
  pixelToCount,
  plotArea,
  scrubTo,
  tickTarget,
  tooltipLeft,
  tooltipTop,
  visibleLabels,
  xToPixel,
  yToPixel,
} from './chartGeometry';
import styles from './ProbabilityChart.module.css';

export interface ChartMarker {
  /** Cumulative probability the marker stands for (0.5, 0.9, 0.99). */
  probability: number;
  /** Encounters at which the curve reaches it. */
  encounters: number;
}

export interface ChartPosition {
  /** The hunt's total encounters. */
  encounters: number;
  /** Cumulative probability at that total. */
  probability: number;
}

export interface ProbabilityChartProps {
  /** Sampled cumulative curve, starting at n = 0. */
  curve: readonly CurvePoint[];
  /** Dimmed reference curve (full odds) over the same range. */
  comparison?: readonly CurvePoint[] | null;
  /** Last encounter count on the x axis. */
  maxN: number;
  /** Exact cumulative probability at any count — used by the crosshair. */
  probabilityAt: (n: number) => number;
  comparisonAt?: ((n: number) => number) | null;
  /** Dashed milestone markers. */
  markers: readonly ChartMarker[];
  /** "You are here" marker; omit when there is no active hunt. */
  position?: ChartPosition | null;
  /** Accessible name of the chart. */
  label: string;
  /** Text alternative describing what the chart shows. */
  summary: string;
  /** Legend / tooltip name of the main curve. */
  seriesLabel: string;
  comparisonLabel?: string;
}

/** Size assumed until the container has been measured (and in non-layout environments). */
const FALLBACK_SIZE = { width: 640, height: 280 };
const TOOLTIP_WIDTH = 188;
const MARKER_LABEL_WIDTH = 92;
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

interface Size {
  width: number;
  height: number;
}

/**
 * The container's content box, tracked with a ResizeObserver. Updates are
 * coalesced into one per frame and skipped when the rounded size is unchanged,
 * so dragging the window edge re-renders the chart at most once per frame and
 * never reads layout back.
 */
function useElementSize(): [ref: (element: HTMLDivElement | null) => void, size: Size] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    if (!element) return undefined;
    const apply = (width: number, height: number): void => {
      const next = { width: Math.round(width), height: Math.round(height) };
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    const rect = element.getBoundingClientRect();
    apply(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return undefined;

    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => apply(width, height));
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [element]);

  return [setElement, size];
}

/**
 * Cumulative probability of at least one shiny against encounters: a glowing
 * line over a soft gradient, dashed milestone markers, a dimmed full-odds
 * reference, the hunter's position, and a crosshair that follows the pointer
 * or the arrow keys.
 */
export function ProbabilityChart({
  curve,
  comparison = null,
  maxN,
  probabilityAt,
  comparisonAt = null,
  markers,
  position = null,
  label,
  summary,
  seriesLabel,
  comparisonLabel = 'Full odds',
}: ProbabilityChartProps) {
  const [containerRef, measured] = useElementSize();
  const width = measured.width > 0 ? measured.width : FALLBACK_SIZE.width;
  const height = measured.height > 0 ? measured.height : FALLBACK_SIZE.height;
  const area = useMemo(() => plotArea(width, height), [width, height]);

  const gradientId = useId();
  const summaryId = useId();
  const [scrub, setScrub] = useState<number | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // ── Static layers: recomputed only when the data or the size changes ──
  const paths = useMemo(
    () => ({
      line: linePath(curve, maxN, area),
      area: areaPath(curve, maxN, area),
      comparison: comparison ? linePath(comparison, maxN, area) : '',
    }),
    [curve, comparison, maxN, area],
  );
  const xTicks = useMemo(() => countTicks(maxN, tickTarget(area.width)), [maxN, area.width]);

  const markerLayout = useMemo(() => {
    const shown = markers.filter(
      (marker) => Number.isFinite(marker.encounters) && marker.encounters <= maxN,
    );
    const xs = shown.map((marker) => xToPixel(marker.encounters, maxN, area));
    const labelled = visibleLabels(xs, MARKER_LABEL_WIDTH);
    return shown.map((marker, index) => ({
      ...marker,
      x: xs[index] ?? area.left,
      y: yToPixel(marker.probability, area),
      labelled: labelled[index] === true,
    }));
  }, [markers, maxN, area]);

  const here = position
    ? {
        x: xToPixel(position.encounters, maxN, area),
        y: yToPixel(position.probability, area),
        text: `You · ${formatPercent(position.probability)}`,
      }
    : null;

  // ── Crosshair ──
  const scrubOrigin = position
    ? Math.min(position.encounters, maxN)
    : (markers[0]?.encounters ?? Math.round(maxN / 2));
  const active = scrub === null ? null : Math.min(scrub, Math.round(maxN));
  const activeProbability = active === null ? 0 : probabilityAt(active);
  const activeComparison = active === null || !comparisonAt ? null : comparisonAt(active);
  const activeX = active === null ? 0 : xToPixel(active, maxN, area);
  const activeY = yToPixel(activeProbability, area);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      // The surface covers the whole SVG, so its left edge is x = 0 of the chart.
      setScrub(pixelToCount(event.clientX - rect.left, maxN, area));
    },
    [maxN, area],
  );
  const onPointerLeave = useCallback(() => {
    // Keyboard users keep their crosshair while the surface has focus.
    if (document.activeElement !== surfaceRef.current) setScrub(null);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (scrub !== null) {
        event.stopPropagation();
        setScrub(null);
      }
      return;
    }
    const next = scrubTo(scrub, event.key, event.shiftKey, maxN, scrubOrigin);
    if (next === null) return;
    event.preventDefault();
    setScrub(next);
  };

  const valueText =
    active === null
      ? summary
      : `${formatCount(active)} encounters: ${formatPercent(activeProbability)} chance of at least one shiny`;

  return (
    <figure className={styles.figure}>
      <div ref={containerRef} className={styles.chart}>
        <svg
          className={styles.svg}
          width={width}
          height={height}
          role="img"
          aria-label={label}
          aria-describedby={summaryId}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className={styles.gradientTop} />
              <stop offset="100%" className={styles.gradientBottom} />
            </linearGradient>
          </defs>

          {/* Grid and axes */}
          <g aria-hidden="true">
            {Y_TICKS.map((tick) => {
              const y = yToPixel(tick, area);
              return (
                <g key={tick}>
                  <line
                    className={tick === 0 ? styles.axis : styles.grid}
                    x1={area.left}
                    x2={area.right}
                    y1={y}
                    y2={y}
                  />
                  <text
                    className={styles.tick}
                    x={area.left - 8}
                    y={y}
                    dy="0.32em"
                    textAnchor="end"
                  >
                    {formatPercent(tick)}
                  </text>
                </g>
              );
            })}
            {xTicks.map((tick) => {
              const x = xToPixel(tick, maxN, area);
              return (
                <g key={tick}>
                  <line
                    className={styles.tickMark}
                    x1={x}
                    x2={x}
                    y1={area.bottom}
                    y2={area.bottom + 4}
                  />
                  <text className={styles.tick} x={x} y={area.bottom + 17} textAnchor="middle">
                    {formatAxisCount(tick, formatCount)}
                  </text>
                </g>
              );
            })}
          </g>

          {/* Curves */}
          <g aria-hidden="true">
            {paths.comparison ? <path className={styles.comparison} d={paths.comparison} /> : null}
            <path className={styles.area} d={paths.area} fill={`url(#${gradientId})`} />
            <path className={styles.lineGlow} d={paths.line} />
            <path className={styles.line} d={paths.line} />
          </g>

          {/* Milestones */}
          <g aria-hidden="true">
            {markerLayout.map((marker) => (
              <g key={marker.probability}>
                <line
                  className={styles.marker}
                  x1={marker.x}
                  x2={marker.x}
                  y1={area.bottom}
                  y2={marker.y}
                />
                <line
                  className={styles.marker}
                  x1={area.left}
                  x2={marker.x}
                  y1={marker.y}
                  y2={marker.y}
                />
                <circle className={styles.markerDot} cx={marker.x} cy={marker.y} r={3} />
                {marker.labelled ? (
                  <text
                    className={styles.markerLabel}
                    x={marker.x}
                    y={area.top - 9}
                    textAnchor={labelAnchor(marker.x, MARKER_LABEL_WIDTH, area)}
                  >
                    {`${formatPercent(marker.probability)} · ${formatCount(marker.encounters)}`}
                  </text>
                ) : null}
              </g>
            ))}
          </g>

          {/* You are here */}
          {here ? (
            <g aria-hidden="true">
              <line
                className={styles.hereLine}
                x1={here.x}
                x2={here.x}
                y1={area.bottom}
                y2={here.y}
              />
              <circle className={styles.hereHalo} cx={here.x} cy={here.y} r={9} />
              <circle className={styles.hereDot} cx={here.x} cy={here.y} r={4} />
              <text
                className={styles.hereLabel}
                x={here.x}
                y={Math.min(area.bottom - 8, here.y + 22)}
                dx={labelAnchor(here.x, 150, area) === 'end' ? -10 : 10}
                textAnchor={labelAnchor(here.x, 150, area) === 'end' ? 'end' : 'start'}
              >
                {here.text}
              </text>
            </g>
          ) : null}

          {/* Crosshair */}
          {active !== null ? (
            <g aria-hidden="true">
              <line
                className={styles.crosshair}
                x1={activeX}
                x2={activeX}
                y1={area.top}
                y2={area.bottom}
              />
              {activeComparison !== null ? (
                <circle
                  className={styles.crosshairComparison}
                  cx={activeX}
                  cy={yToPixel(activeComparison, area)}
                  r={3}
                />
              ) : null}
              <circle className={styles.crosshairDot} cx={activeX} cy={activeY} r={4.5} />
            </g>
          ) : null}
        </svg>

        {/* Pointer + keyboard surface. A slider: arrows scrub, the value text reads the point out. */}
        <div
          ref={surfaceRef}
          className={styles.surface}
          role="slider"
          tabIndex={0}
          // Arrow keys scrub here: keep in-app counter hotkeys from firing on them.
          data-hotkeys="off"
          aria-label={`${label}: scrub with the arrow keys`}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(maxN)}
          aria-valuenow={active ?? Math.round(scrubOrigin)}
          aria-valuetext={valueText}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onFocus={() => setScrub((current) => current ?? Math.round(scrubOrigin))}
          onBlur={() => setScrub(null)}
          onKeyDown={onKeyDown}
        />

        {active !== null ? (
          <div
            className={styles.tooltip}
            style={{
              width: TOOLTIP_WIDTH,
              transform: `translate3d(${tooltipLeft(activeX, TOOLTIP_WIDTH, width)}px, ${tooltipTop(activeY, activeComparison === null ? 52 : 72, area)}px, 0)`,
            }}
            aria-hidden="true"
          >
            <span className={styles.tooltipCount}>{formatCount(active)} encounters</span>
            <span className={styles.tooltipRow}>
              <span className={styles.swatch} data-series="main" />
              <span className={styles.tooltipName}>{seriesLabel}</span>
              <span className={styles.tooltipValue}>{formatPercent(activeProbability)}</span>
            </span>
            {activeComparison !== null ? (
              <span className={styles.tooltipRow}>
                <span className={styles.swatch} data-series="comparison" />
                <span className={styles.tooltipName}>{comparisonLabel}</span>
                <span className={styles.tooltipValue}>{formatPercent(activeComparison)}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <figcaption className={styles.caption}>
        <ul className={styles.legend} aria-hidden="true">
          <li>
            <span className={styles.swatch} data-series="main" />
            {seriesLabel}
          </li>
          {comparison ? (
            <li>
              <span className={styles.swatch} data-series="comparison" />
              {comparisonLabel}
            </li>
          ) : null}
          <li>
            <span className={styles.swatch} data-series="marker" />
            50 / 90 / 99 %
          </li>
          {here ? (
            <li>
              <span className={styles.swatch} data-series="here" />
              Your hunt
            </li>
          ) : null}
        </ul>
        <p id={summaryId} className={styles.summary}>
          {summary}
        </p>
      </figcaption>
    </figure>
  );
}
