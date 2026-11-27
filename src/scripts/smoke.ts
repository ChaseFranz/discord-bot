/**
 * Live smoke test against the real APIs, without Discord. Uses a throwaway in-memory database.
 * Claude is reached through the configured CLAUDE_PROVIDER (Claude Platform on AWS by default).
 *
 *   npm run build && npm run smoke            # Claude + AWS
 *   npm run smoke -- --claude                 # Claude only (a few cents at most)
 *   npm run smoke -- --aws                    # Polly + Transcribe only (fractions of a cent)
 *
 * Claude: seeds a fake voice transcript, then types questions that need the memory tools and checks a
 * second request reads the prompt cache. Then a call on the voice model, streamed and split into
 * sentences as they would be spoken: two people asking at once, a line meant for someone else, a
 * follow-up without the name, a correction mid-reply, and a reminder. Last, it recaps the seeded
 * call and prints the estimated cost of it all.
 * AWS: synthesises a sentence with Polly and transcribes it back with Transcribe streaming.
 */
import dotenv from 'dotenv';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { Assistant } from '../assistant/Assistant.js';
import { CallConversation } from '../assistant/CallConversation.js';
import type { LineAddress } from '../assistant/prompts.js';
import { ToolRegistry } from '../assistant/tools/ToolRegistry.js';
import { createMusicToolProvider } from '../assistant/tools/musicTools.js';
import { createVoiceToolProvider } from '../assistant/tools/voiceTools.js';
import type { ToolContext } from '../assistant/tools/types.js';
import { buildRoutes } from '../app.js';
import { createClaudeClient, describeClaudeAccess, verifyClaudeAccess } from '../claude/client.js';
import { connectMemoryTools } from '../memory/inProcess.js';
import { loadConfig } from '../config/config.js';
import { CallRecapper } from '../recaps/CallRecapper.js';
import { schedulerAlarm } from '../reminders/alarm.js';
import { createReminderToolProvider } from '../reminders/reminderTools.js';
import { createLogger, describeError } from '../logging/logger.js';
import { MusicService } from '../music/MusicService.js';
import { MusicError, type MusicHost, type TrackSource } from '../music/types.js';
import { PollyTextToSpeech } from '../speech/aws/PollyTextToSpeech.js';
import { TranscribeSpeechToText } from '../speech/aws/TranscribeSpeechToText.js';
import { openDatabase, openMemoryDatabase } from '../storage/sqlite/database.js';
import { SqliteConversationRepository } from '../storage/sqlite/SqliteConversationRepository.js';
import { SqliteMemoryRepository } from '../storage/sqlite/SqliteMemoryRepository.js';
import { SqliteReminderRepository } from '../storage/sqlite/SqliteReminderRepository.js';
import { SqliteSettingsRepository } from '../storage/sqlite/SqliteSettingsRepository.js';
import { SqliteTranscriptRepository } from '../storage/sqlite/SqliteTranscriptRepository.js';
import { SqliteUsageRepository } from '../storage/sqlite/SqliteUsageRepository.js';
import { PriceBook } from '../usage/pricing.js';
import { UsageService } from '../usage/UsageService.js';
import { SentenceChunker } from '../voice/SentenceChunker.js';

dotenv.config({ quiet: true });

const GUILD = 'smoke-guild';
const USER = 'smoke-user';

interface Person {
  id: string;
  name: string;
}

/**
 * The process environment for loadConfig, with placeholders for settings this test doesn't use.
 * A placeholder only fills a setting that is unset or blank in .env; `overrides` always win.
 */
function smokeEnv(placeholders: Record<string, string>, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(placeholders)) {
    if (!env[key]?.trim()) env[key] = value;
  }
  return { ...env, ...overrides };
}

async function smokeClaude(): Promise<void> {
  const config = loadConfig(smokeEnv({ DISCORD_BOT_TOKEN: 'unused', CLIENT_ID: 'unused', GUILD_ID: GUILD, AWS_REGION: 'us-east-1' }));
  const logger = createLogger('debug');
  logger.info(`Using ${describeClaudeAccess(config.claude.access)}`);
  const claude = await createClaudeClient(config.claude.access);
  await verifyClaudeAccess(claude, config.claude.access, [config.claude.chat.model, config.claude.voice.model], logger);

  const db = openDatabase(':memory:');
  const conversations = new SqliteConversationRepository(db);
  const transcripts = new SqliteTranscriptRepository(db);
  const settings = new SqliteSettingsRepository(db);

  // Seed two days ago: a call where Sam suggested a trip.
  const t0 = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const session = await transcripts.startSession({ guildId: GUILD, channelId: 'vc1', channelName: 'General', startedAt: t0 });
  const lines: Array<[string, string]> = [
    ['Alex', 'did anyone watch the game last night'],
    ['Sam', 'honestly we should plan a trip, I vote Japan next spring for the cherry blossoms'],
    ['Smoke', 'Japan sounds amazing, but flights are expensive'],
    ['Sam', 'if we book by January it is way cheaper, like eight hundred bucks'],
  ];
  for (const [index, [speaker, text]] of lines.entries()) {
    await transcripts.appendSegment({
      sessionId: session.id, guildId: GUILD, channelId: 'vc1', speakerId: speaker === 'Smoke' ? USER : `id-${speaker}`,
      speakerName: speaker, isAssistant: false, text, startedAt: t0 + index * 15_000, endedAt: t0 + index * 15_000 + 5_000,
    });
  }
  await transcripts.endSession(session.id, t0 + 120_000);

  const memoryDb = openMemoryDatabase(':memory:');
  const memories = new SqliteMemoryRepository(memoryDb);
  const memory = await connectMemoryTools({ transcripts, conversations, memories });
  const reminders = new SqliteReminderRepository(db);
  const usage = new UsageService({
    repository: new SqliteUsageRepository(db),
    prices: new PriceBook({ pollyEngine: config.aws.pollyEngine }),
    clock: Date.now,
    timeZone: config.assistant.timeZone,
    dailyBudgetUsd: 0,
    pollyEngine: config.aws.pollyEngine,
    logger,
  });
  const noMusicHost: MusicHost = {
    ensureOutput: async () => { throw new MusicError('Music is not available in the smoke test.'); },
    queueFinished: () => undefined,
  };
  const noTracks: TrackSource = { resolve: async () => null, open: async () => { throw new Error('unused'); } };
  const registry = new ToolRegistry([
    memory.provider,
    createMusicToolProvider(new MusicService(noMusicHost, noTracks, logger)),
    createVoiceToolProvider({ get: () => undefined }),
    createReminderToolProvider({ reminders, alarm: schedulerAlarm(undefined), clock: Date.now, timeZone: config.assistant.timeZone }),
  ]);
  // Log each tool call so you can see the memory MCP tools being used.
  const loggingRegistry = Object.assign(Object.create(registry) as ToolRegistry, {
    call: async (name: string, input: unknown, context: ToolContext) => {
      const result = await registry.call(name, input, context);
      logger.info(`tool ${name}(${JSON.stringify(input)}) -> ${result.isError ? 'ERROR ' : ''}${result.content.slice(0, 300)}`);
      return result;
    },
  });

  const assistant = new Assistant({
    messages: claude.beta.messages,
    conversations, settings, tools: loggingRegistry, logger, clock: Date.now,
    assistantName: config.assistant.name, timeZone: config.assistant.timeZone, routes: buildRoutes(config), memories, usage,
  });
  const scope = { guildId: GUILD, userId: USER };
  const smoke: Person = { id: USER, name: 'Smoke' };
  const sam: Person = { id: 'id-Sam', name: 'Sam' };
  const alex: Person = { id: 'id-Alex', name: 'Alex' };
  const name = config.assistant.name;

  /** A typed message from Smoke, in their own thread. */
  const type = async (label: string, text: string) => {
    logger.info(`--- typed, ${label}: ${text}`);
    const started = Date.now();
    const reply = await assistant.respond({ scope, userDisplayName: smoke.name, text, channelName: 'bot-chat', textChannelId: 'bot-chat' });
    logger.info(`=== ${reply.model} [${reply.outcome}] after ${Date.now() - started} ms: ${reply.text}`);
    if (reply.sources.length > 0) logger.info(`sources: ${reply.sources.map((s) => s.url).join(', ')}`);
  };

  // A call: everyone shares one conversation, and each turn answers what was said to the assistant
  // since its last one. Replies stream: each sentence is shown as it would be handed to text-to-speech.
  const call = new CallConversation(config.assistant.timeZone);
  const hear = (who: Person, text: string, address: LineAddress = 'named') => {
    logger.info(`  ${who.name}${address === 'named' ? '' : ` (${address})`}: ${text}`);
    call.hear({ speakerId: who.id, speakerName: who.name, text, at: Date.now(), address });
  };
  const turn = async (label: string, askers: Array<[Person, string]>) => {
    const started = Date.now();
    let pieces = 0;
    const chunker = new SentenceChunker((piece) => {
      pieces++;
      logger.info(`  [would start speaking after ${Date.now() - started} ms] ${piece}`);
    });
    const reply = await assistant.respondInCall({
      guildId: GUILD, conversation: call, askers: askers.map(([who, said]) => ({ ...who, said })),
      channelId: 'vc1', channelName: 'General', peoplePresent: [alex, sam, smoke], musicStatus: 'nothing playing',
      onText: (delta) => chunker.push(delta),
    });
    chunker.flush();
    const how = `${reply.outcome}${reply.silent ? ', said nothing' : ''}${reply.stopped ? ', told to stop' : ''}`;
    logger.info(`=== ${label}: ${reply.model} [${how}] after ${Date.now() - started} ms, ${pieces} spoken piece${pieces === 1 ? '' : 's'}: ${reply.text}`);
    return reply;
  };
  const ask = (label: string, who: Person, text: string, address: LineAddress = 'named') => {
    logger.info(`--- in the call, ${label}`);
    hear(who, text, address);
    return turn(label, [[who, text]]);
  };

  await type('1 (needs memory search)', 'What trip did Sam suggest when we were in voice chat the other day, and what did they say about price?');
  await type('2 (should read the prompt cache)', 'Thanks. Remind me what we just talked about, in one sentence.');
  await ask(`one question (${config.claude.voice.model})`, smoke, `${name}, when did Sam say we need to book by?`);

  // Long-term notes: Claude should decide to save these, and they should reach a call with that person in it.
  await type('3 (should save notes)', "Please remember that I'm vegetarian and my favourite game is Hades.");
  const saved = await memories.listAbout(GUILD, [USER], 10);
  logger.info(`Notes saved about Smoke: ${saved.map((m) => `#${m.id} ${m.text}`).join(' | ') || 'none'}`);
  await ask('someone else asks about Smoke (should use the notes)', sam, `${name}, what should we cook for Smoke tonight?`);

  // Two people ask at nearly the same moment: one reply should answer both, by name.
  logger.info('--- in the call, two people ask at once');
  const capital = `${name}, what's the capital of Australia?`;
  const players = `${name}, and how many players are on the field for one soccer team?`;
  hear(alex, capital);
  hear(sam, players);
  await turn('one reply for both', [[alex, capital], [sam, players]]);

  // Right after a reply, without the name: one line is for someone else, the next is a real follow-up.
  await ask('a line meant for someone else (should say nothing)', sam, 'Alex, did you remember to feed the cat?', 'maybe');
  await ask('a follow-up without the name (should answer)', alex, 'and what about New Zealand?', 'maybe');

  // Corrected while speaking: it should pick up from the correction, not start again.
  const first = await ask('a question it will be interrupted on', smoke, `${name}, what's the weather usually like in Kyoto in the spring?`);
  const [heard, ...unsaid] = first.text.split(/(?<=[.!?])\s+/);
  call.note(`You were interrupted while speaking. Heard so far: "${heard ?? ''}" ${unsaid.length > 0 ? `Not yet said: "${unsaid.join(' ')}"` : 'Nothing else was left to say.'}`);
  await ask('the correction (should continue from it)', smoke, 'no, sorry, I meant in the autumn', 'interrupting');

  // Talked over, but nothing changes: it should carry on.
  const second = await ask('another question it will be talked over on', alex, `${name}, give me three tips for packing light.`);
  call.note(`You were interrupted while speaking. Heard so far: "${second.text.split(/(?<=[.!?])\s+/)[0] ?? ''}" Not yet said: "the rest of your reply"`);
  await ask('someone agreeing out loud (should say nothing and carry on)', alex, 'mm-hm, yeah', 'interrupting');

  // Reminders: Claude should call set_reminder for the person who asked, then list_reminders when they type.
  await ask('should set a reminder', smoke, `${name}, remind me in ten minutes to take the pizza out.`);
  await type('(should list reminders)', 'What reminders do I have?');
  const set = await reminders.listActive(GUILD, USER);
  const due = set.map((r) => `#${r.id} "${r.message}" due in ${Math.round((r.dueAt - Date.now()) / 60_000)} min`);
  logger.info(`Reminders stored: ${due.join(' | ') || 'none'}`);

  // A recap of the seeded call, with a couple of plans added to it.
  const plans: Array<[string, string]> = [
    ['Alex', 'okay I will look up hotels in Kyoto this weekend'],
    ['Sam', 'perfect, and I will make a group chat for it'],
  ];
  for (const [index, [speaker, text]] of plans.entries()) {
    await transcripts.appendSegment({
      sessionId: session.id, guildId: GUILD, channelId: 'vc1', speakerId: `id-${speaker}`, speakerName: speaker,
      isAssistant: false, text, startedAt: t0 + 60_000 + index * 10_000, endedAt: t0 + 65_000 + index * 10_000,
    });
  }
  const recapper = new CallRecapper({
    messages: claude.beta.messages, transcripts, usage, budget: usage, model: config.claude.voice.model,
    effort: config.claude.voice.effort, assistantName: config.assistant.name, timeZone: config.assistant.timeZone,
    clock: Date.now, logger,
  });
  recapper.sessionEnded((await transcripts.getSession(session.id))!);
  await recapper.idle();
  logger.info(`Recap: ${(await transcripts.listSessions(GUILD, { limit: 1 }))[0]?.recap ?? '(none written)'}`);

  const stored = await conversations.loadActive(scope);
  logger.info(`Thread now holds ${stored.length} stored messages; thinking blocks stored: ${stored.some((m) => m.content.some((b) => b.type === 'thinking'))}`);
  const report = await usage.report(GUILD);
  const perModel = report.claude.map((m) => `${m.model}: ${m.requests} requests, $${m.costUsd.toFixed(4)}`).join('; ');
  logger.info(`Estimated cost of this smoke test: $${report.status.spentUsd.toFixed(4)} (${perModel}; ${report.webSearch.requests} web searches)`);
  await memory.close();
  db.close();
  memoryDb.close();
}

async function smokeAws(): Promise<void> {
  // Claude isn't used here, so don't require its settings (e.g. the workspace ID).
  const config = loadConfig(smokeEnv({ DISCORD_BOT_TOKEN: 'unused', CLIENT_ID: 'unused', GUILD_ID: GUILD }, { CLAUDE_PROVIDER: 'anthropic' }));
  const logger = createLogger('info');
  const sentence = `Hey ${config.assistant.name}, play some jazz in the living room.`;

  const tts = new PollyTextToSpeech({ region: config.aws.region, voiceId: config.aws.pollyVoiceId, engine: config.aws.pollyEngine });
  const mp3 = await tts.synthesize(sentence);
  let mp3Bytes = 0;
  for await (const chunk of mp3.audio) mp3Bytes += (chunk as Buffer).length;
  logger.info(`Polly (${config.aws.pollyEngine}/${config.aws.pollyVoiceId}) synthesised ${mp3Bytes} bytes of MP3.`);

  // Round trip: Polly PCM (16 kHz mono) -> Transcribe streaming.
  const polly = new PollyClient({ region: config.aws.region });
  const pcm = await polly.send(new SynthesizeSpeechCommand({
    Text: sentence, OutputFormat: 'pcm', SampleRate: '16000', VoiceId: config.aws.pollyVoiceId as never, Engine: config.aws.pollyEngine as never,
  }));
  const audio = Buffer.from(await pcm.AudioStream!.transformToByteArray());
  async function* chunks() {
    for (let offset = 0; offset < audio.length; offset += 3_200) yield audio.subarray(offset, offset + 3_200);
  }
  const stt = new TranscribeSpeechToText({ region: config.aws.region, languageCode: config.aws.transcribeLanguageCode });
  const transcript = await stt.transcribe(chunks(), { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 });
  logger.info(`Transcribe heard: "${transcript}"`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const runClaude = args.has('--claude') || !args.has('--aws');
  const runAws = args.has('--aws') || !args.has('--claude');
  if (runClaude) await smokeClaude();
  if (runAws) await smokeAws();
}

main().catch((error: unknown) => {
  process.stderr.write(`Smoke test failed: ${describeError(error)}\n`);
  process.exit(1);
});
