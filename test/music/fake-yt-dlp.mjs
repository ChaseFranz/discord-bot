// Stands in for yt-dlp in the YtDlpTrackSource tests:
//   node fake-yt-dlp.mjs <mode> <log file> <yt-dlp arguments...>
// It records its arguments and pid in the log file, then behaves as <mode> says.
import { writeFileSync } from 'node:fs';

const [mode, log, ...args] = process.argv.slice(2);
writeFileSync(log, JSON.stringify({ pid: process.pid, args }));

const fail = (message) => {
  process.stderr.write(`WARNING: [youtube] something minor\nERROR: ${message}\n`);
  process.exit(1);
};

switch (mode) {
  case 'version':
    process.stdout.write('2026.11.23\n');
    break;
  case 'found':
    process.stdout.write('{"id": "oWqAf4eex14", "title": "jellyfish jam", "duration": 151.6}\n');
    break;
  case 'nothing':
    break;
  case 'unavailable':
    fail('[youtube] oWqAf4eex14: Video unavailable');
    break;
  case 'audio':
    process.stdout.write(Buffer.alloc(64 * 1024, 1));
    process.stdout.write(Buffer.alloc(64 * 1024, 2));
    break;
  case 'audio-then-fail':
    process.stdout.write(Buffer.alloc(1024, 1), () => setTimeout(() => fail('[download] Got error: connection reset'), 50));
    break;
  case 'endless': {
    const chunk = Buffer.alloc(4 * 1024, 3);
    const write = () => process.stdout.write(chunk, () => setTimeout(write, 5));
    write();
    break;
  }
  case 'hang':
    setInterval(() => {}, 1_000);
    break;
  default:
    fail(`unknown mode ${mode}`);
}
