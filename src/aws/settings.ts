import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

/**
 * Settings only the AWS deployment uses, set by the CDK stack as environment variables. Each
 * program reads just the ones it needs.
 */
const list = z
  .string()
  .min(1)
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const shape = {
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'must be the 64-character hex public key from the Developer Portal'),
  WORKER_FUNCTION_NAME: z.string().min(1),
  VOICE_QUEUE_URL: z.url(),
  VOICE_TASK_CLUSTER: z.string().min(1),
  VOICE_TASK_DEFINITION: z.string().min(1),
  VOICE_TASK_SUBNETS: list,
  VOICE_TASK_SECURITY_GROUPS: list,
  VOICE_TASK_IDLE_EXIT_SECONDS: z.coerce.number().int().min(30).default(120),
  REMINDER_FUNCTION_ARN: z.string().min(1),
  REMINDER_SCHEDULE_GROUP: z.string().min(1),
  REMINDER_SCHEDULER_ROLE_ARN: z.string().min(1),
};

export type AwsSettings = z.infer<z.ZodObject<typeof shape>>;
export type AwsSettingName = keyof AwsSettings;

/** Reads the named settings, failing with every missing or invalid one listed at once. */
export function loadAwsSettings<K extends AwsSettingName>(names: readonly K[], env: NodeJS.ProcessEnv = process.env): Pick<AwsSettings, K> {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const name of names) {
    const raw = env[name]?.trim();
    const result = (shape[name] as z.ZodType).safeParse(raw === '' ? undefined : raw);
    if (result.success) values[name] = result.data;
    else problems.push(`  - ${name}: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  if (problems.length > 0) throw new Error(`Invalid AWS settings:\n${problems.join('\n')}`);
  return values as Pick<AwsSettings, K>;
}

/** Secret ARNs/names in the environment, and the variables their values are loaded into. */
const SECRETS: ReadonlyArray<[secretIdVariable: string, target: string]> = [
  ['DISCORD_BOT_TOKEN_SECRET', 'DISCORD_BOT_TOKEN'],
  ['ANTHROPIC_API_KEY_SECRET', 'ANTHROPIC_API_KEY'],
];

/**
 * Loads secrets from Secrets Manager into the environment (Lambda can't have them injected the
 * way ECS does, and putting them in plain environment variables would expose them in the console).
 * A variable that's already set is left alone.
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env, client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({})): Promise<void> {
  for (const [secretIdVariable, target] of SECRETS) {
    const secretId = env[secretIdVariable];
    if (!secretId || env[target]) continue;
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const value = result.SecretString?.trim();
    if (!value) throw new Error(`Secret ${secretId} (for ${target}) is empty; put the value in Secrets Manager first.`);
    env[target] = value;
  }
}
