import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { createSignatureVerifier } from '../../discord/httpEdge.js';
import { createEdgeHandler } from '../edge.js';
import { loadAwsSettings } from '../settings.js';

/**
 * Lambda behind the function URL set as Discord's Interactions Endpoint. Kept small (no discord.js,
 * no Claude SDK) so even a cold start answers well inside Discord's 3 seconds.
 */
const settings = loadAwsSettings(['DISCORD_PUBLIC_KEY', 'WORKER_FUNCTION_NAME']);
const lambda = new LambdaClient({});

export const handler = createEdgeHandler({
  verify: createSignatureVerifier(settings.DISCORD_PUBLIC_KEY),
  handOff: async (body) => {
    await lambda.send(new InvokeCommand({ FunctionName: settings.WORKER_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(body) }));
  },
});
