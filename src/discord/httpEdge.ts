import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { InteractionResponseType, InteractionType, MessageFlags, type APIInteraction } from 'discord-api-types/v10';

/**
 * The first step of an HTTPS interaction, which has to answer within 3 seconds: check Discord's
 * signature, then reply PONG or "thinking…". Only Discord's API types are imported here (not
 * discord.js), so the Lambda function doing this loads fast.
 */

// DER prefix that turns a raw 32-byte Ed25519 public key into SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** Reject requests signed more than this long ago (replays). */
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

/** Checks Discord's Ed25519 request signature (X-Signature-Ed25519 over X-Signature-Timestamp + body). */
export function createSignatureVerifier(publicKeyHex: string, now: () => number = Date.now) {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) throw new Error('DISCORD_PUBLIC_KEY must be the 64-character hex public key');
  const key: KeyObject = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  return (signatureHex: string | undefined, timestamp: string | undefined, body: string): boolean => {
    if (!signatureHex || !timestamp || !/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d+$/.test(timestamp)) return false;
    if (Math.abs(now() / 1000 - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS) return false;
    return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signatureHex, 'hex'));
  };
}

export interface InitialResponse {
  type: InteractionResponseType;
  data?: { flags?: number; content?: string };
}

/**
 * What to answer right away: PONG for Discord's endpoint check, otherwise "thinking…" (ephemeral
 * for ephemeral commands) so the real work can take longer than 3 seconds. Undefined for
 * interaction types the bot doesn't use.
 */
export function initialResponse(interaction: APIInteraction, ephemeralCommands: ReadonlySet<string>): InitialResponse | undefined {
  switch (interaction.type) {
    case InteractionType.Ping:
      return { type: InteractionResponseType.Pong };
    case InteractionType.ApplicationCommand:
      return {
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: ephemeralCommands.has(interaction.data.name) ? { flags: MessageFlags.Ephemeral } : {},
      };
    case InteractionType.MessageComponent:
      return { type: InteractionResponseType.DeferredMessageUpdate };
    default:
      return undefined;
  }
}
