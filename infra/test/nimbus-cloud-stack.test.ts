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
  cloud.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
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

test('turns music off on AWS unless asked: YouTube refuses audio to AWS addresses', () => {
  cloud.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [Match.objectLike({ Environment: Match.arrayWith([{ Name: 'MUSIC_ENABLED', Value: 'false' }]) })],
  });
  // The worker checks it too, so /play doesn't start the voice task just to say music is off.
  cloud.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'nimbus-worker',
    Environment: { Variables: Match.objectLike({ MUSIC_ENABLED: 'false' }) },
  });

  const withMusic = Template.fromStack(
    new NimbusCloudStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'CloudWithMusic', {
      discord: { clientId: '100000000000000001', guildId: '100000000000000002', publicKey: 'a'.repeat(64) },
      timeZone: 'America/Chicago',
      claude: { provider: 'anthropic' },
      musicEnabled: true,
      projectRoot: join(__dirname, '..', '..'),
    }),
  );
  withMusic.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'nimbus-worker',
    Environment: { Variables: Match.objectLike({ MUSIC_ENABLED: 'true' }) },
  });
});

test('alerts by email on Lambda errors and on AWS spending', () => {
  cloud.resourceCountIs('AWS::CloudWatch::Alarm', 3);
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
