/**
 * Moves the bot between this PC and AWS. Discord sends slash commands either over the live
 * connection (the bot on a PC) or to an HTTPS endpoint (Lambda on AWS), never both, so one
 * setting decides which copy is in charge.
 *
 *   npm run aws:secrets   copy DISCORD_BOT_TOKEN (and ANTHROPIC_API_KEY, if set) from .env into
 *                         Secrets Manager, without printing them
 *   npm run aws:on        send slash commands to AWS (stop the bot on this PC first)
 *   npm run aws:off       send them back to the bot on this PC
 *
 * Uses your AWS credentials as usual, e.g. AWS_PROFILE=admin npm run aws:on.
 */
import dotenv from 'dotenv';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { REST, Routes } from 'discord.js';
import { describeError } from '../logging/logger.js';

// .env is read into its own object, not process.env: it also holds the PC bot's AWS keys, which
// the AWS SDK would otherwise find alongside your AWS_PROFILE (and could one day prefer to it).
const dotEnv: Record<string, string | undefined> = {};
dotenv.config({ quiet: true, processEnv: dotEnv });

/** A setting from the environment, or else from .env. */
function setting(name: string): string | undefined {
  return (process.env[name] ?? dotEnv[name])?.trim() || undefined;
}

/** The region for AWS calls: AWS_REGION from the environment or .env, else your profile's. */
function awsClientConfig(): { region?: string } {
  const region = setting('AWS_REGION');
  return region ? { region } : {};
}

/** A failure whose message says what to do. It's printed without a stack trace. */
class ScriptError extends Error {}

const STACK = 'NimbusCloud';
const SECRETS: ReadonlyArray<[envVariable: string, secretName: string]> = [
  ['DISCORD_BOT_TOKEN', 'nimbus/discord-bot-token'],
  ['ANTHROPIC_API_KEY', 'nimbus/anthropic-api-key'],
];

async function main(): Promise<void> {
  const action = process.argv[2];
  switch (action) {
    case 'secrets':
      return copySecrets();
    case 'on':
      return pointCommandsAt(process.argv[3] ?? (await stackEndpoint()));
    case 'off':
      return pointCommandsAt(null);
    default:
      throw new ScriptError('Usage: awsSwitch.js secrets | on [url] | off');
  }
}

async function copySecrets(): Promise<void> {
  const client = new SecretsManagerClient(awsClientConfig());
  let copied = 0;
  for (const [variable, secretName] of SECRETS) {
    const value = setting(variable);
    if (!value) continue;
    await client.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: value }));
    process.stdout.write(`Stored ${variable} in ${secretName}.\n`);
    copied++;
  }
  if (copied === 0) throw new ScriptError('Nothing to copy: DISCORD_BOT_TOKEN is not set in .env.');
}

async function stackEndpoint(): Promise<string> {
  const client = new CloudFormationClient(awsClientConfig());
  let result;
  try {
    result = await client.send(new DescribeStacksCommand({ StackName: STACK }));
  } catch (error) {
    // CloudFormation has no error code of its own for a missing stack, only this message.
    if (error instanceof Error && error.name === 'ValidationError' && error.message.includes('does not exist')) {
      const region = await client.config.region();
      throw new ScriptError(`The ${STACK} stack isn't deployed in ${region} yet. Deploy it first (see "Running on AWS" in readme.md).`);
    }
    throw error;
  }
  const url = result.Stacks?.[0]?.Outputs?.find((output) => output.OutputKey === 'InteractionsEndpointUrl')?.OutputValue;
  if (!url) throw new ScriptError(`The ${STACK} stack has no InteractionsEndpointUrl output. Is it still deploying?`);
  return url;
}

async function pointCommandsAt(url: string | null): Promise<void> {
  const token = setting('DISCORD_BOT_TOKEN');
  if (!token) throw new ScriptError('DISCORD_BOT_TOKEN is not set in .env.');
  // Discord checks a new endpoint (a PING and some deliberately bad signatures) before accepting it.
  await new REST({ version: '10' }).setToken(token).patch(Routes.currentApplication(), { body: { interactions_endpoint_url: url } });
  process.stdout.write(
    url
      ? `Slash commands now go to AWS (${url}). Keep the bot on this PC stopped; "npm run aws:off" switches back.\n`
      : 'Slash commands now go to the bot on this PC: start it with "npm start". "npm run aws:on" switches back to AWS.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof ScriptError ? error.message : describeError(error)}\n`);
  process.exit(1);
});
