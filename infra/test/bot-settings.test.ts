import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBotSettings } from '../lib/bot-settings';

test('reads NAME=value pairs separated by commas, semicolons or new lines', () => {
  assert.deepEqual(parseBotSettings('VOICE_SILENCE_MS=500, VOICE_BARGE_IN = everyone;FOLLOW_UP_SECONDS=10\nVOICE_ACKNOWLEDGE=false\n'), {
    VOICE_SILENCE_MS: '500',
    VOICE_BARGE_IN: 'everyone',
    FOLLOW_UP_SECONDS: '10',
    VOICE_ACKNOWLEDGE: 'false',
  });
  assert.deepEqual(parseBotSettings(undefined), {});
  assert.deepEqual(parseBotSettings('  \n , '), {});
});

test('refuses anything that is not NAME=value, and anything that looks like a secret', () => {
  assert.throws(() => parseBotSettings('VOICE_SILENCE_MS 500'), /"VOICE_SILENCE_MS 500" is not written as NAME=value/);
  assert.throws(() => parseBotSettings('voice_silence_ms=500'), /is not written as NAME=value/);
  assert.throws(() => parseBotSettings('ANTHROPIC_API_KEY=sk-ant-123'), /ANTHROPIC_API_KEY looks like a secret/);
  assert.throws(() => parseBotSettings('DISCORD_BOT_TOKEN=abc'), /looks like a secret/);
  assert.throws(() => parseBotSettings('AWS_SECRET_ACCESS_KEY=abc'), /looks like a secret/);
});
