/**
 * Bundles the plugin into app.biolume.streamdeck.sdPlugin/bin/plugin.js — the
 * setup `streamdeck create` scaffolds, plus @rollup/plugin-json for the shared
 * theme and the protocol module from ../src/shared (bundled in, so the plugin
 * has no runtime dependency on the app's sources).
 */
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';

const isWatching = Boolean(process.env.ROLLUP_WATCH);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const sdPlugin = 'app.biolume.streamdeck.sdPlugin';

/** @type {import('rollup').RollupOptions} */
const config = {
  input: 'src/plugin.ts',
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    format: 'es',
    sourcemap: isWatching,
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) =>
      url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href,
  },
  plugins: [
    {
      name: 'watch-externals',
      buildStart() {
        this.addWatchFile(`${sdPlugin}/manifest.json`);
      },
    },
    typescript({
      tsconfig: './tsconfig.json',
      // tsconfig's rootDir is the repo root (the protocol lives in ../src/shared), so
      // resolve these patterns from this folder rather than from rootDir.
      filterRoot: here,
      include: ['src/**/*.ts', '../src/shared/streamDeck.ts'],
      exclude: ['**/*.test.ts', 'vitest.config.ts'],
      noEmitOnError: !isWatching,
      outDir: `${sdPlugin}/bin`,
      mapRoot: isWatching ? './' : undefined,
    }),
    json({ preferConst: true }),
    nodeResolve({ browser: false, exportConditions: ['node'], preferBuiltins: true }),
    commonjs(),
    !isWatching && terser(),
    {
      name: 'emit-module-package-file',
      generateBundle() {
        this.emitFile({ fileName: 'package.json', source: `{ "type": "module" }`, type: 'asset' });
      },
    },
  ],
};

export default config;
