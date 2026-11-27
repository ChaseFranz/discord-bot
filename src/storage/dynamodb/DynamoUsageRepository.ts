import { BatchGetCommand, GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { UsageLine, UsageRepository } from '../ports.js';
import { shiftDayKey } from '../../util/zonedTime.js';
import { names, queryAll } from './dynamo.js';

/**
 * Daily usage under `USAGE#<guild>#<day>`: one item per metric plus a TOTAL item with the day's
 * cost. Values are stored as integers (quantities in millionths, costs in billionths of a dollar):
 * DynamoDB adds them exactly, and fractional amounts like $0.0000002 never hit number-format limits.
 */
export class DynamoUsageRepository implements UsageRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async add(guildId: string, day: string, lines: readonly UsageLine[]): Promise<void> {
    if (lines.length === 0) return;
    const attr = names('quantity', 'cost');
    const pk = dayKey(guildId, day);
    const total = names('cost');
    await Promise.all([
      ...lines.map((line) =>
        this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk, sk: `METRIC#${line.metric}` },
            UpdateExpression: `ADD ${attr.refs[0]} :quantity, ${attr.refs[1]} :cost`,
            ExpressionAttributeNames: attr.map,
            ExpressionAttributeValues: { ':quantity': toMicro(line.quantity), ':cost': toNano(line.costUsd) },
          }),
        ),
      ),
      this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk, sk: 'TOTAL' },
          UpdateExpression: `ADD ${total.refs[0]} :cost`,
          ExpressionAttributeNames: total.map,
          ExpressionAttributeValues: { ':cost': lines.reduce((sum, line) => sum + toNano(line.costUsd), 0) },
        }),
      ),
    ]);
  }

  async day(guildId: string, day: string): Promise<UsageLine[]> {
    const items = await queryAll(this.doc, {
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': dayKey(guildId, day), ':prefix': 'METRIC#' },
      ConsistentRead: true,
    });
    return items
      .map((item) => ({
        metric: String(item.sk).slice('METRIC#'.length),
        quantity: fromMicro(Number(item.quantity ?? 0)),
        costUsd: fromNano(Number(item.cost ?? 0)),
      }))
      .sort((a, b) => a.metric.localeCompare(b.metric));
  }

  async dayTotal(guildId: string, day: string): Promise<number> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: dayKey(guildId, day), sk: 'TOTAL' }, ConsistentRead: true }));
    return fromNano(Number(result.Item?.cost ?? 0));
  }

  async dailyTotals(guildId: string, fromDay: string, toDay: string): Promise<Array<{ day: string; costUsd: number }>> {
    const days: string[] = [];
    for (let day = fromDay; day <= toDay && days.length < 366; day = shiftDayKey(day, 1)) days.push(day);
    const totals = new Map<string, number>();
    for (let offset = 0; offset < days.length; offset += 100) {
      let keys: Array<Record<string, unknown>> = days.slice(offset, offset + 100).map((day) => ({ pk: dayKey(guildId, day), sk: 'TOTAL' }));
      for (let attempt = 0; keys.length > 0 && attempt < 10; attempt++) {
        const result = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys, ConsistentRead: true } } }));
        for (const item of result.Responses?.[this.table] ?? []) {
          totals.set(String(item.pk).split('#').at(-1)!, fromNano(Number(item.cost ?? 0)));
        }
        keys = (result.UnprocessedKeys?.[this.table]?.Keys ?? []) as Array<Record<string, unknown>>;
      }
    }
    return days.filter((day) => totals.has(day)).map((day) => ({ day, costUsd: totals.get(day)! }));
  }
}

function dayKey(guildId: string, day: string): string {
  return `USAGE#${guildId}#${day}`;
}

const toMicro = (value: number) => Math.round(value * 1e6);
const fromMicro = (value: number) => value / 1e6;
const toNano = (usd: number) => Math.round(usd * 1e9);
const fromNano = (value: number) => value / 1e9;
