import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BOT_POLICY_FILE, CREDENTIALS_SECRET_NAME, NimbusStack } from '../lib/nimbus-stack';

const template = Template.fromStack(new NimbusStack(new App(), 'Test'));

test('creates the NimbusBot policy exactly as written in nimbus-bot-policy.json', () => {
  const expected = JSON.parse(readFileSync(BOT_POLICY_FILE, 'utf8'));
  template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
    ManagedPolicyName: 'NimbusBot',
    PolicyDocument: expected,
  });
});

test('creates the nimbus-bot user with only that policy', () => {
  template.resourceCountIs('AWS::IAM::User', 1);
  template.hasResourceProperties('AWS::IAM::User', {
    UserName: 'nimbus-bot',
    ManagedPolicyArns: [{ Ref: Match.stringLikeRegexp('BotPolicy') }],
  });
  template.resourcePropertiesCountIs('AWS::IAM::User', { Policies: Match.anyValue() }, 0);
});

test('stores the access key in Secrets Manager and never in stack outputs', () => {
  template.resourceCountIs('AWS::IAM::AccessKey', 1);
  template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: CREDENTIALS_SECRET_NAME });
  const outputs = JSON.stringify(template.findOutputs('*'));
  assert.ok(!outputs.includes('SecretAccessKey'), 'no output may reference the secret access key');
});
