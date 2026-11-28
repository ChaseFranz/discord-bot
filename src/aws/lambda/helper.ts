import { S3Client } from '@aws-sdk/client-s3';
import { isLive } from '../../calls/voiceTask.js';
import { createLogger, describeError } from '../../logging/logger.js';
import { HelperApi } from '../../music/relay/HelperApi.js';
import { createDocumentClient } from '../../storage/dynamodb/dynamo.js';
import { systemClock } from '../../util/time.js';
import { DynamoVoiceTaskStore } from '../adapters.js';
import { DynamoHelperRegistry, DynamoMusicJobBoard, S3AudioRelayStore } from '../musicRelay.js';

/**
 * Lambda behind the public address music helpers talk to (a function URL). It only does what
 * HelperApi allows a valid helper token to do: check in, take a request for a song, and report on
 * it. It holds no Discord or Claude credentials. It also looks at whether the voice task is live,
 * to tell helpers how often to ask, and can read nothing else of its record.
 */
interface FunctionUrlEvent {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
let api: HelperApi | undefined;

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  try {
    api ??= createApi();
    const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const response = await api.handle({ method: event.requestContext?.http?.method ?? 'GET', path: event.rawPath ?? '/', body });
    return json(response.status, response.body);
  } catch (error) {
    logger.error(`The music helper endpoint failed: ${describeError(error)}`);
    return json(500, { error: 'Something went wrong on the Nimbus side. The helper will try again.' });
  }
}

function createApi(): HelperApi {
  const setting = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is not set (the CDK stack sets it).`);
    return value;
  };
  const table = setting('DYNAMODB_TABLE');
  const doc = createDocumentClient({ region: setting('AWS_REGION'), endpoint: process.env.DYNAMODB_ENDPOINT?.trim() || undefined });
  const voiceTasks = new DynamoVoiceTaskStore(doc, table);
  return new HelperApi({
    guildId: setting('GUILD_ID'),
    registry: new DynamoHelperRegistry(doc, table),
    board: new DynamoMusicJobBoard(doc, table),
    store: new S3AudioRelayStore(new S3Client({}), setting('MUSIC_RELAY_BUCKET')),
    clock: systemClock,
    logger,
    // The bot is in a call, or on its way to one, while its voice task is starting or running.
    inCall: async (guildId) => isLive(await voiceTasks.liveness(guildId), systemClock()),
  });
}

function json(statusCode: number, body: unknown): FunctionUrlResult {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}
