import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_USER_SETTINGS, type PrivacyLevel, type SettingsRepository, type UserScope, type UserSettings } from '../ports.js';
import { systemClock, type Clock } from '../../util/time.js';

/** One item per person: `SETTINGS#<guild>#<user>`. */
export class DynamoSettingsRepository implements SettingsRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(scope: UserScope): Promise<UserSettings | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: key(scope), ConsistentRead: true }));
    if (!result.Item) return undefined;
    return {
      style: String(result.Item.style ?? DEFAULT_USER_SETTINGS.style),
      privacy: (result.Item.privacy as PrivacyLevel | undefined) ?? DEFAULT_USER_SETTINGS.privacy,
    };
  }

  async update(scope: UserScope, changes: Partial<UserSettings>): Promise<UserSettings> {
    const next: UserSettings = { ...DEFAULT_USER_SETTINGS, ...(await this.get(scope)), ...changes };
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...key(scope), ...next, updatedAt: this.clock() } }));
    return next;
  }
}

function key(scope: UserScope) {
  return { pk: `SETTINGS#${scope.guildId}#${scope.userId}`, sk: 'SETTINGS' };
}
