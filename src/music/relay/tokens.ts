import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** What a helper sends with every request: whose it is, and the secret that proves it. */
export interface HelperToken {
  guildId: string;
  userId: string;
  secret: string;
}

const SNOWFLAKE = /^\d{5,25}$/;
const SECRET = /^[A-Za-z0-9_-]{20,100}$/;
const SETUP_PREFIX = 'nimbus1.';

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Whether `secret` is the one whose hash was stored, without leaking how close it was. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const given = Buffer.from(hashSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

export function formatToken(token: HelperToken): string {
  return `${token.guildId}.${token.userId}.${token.secret}`;
}

export function parseToken(text: unknown): HelperToken | undefined {
  if (typeof text !== 'string' || text.length > 200) return undefined;
  const [guildId, userId, secret, ...rest] = text.split('.');
  if (rest.length > 0 || !guildId || !userId || !secret) return undefined;
  if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(userId) || !SECRET.test(secret)) return undefined;
  return { guildId, userId, secret };
}

/** The one string a person pastes into the helper: where the service is, and their token. */
export function formatSetupCode(apiUrl: string, token: HelperToken): string {
  return SETUP_PREFIX + Buffer.from(JSON.stringify({ api: apiUrl, token: formatToken(token) })).toString('base64url');
}

export function parseSetupCode(code: string): { apiUrl: string; token: string } | undefined {
  const trimmed = code.trim();
  if (!trimmed.startsWith(SETUP_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(trimmed.slice(SETUP_PREFIX.length), 'base64url').toString('utf8')) as { api?: unknown; token?: unknown };
    if (typeof parsed.api !== 'string' || !URL.canParse(parsed.api) || !parseToken(parsed.token)) return undefined;
    return { apiUrl: parsed.api, token: parsed.token as string };
  } catch {
    return undefined;
  }
}
