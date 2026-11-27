import { gunzipSync, gzipSync } from 'node:zlib';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

export type Item = Record<string, unknown>;

export interface DynamoConnection {
  region: string;
  /** For DynamoDB Local (e.g. http://localhost:8000); leave unset for AWS. */
  endpoint?: string;
}

/** A document client that maps JS values to DynamoDB types (and drops undefined attributes). */
export function createDocumentClient(connection: DynamoConnection): DynamoDBDocumentClient {
  const local = connection.endpoint !== undefined && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(connection.endpoint);
  const client = new DynamoDBClient({
    region: connection.region,
    ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
    // DynamoDB Local accepts any credentials, but the SDK still needs some to sign with.
    ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

/** Zero-pads a non-negative integer so keys sort numerically (15 digits covers epoch ms and ids). */
export function pad(value: number): string {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`Can't use ${value} in a key`);
  return String(value).padStart(15, '0');
}

/** The largest value `pad` is used with in key ranges. */
export const MAX_KEY_NUMBER = 999_999_999_999_999;

/** Epoch seconds `retentionDays` after `epochMs`, for the TTL attribute; undefined keeps the item forever. */
export function expiryAfter(epochMs: number, retentionDays: number): number | undefined {
  return retentionDays > 0 ? Math.floor((epochMs + retentionDays * 86_400_000) / 1000) : undefined;
}

/**
 * Builds ExpressionAttributeNames for `names`, returning placeholders. Every attribute name in an
 * expression goes through this, so DynamoDB's long reserved-word list ("text", "role", "status"...)
 * never matters.
 */
export function names(...attributes: string[]): { refs: string[]; map: Record<string, string> } {
  const map: Record<string, string> = {};
  const refs = attributes.map((attribute) => {
    const ref = `#${attribute.replace(/[^A-Za-z0-9_]/g, '_')}`;
    map[ref] = attribute;
    return ref;
  });
  return { refs, map };
}

/** Runs a query to the end, following pagination. */
export async function queryAll(doc: DynamoDBDocumentClient, input: QueryCommandInput): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new QueryCommand({ ...input, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    items.push(...((page.Items ?? []) as Item[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/**
 * Reads a query page by page, keeping items that pass `keep`, until `wanted` items are collected
 * or the query ends. (DynamoDB applies Limit before filtering, so filtering happens here instead.)
 */
export async function queryUntil(
  doc: DynamoDBDocumentClient,
  input: QueryCommandInput,
  wanted: number,
  keep: (item: Item) => boolean = () => true,
): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({ ...input, Limit: Math.max(wanted, 25), ...(startKey ? { ExclusiveStartKey: startKey } : {}) }),
    );
    for (const item of (page.Items ?? []) as Item[]) {
      if (!keep(item)) continue;
      items.push(item);
      if (items.length >= wanted) return items;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** The partition holding the id counters. Each counter's sort key says what it numbers, e.g. `SESSION`. */
export const COUNTER_PARTITION = 'COUNTER';

/** How many taken ids `putWithNewId` skips before it gives up. */
const MAX_TAKEN_IDS = 100;

/** Hands out increasing ids from a counter item (1, 2, 3, ...). */
export async function nextId(doc: DynamoDBDocumentClient, table: string, counter: string): Promise<number> {
  const { refs, map } = names('value');
  const result = await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk: COUNTER_PARTITION, sk: counter },
      UpdateExpression: `ADD ${refs[0]} :one`,
      ExpressionAttributeNames: map,
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(result.Attributes?.value);
}

/**
 * Writes a new item under the next id from `counter`, never over an existing item. If the id's key
 * is already taken (the counter is behind its items, as after a restore or a renamed counter), it
 * takes the next id and tries again. Returns the id used.
 */
export async function putWithNewId(
  doc: DynamoDBDocumentClient,
  table: string,
  counter: string,
  itemFor: (id: number) => Item,
): Promise<number> {
  for (let attempt = 0; attempt < MAX_TAKEN_IDS; attempt++) {
    const id = await nextId(doc, table, counter);
    try {
      await doc.send(new PutCommand({ TableName: table, Item: itemFor(id), ConditionExpression: 'attribute_not_exists(pk)' }));
      return id;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  throw new Error(`The ${counter} counter in ${table} is more than ${MAX_TAKEN_IDS} ids behind the items it numbers.`);
}

/** Deletes items by key, 25 at a time, retrying anything DynamoDB leaves unprocessed. */
export async function deleteKeys(doc: DynamoDBDocumentClient, table: string, keys: ReadonlyArray<{ pk: string; sk: string }>): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += 25) {
    let requests: Array<{ DeleteRequest: { Key: Record<string, unknown> } }> = keys
      .slice(offset, offset + 25)
      .map((key) => ({ DeleteRequest: { Key: { pk: key.pk, sk: key.sk } } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 50 * 2 ** attempt)));
      const result = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
      requests = (result.UnprocessedItems?.[table] ?? []) as typeof requests;
      if (attempt > 8 && requests.length > 0) throw new Error(`DynamoDB kept ${requests.length} deletes unprocessed`);
    }
  }
}

/** True for a failed condition or a write that lost a race with another one. */
export function isConflict(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  if (name === 'ConditionalCheckFailedException' || name === 'TransactionConflictException') return true;
  if (name !== 'TransactionCanceledException') return false;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  return reasons.some((reason) => reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict');
}

export function gzipJson(value: unknown): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(value)));
}

export function gunzipJson<T>(bytes: Uint8Array): T {
  return JSON.parse(gunzipSync(bytes).toString('utf8')) as T;
}
