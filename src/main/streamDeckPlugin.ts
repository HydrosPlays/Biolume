/**
 * The Biolume Stream Deck plugin installer (`.streamDeckPlugin`) that ships
 * with the app. Opening it makes the Elgato Stream Deck app offer to install
 * the plugin.
 *
 *   packaged   <resources>/streamdeck/<file>  (electron-builder `extraResources`)
 *   dev        <project>/build/streamdeck/<file>
 *
 * This module must stay free of `electron` imports so it can be unit-tested;
 * `main.ts` passes `app.isPackaged`, `process.resourcesPath`, `app.getAppPath()`
 * and `shell.openPath`.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeError } from './dataFiles';

export const STREAM_DECK_PLUGIN_FILE = 'app.biolume.streamdeck.streamDeckPlugin';

export interface PluginLocation {
  packaged: boolean;
  /** `process.resourcesPath`. */
  resourcesPath: string;
  /** `app.getAppPath()` — the project root in development. */
  appPath: string;
}

export function resolveBundledPluginPath(location: PluginLocation): string {
  return location.packaged
    ? join(location.resourcesPath, 'streamdeck', STREAM_DECK_PLUGIN_FILE)
    : join(location.appPath, 'build', 'streamdeck', STREAM_DECK_PLUGIN_FILE);
}

/** Whether the installer exists as a regular file. */
export function isPluginBundled(pluginPath: string): boolean {
  try {
    return existsSync(pluginPath) && statSync(pluginPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Hands the installer to the OS. `openPath` is Electron's `shell.openPath`,
 * which resolves with an error message, or '' on success. Never throws.
 */
export async function openBundledPlugin(
  pluginPath: string,
  openPath: (path: string) => Promise<string>,
): Promise<{ ok: boolean; error?: string }> {
  if (!isPluginBundled(pluginPath)) {
    return {
      ok: false,
      error: 'The Stream Deck plugin is not included in this build of Biolume.',
    };
  }
  try {
    const problem = await openPath(pluginPath);
    if (problem === '') return { ok: true };
    return {
      ok: false,
      error: `The plugin could not be opened (${problem}). Is the Elgato Stream Deck app installed?`,
    };
  } catch (error) {
    return { ok: false, error: `The plugin could not be opened: ${describeError(error)}` };
  }
}
