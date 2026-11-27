import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { mainTableDefinition, memoryTableDefinition } from '../../src/storage/dynamodb/schema.js';
import { openStorage, type Storage } from '../../src/storage/open.js';
import type { Clock } from '../../src/util/time.js';

/**
 * The storage backends the shared repository tests run against. SQLite always; DynamoDB when
 * DYNAMODB_ENDPOINT points at a DynamoDB Local (as in CI), with fresh tables for every test.
 */
export interface Backend {
  name: 'sqlite' | 'dynamodb';
  open(clock: Clock, options?: { retentionDays?: number }): Promise<TestStorage>;
}

/** Storage plus, for DynamoDB, the names of this test's own tables. */
export type TestStorage = Storage & { tables?: { main: string; memory: string } };

export const dynamoEndpoint = process.env.DYNAMODB_ENDPOINT;

const sqlite: Backend = {
  name: 'sqlite',
  async open(clock, options) {
    return openStorage(
      { kind: 'sqlite', databasePath: ':memory:', memoryDatabasePath: ':memory:' },
      { retentionDays: options?.retentionDays ?? 30, clock },
    );
  },
};

const dynamodb: Backend = {
  name: 'dynamodb',
  async open(clock, options) {
    const suffix = randomUUID().slice(0, 8);
    const table = `test-${suffix}`;
    const memoryTable = `test-memories-${suffix}`;
    const admin = localAdminClient();
    for (const definition of [mainTableDefinition(table), memoryTableDefinition(memoryTable)]) {
      await admin.send(new CreateTableCommand(definition));
      await waitUntilTableExists({ client: admin, maxWaitTime: 30 }, { TableName: definition.TableName });
    }
    const storage = openStorage(
      { kind: 'dynamodb', region: 'us-east-1', endpoint: dynamoEndpoint!, table, memoryTable },
      { retentionDays: options?.retentionDays ?? 30, clock },
    );
    return {
      ...storage,
      tables: { main: table, memory: memoryTable },
      async close() {
        await storage.close();
        await admin.send(new DeleteTableCommand({ TableName: table }));
        await admin.send(new DeleteTableCommand({ TableName: memoryTable }));
        admin.destroy();
      },
    };
  },
};

/** A plain DynamoDB client for DynamoDB Local (creating tables, inspecting raw items). */
export function localAdminClient(): DynamoDBClient {
  return new DynamoDBClient({ region: 'us-east-1', endpoint: dynamoEndpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
}

export const backends: Backend[] = dynamoEndpoint ? [sqlite, dynamodb] : [sqlite];

if (!dynamoEndpoint && process.env.CI) {
  throw new Error('CI must run the storage tests against DynamoDB Local too: set DYNAMODB_ENDPOINT.');
}
