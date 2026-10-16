/**
 * Makes every derived copy of the app icon and the logo from the two masters:
 *
 *   build/icon.png   1254 x 1254 app icon, transparent background (master)
 *   docs/logo.png    1536 x 1024 "Biolume" wordmark, transparent background (master)
 *
 * into
 *
 *   build/icon.ico                  Windows icon: exe, installer, uninstaller, shortcuts
 *                                   (16-128 px as 32-bit BMP, 256 px as PNG — the layout
 *                                   NSIS's own icons use, so every consumer can read it)
 *   build/icon-256.png              runtime window / taskbar icon (src/main/windows.ts)
 *   src/renderer/assets/icon-*.png  title-bar / boot-screen mark, 22-128 px
 *   src/renderer/assets/logo.png    Settings > Data & About, 960 px wide
 *
 * The transparent margin around each master is trimmed first, so the mark fills its box.
 *
 * Dependency-free: Electron's own image pipeline does the resampling (Skia, Lanczos with
 * `quality: 'best'`), so this runs under Electron rather than plain Node:
 *
 *   npx electron scripts/resize-images.mjs
 *
 * It opens no window and quits when done. Re-run it whenever a master changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { app, nativeImage } from 'electron';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_MASTER = join(ROOT, 'build', 'icon.png');
const LOGO_MASTER = join(ROOT, 'docs', 'logo.png');
const ASSETS = join(ROOT, 'src', 'renderer', 'assets');

/** Sizes in the .ico: Windows' small/large icon at 100-200 % scaling, Explorer views, jumbo. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
/**
 * The mark in the UI, picked per DPI through srcset (layout/Logo.tsx): 22 and 44 are the
 * title bar (22 CSS px) at 100 / 200 % pixel for pixel, the rest cover other scalings and
 * the 44 px boot screen.
 */
const UI_ICON_SIZES = [22, 32, 44, 64, 128];
const WINDOW_ICON_SIZE = 256;
const LOGO_WIDTH = 960;
/** A pixel counts as content from this alpha up; fainter specks of fringe are ignored. */
const ALPHA_THRESHOLD = 8;
/** Transparent breathing room kept around the trimmed content, as a share of its size. */
const ICON_MARGIN = 0.015;
const LOGO_MARGIN = 0.02;

// Chromium keeps a profile even for a windowless run: one fixed scratch folder that every run
// reuses, rather than the user's AppData.
app.setPath('userData', join(tmpdir(), 'biolume-resize-images'));
app.disableHardwareAcceleration();

// ───────────────────────────── Images ─────────────────────────────

/** @param {string} file */
function load(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`Could not read ${relative(ROOT, file)}`);
  return image;
}

/**
 * Bounding box of the pixels at or above ALPHA_THRESHOLD. `toBitmap()` is BGRA or RGBA
 * depending on the platform; alpha is the fourth byte either way.
 * @param {Electron.NativeImage} image
 */
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

/**
 * The smallest square holding the content plus a margin, centred on the content.
 * @param {Electron.NativeImage} image
 */
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

/**
 * The content plus a margin, keeping its own aspect ratio.
 * @param {Electron.NativeImage} image
 */
function trimCrop(image) {
  const size = image.getSize();
  const box = contentBounds(image);
  const padX = Math.round(box.width * LOGO_MARGIN);
  const padY = Math.round(box.height * LOGO_MARGIN);
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  const width = Math.min(size.width, box.x + box.width + padX) - x;
  const height = Math.min(size.height, box.y + box.height + padY) - y;
  return image.crop({ x, y, width, height });
}

/** @param {Electron.NativeImage} image @param {number} width @param {number} [height] */
function resizedPng(image, width, height) {
  const resized = image.resize({
    width,
    ...(height === undefined ? {} : { height }),
    quality: 'best',
  });
  return resized.toPNG();
}

// ───────────────────────────── PNG → RGBA ─────────────────────────────

/**
 * Decodes a non-interlaced 8-bit RGB/RGBA PNG — what Chromium's encoder writes — to
 * straight (not premultiplied) RGBA, which the BMP images in an .ico need.
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

// ───────────────────────────── .ico ─────────────────────────────

/**
 * One icon image as a 32-bit BMP: BITMAPINFOHEADER (height doubled for the mask),
 * bottom-up BGRA rows, then the 1-bit AND mask (set where fully transparent).
 * @param {Buffer} png
 */
function bmpImage(png) {
  const { width, height, rgba } = decodePng(png);
  const maskStride = Math.ceil(width / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(width * height * 4 + maskStride * height, 20);

  const pixels = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(maskStride * height);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = (row * width + x) * 4;
      pixels[to] = rgba[from + 2] ?? 0;
      pixels[to + 1] = rgba[from + 1] ?? 0;
      pixels[to + 2] = rgba[from] ?? 0;
      pixels[to + 3] = rgba[from + 3] ?? 0;
      if (rgba[from + 3] === 0) {
        const at = row * maskStride + (x >> 3);
        mask[at] = (mask[at] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

/** @param {{ size: number, png: Buffer }[]} images */
function buildIco(images) {
  const entries = images.map(({ size, png }) => ({
    size,
    // Vista and later read PNG at any size; BMP below 256 px keeps older readers happy.
    data: size >= 256 ? png : bmpImage(png),
  }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, data }, index) => {
    const at = index * 16;
    directory[at] = size >= 256 ? 0 : size;
    directory[at + 1] = size >= 256 ? 0 : size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

// ───────────────────────────── Run ─────────────────────────────

/** @param {string} file @param {Buffer} data */
function write(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(
    `  ${relative(ROOT, file).replaceAll('\\', '/')}  ${(data.length / 1024).toFixed(1)} KB`,
  );
}

function run() {
  const icon = squareCrop(load(ICON_MASTER));
  const side = icon.getSize().width;
  console.log(`icon: master trimmed to ${side} x ${side}`);

  write(
    join(ROOT, 'build', 'icon.ico'),
    buildIco(ICO_SIZES.map((size) => ({ size, png: resizedPng(icon, size, size) }))),
  );
  write(
    join(ROOT, 'build', `icon-${WINDOW_ICON_SIZE}.png`),
    resizedPng(icon, WINDOW_ICON_SIZE, WINDOW_ICON_SIZE),
  );
  for (const size of UI_ICON_SIZES) {
    write(join(ASSETS, `icon-${size}.png`), resizedPng(icon, size, size));
  }

  const logo = trimCrop(load(LOGO_MASTER));
  const { width, height } = logo.getSize();
  console.log(`logo: master trimmed to ${width} x ${height}`);
  write(join(ASSETS, 'logo.png'), resizedPng(logo, LOGO_WIDTH));
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
