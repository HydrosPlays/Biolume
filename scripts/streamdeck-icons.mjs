/**
 * Makes the images the Stream Deck plugin's manifest points at, into
 * streamdeck/app.biolume.streamdeck.sdPlugin/imgs/:
 *
 *   plugin/marketplace.png, @2x      256 / 512 px   plugin icon — build/icon.png
 *   plugin/category.png, @2x          28 /  56 px   category icon — build/icon.png's light,
 *                                                   as white on transparent (Elgato asks
 *                                                   for monochrome #FFFFFF here)
 *   actions/counter/key.png, @2x      72 / 144 px   default Counter key — build/icon.png on
 *                                                   the abyss background
 *   actions/<action>/icon.svg                        action-list icon: white line glyph
 *   actions/<action>/key.svg                         default key for the other actions
 *
 * The plugin replaces the key images with live faces as soon as it runs
 * (streamdeck/src/faces/render.ts); these are what Stream Deck shows in its
 * action list and before the plugin has started. Glyphs and colours come from
 * streamdeck/src/faces/theme.json, shared with the live faces.
 *
 * Dependency-free: Electron's own image pipeline does the resampling (Skia, Lanczos with
 * `quality: 'best'`), so this runs under Electron rather than plain Node:
 *
 *   npx electron scripts/streamdeck-icons.mjs
 *
 * It opens no window and quits when done. Re-run it when build/icon.png or theme.json change.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { app, nativeImage } from 'electron';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_MASTER = join(ROOT, 'build', 'icon.png');
const THEME = join(ROOT, 'streamdeck', 'src', 'faces', 'theme.json');
const IMGS = join(ROOT, 'streamdeck', 'app.biolume.streamdeck.sdPlugin', 'imgs');

/** A pixel counts as content from this alpha up; fainter specks of fringe are ignored. */
const ALPHA_THRESHOLD = 8;
/** Transparent breathing room kept around the trimmed icon, as a share of its size. */
const ICON_MARGIN = 0.015;
/** Share of the default Counter key the app icon fills. */
const KEY_ICON_SCALE = 0.8;
/**
 * Category icon: how bright (0–255, Rec. 709 luma) a pixel of the icon must be to
 * count as light, and the luma from which it is fully opaque.
 */
const LIGHT_FROM = 150;
const LIGHT_FULL = 225;

app.setPath('userData', join(tmpdir(), 'biolume-streamdeck-icons'));
app.disableHardwareAcceleration();

/** @type {{ palette: Record<string, string>, actions: Record<string, { label: string, tone: string, glyph: { stroke: string[], fill: string[] } }> }} */
const theme = JSON.parse(readFileSync(THEME, 'utf8'));
const P = theme.palette;

// ───────────────────────────── Raster helpers ─────────────────────────────

/** @param {string} file */
function load(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`Could not read ${relative(ROOT, file)}`);
  return image;
}

/** Bounding box of the pixels at or above ALPHA_THRESHOLD (alpha is the 4th byte in BGRA and RGBA). @param {Electron.NativeImage} image */
function contentBounds(image) {
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) < ALPHA_THRESHOLD) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) throw new Error('The image is fully transparent');
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** The smallest square holding the content plus a margin. @param {Electron.NativeImage} image */
function squareCrop(image) {
  const size = image.getSize();
  const box = contentBounds(image);
  const side = Math.min(
    Math.round(Math.max(box.width, box.height) * (1 + 2 * ICON_MARGIN)),
    size.width,
    size.height,
  );
  const x = clamp(Math.round(box.x + box.width / 2 - side / 2), 0, size.width - side);
  const y = clamp(Math.round(box.y + box.height / 2 - side / 2), 0, size.height - side);
  return image.crop({ x, y, width: side, height: side });
}

/** @param {Electron.NativeImage} image @param {number} size */
function resizedPng(image, size) {
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

/**
 * Decodes a non-interlaced 8-bit RGB/RGBA PNG — what Chromium's encoder writes — to
 * straight (not premultiplied) RGBA.
 * @param {Buffer} png
 */
function decodePng(png) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  /** @type {Buffer[]} */
  const data = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colorType, , , interlace] = body.subarray(8, 13);
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(`Unsupported PNG (depth ${depth}, colour type ${colorType})`);
      }
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? out[(y - 1) * stride + i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (raw[line + i] + predictor) & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: out };
  const rgba = Buffer.alloc(width * height * 4, 0xff);
  for (let p = 0; p < width * height; p++) out.copy(rgba, p * 4, p * 3, p * 3 + 3);
  return { width, height, rgba };
}

/** @param {string} type @param {Buffer} body */
function pngChunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody) >>> 0, 0);
  return Buffer.concat([length, typeAndBody, crc]);
}

/** Straight RGBA -> PNG (colour type 6, filter 0 on every row). @param {number} width @param {number} height @param {Buffer} rgba */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {string} hex `#rrggbb` */
function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * The icon's light as a white mark: alpha follows the pixel's luma between
 * LIGHT_FROM and LIGHT_FULL (times its own alpha), colour is pure white.
 * @param {Buffer} png
 */
function whiteLight(png) {
  const { width, height, rgba } = decodePng(png);
  const out = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const r = rgba[p * 4] ?? 0;
    const g = rgba[p * 4 + 1] ?? 0;
    const b = rgba[p * 4 + 2] ?? 0;
    const a = rgba[p * 4 + 3] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const light = clamp((luma - LIGHT_FROM) / (LIGHT_FULL - LIGHT_FROM), 0, 1);
    out.fill(0xff, p * 4, p * 4 + 3);
    out[p * 4 + 3] = Math.round(light * a);
  }
  return encodePng(width, height, out);
}

/**
 * The app icon centred on the key's abyss gradient (opaque).
 * @param {Electron.NativeImage} icon @param {number} size
 */
function keyWithIcon(icon, size) {
  const inner = Math.round(size * KEY_ICON_SCALE);
  const mark = decodePng(resizedPng(icon, inner));
  const top = rgb(P.abyss600);
  const middle = rgb(P.abyss850);
  const bottom = rgb(P.abyss950);
  const out = Buffer.alloc(size * size * 4);
  const offset = Math.floor((size - inner) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Radial falloff from just above the centre, like the live faces' "sky".
      const d = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.18) / 0.9;
      const t = clamp(d, 0, 1);
      const [from, to, f] =
        t < 0.55 ? [top, middle, t / 0.55] : [middle, bottom, (t - 0.55) / 0.45];
      const bg = [0, 1, 2].map((i) => (from[i] ?? 0) + ((to[i] ?? 0) - (from[i] ?? 0)) * f);
      const mx = x - offset;
      const my = y - offset;
      let alpha = 0;
      let src = [0, 0, 0];
      if (mx >= 0 && my >= 0 && mx < inner && my < inner) {
        const at = (my * inner + mx) * 4;
        alpha = (mark.rgba[at + 3] ?? 0) / 255;
        src = [mark.rgba[at] ?? 0, mark.rgba[at + 1] ?? 0, mark.rgba[at + 2] ?? 0];
      }
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) {
        out[o + i] = Math.round((src[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha));
      }
      out[o + 3] = 0xff;
    }
  }
  return encodePng(size, size, out);
}

// ───────────────────────────── SVG ─────────────────────────────

const FONT = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const TONES = {
  glow: { main: P.cyan, sky: P.abyss600 },
  shiny: { main: P.gold, sky: P.abyss600 },
};

/** @param {string[]} list */
const paths = (list) => list.map((d) => `<path d="${d}"/>`).join('');

/** Action-list icon: the glyph as white lines on transparent. @param {{ stroke: string[], fill: string[] }} glyph */
function listIconSvg(glyph) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24">` +
    (glyph.stroke.length
      ? `<g fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths(glyph.stroke)}</g>`
      : '') +
    (glyph.fill.length ? `<g fill="#FFFFFF">${paths(glyph.fill)}</g>` : '') +
    `</svg>\n`
  );
}

/**
 * Default key: the same frame, glow, glyph and label as the live faces' action keys.
 * @param {{ label: string, tone: string, glyph: { stroke: string[], fill: string[] } }} action
 */
function keySvg(action) {
  const tone = action.tone === 'shiny' ? TONES.shiny : TONES.glow;
  const frame = TONES.glow;
  const size = 58;
  const scale = size / 24;
  const x = (72 - size / 2).toFixed(2);
  const y = (58 - size / 2).toFixed(2);
  const glyph = action.glyph;
  const label = action.label.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const labelSize = [...action.label].length <= 6 ? 26 : [...action.label].length <= 8 ? 23 : 19;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
    `<defs>` +
    `<radialGradient id="sky" cx="50%" cy="18%" r="90%"><stop offset="0" stop-color="${tone.sky}"/>` +
    `<stop offset="0.55" stop-color="${P.abyss850}"/><stop offset="1" stop-color="${P.abyss950}"/></radialGradient>` +
    `<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${tone.main}" stop-opacity="0.42"/>` +
    `<stop offset="0.6" stop-color="${tone.main}" stop-opacity="0.1"/><stop offset="1" stop-color="${tone.main}" stop-opacity="0"/></radialGradient>` +
    `</defs>` +
    `<rect width="144" height="144" fill="url(#sky)"/>` +
    `<rect x="5" y="5" width="134" height="134" rx="24" fill="none" stroke="${frame.main}" stroke-opacity="0.4" stroke-width="3"/>` +
    `<circle cx="72" cy="58" r="52" fill="url(#glow)"/>` +
    `<g transform="translate(${x} ${y}) scale(${scale.toFixed(4)})">` +
    (glyph.stroke.length
      ? `<g fill="none" stroke="${tone.main}" stroke-opacity="0.28" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${paths(glyph.stroke)}</g>` +
        `<g fill="none" stroke="${tone.main}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths(glyph.stroke)}</g>`
      : '') +
    (glyph.fill.length
      ? `<g fill="${tone.main}" stroke="${tone.main}" stroke-opacity="0.3" stroke-width="2.4" stroke-linejoin="round">${paths(glyph.fill)}</g>`
      : '') +
    `</g>` +
    `<text x="72" y="126" font-family="${FONT}" font-size="${labelSize}" font-weight="700" text-anchor="middle" fill="${P.ink100}">${label}</text>` +
    `</svg>\n`
  );
}

// ───────────────────────────── Run ─────────────────────────────

/** @param {string} file @param {Buffer | string} data */
function write(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  console.log(`  ${relative(ROOT, file).replaceAll('\\', '/')}  ${(bytes / 1024).toFixed(1)} KB`);
}

function run() {
  const icon = squareCrop(load(ICON_MASTER));
  const side = icon.getSize().width;
  console.log(`icon: master trimmed to ${side} x ${side}`);

  write(join(IMGS, 'plugin', 'marketplace.png'), resizedPng(icon, 256));
  write(join(IMGS, 'plugin', 'marketplace@2x.png'), resizedPng(icon, 512));
  write(join(IMGS, 'plugin', 'category.png'), whiteLight(resizedPng(icon, 28)));
  write(join(IMGS, 'plugin', 'category@2x.png'), whiteLight(resizedPng(icon, 56)));
  write(join(IMGS, 'actions', 'counter', 'key.png'), keyWithIcon(icon, 72));
  write(join(IMGS, 'actions', 'counter', 'key@2x.png'), keyWithIcon(icon, 144));

  for (const [kind, action] of Object.entries(theme.actions)) {
    write(join(IMGS, 'actions', kind, 'icon.svg'), listIconSvg(action.glyph));
    if (kind !== 'counter') write(join(IMGS, 'actions', kind, 'key.svg'), keySvg(action));
  }
}

app
  .whenReady()
  .then(() => {
    run();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
