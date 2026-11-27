#!/usr/bin/env node
/**
 * Writes the bot's access key (from the nimbus/bot-access-key secret) into an env file without
 * printing it. Run from the repo root:
 *
 *   aws secretsmanager get-secret-value --secret-id nimbus/bot-access-key \
 *     --query SecretString --output text --profile admin | node infra/scripts/write-bot-credentials.mjs [.env]
 *
 * Existing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY lines (commented or not) are replaced; otherwise
 * they're added after AWS_REGION. The file is left readable only by you (mode 600).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2] ?? '.env';

let secret;
try {
  secret = JSON.parse(readFileSync(0, 'utf8').trim());
} catch {
  fail('Expected the secret JSON on stdin (use --query SecretString --output text).');
}
const { accessKeyId, secretAccessKey } = secret ?? {};
if (typeof accessKeyId !== 'string' || !/^A[A-Z0-9]{19}$/.test(accessKeyId)) {
  fail('The secret does not contain a valid accessKeyId.');
}
if (typeof secretAccessKey !== 'string' || secretAccessKey.length < 20) {
  fail('The secret does not contain a secretAccessKey.');
}
if (!existsSync(target)) fail(`${target} not found. Create it first with: cp .env.example .env`);

let lines = readFileSync(target, 'utf8').split('\n');
lines = upsert(lines, 'AWS_ACCESS_KEY_ID', accessKeyId, 'AWS_REGION');
lines = upsert(lines, 'AWS_SECRET_ACCESS_KEY', secretAccessKey, 'AWS_ACCESS_KEY_ID');
writeFileSync(target, lines.join('\n'), { mode: 0o600 });
chmodSync(target, 0o600);
console.log(`Wrote AWS_ACCESS_KEY_ID=…${accessKeyId.slice(-4)} and AWS_SECRET_ACCESS_KEY (not shown) to ${target}.`);

function upsert(lines, key, value, afterKey) {
  const entry = `${key}=${value}`;
  const existing = lines.findIndex((line) => new RegExp(`^\\s*#?\\s*${key}=`).test(line));
  if (existing !== -1) {
    lines[existing] = entry;
    return lines;
  }
  const anchor = lines.findIndex((line) => new RegExp(`^\\s*${afterKey}=`).test(line));
  if (anchor !== -1) {
    lines.splice(anchor + 1, 0, entry);
    return lines;
  }
  return [...lines, entry];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
