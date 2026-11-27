import Anthropic from '@anthropic-ai/sdk';
import AnthropicAws from '@anthropic-ai/aws-sdk';
import { createClaudeClient, describeClaudeAccess, verifyClaudeAccess } from '../../src/claude/client.js';
import type { ClaudeAccess } from '../../src/config/config.js';
import { silentLogger } from '../helpers.js';

const aws: ClaudeAccess = { provider: 'aws', region: 'us-west-2', workspaceId: 'wrkspc_01Test' };

const body = (message: string) => ({ type: 'error', error: { type: 'error', message } });

describe('createClaudeClient', () => {
  it('builds a Claude Platform on AWS client for the workspace and region (no network needed)', async () => {
    const client = await createClaudeClient(aws);
    expect(client).toBeInstanceOf(AnthropicAws);
    expect(client).toBeInstanceOf(Anthropic); // same API surface as the direct client
    const awsClient = client as AnthropicAws;
    expect(awsClient.baseURL).toBe('https://aws-external-anthropic.us-west-2.api.aws');
    expect(awsClient.workspaceId).toBe('wrkspc_01Test');
    expect(typeof client.beta.messages.stream).toBe('function');
  });

  it('describes where requests go', () => {
    expect(describeClaudeAccess(aws)).toBe('Claude Platform on AWS (us-west-2, workspace wrkspc_01Test)');
    expect(describeClaudeAccess({ provider: 'anthropic' })).toBe('the Claude API (direct)');
  });
});

describe('verifyClaudeAccess', () => {
  const fakeClient = (retrieve: (model: string) => Promise<unknown>) =>
    ({ models: { retrieve } }) as unknown as Pick<Anthropic, 'models'>;

  it('looks up each distinct model once', async () => {
    const looked: string[] = [];
    await verifyClaudeAccess(
      fakeClient(async (model) => {
        looked.push(model);
        return { id: model, display_name: model };
      }),
      aws,
      ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
      silentLogger(),
    );
    expect(looked).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
  });

  it('explains Claude Platform on AWS setup problems with a checklist', async () => {
    const denied = new Anthropic.PermissionDeniedError(403, body('Outbound web identity federation is disabled for your account'), undefined, new Headers());
    const error = await verifyClaudeAccess(fakeClient(() => Promise.reject(denied)), aws, ['claude-opus-5-5'], silentLogger()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Could not reach Claude Platform on AWS: 403 Outbound web identity federation is disabled for your account');
    expect(message).toContain('ANTHROPIC_AWS_WORKSPACE_ID');
    expect(message).toContain('created in us-west-2');
    expect(message).toContain('aws iam enable-outbound-web-identity-federation');
    expect((error as Error).cause).toBe(denied);
  });

  it('names a wrong model ID, and points direct-API users at their key', async () => {
    const missing = new Anthropic.NotFoundError(404, body('model: claude-opus-9'), undefined, new Headers());
    await expect(verifyClaudeAccess(fakeClient(() => Promise.reject(missing)), aws, ['claude-opus-9'], silentLogger())).rejects.toThrow(
      'Claude model "claude-opus-9" was not found',
    );
    const unauthorized = new Anthropic.AuthenticationError(401, body('invalid x-api-key'), undefined, new Headers());
    await expect(
      verifyClaudeAccess(fakeClient(() => Promise.reject(unauthorized)), { provider: 'anthropic' }, ['claude-opus-5-5'], silentLogger()),
    ).rejects.toThrow('Set ANTHROPIC_API_KEY');
  });
});
