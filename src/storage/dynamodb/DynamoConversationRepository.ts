import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  AppendTurnInput,
  ConversationRepository,
  ConversationSearchHit,
  Modality,
  StoredConversationMessage,
  UserScope,
  WindowPolicy,
} from '../ports.js';
import { queryTerms, rankByRelevance } from '../search/textSearch.js';
import { extractSearchText } from '../sqlite/SqliteConversationRepository.js';
import {
  MAX_KEY_NUMBER,
  deleteKeys,
  expiryAfter,
  gunzipJson,
  gzipJson,
  isConflict,
  names,
  pad,
  queryAll,
  type Item,
} from './dynamo.js';

const META = 'META';
const MESSAGE = 'MSG#';
const SEARCH_TEXT_LIMIT = 600;
/** Leaves headroom under DynamoDB's 400 KB item limit. */
const MAX_CONTENT_BYTES = 350_000;
const MAX_ATTEMPTS = 5;

interface Meta {
  /** Highest message number used so far (messages are numbered 1, 2, 3...). */
  nextSeq: number;
  /** Messages numbered at or above this are in the active window. */
  windowStart: number;
}

/**
 * Each person's thread: a META item (message counter, window start) and one item per message,
 * under `THREAD#<guild>#<user>`. Message content is stored gzipped. When messages leave the
 * active window they get an expiry, so DynamoDB deletes them after the retention period.
 */
export class DynamoConversationRepository implements ConversationRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly options: { retentionDays: number },
  ) {}

  async loadActive(scope: UserScope): Promise<StoredConversationMessage[]> {
    const meta = await this.meta(scope);
    const items = await this.messages(scope, meta.windowStart);
    return items.map((item) => ({
      id: Number(item.seq),
      role: item.role as 'user' | 'assistant',
      content: gunzipJson<BetaContentBlockParam[]>(item.content as Uint8Array),
      modality: item.modality as Modality,
      createdAt: Number(item.createdAt),
    }));
  }

  async appendTurn(input: AppendTurnInput): Promise<void> {
    const { scope, modality, messages, createdAt } = input;
    if (messages.length === 0) return;
    if (messages[0]!.role !== 'user') throw new Error('A turn must start with the user message');
    const pk = this.pk(scope);
    const meta = names('nextSeq', 'windowStart');

    for (let attempt = 1; ; attempt++) {
      const { nextSeq } = await this.meta(scope);
      try {
        await this.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                // Claims the message numbers; fails if another writer claimed them first.
                Update: {
                  TableName: this.table,
                  Key: { pk, sk: META },
                  UpdateExpression: `SET ${meta.refs[0]} = :next, ${meta.refs[1]} = if_not_exists(${meta.refs[1]}, :zero)`,
                  ConditionExpression: `attribute_not_exists(${meta.refs[0]}) OR ${meta.refs[0]} = :expected`,
                  ExpressionAttributeNames: meta.map,
                  ExpressionAttributeValues: { ':next': nextSeq + messages.length, ':zero': 0, ':expected': nextSeq },
                },
              },
              ...messages.map((message, index) => {
                const seq = nextSeq + 1 + index;
                return {
                  Put: {
                    TableName: this.table,
                    Item: {
                      pk,
                      sk: `${MESSAGE}${pad(seq)}`,
                      seq,
                      role: message.role,
                      modality,
                      turnStart: index === 0,
                      createdAt,
                      content: storableContent(message.content),
                      searchText: extractSearchText(message.content),
                    },
                  },
                };
              }),
            ],
          }),
        );
        return;
      } catch (error) {
        if (!isConflict(error) || attempt >= MAX_ATTEMPTS) throw error;
      }
    }
  }

  async trimWindow(scope: UserScope, policy: WindowPolicy): Promise<number> {
    if (policy.keepMessages > policy.maxMessages) throw new RangeError('keepMessages must not exceed maxMessages');
    const meta = await this.meta(scope);
    const rows = await this.messages(scope, meta.windowStart, ['seq', 'turnStart', 'createdAt']);
    if (rows.length <= policy.maxMessages) return 0;

    // Earliest turn boundary that leaves at most keepMessages in the window.
    let cutIndex = rows.findIndex((row, index) => row.turnStart === true && rows.length - index <= policy.keepMessages);
    if (cutIndex === -1) {
      // A single turn is longer than keepMessages: keep just the latest turn.
      cutIndex = rows.map((row) => row.turnStart === true).lastIndexOf(true);
    }
    if (cutIndex <= 0) return 0;

    const windowStart = Number(rows[cutIndex]!.seq);
    const attr = names('windowStart');
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: this.pk(scope), sk: META },
          UpdateExpression: `SET ${attr.refs[0]} = :start`,
          // Never backwards.
          ConditionExpression: `attribute_not_exists(${attr.refs[0]}) OR ${attr.refs[0]} < :start`,
          ExpressionAttributeNames: attr.map,
          ExpressionAttributeValues: { ':start': windowStart },
        }),
      );
    } catch (error) {
      if (isConflict(error)) return 0;
      throw error;
    }

    // Messages out of view stay searchable until the retention period has passed.
    const expiry = names('expiresAt');
    for (const row of rows.slice(0, cutIndex)) {
      const expiresAt = expiryAfter(Number(row.createdAt), this.options.retentionDays);
      if (expiresAt === undefined) break;
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: this.pk(scope), sk: `${MESSAGE}${pad(Number(row.seq))}` },
          UpdateExpression: `SET ${expiry.refs[0]} = :at`,
          ExpressionAttributeNames: expiry.map,
          ExpressionAttributeValues: { ':at': expiresAt },
        }),
      );
    }
    return cutIndex;
  }

  async search(scope: UserScope, query: string, limit: number): Promise<ConversationSearchHit[]> {
    if (queryTerms(query).length === 0) return [];
    const [meta, rows] = await Promise.all([
      this.meta(scope),
      this.messages(scope, 0, ['seq', 'role', 'modality', 'createdAt', 'searchText']),
    ]);
    const ranked = rankByRelevance(rows, query, [{ text: (row) => String(row.searchText ?? ''), weight: 1 }], limit);
    return ranked.map((row) => {
      const text = String(row.searchText ?? '');
      return {
        messageId: Number(row.seq),
        role: row.role as 'user' | 'assistant',
        modality: row.modality as Modality,
        createdAt: Number(row.createdAt),
        text: text.length > SEARCH_TEXT_LIMIT ? `${text.slice(0, SEARCH_TEXT_LIMIT)}…` : text,
        archived: Number(row.seq) < meta.windowStart,
      };
    });
  }

  async reset(scope: UserScope): Promise<void> {
    const keys = await queryAll(this.doc, {
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': this.pk(scope) },
      ProjectionExpression: 'pk, sk',
    });
    await deleteKeys(this.doc, this.table, keys as Array<{ pk: string; sk: string }>);
  }

  /** DynamoDB deletes expired messages itself (TTL), so there is nothing to sweep. */
  async pruneArchivedBefore(_cutoff: number): Promise<number> {
    return 0;
  }

  private pk(scope: UserScope): string {
    return `THREAD#${scope.guildId}#${scope.userId}`;
  }

  private async meta(scope: UserScope): Promise<Meta> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: this.pk(scope), sk: META }, ConsistentRead: true }));
    return { nextSeq: Number(result.Item?.nextSeq ?? 0), windowStart: Number(result.Item?.windowStart ?? 0) };
  }

  /** Messages numbered `from` or higher, oldest first (optionally only some attributes). */
  private messages(scope: UserScope, from: number, attributes?: string[]): Promise<Item[]> {
    const projection = attributes ? names(...attributes) : undefined;
    return queryAll(this.doc, {
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': this.pk(scope), ':from': `${MESSAGE}${pad(from)}`, ':to': `${MESSAGE}${pad(MAX_KEY_NUMBER)}` },
      ConsistentRead: true,
      ...(projection ? { ProjectionExpression: projection.refs.join(', '), ExpressionAttributeNames: projection.map } : {}),
    });
  }
}

const SERVER_TOOL_BLOCKS = new Set(['server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result']);

/**
 * Gzipped content, small enough for one item. Web search results are what make a message large;
 * if it doesn't fit even compressed, they are dropped (each search and its results go together,
 * so the history stays valid), along with the citations that pointed into them.
 */
function storableContent(content: BetaContentBlockParam[]): Uint8Array {
  const packed = gzipJson(content);
  if (packed.byteLength <= MAX_CONTENT_BYTES) return packed;
  let slim: BetaContentBlockParam[] = content
    .filter((block) => !SERVER_TOOL_BLOCKS.has(block.type))
    .map((block) => (block.type === 'text' ? { type: 'text', text: block.text } : block));
  if (gzipJson(slim).byteLength > MAX_CONTENT_BYTES) {
    slim = slim.map((block) => (block.type === 'text' ? { type: 'text', text: block.text.slice(0, 100_000) } : block));
  }
  return gzipJson(slim.length > 0 ? slim : [{ type: 'text', text: '(searched the web)' }]);
}
