import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Effort } from '../config/config.js';
import type { Logger } from '../logging/logger.js';
import type { ConversationRepository, MemoryRepository, Modality, SettingsRepository, UserScope, WindowPolicy } from '../storage/ports.js';
import type { BudgetGate, UsageMeter } from '../usage/UsageService.js';
import { claudeUsageFrom } from '../usage/UsageService.js';
import { KeyedMutex } from '../util/KeyedMutex.js';
import type { Clock } from '../util/time.js';
import type { CallConversation } from './CallConversation.js';
import { collectSources, collectText, contentForTurnReplay, finalizeTurn, type Source } from './history.js';
import {
  VOICE_TURN_PREFIX,
  buildCallSituationNote,
  buildCallSystemPrompt,
  buildSavedNotes,
  buildSituationNote,
  buildSystemPrompt,
} from './prompts.js';
import { DEFAULT_STYLE, resolveStyle } from './styles.js';
import type { ToolRegistry } from './tools/ToolRegistry.js';
import type { ToolContext, ToolResult, TurnSignals } from './tools/types.js';

/** The slice of the Anthropic client the assistant uses (`client.beta.messages`); fakeable in tests. */
export interface MessagesApi {
  stream(body: Parameters<Anthropic['beta']['messages']['stream']>[0], options?: { signal?: AbortSignal }): {
    /** Text as the model writes it (only text blocks: not thinking or tool input). */
    on(event: 'text', listener: (textDelta: string) => void): unknown;
    finalMessage(): Promise<BetaMessage>;
  };
}

/** Per-modality model settings. */
export interface AssistantRoute {
  model: string;
  effort: Effort;
  maxTokens: number;
  timeoutMs: number;
  /** Max web searches per turn; undefined disables web search on this route. */
  webSearchMaxUses: number | undefined;
}

export interface AssistantDeps {
  messages: MessagesApi;
  conversations: ConversationRepository;
  settings: SettingsRepository;
  tools: ToolRegistry;
  logger: Logger;
  clock: Clock;
  assistantName: string;
  timeZone: string;
  routes: Record<Modality, AssistantRoute>;
  window?: WindowPolicy;
  /** Long-term notes about people; attached to each turn when present. */
  memories?: MemoryRepository;
  /** Records what each model call cost. */
  usage?: UsageMeter;
  /** Refuses new turns once the server's daily budget is spent. */
  budget?: BudgetGate;
  /**
   * Also copy what each person asked in a call, and the reply, into their own typed thread, so
   * /chat knows about it later. Default true.
   */
  saveCallTurnsToThreads?: boolean;
}

/** An image attached to a typed message. Sent with that turn only; history keeps a placeholder. */
export interface AttachedImage {
  name: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** Base64-encoded bytes. */
  data: string;
}

/** Thrown by respond() when the server has used up today's budget; no model call was made. */
export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(readonly guildId: string) {
    super(`The daily budget for guild ${guildId} has been reached.`);
  }
}

/** A typed message to the assistant (/chat, or a message that mentions it). */
export interface AssistantRequest {
  scope: UserScope;
  userDisplayName: string;
  /** What the person typed. */
  text: string;
  /** The text channel it was typed in. */
  channelName?: string;
  /** Voice channel the person is in right now, if any. */
  userVoiceChannelId?: string;
  userVoiceChannelName?: string;
  /** The people in that voice channel, with their Discord user IDs. */
  peoplePresent?: ReadonlyArray<{ id: string; name: string }>;
  musicStatus?: string;
  /** Where to post replies the assistant sends later (reminders). */
  textChannelId?: string;
  /** Images attached to this message. */
  images?: readonly AttachedImage[];
  /** Aborting stops the turn; respond() then rejects and nothing is stored. */
  signal?: AbortSignal;
}

/** Someone a turn in a call is answering. */
export interface CallAsker {
  id: string;
  name: string;
  /** What they said to the assistant this turn (kept with the reply in their own typed thread). */
  said: string;
}

/** One turn of the assistant in a voice call. */
export interface CallTurnRequest {
  guildId: string;
  /** The call's conversation. Everything heard so far is the turn's input; the reply is recorded in it. */
  conversation: CallConversation;
  /** The people being answered, most recent speaker last. Tools act for the last unless the model names another. */
  askers: readonly CallAsker[];
  channelId: string;
  channelName: string;
  peoplePresent: ReadonlyArray<{ id: string; name: string }>;
  musicStatus: string;
  /** Receives the reply's text as it's written, to be spoken sentence by sentence. */
  onText?: (textDelta: string) => void;
  /**
   * Called when a tool is about to run. From then on the turn may have done something (set a
   * reminder, queued a song), so it can't simply be thrown away and started again.
   */
  onToolCall?: (name: string) => void;
  /** Aborting stops the turn; respondInCall() then rejects and the conversation is left as it was. */
  signal?: AbortSignal;
}

export type ReplyOutcome = 'answered' | 'truncated' | 'refused' | 'incomplete';

export interface AssistantReply {
  text: string;
  /** The assistant chose to say nothing (say_nothing or stop_speaking). */
  silent: boolean;
  outcome: ReplyOutcome;
  sources: Source[];
  /** Model that produced the reply (differs from the route's model if a fallback served it). */
  model: string;
}

export interface CallTurnReply extends AssistantReply {
  /** stop_speaking was called: someone told the assistant to stop, so everything should go quiet. */
  stopped: boolean;
  /** leave_call was called: someone told the assistant to go, so it leaves once the reply has been said. */
  leave: boolean;
}

/** Server-side refusal fallback; documented for these models (Claude Haiku 5.5 has none). */
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MODELS_WITH_SERVER_FALLBACK = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-fable-5-2',
  'claude-fable-5-1',
]);

const MAX_ITERATIONS = 10;
/** Notes attached per person (and for the server) each turn, and how many other people get theirs. */
const NOTES_PER_SUBJECT = 12;
const MAX_OTHER_PEOPLE_WITH_NOTES = 8;
const MAX_STREAM_RETRIES = 2;
const DEFAULT_WINDOW: WindowPolicy = { maxMessages: 48, keepMessages: 24 };
/** The extra input every tool takes in a call: who the action is for. */
const REQUESTER_PARAM = 'requester_id';

/** How one kind of conversation reaches the model: its model settings, fixed prompt and tools. */
interface Lane {
  route: AssistantRoute;
  system: BetaTextBlockParam[];
  tools: BetaToolUnion[];
}

/** One run of the model loop: a request that grows as the model calls tools. */
interface LoopRun {
  modality: Modality;
  guildId: string;
  /** Who the turn is for, in log lines. */
  who: string;
  /** The request so far. The model's messages and the tool results are added to it. */
  messages: BetaMessageParam[];
  /** What the turn adds to the stored conversation; grows in step with `messages`. */
  turn: BetaMessageParam[];
  signals: TurnSignals;
  signal: AbortSignal | undefined;
  onText: ((delta: string) => void) | undefined;
  /** Let the API place the cache breakpoint at the end of the request (typed threads). */
  autoCache: boolean;
  /** What a tool call runs with, or the error to give the model instead of running it. */
  toolFor: (use: BetaToolUseBlock) => { input: unknown; context: ToolContext } | ToolResult;
  onToolCall: ((name: string) => void) | undefined;
  /** End the turn as soon as a tool asks for silence, without going back to the model. */
  endOnSilence: boolean;
}

/**
 * The Claude-backed assistant. Typed messages go through respond(): each person has their own
 * thread, which is loaded, extended with the turn, run through the tool loop, and stored. Voice
 * calls go through respondInCall(): everyone in a call shares one conversation, and each turn
 * answers whatever has been said to the assistant since its last one.
 */
export class Assistant {
  private readonly mutex = new KeyedMutex();
  private readonly lanes: Record<Modality, Lane>;
  private readonly window: WindowPolicy;

  constructor(private readonly deps: AssistantDeps) {
    this.window = deps.window ?? DEFAULT_WINDOW;
    // System prompt and tools are fixed per lane for the life of the process. Each lane runs on its
    // own model, and caches are per model, so separate prompts cost no cache hits. Each has an
    // explicit breakpoint on its system prompt (tools render before it, so they're cached with it).
    const lane = (modality: Modality): Lane => {
      const route = deps.routes[modality];
      const options = { webSearch: route.webSearchMaxUses !== undefined };
      const inCall = modality === 'voice';
      const text = inCall ? buildCallSystemPrompt(deps.assistantName, options) : buildSystemPrompt(deps.assistantName, options);
      return { route, system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }], tools: this.buildTools(route, inCall) };
    };
    this.lanes = { text: lane('text'), voice: lane('voice') };
  }

  /** Answers a typed message, in that person's own thread. */
  respond(request: AssistantRequest): Promise<AssistantReply> {
    const key = `${request.scope.guildId}:${request.scope.userId}`;
    return this.mutex.run(key, () => this.runTurn(request));
  }

  /**
   * Takes a turn in a voice call: answers what has been said to the assistant since its last turn
   * (or decides there is nothing to say), and records the turn in the call's conversation.
   */
  respondInCall(request: CallTurnRequest): Promise<CallTurnReply> {
    return this.mutex.run(`call:${request.guildId}`, () => this.runCallTurn(request));
  }

  private async runTurn(request: AssistantRequest): Promise<AssistantReply> {
    const { deps } = this;
    if (deps.budget?.isPaused(request.scope.guildId)) throw new BudgetExceededError(request.scope.guildId);
    request.signal?.throwIfAborted();
    const now = deps.clock();
    const others = (request.peoplePresent ?? [])
      .filter((person) => person.id !== request.scope.userId)
      .slice(0, MAX_OTHER_PEOPLE_WITH_NOTES);
    const [history, settings, memories] = await Promise.all([
      deps.conversations.loadActive(request.scope),
      deps.settings.get(request.scope),
      deps.memories
        ? deps.memories.listAbout(
            request.scope.guildId,
            [request.scope.userId, ...others.map((person) => person.id), null],
            NOTES_PER_SUBJECT,
          )
        : Promise.resolve([]),
    ]);

    const images = request.images ?? [];
    const imageNote = images.length > 0 ? `\n${images.map((image) => `[image: ${oneLineName(image.name)}]`).join(' ')}` : '';
    const storedText = `${request.text}${imageNote}`;
    const userContent: BetaContentBlockParam[] = [];
    const notes = buildSavedNotes(memories, request.scope.userId);
    if (notes) userContent.push({ type: 'text', text: notes });
    // Images go before the text that refers to them. They're sent with this turn only: stored
    // history keeps the "[image: name]" placeholder instead of the bytes.
    for (const image of images) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
    }
    userContent.push({ type: 'text', text: storedText });

    const situation: BetaMessageParam = {
      role: 'system',
      content: buildSituationNote({
        now,
        timeZone: deps.timeZone,
        userId: request.scope.userId,
        userDisplayName: request.userDisplayName,
        channelName: request.channelName,
        userVoiceChannelName: request.userVoiceChannelName,
        peoplePresent: request.peoplePresent ?? [],
        musicStatus: request.musicStatus ?? 'nothing playing',
        style: resolveStyle(settings?.style),
      }),
    };

    // What goes to the model: stored history, this turn, then the situation note. What gets
    // stored: the plain user message plus the model's own messages.
    const messages: BetaMessageParam[] = [
      ...history.map((message): BetaMessageParam => ({ role: message.role, content: message.content })),
      { role: 'user', content: userContent },
      situation,
    ];
    const turn: BetaMessageParam[] = [{ role: 'user', content: [{ type: 'text', text: storedText }] }];

    const signals: TurnSignals = { silenceRequested: false, stopRequested: false, leaveRequested: false };
    const toolContext: ToolContext = {
      guildId: request.scope.guildId,
      userId: request.scope.userId,
      userDisplayName: request.userDisplayName,
      modality: 'text',
      voiceChannelId: request.userVoiceChannelId,
      textChannelId: request.textChannelId,
      signals,
    };
    const { output, outcome, servedBy } = await this.runLoop({
      modality: 'text',
      guildId: request.scope.guildId,
      who: request.scope.userId,
      messages,
      turn,
      signals,
      signal: request.signal,
      onText: undefined,
      autoCache: true,
      toolFor: (use) => ({ input: use.input, context: toolContext }),
      onToolCall: undefined,
      endOnSilence: false,
    });
    // A declined turn is not stored, so it doesn't colour the rest of the conversation.
    if (outcome === 'refused') {
      return { text: "Sorry, I can't help with that request.", silent: false, outcome, sources: [], model: servedBy };
    }

    const stored = finalizeTurn(turn);
    if (stored.length > 0 && stored[0]!.role === 'user') {
      await deps.conversations.appendTurn({ scope: request.scope, modality: 'text', messages: stored, createdAt: now });
      await deps.conversations.trimWindow(request.scope, this.window);
    }
    return {
      text: replyText(output, outcome, signals),
      silent: signals.silenceRequested,
      outcome,
      sources: collectSources(output),
      model: servedBy,
    };
  }

  private async runCallTurn(request: CallTurnRequest): Promise<CallTurnReply> {
    const { deps } = this;
    if (deps.budget?.isPaused(request.guildId)) throw new BudgetExceededError(request.guildId);
    request.signal?.throwIfAborted();
    const now = deps.clock();
    const { askers, conversation } = request;
    const subjects = [...new Set([...askers.map((asker) => asker.id), ...request.peoplePresent.map((person) => person.id)])].slice(
      0,
      MAX_OTHER_PEOPLE_WITH_NOTES + 1,
    );
    const [settings, memories] = await Promise.all([
      // One person's own style when answering just them; the default when answering several.
      askers.length === 1 ? deps.settings.get({ guildId: request.guildId, userId: askers[0]!.id }) : Promise.resolve(undefined),
      deps.memories ? deps.memories.listAbout(request.guildId, [...subjects, null], NOTES_PER_SUBJECT) : Promise.resolve([]),
    ]);

    const mark = conversation.mark();
    const messages = conversation.messages(mark);
    const last = messages.at(-1);
    const content = last?.role === 'user' && Array.isArray(last.content) ? last.content : undefined;
    const newest = content?.at(-1);
    if (!content || newest?.type !== 'text') {
      throw new Error('A turn in a call needs something to have been heard since the last one.');
    }
    // Everything up to here is repeated exactly by the next turn, so the cache breakpoint goes at
    // its end. The notes and the situation change every time; they come after it and aren't kept.
    newest.cache_control = { type: 'ephemeral' };
    const notes = buildSavedNotes(memories, askers.map((asker) => asker.id));
    if (notes) content.push({ type: 'text', text: notes });
    messages.push({
      role: 'system',
      content: buildCallSituationNote({
        now,
        timeZone: deps.timeZone,
        channelName: request.channelName,
        peoplePresent: request.peoplePresent,
        askers,
        musicStatus: request.musicStatus,
        style: askers.length === 1 ? resolveStyle(settings?.style) : DEFAULT_STYLE,
      }),
    });

    const turn: BetaMessageParam[] = [];
    const signals: TurnSignals = { silenceRequested: false, stopRequested: false, leaveRequested: false };
    let result: Awaited<ReturnType<Assistant['runLoop']>>;
    try {
      result = await this.runLoop({
        modality: 'voice',
        guildId: request.guildId,
        who: askers.map((asker) => asker.id).join(', ') || 'the call',
        messages,
        turn,
        signals,
        signal: request.signal,
        onText: request.onText,
        autoCache: false,
        toolFor: (use) => this.callToolFor(use, request, signals),
        onToolCall: request.onToolCall,
        endOnSilence: true,
      });
    } catch (error) {
      // Stopped part-way. Tools that had already run still happened, so they stay on record.
      const done = finalizeTurn(turn);
      if (done.some((message) => message.content.some((block) => block.type === 'tool_result'))) conversation.reply(mark, done);
      throw error;
    }
    const { output, outcome, servedBy } = result;
    if (outcome === 'refused') {
      // The lines that were declined come out of the conversation, or every later turn would be declined too.
      conversation.strike(mark, 'Some of what was said here has been left out: you declined to respond to it.');
      return { text: "Sorry, I can't help with that one.", silent: false, stopped: false, leave: false, outcome, sources: [], model: servedBy };
    }

    if (!conversation.reply(mark, finalizeTurn(turn))) {
      deps.logger.warn(`A call turn in guild ${request.guildId} could not be recorded: the conversation had moved on past it.`);
    }
    const text = replyText(output, outcome, signals);
    if (text.length > 0 && !signals.silenceRequested && deps.saveCallTurnsToThreads !== false) this.copyToThreads(request, text, now);
    return {
      text,
      silent: signals.silenceRequested,
      stopped: signals.stopRequested,
      leave: signals.leaveRequested,
      outcome,
      sources: collectSources(output),
      model: servedBy,
    };
  }

  /** Who a tool call in a call acts for: the person the model named, or the last one to speak to it. */
  private callToolFor(use: BetaToolUseBlock, request: CallTurnRequest, signals: TurnSignals): { input: unknown; context: ToolContext } | ToolResult {
    const input: Record<string, unknown> = typeof use.input === 'object' && use.input !== null ? { ...(use.input as Record<string, unknown>) } : {};
    const named = input[REQUESTER_PARAM];
    delete input[REQUESTER_PARAM];
    const { askers } = request;
    if (askers.length === 0) return { content: 'Nobody is talking to you right now, so there is no one to do this for.', isError: true };
    const wanted = typeof named === 'string' ? named.trim() : typeof named === 'number' ? String(named) : '';
    const asker = wanted === '' ? askers.at(-1) : askers.find((candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted.toLowerCase());
    if (!asker) {
      const list = askers.map((candidate) => `${candidate.name} (user ${candidate.id})`).join(', ');
      return { content: `${REQUESTER_PARAM} must be someone you are answering right now: ${list}.`, isError: true };
    }
    return {
      input,
      context: {
        guildId: request.guildId,
        userId: asker.id,
        userDisplayName: asker.name,
        modality: 'voice',
        voiceChannelId: request.channelId,
        textChannelId: request.channelId,
        signals,
      },
    };
  }

  /**
   * Keeps what each person asked in the call, with the reply, in their own typed thread too. Not
   * awaited: it queues behind that person's own turns, and the call shouldn't wait on those.
   */
  private copyToThreads(request: CallTurnRequest, reply: string, at: number): void {
    for (const asker of request.askers) {
      const said = asker.said.trim();
      if (said.length === 0) continue;
      const scope = { guildId: request.guildId, userId: asker.id };
      void this.mutex
        .run(`${scope.guildId}:${scope.userId}`, async () => {
          await this.deps.conversations.appendTurn({
            scope,
            modality: 'voice',
            messages: [
              { role: 'user', content: [{ type: 'text', text: `${VOICE_TURN_PREFIX}${said}` }] },
              { role: 'assistant', content: [{ type: 'text', text: reply }] },
            ],
            createdAt: at,
          });
          await this.deps.conversations.trimWindow(scope, this.window);
        })
        .catch((error: unknown) =>
          this.deps.logger.warn(`Could not copy a call turn into ${asker.id}'s thread: ${error instanceof Error ? error.message : String(error)}`),
        );
    }
  }

  /** Runs the model, then its tool calls, until it has an answer (or asks for silence in a call). */
  private async runLoop(run: LoopRun): Promise<{ output: BetaContentBlock[]; outcome: ReplyOutcome; servedBy: string }> {
    const { deps } = this;
    const lane = this.lanes[run.modality];
    const timeout = AbortSignal.timeout(lane.route.timeoutMs);
    const signal = run.signal ? AbortSignal.any([timeout, run.signal]) : timeout;
    // Once a tool has asked for silence, nothing more from this turn should be heard.
    const onText = run.onText
      ? (delta: string) => {
          if (!run.signals.silenceRequested) run.onText!(delta);
        }
      : undefined;
    const output: BetaContentBlock[] = [];
    let outcome: ReplyOutcome = 'incomplete';
    let servedBy = lane.route.model;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      run.signal?.throwIfAborted();
      const message = await this.callModel(lane, run.messages, signal, onText, run.autoCache);
      servedBy = message.model;
      this.logUsage(run.modality, lane.route, message);
      deps.usage?.recordClaude(run.guildId, message.model, claudeUsageFrom(message.usage));

      if (message.stop_reason === 'refusal') {
        deps.logger.warn(`Claude declined a ${run.modality} request from ${run.who} (category: ${message.stop_details?.category ?? 'none'})`);
        return { output: [], outcome: 'refused', servedBy };
      }

      const content = contentForTurnReplay(message.content);
      output.push(...content);
      run.messages.push({ role: 'assistant', content: content as BetaContentBlockParam[] });
      run.turn.push({ role: 'assistant', content: content as BetaContentBlockParam[] });

      if (message.stop_reason === 'pause_turn') continue; // server tool loop paused; resend to resume

      const toolUses = content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      if (message.stop_reason === 'tool_use' && toolUses.length > 0) {
        const results: BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          // Stopped or being redone: don't start anything that can't be taken back.
          run.signal?.throwIfAborted();
          const prepared = run.toolFor(use);
          let result: ToolResult;
          if ('context' in prepared) {
            run.onToolCall?.(use.name);
            result = await deps.tools.call(use.name, prepared.input, prepared.context);
          } else {
            result = prepared;
          }
          if (result.isError) deps.logger.info(`Tool ${use.name} returned an error: ${result.content}`);
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          });
        }
        run.messages.push({ role: 'user', content: results });
        run.turn.push({ role: 'user', content: results });
        if (run.endOnSilence && run.signals.silenceRequested) {
          outcome = 'answered';
          break;
        }
        continue;
      }

      outcome = message.stop_reason === 'max_tokens' ? 'truncated' : 'answered';
      break;
    }

    if (outcome === 'incomplete') deps.logger.warn(`Turn for ${run.who} hit the ${MAX_ITERATIONS}-iteration tool limit`);
    return { output, outcome, servedBy };
  }

  private async callModel(
    lane: Lane,
    messages: BetaMessageParam[],
    signal: AbortSignal,
    onText: ((delta: string) => void) | undefined,
    autoCache: boolean,
  ): Promise<BetaMessage> {
    const { route } = lane;
    const fallbacks = MODELS_WITH_SERVER_FALLBACK.has(route.model);
    const params = {
      model: route.model,
      max_tokens: route.maxTokens,
      system: lane.system,
      messages,
      tools: lane.tools,
      thinking: { type: 'adaptive' as const },
      output_config: { effort: route.effort },
      ...(autoCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      ...(fallbacks ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      let streamedText = false;
      try {
        const stream = this.deps.messages.stream(params, { signal });
        if (onText) {
          stream.on('text', (delta) => {
            streamedText = true;
            onText(delta);
          });
        }
        return await stream.finalMessage();
      } catch (error) {
        // API errors (rate limits, auth, 4xx/5xx after the SDK's own retries) and timeouts are final.
        // Anything else is a dropped stream or an unparseable streamed tool input: re-issue the request,
        // unless part of the reply was already passed on (it would be said twice).
        if (error instanceof Anthropic.APIError || signal.aborted || streamedText || attempt >= MAX_STREAM_RETRIES) throw error;
        this.deps.logger.warn(`Re-issuing a model request after a stream error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** In a call, every tool also takes who the action is for (see callToolFor). */
  private buildTools(route: AssistantRoute, inCall: boolean): BetaToolUnion[] {
    const tools: BetaToolUnion[] = this.deps.tools.definitions().map((definition) => ({
      name: definition.name,
      description: definition.description,
      input_schema: inCall
        ? {
            ...definition.inputSchema,
            properties: {
              ...definition.inputSchema.properties,
              [REQUESTER_PARAM]: {
                type: 'string',
                description:
                  'Discord user ID of the person this is for. Only needed when you are answering more than one person; otherwise it is the person talking to you.',
              },
            },
          }
        : definition.inputSchema,
      // Requests are streamed; let tool inputs stream as they're generated (validated before running).
      eager_input_streaming: true,
    }));
    if (route.webSearchMaxUses !== undefined) {
      tools.push({
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: route.webSearchMaxUses,
        // Direct calls (no dynamic-filtering code execution): lower latency for voice, and the same
        // block shapes in history whichever model answers.
        allowed_callers: ['direct'],
      });
    }
    return tools;
  }

  private logUsage(modality: Modality, route: AssistantRoute, message: BetaMessage): void {
    const usage = message.usage;
    this.deps.logger.debug(
      `Claude ${message.model} (${modality}) stop=${message.stop_reason} in=${usage.input_tokens} ` +
        `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} out=${usage.output_tokens}`,
    );
    if (message.model !== route.model) {
      this.deps.logger.info(`Request was served by fallback model ${message.model} instead of ${route.model}`);
    }
  }
}

/** What the model wrote, or an apology if it ran out of steps without writing anything. */
function replyText(output: readonly BetaContentBlock[], outcome: ReplyOutcome, signals: TurnSignals): string {
  const text = collectText(output);
  if (text.length > 0 || signals.silenceRequested) return text;
  return outcome === 'incomplete' ? 'Sorry, I got stuck working on that. Could you try asking another way?' : '';
}

/** Keeps a file name on one line and short inside the stored placeholder. */
function oneLineName(name: string): string {
  const flat = name.replace(/[\s\]\[]+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat || 'image';
}
