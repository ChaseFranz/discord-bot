import Anthropic from '@anthropic-ai/sdk';
import AnthropicAws from '@anthropic-ai/aws-sdk';
import type { ClaudeAccess } from '../config/config.js';
import type { Logger } from '../logging/logger.js';

/** Where Claude requests go, for logs and error messages. */
export function describeClaudeAccess(access: ClaudeAccess): string {
  return access.provider === 'aws'
    ? `Claude Platform on AWS (${access.region}, workspace ${access.workspaceId})`
    : 'the Claude API (direct)';
}

/**
 * Builds the Claude client for the configured provider. `AnthropicAws` extends `Anthropic`, so both
 * expose the same API surface and nothing downstream needs to know which one it was given.
 */
export async function createClaudeClient(access: ClaudeAccess): Promise<Anthropic> {
  if (access.provider === 'aws') {
    // Requests are SigV4-signed with the standard AWS credential chain (AWS_ACCESS_KEY_ID /
    // AWS_SECRET_ACCESS_KEY, AWS_PROFILE, SSO, or an instance role): the same identity Transcribe
    // and Polly use. An ANTHROPIC_AWS_API_KEY in the environment is used instead if present.
    const client = new AnthropicAws({ awsRegion: access.region, workspaceId: access.workspaceId });
    await client.ready;
    return client;
  }
  return new Anthropic();
}

/**
 * Fails fast with an actionable message if the credentials, workspace, permissions or model IDs
 * are wrong, by looking up each configured model (Models API; free).
 */
export async function verifyClaudeAccess(
  client: Pick<Anthropic, 'models'>,
  access: ClaudeAccess,
  models: readonly string[],
  logger: Logger,
): Promise<void> {
  for (const model of new Set(models)) {
    try {
      const info = await client.models.retrieve(model);
      logger.info(`Claude model ready: ${info.display_name} (${info.id}) via ${describeClaudeAccess(access)}`);
    } catch (error) {
      throw new Error(explainAccessError(error, model, access), { cause: error });
    }
  }
}

/** The API's human-readable error message (the SDK's `message` embeds the raw JSON body). */
function errorDetail(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    const body = error.error as { error?: { message?: unknown } } | undefined;
    const message = body?.error?.message;
    if (typeof message === 'string' && message.length > 0) {
      return error.status !== undefined ? `${error.status} ${message}` : message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function explainAccessError(error: unknown, model: string, access: ClaudeAccess): string {
  const detail = errorDetail(error);
  if (error instanceof Anthropic.NotFoundError) {
    return `Claude model "${model}" was not found (${detail}). Check CLAUDE_CHAT_MODEL / CLAUDE_VOICE_MODEL.`;
  }
  if (access.provider === 'anthropic') {
    if (error instanceof Anthropic.AuthenticationError) {
      return `The Claude API rejected the credentials (${detail}). Set ANTHROPIC_API_KEY.`;
    }
    return `Could not reach the Claude API: ${detail}`;
  }
  const checks = [
    'AWS credentials are available to the bot (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or SSO)',
    `ANTHROPIC_AWS_WORKSPACE_ID is right and that workspace was created in ${access.region} ` +
      '(set CLAUDE_AWS_REGION if it lives in a different region than AWS_REGION)',
    'the AWS identity has the aws-external-anthropic and sts permissions listed in the README',
    'outbound web identity federation is enabled for the account: aws iam enable-outbound-web-identity-federation',
  ];
  return `Could not reach Claude Platform on AWS: ${detail}\nCheck that:\n${checks.map((check) => `  - ${check}`).join('\n')}`;
}
