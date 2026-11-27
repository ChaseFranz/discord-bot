#!/usr/bin/env node
// Stands in for yt-dlp when the real helper script is tested. What it does depends on the target:
// a target with "nothing" in it finds nothing, "unavailable" fails, "endless" never stops sending,
// and anything else is a 600,000-byte "song" whose bytes follow a known pattern.
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
const target = args[args.indexOf('--') + 1] ?? '';
const detailsFile = args[args.indexOf('--print-to-file') + 2];
const write = (bytes) => new Promise((resolve) => process.stdout.write(bytes, resolve));
const pattern = (start, length) => Buffer.from(Array.from({ length }, (_, index) => (start + index) % 251));

if (target.includes('nothing')) process.exit(0);
if (target.includes('unavailable')) {
  process.stderr.write('WARNING: something minor\nERROR: [youtube] aaaaaaaaaaa: This video is unavailable\n');
  process.exit(1);
}
writeFileSync(detailsFile, `${JSON.stringify({ id: 'oWqAf4eex14', title: 'jellyfish jam', duration: 151 })}\n`);
if (target.includes('endless')) {
  for (let sent = 0; ; sent += 65_536) {
    await write(pattern(sent, 65_536));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
for (let sent = 0; sent < 600_000; sent += 50_000) await write(pattern(sent, 50_000));
