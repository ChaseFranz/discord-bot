import { InteractionType, type APIInteraction } from 'discord-api-types/v10';
import { EPHEMERAL_COMMANDS } from '../discord/commandMeta.js';
import { initialResponse } from '../discord/httpEdge.js';

/** A Lambda function URL request (payload format 2.0), as much of it as the edge reads. */
export interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export interface EdgeDeps {
  verify(signature: string | undefined, timestamp: string | undefined, body: string): boolean;
  /** Passes the interaction to the worker without waiting for it (async Lambda invoke). */
  handOff(body: string): Promise<void>;
}

/**
 * Discord's Interactions Endpoint: rejects unsigned requests, answers Discord's PING, and for
 * everything else says "thinking…" right away and hands the interaction to the worker, which has
 * up to 15 minutes to edit that reply.
 */
export function createEdgeHandler(deps: EdgeDeps): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  return async (event) => {
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    const header = (name: string) => Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
    // Discord checks that invalid signatures are refused; it disables the endpoint otherwise.
    if (!deps.verify(header('x-signature-ed25519'), header('x-signature-timestamp'), body)) {
      return { statusCode: 401, body: 'invalid request signature' };
    }
    let interaction: APIInteraction;
    try {
      interaction = JSON.parse(body) as APIInteraction;
    } catch {
      return { statusCode: 400, body: 'body is not JSON' };
    }
    const response = initialResponse(interaction, EPHEMERAL_COMMANDS);
    if (!response) return { statusCode: 400, body: 'unsupported interaction type' };
    if (interaction.type !== InteractionType.Ping) await deps.handOff(body);
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(response) };
  };
}
