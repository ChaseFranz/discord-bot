import { GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { NewReminder, Reminder, ReminderRepository, RepeatRule } from '../ports.js';
import { systemClock, type Clock } from '../../util/time.js';
import { expiryAfter, isConflict, names, nextId, pad, queryAll, type Item } from './dynamo.js';
import { GSI1, GSI2 } from './schema.js';

const SK = 'REMINDER';
const DUE = 'REMINDER_DUE';

/**
 * Reminders under `REMINDER#<id>`. While a reminder is active it appears in two sparse indexes:
 * gsi1 (`REMINDERS#<guild>#<user>`, a person's reminders by due time) and gsi2 (`REMINDER_DUE`,
 * everything by due time, for the scheduler). Finished reminders leave both and expire after the
 * retention period.
 */
export class DynamoReminderRepository implements ReminderRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly options: { retentionDays: number },
    private readonly clock: Clock = systemClock,
  ) {}

  async create(reminder: NewReminder): Promise<Reminder> {
    const id = await nextId(this.doc, this.table, 'reminder');
    const stored: Reminder = { ...reminder, id, firedCount: 0, lastFiredAt: null, status: 'active' };
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: key(id), sk: SK, ...stored, updatedAt: reminder.createdAt, ...activeIndexes(stored, reminder.dueAt) },
      }),
    );
    return stored;
  }

  async get(guildId: string, id: number): Promise<Reminder | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: key(id), sk: SK }, ConsistentRead: true }));
    return result.Item && result.Item.guildId === guildId ? toReminder(result.Item) : undefined;
  }

  async listActive(guildId: string, userId: string): Promise<Reminder[]> {
    const items = await queryAll(this.doc, {
      TableName: this.table,
      IndexName: GSI1,
      KeyConditionExpression: 'gsi1pk = :owner',
      ExpressionAttributeValues: { ':owner': ownerKey(guildId, userId) },
    });
    return items.map(toReminder);
  }

  async countActive(guildId: string, userId: string): Promise<number> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: GSI1,
        KeyConditionExpression: 'gsi1pk = :owner',
        ExpressionAttributeValues: { ':owner': ownerKey(guildId, userId) },
        Select: 'COUNT',
      }),
    );
    return result.Count ?? 0;
  }

  async nextDue(): Promise<Reminder | undefined> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: GSI2,
        KeyConditionExpression: 'gsi2pk = :due',
        ExpressionAttributeValues: { ':due': DUE },
        Limit: 1,
      }),
    );
    const item = result.Items?.[0];
    return item ? toReminder(item) : undefined;
  }

  async listDue(now: number, limit: number): Promise<Reminder[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: GSI2,
        KeyConditionExpression: 'gsi2pk = :due AND gsi2sk <= :now',
        ExpressionAttributeValues: { ':due': DUE, ':now': `${pad(now)}#~` },
        Limit: limit,
      }),
    );
    return ((result.Items ?? []) as Item[]).map(toReminder);
  }

  async markFired(id: number, firedAt: number, nextDueAt: number | null): Promise<void> {
    const attr = names('status', 'firedCount', 'lastFiredAt', 'updatedAt', 'dueAt', 'expiresAt');
    const [status, firedCount, lastFiredAt, updatedAt, dueAt, expiresAt] = attr.refs as [string, string, string, string, string, string];
    try {
      if (nextDueAt === null) {
        const expiry = expiryAfter(firedAt, this.options.retentionDays);
        await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: key(id), sk: SK },
            UpdateExpression:
              `SET ${status} = :done, ${lastFiredAt} = :at, ${updatedAt} = :at${expiry === undefined ? '' : `, ${expiresAt} = :expires`} ` +
              `ADD ${firedCount} :one REMOVE gsi1pk, gsi1sk, gsi2pk, gsi2sk`,
            ConditionExpression: `${status} = :active`,
            ExpressionAttributeNames: expiry === undefined ? omit(attr.map, '#expiresAt', '#dueAt') : omit(attr.map, '#dueAt'),
            ExpressionAttributeValues: { ':done': 'done', ':active': 'active', ':at': firedAt, ':one': 1, ...(expiry === undefined ? {} : { ':expires': expiry }) },
          }),
        );
      } else {
        const sortKey = `${pad(nextDueAt)}#${pad(id)}`;
        await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: key(id), sk: SK },
            UpdateExpression: `SET ${dueAt} = :next, ${lastFiredAt} = :at, ${updatedAt} = :at, gsi1sk = :sortKey, gsi2sk = :sortKey ADD ${firedCount} :one`,
            ConditionExpression: `${status} = :active`,
            ExpressionAttributeNames: omit(attr.map, '#expiresAt'),
            ExpressionAttributeValues: { ':next': nextDueAt, ':at': firedAt, ':sortKey': sortKey, ':active': 'active', ':one': 1 },
          }),
        );
      }
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  async cancel(guildId: string, id: number): Promise<boolean> {
    const now = this.clock();
    const expiry = expiryAfter(now, this.options.retentionDays);
    const attr = names('status', 'updatedAt', 'guildId', 'expiresAt');
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: key(id), sk: SK },
          UpdateExpression: `SET #status = :cancelled, #updatedAt = :at${expiry === undefined ? '' : ', #expiresAt = :expires'} REMOVE gsi1pk, gsi1sk, gsi2pk, gsi2sk`,
          ConditionExpression: '#guildId = :guild AND #status = :active',
          ExpressionAttributeNames: expiry === undefined ? omit(attr.map, '#expiresAt') : attr.map,
          ExpressionAttributeValues: {
            ':cancelled': 'cancelled',
            ':active': 'active',
            ':at': now,
            ':guild': guildId,
            ...(expiry === undefined ? {} : { ':expires': expiry }),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }

  /** DynamoDB deletes finished reminders itself (TTL), so there is nothing to sweep. */
  async pruneFinishedBefore(_cutoff: number): Promise<number> {
    return 0;
  }
}

function key(id: number): string {
  return `REMINDER#${id}`;
}

function ownerKey(guildId: string, userId: string): string {
  return `REMINDERS#${guildId}#${userId}`;
}

function activeIndexes(reminder: Reminder, dueAt: number) {
  const sortKey = `${pad(dueAt)}#${pad(reminder.id)}`;
  return { gsi1pk: ownerKey(reminder.guildId, reminder.userId), gsi1sk: sortKey, gsi2pk: DUE, gsi2sk: sortKey };
}

function omit(map: Record<string, string>, ...refs: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(map).filter(([ref]) => !refs.includes(ref)));
}

function toReminder(item: Item): Reminder {
  return {
    id: Number(item.id),
    guildId: String(item.guildId),
    userId: String(item.userId),
    userName: String(item.userName),
    kind: item.kind as Reminder['kind'],
    message: String(item.message ?? ''),
    audience: item.audience as Reminder['audience'],
    channelId: String(item.channelId),
    dueAt: Number(item.dueAt),
    repeat: (item.repeat as RepeatRule | null | undefined) ?? null,
    timeZone: String(item.timeZone),
    durationMs: item.durationMs === null || item.durationMs === undefined ? null : Number(item.durationMs),
    createdAt: Number(item.createdAt),
    firedCount: Number(item.firedCount ?? 0),
    lastFiredAt: item.lastFiredAt === null || item.lastFiredAt === undefined ? null : Number(item.lastFiredAt),
    status: item.status as Reminder['status'],
  };
}
