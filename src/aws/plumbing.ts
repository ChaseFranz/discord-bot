import { LambdaClient } from '@aws-sdk/client-lambda';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SQSClient } from '@aws-sdk/client-sqs';
import { VoiceTaskAnnouncer } from '../calls/voiceTask.js';
import type { AppConfig } from '../config/config.js';
import { createDocumentClient } from '../storage/dynamodb/dynamo.js';
import type { StorageConfig } from '../storage/open.js';
import type { Clock } from '../util/time.js';
import { AwsReminderAlarm, DynamoVoiceTaskStore, SqsVoiceTaskQueue } from './adapters.js';
import type { AwsSettings } from './settings.js';

/** The DynamoDB settings; the AWS deployment always stores data in DynamoDB. */
export function dynamoBackend(config: AppConfig): Extract<StorageConfig, { kind: 'dynamodb' }> {
  const backend = config.storage.backend;
  if (backend.kind !== 'dynamodb') throw new Error('On AWS, set STORAGE=dynamodb (the CDK stack does).');
  return backend;
}

/** The voice task's status record and queue, and the announcer built on them. */
export function voiceTaskPlumbing(config: AppConfig, settings: Pick<AwsSettings, 'VOICE_QUEUE_URL'>, clock: Clock) {
  const backend = dynamoBackend(config);
  const store = new DynamoVoiceTaskStore(createDocumentClient({ region: backend.region, endpoint: backend.endpoint }), backend.table);
  const queue = new SqsVoiceTaskQueue(new SQSClient({}), settings.VOICE_QUEUE_URL);
  return { store, queue, announcer: new VoiceTaskAnnouncer({ store, queue, clock }) };
}

export function reminderAlarm(
  settings: Pick<AwsSettings, 'REMINDER_FUNCTION_ARN' | 'REMINDER_SCHEDULE_GROUP' | 'REMINDER_SCHEDULER_ROLE_ARN'>,
  clock: Clock,
): AwsReminderAlarm {
  return new AwsReminderAlarm({
    lambda: new LambdaClient({}),
    scheduler: new SchedulerClient({}),
    config: {
      functionArn: settings.REMINDER_FUNCTION_ARN,
      scheduleGroup: settings.REMINDER_SCHEDULE_GROUP,
      schedulerRoleArn: settings.REMINDER_SCHEDULER_ROLE_ARN,
    },
    clock,
  });
}
