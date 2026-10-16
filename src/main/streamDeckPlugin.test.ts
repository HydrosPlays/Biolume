import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STREAM_DECK_PLUGIN_FILE,
  isPluginBundled,
  openBundledPlugin,
  resolveBundledPluginPath,
} from './streamDeckPlugin';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'biolume-plugin-test-'));
  directories.push(directory);
  return directory;
}

describe('the bundled Stream Deck plugin', () => {
  it('lives in resources/streamdeck when packaged and build/streamdeck in development', () => {
    const location = { resourcesPath: join('R', 'resources'), appPath: join('P', 'project') };
    expect(resolveBundledPluginPath({ ...location, packaged: true })).toBe(
      join('R', 'resources', 'streamdeck', STREAM_DECK_PLUGIN_FILE),
    );
    expect(resolveBundledPluginPath({ ...location, packaged: false })).toBe(
      join('P', 'project', 'build', 'streamdeck', STREAM_DECK_PLUGIN_FILE),
    );
  });

  it('reports whether the installer file exists', () => {
    const directory = tempDir();
    const file = join(directory, STREAM_DECK_PLUGIN_FILE);
    expect(isPluginBundled(file)).toBe(false);
    mkdirSync(file);
    expect(isPluginBundled(file)).toBe(false);
    rmSync(file, { recursive: true });
    writeFileSync(file, 'zip');
    expect(isPluginBundled(file)).toBe(true);
  });

  it('opens the installer, and explains a missing file or a failed open', async () => {
    const directory = tempDir();
    const file = join(directory, STREAM_DECK_PLUGIN_FILE);
    const opened: string[] = [];
    const open = (path: string): Promise<string> => {
      opened.push(path);
      return Promise.resolve('');
    };

    const missing = await openBundledPlugin(file, open);
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not included/);
    expect(opened).toEqual([]);

    writeFileSync(file, 'zip');
    expect(await openBundledPlugin(file, open)).toEqual({ ok: true });
    expect(opened).toEqual([file]);

    const refused = await openBundledPlugin(file, () => Promise.resolve('No application'));
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/No application/);
    const thrown = await openBundledPlugin(file, () => Promise.reject(new Error('boom')));
    expect(thrown).toEqual({ ok: false, error: 'The plugin could not be opened: boom' });
  });
});
