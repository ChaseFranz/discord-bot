import { randomUUID } from 'node:crypto';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  type CreateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  HEARTBEAT_STALE_MS,
  START_TIMEOUT_MS,
  type CallSnapshot,
  type ReceivedMessage,
  type VoiceTaskLauncher,
  type VoiceTaskMessage,
  type VoiceTaskQueue,
  type VoiceTaskRecord,
  type VoiceTaskStore,
} from '../calls/voiceTask.js';
import type { ReminderAlarm } from '../reminders/alarm.js';
import type { ReminderWakeUp } from '../reminders/wakeUp.js';
import type { Reminder } from '../storage/ports.js';
import { isConflict, names } from '../storage/dynamodb/dynamo.js';
import type { Clock } from '../util/time.js';

/** The voice task's status record, one item per guild in the main table: `VOICE#<guild>` / `TASK`. */
export class DynamoVoiceTaskStore implements VoiceTaskStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async get(guildId: string): Promise<VoiceTaskRecord | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: key(guildId), ConsistentRead: true }));
    const item = result.Item;
    if (!item) return undefined;
    return {
      guildId,
      status: item.status as VoiceTaskRecord['status'],
      startedAt: Number(item.startedAt),
      heartbeatAt: Number(item.heartbeatAt),
      ...(item.taskArn ? { taskArn: String(item.taskArn) } : {}),
      ...(item.call ? { call: item.call as CallSnapshot } : {}),
    };
  }

  async claimStart(guildId: string, now: number): Promise<boolean> {
    const attr = names('status', 'heartbeatAt', 'startedAt');
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...key(guildId), guildId, status: 'starting', startedAt: now, heartbeatAt: now },
          // Only if no task is recorded, or the recorded one has gone quiet.
          ConditionExpression:
            'attribute_not_exists(pk) OR (#status = :running AND #heartbeatAt < :staleRunning) OR (#status = :starting AND #startedAt < :staleStarting)',
          ExpressionAttributeNames: attr.map,
          ExpressionAttributeValues: {
            ':running': 'running',
            ':starting': 'starting',
            ':staleRunning': now - HEARTBEAT_STALE_MS,
            ':staleStarting': now - START_TIMEOUT_MS,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }

  async heartbeat(guildId: string, now: number, call: CallSnapshot | undefined): Promise<void> {
    const attr = names('status', 'heartbeatAt', 'startedAt', 'guildId', 'call');
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: key(guildId),
        UpdateExpression:
          'SET #status = :running, #heartbeatAt = :now, #startedAt = if_not_exists(#startedAt, :now), #guildId = :guild' +
          (call ? ', #call = :call' : ' REMOVE #call'),
        ExpressionAttributeNames: attr.map,
        ExpressionAttributeValues: { ':running': 'running', ':now': now, ':guild': guildId, ...(call ? { ':call': call } : {}) },
      }),
    );
  }

  async setTaskArn(guildId: string, taskArn: string): Promise<void> {
    const attr = names('taskArn');
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: key(guildId),
          UpdateExpression: 'SET #taskArn = :arn',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: attr.map,
          ExpressionAttributeValues: { ':arn': taskArn },
        }),
      );
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  async clear(guildId: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: key(guildId) }));
  }
}

function key(guildId: string) {
  return { pk: `VOICE#${guildId}`, sk: 'TASK' };
}

/**
 * Orders for the voice task on an SQS FIFO queue: one message group, so they're handled in order,
 * and deduplicated by interaction, so a retried relay doesn't run a command twice.
 */
export class SqsVoiceTaskQueue implements VoiceTaskQueue {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(message: VoiceTaskMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: 'voice',
        MessageDeduplicationId: message.kind === 'interaction' ? message.interaction.id : randomUUID(),
      }),
    );
  }

  async receive(waitSeconds: number, signal?: AbortSignal): Promise<ReceivedMessage[]> {
    try {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds, VisibilityTimeout: 120 }),
        { abortSignal: signal },
      );
      return (result.Messages ?? []).flatMap((message) =>
        message.Body && message.ReceiptHandle ? [{ message: JSON.parse(message.Body) as VoiceTaskMessage, receipt: message.ReceiptHandle }] : [],
      );
    } catch (error) {
      if (signal?.aborted) return [];
      throw error;
    }
  }

  async delete(receipt: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt }));
  }
}

export interface EcsLaunchConfig {
  cluster: string;
  taskDefinition: string;
  subnets: string[];
  securityGroups: string[];
}

/** Starts the voice task on Fargate, with a public IP (no NAT gateway needed to reach Discord). */
export class EcsVoiceTaskLauncher implements VoiceTaskLauncher {
  constructor(
    private readonly ecs: ECSClient,
    private readonly config: EcsLaunchConfig,
  ) {}

  async start(): Promise<string> {
    const result = await this.ecs.send(
      new RunTaskCommand({
        cluster: this.config.cluster,
        taskDefinition: this.config.taskDefinition,
        launchType: 'FARGATE',
        count: 1,
        startedBy: 'nimbus-voice',
        networkConfiguration: {
          awsvpcConfiguration: { subnets: this.config.subnets, securityGroups: this.config.securityGroups, assignPublicIp: 'ENABLED' },
        },
      }),
    );
    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const reasons = (result.failures ?? []).map((failure) => `${failure.reason ?? 'unknown'}${failure.detail ? ` (${failure.detail})` : ''}`);
      throw new Error(`ECS didn't start the voice task: ${reasons.join('; ') || 'no reason given'}`);
    }
    return taskArn;
  }
}

/** EventBridge Scheduler only fires within a minute of the requested time. */
const SCHEDULER_LEAD_MS = 2 * 60_000;
/** Reminders due sooner than this are handled by a Lambda that waits for the exact moment. */
export const DIRECT_WAIT_MS = 12 * 60_000;

export interface ReminderAlarmConfig {
  /** The reminder Lambda (it waits until the due time, then delivers). */
  functionArn: string;
  scheduleGroup: string;
  /** Role EventBridge Scheduler assumes to invoke the Lambda. */
  schedulerRoleArn: string;
}

/**
 * Wakes the reminder Lambda for each reminder, close enough before it's due that it can wait out
 * the rest and deliver on the second: directly (async invoke) when it's due within 12 minutes,
 * otherwise through a one-time EventBridge schedule 2 minutes early. One schedule per reminder,
 * deleted after it runs.
 */
export class AwsReminderAlarm implements ReminderAlarm {
  constructor(
    private readonly deps: { lambda: LambdaClient; scheduler: SchedulerClient; config: ReminderAlarmConfig; clock: Clock },
  ) {}

  async set(reminder: Reminder): Promise<void> {
    const wakeUp: ReminderWakeUp = { reminderId: reminder.id, guildId: reminder.guildId, dueAt: reminder.dueAt };
    const now = this.deps.clock();
    if (reminder.dueAt - now <= DIRECT_WAIT_MS) {
      await this.clear(reminder.id);
      await this.deps.lambda.send(
        new InvokeCommand({ FunctionName: this.deps.config.functionArn, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(wakeUp)) }),
      );
      return;
    }
    const input: CreateScheduleCommandInput = {
      Name: scheduleName(reminder.id),
      GroupName: this.deps.config.scheduleGroup,
      ScheduleExpression: `at(${new Date(reminder.dueAt - SCHEDULER_LEAD_MS).toISOString().slice(0, 19)})`,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: { Arn: this.deps.config.functionArn, RoleArn: this.deps.config.schedulerRoleArn, Input: JSON.stringify(wakeUp) },
    };
    try {
      await this.deps.scheduler.send(new CreateScheduleCommand(input));
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      // A repeating reminder moving on to its next time.
      await this.deps.scheduler.send(new UpdateScheduleCommand(input));
    }
  }

  async clear(reminderId: number): Promise<void> {
    try {
      await this.deps.scheduler.send(new DeleteScheduleCommand({ Name: scheduleName(reminderId), GroupName: this.deps.config.scheduleGroup }));
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
  }
}

function scheduleName(reminderId: number): string {
  return `nimbus-reminder-${reminderId}`;
}
