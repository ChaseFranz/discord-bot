#!/usr/bin/env node
// Stands in for yt-dlp when the real helper script is tested. What it does depends on the target:
// a target with "nothing" in it finds nothing, "unavailable" fails, "endless" never stops sending,
// "live" is a live stream (a burst, then a trickle for as long as it is left running, and only
// with ffmpeg), and anything else is a 600,000-byte "song" whose bytes follow a known pattern.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2026.11.23');
  process.exit(0);
}
if (args[0] === '-U') {
  console.log('yt-dlp is up to date (stable@2026.11.23)');
  process.exit(0);
}
// For tests that look at how it was started.
if (process.env.FAKE_YT_DLP_ARGS_FILE) writeFileSync(process.env.FAKE_YT_DLP_ARGS_FILE, JSON.stringify(args));
const target = args[args.indexOf('--') + 1] ?? '';
const detailsFile = args[args.indexOf('--print-to-file') + 2];
const write = (bytes) => new Promise((resolve) => process.stdout.write(bytes, resolve));
const pattern = (start, length) => Buffer.from(Array.from({ length }, (_, index) => (start + index) % 251));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (target.includes('nothing')) process.exit(0);
if (target.includes('unavailable')) {
  process.stderr.write('WARNING: something minor\nERROR: [youtube] aaaaaaaaaaa: This video is unavailable\n');
  process.exit(1);
}
if (target.includes('live')) {
  // As yt-dlp does: it says which video it is, and only then finds it has no ffmpeg to fetch it with.
  writeFileSync(detailsFile, `${JSON.stringify({ id: 'rFZHOHl-L8A', title: 'lofi hip hop radio 2026-11-27 12:40', is_live: true })}\n`);
  if (!args.includes('--ffmpeg-location')) {
    await pause(Number(process.env.FAKE_YT_DLP_FAIL_AFTER_MS ?? 0));
    process.stderr.write('ERROR: m3u8 download detected but ffmpeg could not be found. Please install\n');
    process.exit(1);
  }
  await write(pattern(0, 300_000));
  for (let sent = 300_000; ; sent += 20_000) {
    await pause(100);
    await write(pattern(sent, 20_000));
  }
}
writeFileSync(detailsFile, `${JSON.stringify({ id: 'oWqAf4eex14', title: 'jellyfish jam', duration: 151, is_live: false })}\n`);
if (target.includes('endless')) {
  for (let sent = 0; ; sent += 65_536) {
    await write(pattern(sent, 65_536));
    await pause(20);
  }
}
for (let sent = 0; sent < 600_000; sent += 50_000) await write(pattern(sent, 50_000));
