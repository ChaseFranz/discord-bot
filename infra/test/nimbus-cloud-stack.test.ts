import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NimbusCloudStack } from '../lib/nimbus-cloud-stack';
import { NimbusDeployStack } from '../lib/nimbus-deploy-stack';

// Skip Lambda bundling and Docker builds: these tests look at the template only.
const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
const cloud = Template.fromStack(
  new NimbusCloudStack(app, 'Cloud', {
    discord: { clientId: '100000000000000001', guildId: '100000000000000002', publicKey: 'a'.repeat(64) },
    timeZone: 'America/Chicago',
    claude: { provider: 'anthropic' },
    alertEmail: 'alerts@example.com',
    projectRoot: join(__dirname, '..', '..'),
  }),
);

test('stores data in two on-demand tables kept if the stack is deleted, with TTL on the main one', () => {
  cloud.resourceCountIs('AWS::DynamoDB::Table', 2);
  cloud.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      TableName: 'nimbus',
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'gsi1' }), Match.objectLike({ IndexName: 'gsi2' })],
    }),
  });
  cloud.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'nimbus-memories' });
});

test('runs nothing all the time: no NAT gateway, no ECS service, no provisioned capacity', () => {
  cloud.resourceCountIs('AWS::EC2::NatGateway', 0);
  cloud.resourceCountIs('AWS::ECS::Service', 0);
  cloud.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Family: 'nimbus-voice',
    Cpu: '512',
    Memory: '2048',
    RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
  });
  cloud.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'nimbus-voice.fifo', FifoQueue: true, MessageRetentionPeriod: 900 });
});

test('gives Discord a public URL to the edge, which only knows the public key and the worker', () => {
  // Two public addresses in all: this one for Discord, and the one music helpers talk to.
  cloud.resourceCountIs('AWS::Lambda::Url', 2);
  cloud.allResourcesProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
  const functions = cloud.findResources('AWS::Lambda::Function');
  const edge = Object.values(functions).find((fn) => fn.Properties.FunctionName === 'nimbus-edge')!;
  assert.deepEqual(Object.keys(edge.Properties.Environment.Variables).sort(), ['DISCORD_PUBLIC_KEY', 'NODE_OPTIONS', 'WORKER_FUNCTION_NAME']);
  assert.equal(edge.Properties.Timeout, 5);
  for (const fn of Object.values(functions)) {
    assert.equal(fn.Properties.Runtime, 'nodejs24.x');
    assert.deepEqual(fn.Properties.Architectures, ['arm64']);
    const variables = JSON.stringify(fn.Properties.Environment?.Variables ?? {});
    assert.ok(!variables.includes('"DISCORD_BOT_TOKEN"'), 'tokens come from Secrets Manager, never plain environment variables');
  }
});

test('lets the voice task transcribe and speak, including through a speech stream', () => {
  const policies = Object.values(cloud.findResources('AWS::IAM::Policy')).filter((policy) => JSON.stringify(policy.Properties.Roles).includes('TaskRole'));
  const actions = policies.flatMap((policy) => (policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>).flatMap((statement) => [statement.Action].flat()));
  for (const action of ['transcribe:StartStreamTranscription', 'polly:SynthesizeSpeech', 'polly:StartSpeechSynthesisStream']) {
    assert.ok(actions.includes(action), `the task role can't ${action}`);
  }
});

test('passes the token to the voice task as an ECS secret and sets the time zone everywhere', () => {
  cloud.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [
      Match.objectLike({
        Secrets: Match.arrayWith([Match.objectLike({ Name: 'DISCORD_BOT_TOKEN' }), Match.objectLike({ Name: 'ANTHROPIC_API_KEY' })]),
        Environment: Match.arrayWith([{ Name: 'TIMEZONE', Value: 'America/Chicago' }, { Name: 'STORAGE', Value: 'dynamodb' }]),
      }),
    ],
  });
  // The secrets themselves belong to NimbusDeploy, so they can be set before the first deploy.
  cloud.resourceCountIs('AWS::SecretsManager::Secret', 0);
});

test('has music fetched by music helpers (YouTube refuses audio to AWS addresses), unless it is switched off', () => {
  const music = { MUSIC_ENABLED: 'true', MUSIC_SOURCE: 'helpers', MUSIC_RELAY_BUCKET: Match.anyValue(), MUSIC_HELPER_API_URL: Match.anyValue() };
  // The worker needs it too: it answers /play itself when nobody is running a helper. And every
  // process that reads the bot's settings gets the same ones, so none of them refuses to start.
  for (const name of ['nimbus-worker', 'nimbus-reminders']) {
    cloud.hasResourceProperties('AWS::Lambda::Function', { FunctionName: name, Environment: { Variables: Match.objectLike(music) } });
  }
  cloud.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [
      Match.objectLike({
        Environment: Match.arrayWith([
          { Name: 'MUSIC_ENABLED', Value: 'true' },
          { Name: 'MUSIC_SOURCE', Value: 'helpers' },
        ]),
      }),
    ],
  });

  const withoutMusic = Template.fromStack(
    new NimbusCloudStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'CloudWithoutMusic', {
      discord: { clientId: '100000000000000001', guildId: '100000000000000002', publicKey: 'a'.repeat(64) },
      timeZone: 'America/Chicago',
      claude: { provider: 'anthropic' },
      musicEnabled: false,
      projectRoot: join(__dirname, '..', '..'),
    }),
  );
  withoutMusic.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'nimbus-worker',
    Environment: { Variables: Match.objectLike({ MUSIC_ENABLED: 'false' }) },
  });

  // BOT_SETTINGS can still ask for the bot to fetch music itself.
  const direct = Template.fromStack(
    new NimbusCloudStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'CloudFetchingMusicItself', {
      discord: { clientId: '100000000000000001', guildId: '100000000000000002', publicKey: 'a'.repeat(64) },
      timeZone: 'America/Chicago',
      claude: { provider: 'anthropic' },
      botSettings: { MUSIC_SOURCE: 'direct' },
      projectRoot: join(__dirname, '..', '..'),
    }),
  );
  for (const name of ['nimbus-worker', 'nimbus-reminders']) {
    direct.hasResourceProperties('AWS::Lambda::Function', { FunctionName: name, Environment: { Variables: Match.objectLike({ MUSIC_SOURCE: 'direct' }) } });
  }
  direct.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [Match.objectLike({ Environment: Match.arrayWith([{ Name: 'MUSIC_SOURCE', Value: 'direct' }]) })],
  });
});

test('relays music through a private bucket that keeps nothing for more than a day', () => {
  cloud.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    BucketEncryption: Match.anyValue(),
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 1, Status: 'Enabled' })]) },
  });
});

test('gives music helpers an address that can reach only their own records, and no secrets', () => {
  const functions = cloud.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'nimbus-helper' } });
  const [helper] = Object.values(functions);
  assert.deepEqual(Object.keys(helper.Properties.Environment.Variables).sort(), ['DYNAMODB_TABLE', 'GUILD_ID', 'MUSIC_RELAY_BUCKET', 'NODE_OPTIONS']);

  // In the table: reading and updating helper registrations and song requests of this server only.
  const policies = Object.values(cloud.findResources('AWS::IAM::Policy')).filter((policy) => JSON.stringify(policy.Properties.Roles).includes('Helper'));
  const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Condition?: unknown }>);
  const table = statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith('dynamodb:')));
  assert.equal(table.length, 2);
  assert.deepEqual(table[0]!.Action, ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
  assert.deepEqual(table[0]!.Condition, {
    'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['HELPER#100000000000000002', 'MUSICJOB#100000000000000002'] },
  });
  // And whether the bot is in a call: only the three fields of the voice task's record that say so,
  // by a Query that has to name them (not who is in the call, or anything else).
  assert.equal(table[1]!.Action, 'dynamodb:Query');
  assert.deepEqual(table[1]!.Condition, {
    'ForAllValues:StringEquals': {
      'dynamodb:LeadingKeys': ['VOICE#100000000000000002'],
      'dynamodb:Attributes': ['pk', 'sk', 'status', 'startedAt', 'heartbeatAt'],
    },
    StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
  });
  // In the bucket: writing under music/ only (that is what its upload forms are signed with). Nothing
  // else: no reading or deleting what was uploaded, and no secrets.
  const rest = statements.filter((statement) => !table.includes(statement));
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.Action, 's3:PutObject');
  assert.ok(JSON.stringify(rest[0]).endsWith('"/music/*"]]}}'), JSON.stringify(rest[0]));
});

test('alerts by email on Lambda errors and on AWS spending', () => {
  cloud.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  cloud.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetLimit: { Amount: 25, Unit: 'USD' } }) });
});

test('lets only this repository\'s production environment deploy, through the CDK roles', () => {
  const deploy = Template.fromStack(new NimbusDeployStack(new App(), 'Deploy', { repository: 'owner/repo', environment: 'production' }));
  deploy.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'nimbus-github-deploy',
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': 'repo:owner/repo:environment:production',
            },
          },
        }),
      ],
    },
  });
  deploy.hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Retain', Properties: { Name: 'nimbus/discord-bot-token', Description: Match.anyValue() } });
  deploy.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'nimbus/anthropic-api-key' });
  const policies = JSON.stringify(deploy.findResources('AWS::IAM::Policy'));
  assert.ok(policies.includes('cdk-hnb659fds-'), 'deploys through the CDK bootstrap roles');
  assert.ok(!policies.includes('"*"'), 'no wildcard permissions');
});
