#!/usr/bin/env node
/**
 * Nimbus music helper.
 *
 * YouTube won't send audio to the servers Nimbus runs on, so music is fetched by a helper like this
 * one, running on someone's own computer. While it runs, it asks Nimbus every few seconds whether
 * anyone has requested a song. When someone has, it downloads the audio from YouTube with yt-dlp
 * and uploads it to Nimbus, which plays it in the call.
 *
 *   node nimbus-music-helper.mjs <code>     first time: <code> is what /musichelper gave you
 *   node nimbus-music-helper.mjs            after that
 *   node nimbus-music-helper.mjs --forget   forget the saved code
 *
 * It needs Node.js 22 or newer and nothing else: it downloads yt-dlp itself, into
 * ~/.nimbus-music-helper. It only ever makes outgoing requests, to the address in your code, to
 * YouTube (through yt-dlp) and to GitHub (to download yt-dlp). See README.md next to this file.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '1.0.0';
/** How much audio goes up in each request: small enough that playback starts within a second or two. */
const CHUNK_BYTES = 256 * 1024;
/** Songs fetched at the same time, at most (people sometimes queue several at once). */
const MAX_JOBS = 3;
const YT_DLP_RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
/** yt-dlp is brought up to date this often, and whenever a song fails. */
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const WATCH_URL = /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/;
const NOTHING_FOUND = 'nothing-found';

const home = process.env.NIMBUS_HELPER_HOME || join(homedir(), '.nimbus-music-helper');
const configFile = join(home, 'config.json');
const running = new Map();
let stopping = false;

function say(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Your code
// ---------------------------------------------------------------------------

/** A setup code is "nimbus1." followed by where Nimbus is and your personal token. */
function parseCode(code) {
  if (typeof code !== 'string' || !code.startsWith('nimbus1.')) return undefined;
  try {
    const { api, token } = JSON.parse(Buffer.from(code.slice('nimbus1.'.length), 'base64url').toString('utf8'));
    if (typeof api !== 'string' || typeof token !== 'string' || !/^https?:\/\//.test(api)) return undefined;
    return { api: api.replace(/\/+$/, ''), token };
  } catch {
    return undefined;
  }
}

function loadConfig(argument) {
  mkdirSync(home, { recursive: true });
  if (argument) {
    const parsed = parseCode(argument.trim());
    if (!parsed) fail("That doesn't look like a helper code. Run /musichelper in Discord and copy the whole line it gives you.");
    // Readable by you only: the code lets its holder play audio through Nimbus as you.
    writeFileSync(configFile, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    say(`Saved your code in ${configFile}. From now on, "node nimbus-music-helper.mjs" is enough.`);
    return parsed;
  }
  if (!existsSync(configFile)) {
    fail('No helper code saved yet. In Discord, run /musichelper, then start this with the code it gives you:\n\n  node nimbus-music-helper.mjs <code>');
  }
  try {
    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    if (typeof saved.api === 'string' && typeof saved.token === 'string') return saved;
  } catch {
    // Falls through to the message below.
  }
  return fail(`${configFile} is damaged. Run /musichelper action:New code in Discord and start this with the new code.`);
}

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

function ytDlpAsset() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  if (process.platform === 'linux' && process.arch === 'x64') return 'yt-dlp_linux';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'yt-dlp_linux_aarch64';
  return undefined;
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: String(error.message) }));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Finds yt-dlp, downloading the official release for this computer the first time. */
async function ensureYtDlp() {
  if (process.env.NIMBUS_YT_DLP) return process.env.NIMBUS_YT_DLP;
  const asset = ytDlpAsset();
  if (!asset) {
    fail(`There's no ready-made yt-dlp for ${process.platform}/${process.arch}. Install yt-dlp yourself and set NIMBUS_YT_DLP to where it is.`);
  }
  const file = join(home, asset);
  if (!existsSync(file)) {
    say('Downloading yt-dlp (about 40 MB, this once)...');
    const [binary, sums] = await Promise.all([download(`${YT_DLP_RELEASES}/${asset}`), download(`${YT_DLP_RELEASES}/SHA2-256SUMS`)]);
    const expected = sums
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === asset)?.[0];
    const actual = createHash('sha256').update(binary).digest('hex');
    if (!expected || expected !== actual) throw new Error('The yt-dlp download did not match its published checksum. Try again in a minute.');
    writeFileSync(file, binary);
    if (process.platform !== 'win32') chmodSync(file, 0o755);
  }
  const version = await run(file, ['--version']);
  if (version.code !== 0) {
    rmSync(file, { force: true });
    throw new Error(`yt-dlp would not start (${version.stderr.trim() || `exit code ${version.code}`}). Start the helper again to download a fresh copy.`);
  }
  say(`yt-dlp ${version.stdout.trim()} is ready.`);
  return file;
}

let lastUpdate = Date.now();
let updating;

/** Brings yt-dlp up to date (YouTube changes often), at most once at a time. */
function updateYtDlp(ytDlp, why) {
  if (process.env.NIMBUS_YT_DLP) return Promise.resolve();
  updating ??= (async () => {
    say(`Checking for a newer yt-dlp (${why})...`);
    const result = await run(ytDlp, ['-U']);
    lastUpdate = Date.now();
    const line = (result.stdout + result.stderr).trim().split('\n').pop();
    if (line) say(line.trim());
  })().finally(() => {
    updating = undefined;
  });
  return updating;
}

// ---------------------------------------------------------------------------
// Talking to Nimbus
// ---------------------------------------------------------------------------

async function call(config, path, body) {
  const response = await fetch(`${config.api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: config.token, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const answer = await response.json().catch(() => ({}));
  if (response.status === 401) {
    fail(`${answer.error ?? 'Nimbus no longer accepts this helper code.'}\nThen start this again with the new code.`);
  }
  if (!response.ok) throw new Error(answer.error ?? `Nimbus answered ${response.status}`);
  return answer;
}

async function uploadChunk(upload, index, bytes) {
  for (let attempt = 1; ; attempt++) {
    try {
      const form = new FormData();
      for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
      form.append('key', `${upload.keyPrefix}${String(index).padStart(6, '0')}`);
      // The file has to be the last field.
      form.append('file', new Blob([bytes]), 'audio');
      const response = await fetch(upload.url, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`the upload was answered with ${response.status}`);
      return;
    } catch (error) {
      if (attempt >= 3) throw new Error(`Could not upload the audio: ${error.message}`);
      await sleep(500 * attempt);
    }
  }
}

// ---------------------------------------------------------------------------
// Fetching a song
// ---------------------------------------------------------------------------

/** What yt-dlp said went wrong, in a line. */
function reasonFrom(stderr, code) {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const error = [...lines].reverse().find((line) => line.startsWith('ERROR:'));
  return (error ? error.slice('ERROR:'.length).trim() : lines.at(-1)) || `yt-dlp stopped with code ${code}`;
}

/**
 * Downloads one request with yt-dlp and uploads the audio as it arrives. Resolves to how it went:
 * 'done', 'dropped' (Nimbus no longer wants it), or throws with the reason it failed.
 */
async function fetchSong(config, ytDlp, job) {
  const report = (body) => call(config, '/report', { jobId: job.id, ...body });
  // Only ever a YouTube video or a YouTube search, whatever is asked for.
  if (!WATCH_URL.test(job.target) && !job.target.startsWith('ytsearch1:')) throw new Error('That is not something this helper fetches.');
  const tmp = join(home, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const detailsFile = join(tmp, `${job.id.replace(/[^\w-]/g, '_')}.json`);
  rmSync(detailsFile, { force: true });

  const child = spawn(
    ytDlp,
    [
      '--ignore-config',
      '--no-playlist',
      '--use-extractors', 'youtube,youtube:search',
      // Node, which is running this script, also runs YouTube's player code for yt-dlp.
      '--js-runtimes', `node:${process.execPath}`,
      '--quiet',
      '--no-simulate',
      // Which video it turned out to be, written just before its download starts.
      '--print-to-file', 'before_dl:%(.{id,title,duration})j', detailsFile,
      '-f', 'bestaudio/best',
      '-o', '-',
      '--', job.target,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  running.set(job.id, child);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4_000)));
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: -1, error }));
    child.once('close', (code) => resolve({ code }));
  });

  let title;
  let dropped = false;
  const tellWhichVideo = async () => {
    if (title !== undefined || !existsSync(detailsFile)) return;
    const text = readFileSync(detailsFile, 'utf8').split('\n').find((line) => line.trim().startsWith('{'));
    if (!text) return;
    const details = JSON.parse(text);
    title = details.title ?? details.id;
    say(`Fetching "${title}"`);
    const answer = await report({ kind: 'found', videoId: details.id, title, ...(details.duration ? { durationSeconds: details.duration } : {}) });
    if (answer.ok === false) dropped = true;
  };
  // Nimbus is told which video it is as soon as yt-dlp knows, without waiting for the first audio.
  const watching = setInterval(() => void tellWhichVideo().catch(() => undefined), 150);

  let chunks = 0;
  let bytes = 0;
  let pending = [];
  let pendingBytes = 0;
  const send = async (buffer) => {
    await tellWhichVideo();
    if (dropped) return;
    await uploadChunk(job.upload, chunks, buffer);
    chunks++;
    bytes += buffer.length;
    const answer = await report({ kind: 'progress', chunks });
    if (answer.ok === false) dropped = true;
  };

  try {
    for await (const piece of child.stdout) {
      pending.push(piece);
      pendingBytes += piece.length;
      while (pendingBytes >= CHUNK_BYTES && !dropped) {
        const all = Buffer.concat(pending, pendingBytes);
        await send(all.subarray(0, CHUNK_BYTES));
        pending = [all.subarray(CHUNK_BYTES)];
        pendingBytes = all.length - CHUNK_BYTES;
      }
      if (dropped) break;
    }
    if (!dropped && pendingBytes > 0) await send(Buffer.concat(pending, pendingBytes));
    if (dropped) {
      child.kill();
      say(`Stopped fetching ${title ? `"${title}"` : 'that'}: it's no longer wanted.`);
      return 'dropped';
    }
    const { code, error } = await exited;
    if (error) throw new Error(`yt-dlp could not be started: ${error.message}`);
    if (code !== 0) throw new Error(reasonFrom(stderr, code));
    // Nothing came out and nothing went wrong: the search found nothing.
    if (chunks === 0) throw new Error(NOTHING_FOUND);
    await tellWhichVideo();
    await report({ kind: 'done', chunks });
    say(`Sent "${title ?? job.target}" (${(bytes / 1024 / 1024).toFixed(1)} MB).`);
    return 'done';
  } finally {
    clearInterval(watching);
    running.delete(job.id);
    if (child.exitCode === null) child.kill();
    rmSync(detailsFile, { force: true });
  }
}

async function handle(config, ytDlp, job) {
  try {
    await fetchSong(config, ytDlp, job);
  } catch (error) {
    const reason = error.message || 'something went wrong';
    if (reason === NOTHING_FOUND) say(`Nothing found for ${job.target.replace(/^ytsearch1:/, '"')}".`);
    else say(`Could not fetch that: ${reason}`);
    await call(config, '/report', { jobId: job.id, kind: 'failed', error: reason }).catch(() => undefined);
    // Most failures that aren't "no such video" mean YouTube changed something: a newer yt-dlp usually fixes it.
    if (reason !== NOTHING_FOUND && !/unavailable|private|not available in your country|removed/i.test(reason)) {
      await updateYtDlp(ytDlp, 'a song failed');
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) fail(`This needs Node.js 22 or newer (you have ${process.versions.node}). Get it from https://nodejs.org`);
  const argument = process.argv[2];
  if (argument === '--version') {
    console.log(VERSION);
    return;
  }
  if (argument === '--forget') {
    rmSync(configFile, { force: true });
    console.log('Forgot the saved code.');
    return;
  }
  if (argument === '--help' || argument === '-h') {
    console.log('Usage: node nimbus-music-helper.mjs [<code from /musichelper> | --forget | --version]');
    return;
  }

  const config = loadConfig(argument);
  const ytDlp = await ensureYtDlp();
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    for (const child of running.values()) child.kill();
    say('Stopped. Music needs a helper running, so start this again when you want it.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  say(`Nimbus music helper ${VERSION} is running. Leave this window open while you want music; Ctrl+C stops it.`);
  let connected = false;
  let waitMs = 3_000;
  while (!stopping) {
    try {
      const answer = await call(config, '/poll', { version: VERSION });
      if (!connected) say('Connected to Nimbus. Waiting for someone to ask for a song...');
      connected = true;
      waitMs = Number(answer.pollMs) > 0 ? Number(answer.pollMs) : 3_000;
      if (answer.job) void handle(config, ytDlp, answer.job);
      if (Date.now() - lastUpdate > UPDATE_EVERY_MS && running.size === 0) void updateYtDlp(ytDlp, 'daily check');
    } catch (error) {
      if (connected) say(`Lost touch with Nimbus (${error.message}). Trying again...`);
      connected = false;
      waitMs = Math.min(waitMs * 2, 30_000);
    }
    // Busy: don't take on more than a few songs at once.
    do {
      await sleep(waitMs);
    } while (running.size >= MAX_JOBS && !stopping);
  }
}

main().catch((error) => fail(error.message ?? String(error)));
