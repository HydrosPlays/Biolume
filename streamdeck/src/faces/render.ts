/**
 * Key faces as SVG, in Biolume's look: a deep-navy abyss, light that comes
 * from living things — cyan / teal glow for normal keys, gold for shinies and
 * the armed Shiny Found confirmation, red when Biolume cannot be reached.
 *
 * Drawn on a 144 x 144 canvas (Stream Deck's @2x key size) and scaled down for
 * 72 px keys, so every text is large and bold. Only SVG features that simple
 * renderers handle are used: no filters, no CSS, no web fonts — the glow is a
 * radial gradient plus a wide translucent stroke under each shape.
 *
 * All text that originates outside the plugin (hunt and Pokémon names) is
 * cleaned by ./../bridge/protocol.ts and XML-escaped here.
 *
 * Pure functions, no SDK imports.
 */
import type { BridgeHunt } from '../../../src/shared/streamDeck';
import type { KeyKind } from '../keys/kinds';
import { escapeXml, formatCount, truncate } from './format';
import theme from './theme.json';

type Palette = typeof theme.palette;
const P: Palette = theme.palette;

interface Glyph {
  stroke: string[];
  fill: string[];
}

const GLYPHS: Record<KeyKind, Glyph> = {
  counter: theme.actions.counter.glyph,
  increment: theme.actions.increment.glyph,
  decrement: theme.actions.decrement.glyph,
  logphase: theme.actions.logphase.glyph,
  shinyfound: theme.actions.shinyfound.glyph,
  undo: theme.actions.undo.glyph,
  overlay: theme.actions.overlay.glyph,
};

const LABELS: Record<KeyKind, string> = {
  counter: theme.actions.counter.label,
  increment: theme.actions.increment.label,
  decrement: theme.actions.decrement.label,
  logphase: theme.actions.logphase.label,
  shinyfound: theme.actions.shinyfound.label,
  undo: theme.actions.undo.label,
  overlay: theme.actions.overlay.label,
};

export type Tone = 'glow' | 'shiny' | 'error' | 'muted';

interface ToneColors {
  /** Glyphs, frame and glow. */
  main: string;
  /** Small text in this tone. */
  text: string;
  /** Top of the background gradient. */
  sky: string;
}

const TONES: Record<Tone, ToneColors> = {
  glow: { main: P.cyan, text: P.aqua, sky: P.abyss600 },
  shiny: { main: P.gold, text: P.goldPale, sky: P.abyss600 },
  error: { main: P.danger, text: P.danger, sky: P.abyss700 },
  muted: { main: P.ink400, text: P.ink300, sky: P.abyss700 },
};

const FONT = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const SIZE = 144;
const CENTER = SIZE / 2;
/** Drawn size of a 96 px PokeAPI sprite on the counter key. */
const SPRITE_SIZE = 132;

/** What a key should show, derived from the bridge snapshot by the key controller. */
export type KeyView =
  | { connection: 'offline' }
  | { connection: 'incompatible' }
  | {
      connection: 'online';
      hunt: BridgeHunt | null;
      /** Shiny Found is waiting for its second press. */
      armed: { remainingMs: number; fraction: number } | null;
      /** Data URL of the target's shiny sprite, once downloaded. */
      sprite: string | null;
    };

// ───────────────────────────── Primitives ─────────────────────────────

function svg(tone: Tone, body: string, frameTone: Tone = tone): string {
  const t = TONES[tone];
  const frame = TONES[frameTone];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<defs>` +
    `<radialGradient id="sky" cx="50%" cy="18%" r="90%">` +
    `<stop offset="0" stop-color="${t.sky}"/>` +
    `<stop offset="0.55" stop-color="${P.abyss850}"/>` +
    `<stop offset="1" stop-color="${P.abyss950}"/>` +
    `</radialGradient>` +
    `<radialGradient id="glow" cx="50%" cy="50%" r="50%">` +
    `<stop offset="0" stop-color="${t.main}" stop-opacity="0.42"/>` +
    `<stop offset="0.6" stop-color="${t.main}" stop-opacity="0.1"/>` +
    `<stop offset="1" stop-color="${t.main}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#sky)"/>` +
    `<rect x="5" y="5" width="134" height="134" rx="24" fill="none" ` +
    `stroke="${frame.main}" stroke-opacity="0.4" stroke-width="3"/>` +
    body +
    `</svg>`
  );
}

function halo(cx: number, cy: number, r: number): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#glow)"/>`;
}

function glyph(
  kind: KeyKind,
  tone: Tone,
  cx: number,
  cy: number,
  size: number,
  opacity = 1,
): string {
  const { stroke, fill } = GLYPHS[kind];
  const color = TONES[tone].main;
  const scale = size / 24;
  const paths = (list: readonly string[]): string => list.map((d) => `<path d="${d}"/>`).join('');
  const parts: string[] = [];
  if (stroke.length > 0) {
    parts.push(
      `<g fill="none" stroke="${color}" stroke-opacity="0.28" stroke-width="5" ` +
        `stroke-linecap="round" stroke-linejoin="round">${paths(stroke)}</g>`,
      `<g fill="none" stroke="${color}" stroke-width="2.2" ` +
        `stroke-linecap="round" stroke-linejoin="round">${paths(stroke)}</g>`,
    );
  }
  if (fill.length > 0) {
    parts.push(
      `<g fill="${color}" stroke="${color}" stroke-opacity="0.3" stroke-width="2.4" ` +
        `stroke-linejoin="round">${paths(fill)}</g>`,
    );
  }
  const x = round(cx - size / 2);
  const y = round(cy - size / 2);
  return (
    `<g transform="translate(${x} ${y}) scale(${round(scale)})"` +
    (opacity < 1 ? ` opacity="${opacity}"` : '') +
    `>${parts.join('')}</g>`
  );
}

interface TextOptions {
  size: number;
  color: string;
  weight?: number;
  opacity?: number;
  /** Translucent wide stroke under the text in this colour (a glow). */
  glow?: string;
}

function text(content: string, x: number, y: number, options: TextOptions): string {
  const safe = escapeXml(content);
  const common =
    `x="${x}" y="${y}" font-family="${FONT}" font-size="${options.size}" ` +
    `font-weight="${options.weight ?? 700}" text-anchor="middle"`;
  const under = options.glow
    ? `<text ${common} fill="none" stroke="${options.glow}" stroke-opacity="0.3" ` +
      `stroke-width="${Math.max(4, Math.round(options.size / 9))}" stroke-linejoin="round">${safe}</text>`
    : '';
  const opacity =
    options.opacity !== undefined && options.opacity < 1 ? ` opacity="${options.opacity}"` : '';
  return `${under}<text ${common} fill="${options.color}"${opacity}>${safe}</text>`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Font size for a bottom label of this many characters. */
function labelSize(label: string): number {
  const length = Array.from(label).length;
  if (length <= 6) return 26;
  if (length <= 8) return 23;
  if (length <= 10) return 19;
  return 16;
}

/** Bottom label in the shared position. */
function label(content: string, tone: Tone, color?: string): string {
  const fitted = truncate(content, 12);
  return text(fitted, CENTER, 126, { size: labelSize(fitted), color: color ?? TONES[tone].text });
}

/** Glyph in its glow, plus a label: the face of every plain action key. */
function actionFace(kind: KeyKind, tone: Tone, caption: string, frameTone?: Tone): string {
  return svg(
    tone,
    halo(CENTER, 58, 52) + glyph(kind, tone, CENTER, 58, 58) + label(caption, tone, P.ink100),
    frameTone,
  );
}

// ───────────────────────────── Faces ─────────────────────────────

function offlineFace(kind: KeyKind, caption: string): string {
  return svg('error', glyph(kind, 'muted', CENTER, 56, 52, 0.55) + label(caption, 'error'));
}

/** Font size for the big count of this many characters (it must fit 144 px with margin). */
function countSize(length: number, max: number): number {
  const byLength = [72, 72, 72, 62, 52, 44, 38, 34];
  return Math.min(max, byLength[length] ?? 30);
}

function counterFace(hunt: BridgeHunt, sprite: string | null): string {
  const found = hunt.status === 'completed';
  const tone: Tone = found ? 'shiny' : 'glow';
  const colors = TONES[tone];
  const count = formatCount(hunt.count);
  const numberColor = found ? P.gold : P.ink50;
  const parts: string[] = [];

  if (sprite) {
    parts.push(
      halo(CENTER, 46, 50),
      // PokeAPI pixel sprites are 96 px with wide transparent margins: draw them
      // large (the margins fall off the key) and pixel-sharp.
      `<image x="${CENTER - SPRITE_SIZE / 2}" y="${46 - SPRITE_SIZE / 2}" ` +
        `width="${SPRITE_SIZE}" height="${SPRITE_SIZE}" preserveAspectRatio="xMidYMid meet" ` +
        `image-rendering="optimizeSpeed" style="image-rendering:pixelated" xlink:href="${sprite}"/>`,
      text(count, CENTER, 130, {
        size: countSize(count.length, 46),
        color: numberColor,
        weight: 800,
        glow: colors.main,
      }),
    );
    if (hunt.phaseNumber > 1) {
      parts.push(text(`P${hunt.phaseNumber}`, 122, 30, { size: 20, color: colors.text }));
    }
  } else {
    const title = truncate(hunt.targetName ?? hunt.name, 12);
    const size = countSize(count.length, 72);
    parts.push(
      halo(CENTER, 80, 56),
      text(title, CENTER, 34, { size: title.length > 9 ? 17 : 20, color: P.ink300, weight: 600 }),
      text(count, CENTER, 82 + size * 0.36, {
        size,
        color: numberColor,
        weight: 800,
        glow: colors.main,
      }),
    );
    const footer = found ? 'Found!' : hunt.phaseNumber > 1 ? `Phase ${hunt.phaseNumber}` : '';
    if (footer) parts.push(text(footer, CENTER, 132, { size: 18, color: colors.text }));
  }
  return svg(tone, parts.join(''));
}

/** The armed Shiny Found key: a gold ring draining over the confirmation window. */
function armedFace(remainingMs: number, fraction: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const r = 38;
  const cx = CENTER;
  const cy = 58;
  const f = Math.min(1, Math.max(0, fraction));
  let arc = '';
  if (f >= 0.999) {
    arc = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${P.gold}" stroke-width="8"/>`;
  } else if (f > 0) {
    const angle = 2 * Math.PI * f;
    const x = round(cx + r * Math.sin(angle));
    const y = round(cy - r * Math.cos(angle));
    const large = angle > Math.PI ? 1 : 0;
    arc =
      `<path d="M${cx} ${cy - r}A${r} ${r} 0 ${large} 1 ${x} ${y}" fill="none" ` +
      `stroke="${P.gold}" stroke-width="8" stroke-linecap="round"/>`;
  }
  return svg(
    'shiny',
    halo(cx, cy, 60) +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${P.gold}" stroke-opacity="0.2" stroke-width="8"/>` +
      arc +
      text(String(seconds), cx, cy + 16, {
        size: 46,
        color: P.goldPale,
        weight: 800,
        glow: P.gold,
      }) +
      text('Confirm?', CENTER, 128, { size: 24, color: P.gold, weight: 800 }),
  );
}

/** SVG markup for one key. */
export function renderKey(kind: KeyKind, view: KeyView): string {
  if (view.connection === 'offline') return offlineFace(kind, 'Offline');
  if (view.connection === 'incompatible') return offlineFace(kind, 'Update');

  // The overlay toggles with or without a hunt; every other key acts on the active hunt.
  if (kind === 'overlay') return actionFace(kind, 'glow', LABELS.overlay);
  const { hunt } = view;
  if (hunt === null) {
    return svg('muted', glyph(kind, 'muted', CENTER, 56, 52, 0.7) + label('No hunt', 'muted'));
  }

  switch (kind) {
    case 'counter':
      return counterFace(hunt, view.sprite);
    case 'increment':
      return actionFace(kind, 'glow', `+${formatCount(hunt.step)}`);
    case 'decrement':
      return actionFace(kind, 'glow', `−${formatCount(hunt.step)}`);
    case 'logphase':
      return actionFace(kind, 'glow', `Phase ${formatCount(hunt.phaseNumber)}`);
    case 'shinyfound':
      if (view.armed) return armedFace(view.armed.remainingMs, view.armed.fraction);
      if (hunt.status === 'completed') return actionFace(kind, 'shiny', 'Found!');
      return actionFace(kind, 'shiny', LABELS.shinyfound, 'glow');
    case 'undo':
      return actionFace(kind, 'glow', LABELS.undo);
  }
}

/** The form `setImage` takes: an SVG data URL. */
export function svgDataUrl(markup: string): string {
  return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}
