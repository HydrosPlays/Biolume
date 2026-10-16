import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  biolumeUserDataDir,
  currentOwnerUid,
  isPidAlive,
  pairingFilePath,
  readPairing,
} from './pairing';
import { TOKEN } from './testFixtures';

describe('biolumeUserDataDir / pairingFilePath', () => {
  it('uses %APPDATA%\\Biolume on Windows', () => {
    expect(
      pairingFilePath({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\ash\\AppData\\Roaming' },
        homedir: 'C:\\Users\\ash',
      }),
    ).toBe('C:\\Users\\ash\\AppData\\Roaming\\Biolume\\streamdeck-bridge.json');
  });

  it('falls back to the profile folder when APPDATA is missing', () => {
    expect(biolumeUserDataDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\ash' })).toBe(
      'C:\\Users\\ash\\AppData\\Roaming\\Biolume',
    );
  });

  it('uses Application Support on macOS and XDG on other systems', () => {
    expect(biolumeUserDataDir({ platform: 'darwin', env: {}, homedir: '/Users/ash' })).toBe(
      '/Users/ash/Library/Application Support/Biolume',
    );
    expect(biolumeUserDataDir({ platform: 'linux', env: {}, homedir: '/home/ash' })).toBe(
      '/home/ash/.config/Biolume',
    );
    expect(
      biolumeUserDataDir({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/cfg' },
        homedir: '/home/ash',
      }),
    ).toBe('/cfg/Biolume');
  });

  it('honours BIOLUME_USER_DATA (trimmed), like the app does', () => {
    expect(
      biolumeUserDataDir({
        platform: 'win32',
        env: { BIOLUME_USER_DATA: '  D:\\BiolumeData  ', APPDATA: 'C:\\x' },
        homedir: 'C:\\Users\\ash',
      }),
    ).toBe('D:\\BiolumeData');
    expect(
      biolumeUserDataDir({
        platform: 'darwin',
        env: { BIOLUME_USER_DATA: '/tmp/b' },
        homedir: '/',
      }),
    ).toBe('/tmp/b');
    expect(
      biolumeUserDataDir({ platform: 'darwin', env: { BIOLUME_USER_DATA: '   ' }, homedir: '/h' }),
    ).toBe('/h/Library/Application Support/Biolume');
  });
});

describe('isPidAlive', () => {
  it('is true for this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('is false for nonsense ids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it('is false once a process has exited', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid;
    await new Promise((resolve) => child.once('exit', resolve));
    expect(pid).toBeTypeOf('number');
    expect(isPidAlive(pid ?? 0)).toBe(false);
  });
});

describe('readPairing', () => {
  let dir: string;
  let file: string;
  const pairing = { protocol: 1, port: 47637, token: TOKEN, pid: process.pid, app: '0.1.0' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'biolume-sd-pairing-'));
    file = join(dir, 'streamdeck-bridge.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a live pairing', async () => {
    await writeFile(file, JSON.stringify(pairing));
    expect(await readPairing(file)).toEqual({ kind: 'ok', pairing });
  });

  it('tolerates a UTF-8 BOM', async () => {
    await writeFile(file, `\ufeff${JSON.stringify(pairing)}`);
    expect((await readPairing(file)).kind).toBe('ok');
  });

  it('reports a missing file (or folder) as missing', async () => {
    expect(await readPairing(file)).toEqual({ kind: 'missing' });
    expect(await readPairing(join(dir, 'nope', 'streamdeck-bridge.json'))).toEqual({
      kind: 'missing',
    });
  });

  it('reports a file whose process is gone as stale', async () => {
    await writeFile(file, JSON.stringify({ ...pairing, pid: 99_999 }));
    expect(await readPairing(file, { isPidAlive: () => false })).toEqual({
      kind: 'stale',
      pid: 99_999,
    });
  });

  it('rejects malformed, half-written, oversized and non-file entries', async () => {
    await writeFile(file, JSON.stringify(pairing).slice(0, 20));
    expect((await readPairing(file)).kind).toBe('invalid');

    await writeFile(file, JSON.stringify({ ...pairing, junk: 'x'.repeat(20_000) }));
    expect(await readPairing(file)).toEqual({ kind: 'invalid', reason: 'file too large' });

    await rm(file);
    await mkdir(file);
    expect((await readPairing(file)).kind).toBe('invalid');
  });

  it('reports another protocol version as incompatible', async () => {
    await writeFile(file, JSON.stringify({ ...pairing, protocol: 2 }));
    expect(await readPairing(file)).toEqual({ kind: 'incompatible', protocol: 2 });
  });

  // Regression: a pairing file another account planted (say under a shared
  // BIOLUME_USER_DATA folder) used to be trusted, sending every key press — and the
  // keys' faces — to that account's server.
  it('refuses a pairing file owned by another user', async () => {
    await writeFile(file, JSON.stringify(pairing));
    const { uid } = await stat(file);
    expect(await readPairing(file, { ownerUid: uid + 1 })).toEqual({
      kind: 'invalid',
      reason: 'not owned by this user',
    });
  });

  it('refuses a pairing file other users can write to', async () => {
    await writeFile(file, JSON.stringify(pairing));
    const { uid } = await stat(file);
    // On Windows chmod only toggles read-only: 0o666 reads back as writable by all, 0o400 as 0o444.
    await chmod(file, 0o666);
    expect(await readPairing(file, { ownerUid: uid })).toEqual({
      kind: 'invalid',
      reason: 'writable by other users',
    });
    await chmod(file, 0o400);
    try {
      expect(await readPairing(file, { ownerUid: uid })).toEqual({ kind: 'ok', pairing });
    } finally {
      await chmod(file, 0o600);
    }
  });

  it('checks the owner by default on macOS and Linux, never on Windows', () => {
    expect(currentOwnerUid()).toBe(process.platform === 'win32' ? null : process.getuid?.());
  });

  it.skipIf(process.platform === 'win32')(
    'does not hang on a FIFO put in place of the file',
    async () => {
      execFileSync('mkfifo', [file]);
      expect(await readPairing(file)).toEqual({ kind: 'invalid', reason: 'not a regular file' });
    },
  );

  it.skipIf(process.platform === 'win32')('does not follow a symlink', async () => {
    const elsewhere = join(dir, 'elsewhere.json');
    await writeFile(elsewhere, JSON.stringify(pairing));
    await symlink(elsewhere, file);
    expect((await readPairing(file)).kind).toBe('invalid');
  });
});
