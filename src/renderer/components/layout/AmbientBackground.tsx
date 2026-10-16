import { useEffect, useRef } from 'react';
import { useReducedMotion } from '@renderer/hooks/useReducedMotion';
import styles from './AmbientBackground.module.css';

interface Particle {
  x: number;
  y: number;
  radius: number;
  /** Drift in CSS px per second. */
  vx: number;
  vy: number;
  /** Twinkle phase and speed (radians, radians per second). */
  phase: number;
  speed: number;
  /** Peak opacity. */
  alpha: number;
  color: string;
}

const PARTICLE_COUNT = 42;
/** Plankton does not need 60 fps; halving it halves the cost of a full-window canvas. */
const FRAME_INTERVAL_MS = 1000 / 30;
/** rgb triplets of the token palette: mostly cyan / teal, a little violet. */
const COLORS = [
  '46 232 255',
  '46 232 255',
  '111 245 255',
  '29 242 194',
  '29 242 194',
  '154 107 255',
];

function random(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createParticle(width: number, height: number): Particle {
  const depth = Math.random();
  return {
    x: random(0, width),
    y: random(0, height),
    // Nearer particles are larger, brighter and drift faster.
    radius: 0.5 + depth * 1.5,
    vx: random(-5, 5) * (0.4 + depth),
    vy: -random(2, 9) * (0.4 + depth),
    phase: random(0, Math.PI * 2),
    speed: random(0.35, 1.1),
    alpha: 0.18 + depth * 0.5,
    color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? '46 232 255',
  };
}

function draw(
  context: CanvasRenderingContext2D,
  particles: Particle[],
  width: number,
  height: number,
): void {
  context.clearRect(0, 0, width, height);
  for (const particle of particles) {
    const twinkle = 0.55 + 0.45 * Math.sin(particle.phase);
    const alpha = particle.alpha * twinkle;
    // Soft halo, then a bright core.
    context.fillStyle = `rgb(${particle.color} / ${(alpha * 0.16).toFixed(3)})`;
    context.beginPath();
    context.arc(particle.x, particle.y, particle.radius * 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = `rgb(${particle.color} / ${alpha.toFixed(3)})`;
    context.beginPath();
    context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    context.fill();
  }
}

/** `getContext` can throw (or be unimplemented) on exotic GPU / test setups; the field is optional. */
function getContext2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/**
 * The water column behind the app: the abyss gradient, two slow drifting
 * blooms of light, and a sparse field of plankton on a canvas.
 *
 * The canvas runs at 30 fps and stops completely while the document is hidden
 * (minimised, or covered while the game has focus) or when motion is reduced —
 * in which case a single still frame is drawn.
 */
export function AmbientBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = getContext2d(canvas);
    if (!ctx) return undefined;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frame = 0;
    let lastFrameAt = 0;

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (particles.length === 0) {
        particles = Array.from({ length: PARTICLE_COUNT }, () => createParticle(width, height));
      }
      draw(ctx, particles, width, height);
    };

    const step = (now: number): void => {
      frame = window.requestAnimationFrame(step);
      const elapsed = now - lastFrameAt;
      if (elapsed < FRAME_INTERVAL_MS) return;
      lastFrameAt = now;
      // Clamp the time step so a long pause never teleports the field.
      const dt = Math.min(elapsed, 100) / 1000;
      for (const particle of particles) {
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.phase += particle.speed * dt;
        const margin = particle.radius * 4;
        if (particle.y < -margin) {
          particle.y = height + margin;
          particle.x = random(0, width);
        }
        if (particle.x < -margin) particle.x = width + margin;
        else if (particle.x > width + margin) particle.x = -margin;
      }
      draw(ctx, particles, width, height);
    };

    const start = (): void => {
      if (frame !== 0 || reducedMotion || document.hidden) return;
      lastFrameAt = performance.now();
      frame = window.requestAnimationFrame(step);
    };
    const stop = (): void => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };

    resize();
    start();

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reducedMotion]);

  return (
    <div className={styles.ambient} aria-hidden="true">
      <div className={styles.bloomA} />
      <div className={styles.bloomB} />
      <canvas ref={canvasRef} className={styles.canvas} />
      <div className={styles.vignette} />
    </div>
  );
}
