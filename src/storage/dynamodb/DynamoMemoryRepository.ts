import { DeleteCommand, GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Memory, MemoryRepository, NewMemory } from '../ports.js';
import { queryTerms, rankByRelevance } from '../search/textSearch.js';
import { deleteKeys, isConflict, names, pad, putWithNewId, queryAll, type Item } from './dynamo.js';

/**
 * Long-term notes, in their own table: `GUILD#<guild>` / `NOTE#<id>`, numbered per guild by the
 * `COUNTER` / `NOTE#<guild>` counter. A guild holds at most a
 * few dozen notes per person, so listing and keyword search read the guild's notes and sort or rank
 * them in code.
 */
export class DynamoMemoryRepository implements MemoryRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async add(memory: NewMemory): Promise<Memory> {
    const stored = (id: number): Memory => ({ ...memory, id, updatedAt: memory.createdAt });
    const id = await putWithNewId(this.doc, this.table, `NOTE#${memory.guildId}`, (id) => ({ ...key(memory.guildId, id), ...stored(id) }));
    return stored(id);
  }

  async get(guildId: string, id: number): Promise<Memory | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: key(guildId, id), ConsistentRead: true }));
    return result.Item ? toMemory(result.Item) : undefined;
  }

  async update(guildId: string, id: number, text: string, updatedAt: number): Promise<Memory | undefined> {
    const attr = names('text', 'updatedAt');
    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: key(guildId, id),
          UpdateExpression: `SET ${attr.refs[0]} = :text, ${attr.refs[1]} = :at`,
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: attr.map,
          ExpressionAttributeValues: { ':text': text, ':at': updatedAt },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return result.Attributes ? toMemory(result.Attributes) : undefined;
    } catch (error) {
      if (isConflict(error)) return undefined;
      throw error;
    }
  }

  async delete(guildId: string, id: number): Promise<boolean> {
    const result = await this.doc.send(new DeleteCommand({ TableName: this.table, Key: key(guildId, id), ReturnValues: 'ALL_OLD' }));
    return result.Attributes !== undefined;
  }

  async deleteAllAbout(guildId: string, subjectId: string): Promise<number> {
    const doomed = (await this.all(guildId)).filter((memory) => memory.subjectId === subjectId);
    await deleteKeys(this.doc, this.table, doomed.map((memory) => key(guildId, memory.id)));
    return doomed.length;
  }

  async listAbout(guildId: string, subjectIds: ReadonlyArray<string | null>, perSubject: number): Promise<Memory[]> {
    const all = (await this.all(guildId)).sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    return [...new Set(subjectIds)].flatMap((subjectId) => all.filter((memory) => memory.subjectId === subjectId).slice(0, perSubject));
  }

  async countAbout(guildId: string, subjectId: string | null): Promise<number> {
    return (await this.all(guildId)).filter((memory) => memory.subjectId === subjectId).length;
  }

  async search(guildId: string, query: string, limit: number): Promise<Memory[]> {
    if (queryTerms(query).length === 0) return [];
    return rankByRelevance(
      (await this.all(guildId)).sort((a, b) => a.id - b.id),
      query,
      [
        { text: (memory) => memory.text, weight: 1 },
        { text: (memory) => memory.subjectName, weight: 1 },
      ],
      limit,
    );
  }

  private async all(guildId: string): Promise<Memory[]> {
    const items = await queryAll(this.doc, {
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `GUILD#${guildId}`, ':prefix': 'NOTE#' },
      ConsistentRead: true,
    });
    return items.map(toMemory);
  }
}

function key(guildId: string, id: number) {
  return { pk: `GUILD#${guildId}`, sk: `NOTE#${pad(id)}` };
}

function toMemory(item: Item): Memory {
  return {
    id: Number(item.id),
    guildId: String(item.guildId),
    subjectId: item.subjectId === null || item.subjectId === undefined ? null : String(item.subjectId),
    subjectName: String(item.subjectName),
    text: String(item.text),
    sourceUserId: String(item.sourceUserId),
    sourceName: String(item.sourceName),
    createdAt: Number(item.createdAt),
    updatedAt: Number(item.updatedAt),
  };
}
