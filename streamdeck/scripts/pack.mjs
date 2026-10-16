/**
 * Builds, validates and packs the Stream Deck plugin into
 * build/streamdeck/app.biolume.streamdeck.streamDeckPlugin — the installer the
 * Biolume app ships and opens from Settings (`npm run dist` runs this first).
 *
 *   node streamdeck/scripts/pack.mjs               install deps if missing, typecheck,
 *                                                  bundle, smoke-test the bundle,
 *                                                  validate, pack
 *   node streamdeck/scripts/pack.mjs --build-only  stop after the bundle
 *
 * Root shortcuts: `npm run streamdeck:pack`, `npm run streamdeck:build`.
 * Tools run straight from this package's node_modules through the current Node,
 * so no shell is involved (except for a bare `npm ci` outside npm).
 */
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..');
const SD_PLUGIN = 'app.biolume.streamdeck.sdPlugin';
const MANIFEST = join(PLUGIN_ROOT, SD_PLUGIN, 'manifest.json');
const OUT_DIR = join(REPO_ROOT, 'build', 'streamdeck');
const OUT_FILE = join(OUT_DIR, 'app.biolume.streamdeck.streamDeckPlugin');
const CLI = '@elgato/cli/bin/streamdeck.mjs';

class StepFailed extends Error {}

/**
 * Runs a command in the plugin folder; throws StepFailed unless it exits cleanly.
 * @param {string} label @param {string} command @param {string[]} args @param {boolean} [shell]
 */
function run(label, command, args, shell = false) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, { cwd: PLUGIN_ROOT, stdio: 'inherit', shell });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new StepFailed(`${label} failed (exit code ${result.status}).`);
}

/** Runs a package's JS entry point with this Node. @param {string} label @param {string} entry @param {string[]} args */
function tool(label, entry, args) {
  run(label, process.execPath, [join(PLUGIN_ROOT, 'node_modules', ...entry.split('/')), ...args]);
}

/** A fresh clone has no node_modules here; `npm ci` installs exactly the lock file. */
function ensureDependencies() {
  const needed = ['@elgato/cli', '@elgato/streamdeck', 'rollup', 'typescript', 'ws'];
  if (needed.every((name) => existsSync(join(PLUGIN_ROOT, 'node_modules', ...name.split('/'))))) {
    return;
  }
  const npmCli = process.env['npm_execpath'];
  if (npmCli && /\.c?js$/.test(npmCli)) {
    run('npm ci (streamdeck)', process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund']);
  } else {
    run('npm ci (streamdeck)', 'npm', ['ci', '--no-audit', '--no-fund'], true);
  }
}

/** The manifest's version should follow the app's; only a warning. @param {Buffer} manifestSource */
function checkVersion(manifestSource) {
  const appVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const { Version } = JSON.parse(manifestSource.toString('utf8'));
  if (typeof appVersion === 'string' && !String(Version).startsWith(`${appVersion}.`)) {
    console.warn(
      `\nNote: manifest.json Version ${Version} does not match Biolume ${appVersion} ` +
        `(expected ${appVersion}.0). Update it when releasing.`,
    );
  }
}

function main() {
  ensureDependencies();

  tool('typecheck', 'typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.json']);
  tool('bundle', 'rollup/dist/bin/rollup', ['-c']);
  if (process.argv.includes('--build-only')) return;

  // Boot the bundle against a fake Stream Deck and a fake Biolume.
  run('smoke test', process.execPath, [join(PLUGIN_ROOT, 'scripts', 'smoke.mjs')]);

  const manifestSource = readFileSync(MANIFEST);
  checkVersion(manifestSource);

  // `--no-update-check` keeps builds offline and reproducible; run
  // `npx streamdeck validate app.biolume.streamdeck.sdPlugin --force-update-check` now and then.
  tool('validate', CLI, ['validate', SD_PLUGIN, '--no-update-check']);
  mkdirSync(OUT_DIR, { recursive: true });
  try {
    tool('pack', CLI, ['pack', SD_PLUGIN, '--output', OUT_DIR, '--force', '--no-update-check']);
  } finally {
    // `streamdeck pack` re-serialises manifest.json in place (same content, its own
    // formatting): put the source back byte for byte so a build never dirties it.
    if (!readFileSync(MANIFEST).equals(manifestSource)) writeFileSync(MANIFEST, manifestSource);
  }

  if (!existsSync(OUT_FILE)) {
    throw new StepFailed(`Expected ${relative(REPO_ROOT, OUT_FILE)} after packing; it is missing.`);
  }
  const kb = (statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`\n${relative(REPO_ROOT, OUT_FILE).replaceAll('\\', '/')}  ${kb} KB`);
}

try {
  main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
