import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSetupCode } from '../../../src/music/relay/tokens.js';

/**
 * The installers that /musichelper gives the lines for, run the way a person runs them
 * (`curl … | sh -s -- <code>`, and the PowerShell line) against a stand-in for nodejs.org and
 * GitHub on this machine. They start the real helper, which ends once Nimbus (also a stand-in)
 * refuses its code. The Node.js they download is a stand-in too, with its checksum written into a
 * copy of the installer.
 */
const INSTALL_SH = join(process.cwd(), 'helper/install.sh');
const INSTALL_PS1 = join(process.cwd(), 'helper/install.ps1');
const HELPER = join(process.cwd(), 'helper/nimbus-music-helper.mjs');
const NODE_VERSION = /^NODE_VERSION=(\S+)$/m.exec(readFileSync(INSTALL_SH, 'utf8'))![1]!;
const PATIENCE_MS = 30_000;
const REFUSED = 'This helper code no longer works. Get a new one with /musichelper.';

/** Where a command is on this machine, if it is anywhere. */
function find(command: string): string | undefined {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const unix = process.platform === 'linux' || process.platform === 'darwin';
const pwsh = unix ? find('pwsh') : undefined;
/** The key the installers use for this kind of computer, as in node-v26.13.1-linux-x64. */
const platform = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

/** A stand-in Node.js: reports `version`, otherwise runs the real one (noting each script it is given in `marker`). */
const fakeNode = (version: string, marker?: string) =>
  ['#!/bin/sh', `if [ "$1" = --version ]; then echo v${version}; exit 0; fi`, marker ? `echo "$1" >> '${marker}'` : '', `exec '${process.execPath}' "$@"`, ''].join('\n');

/** Replaces `from` in `text`, which must match exactly once. */
function replaceOnce(text: string, from: string | RegExp, to: string): string {
  const matches = typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from.source, `${from.flags}g`)) ?? []).length;
  if (matches !== 1) throw new Error(`Expected one match for ${String(from)}, found ${matches}.`);
  return text.replace(from, to);
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('the music helper installers', () => {
  let server: Server;
  let address: string;
  /** What the stand-in for nodejs.org and GitHub serves, by path; anything else is a 404. */
  let served: Map<string, Buffer>;
  let requests: string[];
  let work: string;
  /** The person's home folder; the helper's folder is in it. */
  let home: string;
  /** The only folder on PATH: the commands the installers use, and a Node.js only when a test puts one there. */
  let bin: string;
  let code: string;

  beforeEach(async () => {
    served = new Map();
    requests = [];
    work = mkdtempSync(join(tmpdir(), 'nimbus-installer-test-'));
    home = join(work, 'home');
    bin = join(work, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests.push(`${request.method} ${request.url}`);
        // The stand-in Nimbus refuses every code, which ends the helper.
        if (request.method === 'POST' && request.url === '/poll') {
          response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: REFUSED }));
          return;
        }
        const body = served.get(request.url ?? '');
        if (body) response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(body);
        else response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    code = formatSetupCode(address, { guildId: '1083158655429509190', userId: '100000000000000001', secret: 'a'.repeat(43) });
    served.set('/helper/nimbus-music-helper.mjs', readFileSync(HELPER));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  });

  const helperHome = () => join(home, '.nimbus-music-helper');
  const nodeDownloads = () => requests.filter((request) => request.startsWith('GET /dist/'));
  /** A command the installers may use, put on PATH. */
  const provide = (...commands: string[]) => {
    for (const command of commands) {
      const found = find(command);
      if (found && !existsSync(join(bin, command))) symlinkSync(found, join(bin, command));
    }
  };
  /** A stand-in Node.js on PATH, as if it were installed. */
  const installNode = (version: string, marker?: string) => {
    writeFileSync(join(bin, 'node'), fakeNode(version, marker));
    chmodSync(join(bin, 'node'), 0o755);
  };
  /** Runs a command line as a person would, with only `bin` on PATH. Resolves when it has ended. */
  const run = (command: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(command, args, {
        env: {
          ...(command === pwsh ? process.env : {}),
          PATH: bin,
          HOME: home,
          // The helper is told there are a yt-dlp and an ffmpeg, so that it downloads neither.
          NIMBUS_YT_DLP: '/nowhere/yt-dlp',
          NIMBUS_FFMPEG: '/nowhere/ffmpeg',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (text: Buffer) => (output += text.toString()));
      child.stderr.on('data', (text: Buffer) => (output += text.toString()));
      child.once('close', (exit) => resolve({ code: exit, output }));
    });

  (unix ? describe : describe.skip)('macOS and Linux (install.sh)', () => {
    let tarball: Buffer;

    beforeEach(() => {
      provide('sh', 'curl', 'sed', 'cut', 'uname', 'mktemp', 'tar', 'gzip', 'mkdir', 'mv', 'rm', 'sha256sum', 'shasum', 'openssl');
      // A stand-in Node.js download: the program, and the rest of what comes with it.
      const unpacked = join(work, 'node-download');
      const top = join(unpacked, `node-v${NODE_VERSION}-${platform}`);
      mkdirSync(join(top, 'bin'), { recursive: true });
      mkdirSync(join(top, 'lib', 'node_modules', 'npm'), { recursive: true });
      writeFileSync(join(top, 'bin', 'node'), fakeNode(NODE_VERSION));
      chmodSync(join(top, 'bin', 'node'), 0o755);
      writeFileSync(join(top, 'lib', 'node_modules', 'npm', 'package.json'), '{}');
      execFileSync('tar', ['-czf', join(work, 'node.tar.gz'), '-C', unpacked, `node-v${NODE_VERSION}-${platform}`]);
      tarball = readFileSync(join(work, 'node.tar.gz'));
      served.set(`/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${platform}.tar.gz`, tarball);
      serveInstaller(sha256(tarball));
    });

    /** Serves a copy of install.sh that downloads from here, and expects a Node.js download with `checksum`. */
    const serveInstaller = (checksum: string) => {
      let script = readFileSync(INSTALL_SH, 'utf8');
      script = replaceOnce(script, 'NODE_DOWNLOADS="https://nodejs.org/dist/v$NODE_VERSION"', `NODE_DOWNLOADS="${address}/dist/v$NODE_VERSION"`);
      script = replaceOnce(script, /^HELPER_DOWNLOAD=.*$/m, `HELPER_DOWNLOAD=${address}/helper/nimbus-music-helper.mjs`);
      script = replaceOnce(script, new RegExp(`(    ${platform}\\) echo )[0-9a-f]{64}`), `$1${checksum}`);
      served.set('/install.sh', Buffer.from(script));
    };
    /** The line /musichelper gives: with the code the first time, without it after that. */
    const install = (...args: string[]) => run(join(bin, 'sh'), ['-c', `curl -fsSL ${address}/install.sh | sh -s -- "$@"`, 'sh', ...args]);

    it('sets up Node.js and the helper, and starts the helper with the code', async () => {
      const { code: exit, output } = await install(code);
      expect(output).toContain(`Downloading Node.js ${NODE_VERSION} (about 60 MB, this once)`);
      expect(output).toContain(`Node.js ${NODE_VERSION} is ready.`);
      // The helper started, saved the code, and says how to start it again: with this line.
      expect(output).toContain(`Saved your code in ${join(helperHome(), 'config.json')}. To start the helper again later, run the same line without the code at the end.`);
      expect(JSON.parse(readFileSync(join(helperHome(), 'config.json'), 'utf8'))).toMatchObject({ api: address });
      // It reached Nimbus, which turned the code down.
      expect(output).toContain(REFUSED);
      expect(exit).toBe(1);

      // Only the program itself is kept, and nothing half-done.
      expect(readdirSync(helperHome()).sort()).toEqual(['config.json', 'nimbus-music-helper.mjs', `node-v${NODE_VERSION}`]);
      expect(readdirSync(join(helperHome(), `node-v${NODE_VERSION}`))).toEqual(['node']);
      expect(statSync(join(helperHome(), `node-v${NODE_VERSION}`, 'node')).mode & 0o111).not.toBe(0);
      expect(readFileSync(join(helperHome(), 'nimbus-music-helper.mjs')).equals(readFileSync(HELPER))).toBe(true);
      expect(nodeDownloads()).toHaveLength(1);
    }, PATIENCE_MS);

    it('starts again from the saved code without downloading Node.js again, and brings the helper up to date', async () => {
      await install(code);
      const newer = Buffer.concat([readFileSync(HELPER), Buffer.from('// a newer helper\n')]);
      served.set('/helper/nimbus-music-helper.mjs', newer);

      const { output } = await install();
      expect(output).not.toContain('Downloading Node.js');
      expect(output).not.toContain('Saved your code');
      expect(output).toContain(REFUSED);
      expect(readFileSync(join(helperHome(), 'nimbus-music-helper.mjs')).equals(newer)).toBe(true);
      expect(nodeDownloads()).toHaveLength(1);
      expect(requests.filter((request) => request === 'POST /poll')).toHaveLength(2);
    }, PATIENCE_MS);

    it('uses a Node.js that is installed already when it is 22 or newer, and not an older one', async () => {
      const used = join(work, 'used');
      installNode('24.1.0', used);
      expect((await install(code)).output).toContain(REFUSED);
      expect(nodeDownloads()).toHaveLength(0);
      expect(readFileSync(used, 'utf8').trim()).toBe(join(helperHome(), 'nimbus-music-helper.mjs'));
      expect(existsSync(join(helperHome(), `node-v${NODE_VERSION}`))).toBe(false);

      installNode('20.11.0', used);
      const { output } = await install();
      expect(output).toContain(`Downloading Node.js ${NODE_VERSION}`);
      expect(output).toContain(REFUSED);
      expect(nodeDownloads()).toHaveLength(1);
    }, PATIENCE_MS);

    it('refuses a Node.js download that is not the one it expects, and leaves nothing behind', async () => {
      serveInstaller('0'.repeat(64));
      const { code: exit, output } = await install(code);
      expect(exit).toBe(1);
      expect(output).toContain('The Node.js download did not match its known checksum, so it was not used. Try again in a minute.');
      expect(output).not.toContain('Saved your code');
      expect(readdirSync(helperHome())).toEqual([]);
      expect(requests).not.toContain('POST /poll');
    }, PATIENCE_MS);

    it('replaces a Node.js it set up before, once the version it uses changes', async () => {
      const old = join(helperHome(), 'node-v24.0.0');
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, 'node'), fakeNode('24.0.0'));
      chmodSync(join(old, 'node'), 0o755);
      expect((await install(code)).output).toContain(`Node.js ${NODE_VERSION} is ready.`);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(join(helperHome(), `node-v${NODE_VERSION}`, 'node'))).toBe(true);
    }, PATIENCE_MS);

    it('starts the helper it has when GitHub cannot be reached, and needs GitHub the first time', async () => {
      await install(code);
      // A network that answers with a page of its own (a sign-in page, say), then none at all.
      served.set('/helper/nimbus-music-helper.mjs', Buffer.from('<html>Sign in to use this network</html>'));
      let { output } = await install();
      expect(output).toContain('Could not check for a newer helper, so starting the one you have.');
      expect(output).toContain(REFUSED);
      expect(readFileSync(join(helperHome(), 'nimbus-music-helper.mjs')).equals(readFileSync(HELPER))).toBe(true);

      served.delete('/helper/nimbus-music-helper.mjs');
      rmSync(join(helperHome(), 'nimbus-music-helper.mjs'));
      let exit: number | null;
      ({ code: exit, output } = await install());
      expect(exit).toBe(1);
      expect(output).toContain('Could not download the helper from GitHub. Check your internet connection and try again.');
      expect(existsSync(join(helperHome(), 'nimbus-music-helper.mjs.download'))).toBe(false);
    }, PATIENCE_MS);

    it('says so when there is no Node.js to download for this computer, or this is the Windows line\'s job', async () => {
      const uname = (system: string, machine: string) => {
        rmSync(join(bin, 'uname'), { force: true });
        writeFileSync(join(bin, 'uname'), `#!/bin/sh\nif [ "$1" = -s ]; then echo ${system}; else echo ${machine}; fi\n`);
        chmodSync(join(bin, 'uname'), 0o755);
      };
      uname('Linux', 'riscv64');
      let { code: exit, output } = await install(code);
      expect(exit).toBe(1);
      expect(output).toContain("There's no ready-made Node.js here for linux/riscv64. Install Node.js 22 or newer yourself (https://nodejs.org) and run this line again: it will use yours.");

      uname('MINGW64_NT-10.0-26100', 'x86_64');
      ({ code: exit, output } = await install(code));
      expect(exit).toBe(1);
      expect(output).toContain('This is the line for macOS and Linux. On Windows, use the Windows line from /musichelper.');
      expect(nodeDownloads()).toHaveLength(0);
    }, PATIENCE_MS);

    it('tells the helper started without a code how to start it with one, in terms of the line', async () => {
      const { code: exit, output } = await install();
      expect(exit).toBe(1);
      expect(output).toContain('No helper code saved yet. In Discord, run /musichelper and run the line it gives you, with your code at the end.');
    }, PATIENCE_MS);
  });

  (pwsh ? describe : describe.skip)('Windows (install.ps1, here in PowerShell 7)', () => {
    let zip: Buffer;

    beforeEach(() => {
      // A stand-in Node.js download for Windows: node.exe (runnable here), and the rest of what comes with it.
      const top = `node-v${NODE_VERSION}-win-x64`;
      const node = join(work, 'node.exe');
      writeFileSync(node, fakeNode(NODE_VERSION));
      execFileSync('python3', [
        '-c',
        [
          'import sys, zipfile',
          'with zipfile.ZipFile(sys.argv[1], "w") as z:',
          '    entry = zipfile.ZipInfo(sys.argv[2] + "/node.exe")',
          '    entry.external_attr = 0o100755 << 16',
          '    z.writestr(entry, open(sys.argv[3], "rb").read())',
          '    z.writestr(sys.argv[2] + "/npm.cmd", "@echo off")',
        ].join('\n'),
        join(work, 'node.zip'),
        top,
        node,
      ]);
      zip = readFileSync(join(work, 'node.zip'));
      served.set(`/dist/v${NODE_VERSION}/${top}.zip`, zip);
      serveInstaller(sha256(zip));
    });

    const serveInstaller = (checksum: string) => {
      let script = readFileSync(INSTALL_PS1, 'utf8');
      script = replaceOnce(script, '$NodeDownloads = "https://nodejs.org/dist/v$NodeVersion"', `$NodeDownloads = "${address}/dist/v$NodeVersion"`);
      script = replaceOnce(script, /^ {2}\$HelperDownload = '.*'$/m, `  $HelperDownload = '${address}/helper/nimbus-music-helper.mjs'`);
      script = replaceOnce(script, /('x64' {3}= ')[0-9a-f]{64}/, `$1${checksum}`);
      served.set('/install.ps1', Buffer.from(script));
    };
    /** The line /musichelper gives, as PowerShell runs it. */
    const install = (...args: string[]) =>
      run(pwsh!, ['-NoProfile', '-NonInteractive', '-Command', `& ([scriptblock]::Create((irm ${address}/install.ps1)))${args.map((arg) => ` ${arg}`).join('')}`], {
        USERPROFILE: home,
        PROCESSOR_ARCHITECTURE: 'AMD64',
      });

    it('sets up Node.js and the helper, and starts the helper with the code', async () => {
      const { output } = await install(code);
      expect(output).toContain(`Downloading Node.js ${NODE_VERSION} (about 40 MB, this once)`);
      expect(output).toContain(`Node.js ${NODE_VERSION} is ready.`);
      expect(output).toContain('To start the helper again later, run the same line without the code at the end.');
      expect(output).toContain(REFUSED);
      expect(readdirSync(helperHome()).sort()).toEqual(['config.json', 'nimbus-music-helper.mjs', `node-v${NODE_VERSION}`]);
      expect(readdirSync(join(helperHome(), `node-v${NODE_VERSION}`))).toEqual(['node.exe']);
      expect(nodeDownloads()).toHaveLength(1);

      // Again, without the code: no second download, and the saved code is used.
      const again = await install();
      expect(again.output).not.toContain('Downloading Node.js');
      expect(again.output).toContain(REFUSED);
      expect(nodeDownloads()).toHaveLength(1);
    }, PATIENCE_MS);

    it('uses a Node.js that is installed already when it is 22 or newer', async () => {
      const used = join(work, 'used');
      installNode('24.1.0', used);
      expect((await install(code)).output).toContain(REFUSED);
      expect(nodeDownloads()).toHaveLength(0);
      expect(readFileSync(used, 'utf8').trim()).toBe(join(helperHome(), 'nimbus-music-helper.mjs'));
    }, PATIENCE_MS);

    it('refuses a Node.js download that is not the one it expects, and leaves nothing behind', async () => {
      serveInstaller('0'.repeat(64));
      const { output } = await install(code);
      expect(output).toContain('The Node.js download did not match its known checksum, so it was not used. Try again in a minute.');
      expect(readdirSync(helperHome())).toEqual([]);
      expect(requests).not.toContain('POST /poll');
    }, PATIENCE_MS);

    it('starts the helper it has when GitHub cannot be reached, and needs GitHub the first time', async () => {
      await install(code);
      served.delete('/helper/nimbus-music-helper.mjs');
      let { output } = await install();
      expect(output).toContain('Could not check for a newer helper, so starting the one you have.');
      expect(output).toContain(REFUSED);

      rmSync(join(helperHome(), 'nimbus-music-helper.mjs'));
      ({ output } = await install());
      expect(output).toMatch(/Could not download the helper from GitHub \(.*\)\. Check your internet connection and try again\./);
    }, PATIENCE_MS);

    it('says so when there is no Node.js to download for this kind of Windows', async () => {
      const { output } = await run(pwsh!, ['-NoProfile', '-NonInteractive', '-Command', `& ([scriptblock]::Create((irm ${address}/install.ps1))) ${code}`], {
        USERPROFILE: home,
        PROCESSOR_ARCHITECTURE: 'x86',
      });
      expect(output).toContain("There's no ready-made Node.js here for this kind of Windows (x86).");
      expect(nodeDownloads()).toHaveLength(0);
    }, PATIENCE_MS);
  });

  it('pins the same Node.js in both installers, by checksum for every download', () => {
    const sh = readFileSync(INSTALL_SH, 'utf8');
    const ps1 = readFileSync(INSTALL_PS1, 'utf8');
    expect(/\$NodeVersion = '([^']+)'/.exec(ps1)?.[1]).toBe(NODE_VERSION);
    for (const key of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) expect(sh).toMatch(new RegExp(`    ${key}\\) echo [0-9a-f]{64} ;;`));
    for (const key of ['x64', 'arm64']) expect(ps1).toMatch(new RegExp(`'${key}' += '[0-9a-f]{64}'`));
    // Both fetch the helper from the same place, and PowerShell can read the file however Windows is set up.
    const helperUrl = (text: string) => /(https:\/\/raw\.githubusercontent\.com\/\S+\/nimbus-music-helper\.mjs)/.exec(text)?.[1];
    expect(helperUrl(sh)).toBe(helperUrl(ps1));
    expect(/^[\x20-\x7e\n]*$/.test(ps1)).toBe(true);
  });
});
