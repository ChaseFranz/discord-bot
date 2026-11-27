import { join } from 'node:path';
import { App, Tags } from 'aws-cdk-lib';
import { NimbusCloudStack, type ClaudeAccessProps } from '../lib/nimbus-cloud-stack';
import { NimbusDeployStack } from '../lib/nimbus-deploy-stack';
import { NimbusStack } from '../lib/nimbus-stack';

const app = new App();
Tags.of(app).add('Project', 'nimbus');

// Deploys to the account and region of the profile (or role) you run `cdk deploy` with.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

// The IAM identity for running the bot on a PC.
new NimbusStack(app, 'Nimbus', {
  env,
  description: 'Nimbus Discord bot: IAM identity for running the bot outside AWS',
  accessKeySerial: 1,
});

// GitHub Actions' way in. Deploy once by hand: npx cdk deploy NimbusDeploy --profile admin
new NimbusDeployStack(app, 'NimbusDeploy', {
  env,
  description: 'Nimbus Discord bot: lets GitHub Actions deploy with OIDC (no stored keys)',
  repository: context('githubRepository') ?? 'ChaseFranz/discord-bot',
  environment: context('githubEnvironment') ?? 'production',
  existingProviderArn: context('githubOidcProviderArn'),
});

// The bot itself on AWS. Settings come as context (-c key=value), from the GitHub deploy workflow.
const clientId = context('clientId');
const guildId = context('guildId');
const publicKey = context('publicKey');
const timeZone = context('timeZone');
if (clientId && guildId && publicKey && timeZone) {
  const provider = context('claudeProvider') ?? 'aws';
  if (provider !== 'aws' && provider !== 'anthropic') throw new Error(`claudeProvider must be "aws" or "anthropic", not "${provider}"`);
  let claude: ClaudeAccessProps;
  if (provider === 'aws') {
    const workspaceId = context('anthropicWorkspaceId');
    if (!workspaceId) throw new Error('claudeProvider=aws needs -c anthropicWorkspaceId=wrkspc_...');
    claude = { provider, workspaceId };
  } else {
    claude = { provider };
  }
  const dailyBudget = context('dailyBudgetUsd');
  const music = context('musicEnabled');
  if (music !== undefined && music !== 'true' && music !== 'false') throw new Error(`musicEnabled must be "true" or "false", not "${music}"`);
  const monthlyBudget = context('monthlyBudgetUsd');
  new NimbusCloudStack(app, 'NimbusCloud', {
    env,
    description: 'Nimbus Discord bot on AWS: Lambda for commands, an on-demand Fargate task for calls, DynamoDB',
    discord: { clientId, guildId, publicKey },
    timeZone,
    claude,
    alertEmail: context('alertEmail'),
    monthlyBudgetUsd: monthlyBudget ? Number(monthlyBudget) : undefined,
    musicEnabled: music === 'true',
    botSettings: dailyBudget ? { DAILY_BUDGET_USD: dailyBudget } : {},
    projectRoot: join(__dirname, '..', '..'),
  });
} else {
  console.error('NimbusCloud is skipped: it needs -c clientId=... -c guildId=... -c publicKey=... -c timeZone=... (see readme.md).');
}

function context(key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
