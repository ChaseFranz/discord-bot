import { spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import type { Track, TrackSource } from './types.js';

export interface YtDlpOptions {
  /** The yt-dlp executable: a path, or a name on PATH. */
  executable?: string;
  /** Arguments placed before yt-dlp's own. Tests use it to run a stand-in script with Node. */
  prefixArgs?: readonly string[];
  /** The JavaScript runtime yt-dlp solves YouTube's player challenges with. Defaults to this Node. */
  nodePath?: string;
  /** How long a lookup, or the wait for a stream's first audio, may take. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const VIDEO_ID = /^[\w-]{11}$/;
/** Keeps the end of yt-dlp's messages for error reports. */
const STDERR_TAIL_BYTES = 4_000;

/**
 * YouTube audio through yt-dlp, which keeps up with YouTube's player changes faster than any
 * library. Only YouTube's extractors are enabled, so a link to anywhere else is never fetched.
 */
export class YtDlpTrackSource implements TrackSource {
  private readonly executable: string;
  private readonly prefixArgs: readonly string[];
  private readonly timeoutMs: number;
  private readonly commonArgs: readonly string[];

  constructor(options: YtDlpOptions = {}) {
    this.executable = options.executable ?? 'yt-dlp';
    this.prefixArgs = options.prefixArgs ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.commonArgs = [
      '--ignore-config',
      '--no-playlist',
      '--use-extractors', 'youtube,youtube:search',
      '--js-runtimes', `node:${options.nodePath ?? process.execPath}`,
    ];
  }

  /** yt-dlp's version, to confirm at startup that it's installed. */
  async version(): Promise<string> {
    const { stdout } = await this.run(['--version']);
    return stdout.trim();
  }

  async resolve(query: string): Promise<Track | null> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return null;
    const id = youTubeVideoId(trimmed);
    const target = id
      ? ['--skip-download', '--print', '%(.{id,title,duration})j', '--', watchUrl(id)]
      : ['--flat-playlist', '--print', '%(.{id,title,duration})j', '--', `ytsearch1:${trimmed}`];
    const { stdout } = await this.run([...this.commonArgs, ...target]);
    const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'));
    if (!line) return null;
    const info = JSON.parse(line) as { id?: unknown; title?: unknown; duration?: unknown };
    if (typeof info.id !== 'string' || !VIDEO_ID.test(info.id)) return null;
    const duration = typeof info.duration === 'number' && info.duration > 0 ? Math.round(info.duration) : undefined;
    return {
      title: typeof info.title === 'string' && info.title.length > 0 ? info.title : info.id,
      url: watchUrl(info.id),
      ...(duration ? { durationSeconds: duration } : {}),
    };
  }

  /** Streams the track's best audio. Resolves once audio is flowing, so a failure skips the track. */
  async open(track: Track): Promise<Readable> {
    const id = youTubeVideoId(track.url);
    if (!id) throw new Error(`Not a YouTube video: ${track.url}`);
    const child = spawn(this.executable, [...this.prefixArgs, ...this.commonArgs, '--quiet', '-f', 'bestaudio/best', '-o', '-', '--', watchUrl(id)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = keepTail(child.stderr);
    const running = () => child.exitCode === null && child.signalCode === null;
    const output = new PassThrough();
    // The output ends only after yt-dlp exits cleanly, so a failure part-way through is an error, not a short song.
    child.stdout.pipe(output, { end: false });
    // Whoever plays it destroys the output on skip or stop; yt-dlp mustn't keep downloading.
    output.once('close', () => {
      if (running()) child.kill('SIGTERM');
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          if (running()) child.kill('SIGTERM');
          output.destroy();
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => settle(new Error(`yt-dlp sent no audio within ${seconds(this.timeoutMs)}`)), this.timeoutMs);
      child.stdout.once('data', () => settle());
      child.once('error', (error) => settle(this.spawnError(error)));
      child.once('close', (code) => settle(new Error(failureMessage(stderr(), code))));
    });

    child.once('close', (code, signal) => {
      if (code === 0) output.end();
      else if (!output.destroyed) output.destroy(new Error(signal ? `yt-dlp was stopped (${signal})` : failureMessage(stderr(), code)));
    });
    return output;
  }

  /** Runs yt-dlp to completion and returns what it printed; rejects with its error message. */
  private run(args: readonly string[]): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...this.prefixArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const stderr = keepTail(child.stderr);
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      let settled = false;
      const settle = (result: { stdout: string } | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        settle(new Error(`yt-dlp took longer than ${seconds(this.timeoutMs)}`));
      }, this.timeoutMs);
      child.once('error', (error) => settle(this.spawnError(error)));
      child.once('close', (code) => {
        if (code === 0) settle({ stdout: Buffer.concat(chunks).toString('utf8') });
        else settle(new Error(failureMessage(stderr(), code)));
      });
    });
  }

  private spawnError(error: Error & { code?: string }): Error {
    return error.code === 'ENOENT'
      ? new Error(`yt-dlp isn't installed (looked for "${this.executable}"). Install it, or set YT_DLP_PATH.`, { cause: error })
      : error;
  }
}

/** The video ID in a YouTube link (watch, youtu.be, shorts, embed, live, music), or a bare ID. */
export function youTubeVideoId(input: string): string | undefined {
  const text = input.trim();
  // A bare ID. An all-lowercase word of the same length is a search, not an ID.
  if (VIDEO_ID.test(text)) return /^[a-z]+$/.test(text) ? undefined : text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null | undefined;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:[/?]|$)/.exec(url.pathname)?.[1];
  }
  return id && VIDEO_ID.test(id) ? id : undefined;
}

function seconds(ms: number): string {
  const whole = Math.max(1, Math.round(ms / 1000));
  return whole === 1 ? '1 second' : `${whole} seconds`;
}

function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Collects the end of a stream (yt-dlp's messages), returning a function that reads it. */
function keepTail(stream: Readable): () => string {
  let tail = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  return () => tail;
}

/** yt-dlp's own error line when it gave one, e.g. "[youtube] abc: Video unavailable". */
function failureMessage(stderr: string, code: number | null): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const error = [...lines].reverse().find((line) => line.startsWith('ERROR:'));
  const detail = error ? error.slice('ERROR:'.length).trim() : lines.at(-1);
  const status = code === null ? 'yt-dlp stopped' : `yt-dlp exited with code ${code}`;
  return detail ? `${status}: ${detail}` : status;
}
