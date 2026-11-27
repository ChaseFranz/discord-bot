import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

/**
 * DynamoDB layout. Two tables, both on-demand (pay per request):
 *
 *  - The main table holds conversations, voice transcripts and call recaps, settings, reminders and
 *    usage, distinguished by key prefix (`THREAD#`, `SESSION#`, `SETTINGS#`, `REMINDER#`, `USAGE#`).
 *  - The memory table holds the long-term notes about people, kept apart (as `memories.db` is
 *    locally) so it can be backed up, inspected or restored on its own.
 *
 * Both use string keys `pk` / `sk`. The main table has two sparse indexes: `gsi1` (a guild's
 * transcript in time order; a person's active reminders) and `gsi2` (open or unrecapped sessions;
 * reminders by due time). Items with an `expiresAt` (epoch seconds) are deleted by DynamoDB's TTL,
 * which replaces the retention sweep. The CDK stack in infra/ must match these definitions.
 *
 * Key values are `#`-separated parts. Type names and fixed markers are upper case (`NOTE#`, `META`,
 * `SESSION_STATUS#OPEN`); data is kept as it is (Discord IDs, dates, model and metric names). Numbers
 * that DynamoDB sorts by are zero-padded. Ids come from counter items, `COUNTER` / `<TYPE>`.
 */
export const TTL_ATTRIBUTE = 'expiresAt';
export const GSI1 = 'gsi1';
export const GSI2 = 'gsi2';

const key = (name: string) => ({ AttributeName: name, AttributeType: 'S' as const });

export function mainTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [key('pk'), key('sk'), key('gsi1pk'), key('gsi1sk'), key('gsi2pk'), key('gsi2sk')],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: GSI1,
        KeySchema: [
          { AttributeName: 'gsi1pk', KeyType: 'HASH' },
          { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: GSI2,
        KeySchema: [
          { AttributeName: 'gsi2pk', KeyType: 'HASH' },
          { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  };
}

export function memoryTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [key('pk'), key('sk')],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
  };
}
