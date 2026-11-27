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
import type {
  ConversationRepository,
  MemoryRepository,
  Modality,
  SettingsRepository,
  TranscriptSegment,
  UserScope,
  WindowPolicy,
} from '../storage/ports.js';
import type { BudgetGate, UsageMeter } from '../usage/UsageService.js';
import { claudeUsageFrom } from '../usage/UsageService.js';
import { KeyedMutex } from '../util/KeyedMutex.js';
import type { Clock } from '../util/time.js';
import { collectSources, collectText, contentForTurnReplay, finalizeTurn, type Source } from './history.js';
import { VOICE_TURN_PREFIX, buildAmbientExcerpt, buildSavedNotes, buildSituationNote, buildSystemPrompt } from './prompts.js';
import { resolveStyle } from './styles.js';
import type { ToolRegistry } from './tools/ToolRegistry.js';
import type { ToolContext, TurnSignals } from './tools/types.js';

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

export interface AssistantRequest {
  scope: UserScope;
  modality: Modality;
  userDisplayName: string;
  /** What the person typed or said. */
  text: string;
  /** Text channel (text turns) or voice channel (spoken turns) name. */
  channelName?: string;
  /** Voice channel the person is in right now, if any. */
  userVoiceChannelId?: string;
  userVoiceChannelName?: string;
  /** Other people in the conversation (the voice channel), with their Discord user IDs. */
  peoplePresent?: ReadonlyArray<{ id: string; name: string }>;
  musicStatus?: string;
  /** Recent voice-channel conversation (spoken turns only). */
  ambient?: readonly TranscriptSegment[];
  /** Where to post replies the assistant sends later (reminders): the text channel, or the voice channel's chat. */
  textChannelId?: string;
  /** Spoken right after the assistant's last reply to this person, without its name. */
  followUp?: boolean;
  /** Images attached to this message. */
  images?: readonly AttachedImage[];
  /** Receives the reply's text as it's written (for speaking it sentence by sentence). */
  onText?: (textDelta: string) => void;
  /** Aborting stops the turn; respond() then rejects and nothing is stored. */
  signal?: AbortSignal;
}

export type ReplyOutcome = 'answered' | 'truncated' | 'refused' | 'incomplete';

export interface AssistantReply {
  text: string;
  /** stop_speaking was called: say nothing. */
  silent: boolean;
  outcome: ReplyOutcome;
  sources: Source[];
  /** Model that produced the reply (differs from the route's model if a fallback served it). */
  model: string;
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

/**
 * The Claude-backed assistant: one entry point for typed and spoken turns. Each person's thread
 * (shared across text and voice) is loaded, extended with this turn, run through the tool loop,
 * then appended to storage.
 */
export class Assistant {
  private readonly mutex = new KeyedMutex();
  private readonly systemByRoute = new Map<Modality, BetaTextBlockParam[]>();
  private readonly toolsByRoute = new Map<Modality, BetaToolUnion[]>();
  private readonly window: WindowPolicy;

  constructor(private readonly deps: AssistantDeps) {
    this.window = deps.window ?? DEFAULT_WINDOW;
    // System prompt and tools are fixed per route for the life of the process. Each route runs on
    // its own model, and caches are per model, so per-route prompts cost no cache hits. One explicit
    // breakpoint on the system prompt (tools render before it, so they're cached with it); top-level
    // automatic caching covers the growing conversation.
    for (const modality of ['text', 'voice'] as const) {
      const route = deps.routes[modality];
      const text = buildSystemPrompt(deps.assistantName, { webSearch: route.webSearchMaxUses !== undefined });
      this.systemByRoute.set(modality, [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]);
      this.toolsByRoute.set(modality, this.buildTools(route));
    }
  }

  respond(request: AssistantRequest): Promise<AssistantReply> {
    const key = `${request.scope.guildId}:${request.scope.userId}`;
    return this.mutex.run(key, () => this.runTurn(request));
  }

  private async runTurn(request: AssistantRequest): Promise<AssistantReply> {
    const { deps } = this;
    if (deps.budget?.isPaused(request.scope.guildId)) throw new BudgetExceededError(request.scope.guildId);
    request.signal?.throwIfAborted();
    const route = deps.routes[request.modality];
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
    const storedText = `${request.modality === 'voice' ? VOICE_TURN_PREFIX : ''}${request.text}${imageNote}`;
    const userContent: BetaContentBlockParam[] = [];
    const notes = buildSavedNotes(memories, request.scope.userId);
    if (notes) userContent.push({ type: 'text', text: notes });
    const ambient = request.modality === 'voice' ? buildAmbientExcerpt(request.ambient ?? [], deps.timeZone) : undefined;
    if (ambient) userContent.push({ type: 'text', text: ambient });
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
        modality: request.modality,
        userId: request.scope.userId,
        userDisplayName: request.userDisplayName,
        channelName: request.channelName,
        userVoiceChannelName: request.userVoiceChannelName,
        peoplePresent: request.peoplePresent ?? [],
        musicStatus: request.musicStatus ?? 'nothing playing',
        style: resolveStyle(settings?.style),
        followUp: request.followUp === true,
      }),
    };

    // What goes to the model: stored history, this turn (with ambient excerpt), then the
    // situation note. What gets stored: the plain user message plus the model's own messages.
    const messages: BetaMessageParam[] = [
      ...history.map((message): BetaMessageParam => ({ role: message.role, content: message.content })),
      { role: 'user', content: userContent },
      situation,
    ];
    const turn: BetaMessageParam[] = [{ role: 'user', content: [{ type: 'text', text: storedText }] }];

    const signals: TurnSignals = { silenceRequested: false };
    const toolContext: ToolContext = {
      guildId: request.scope.guildId,
      userId: request.scope.userId,
      userDisplayName: request.userDisplayName,
      modality: request.modality,
      voiceChannelId: request.userVoiceChannelId,
      textChannelId: request.textChannelId,
      signals,
    };
    const timeout = AbortSignal.timeout(route.timeoutMs);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
    // Once stop_speaking has run, nothing more from this turn should be heard.
    const onText = request.onText
      ? (delta: string) => {
          if (!signals.silenceRequested) request.onText!(delta);
        }
      : undefined;
    const output: BetaContentBlock[] = [];
    let outcome: ReplyOutcome = 'incomplete';
    let servedBy = route.model;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      request.signal?.throwIfAborted();
      const message = await this.callModel(request.modality, route, messages, signal, onText);
      servedBy = message.model;
      this.logUsage(request, route, message);
      deps.usage?.recordClaude(request.scope.guildId, message.model, claudeUsageFrom(message.usage));

      if (message.stop_reason === 'refusal') {
        deps.logger.warn(
          `Claude declined a ${request.modality} request from ${request.scope.userId} (category: ${message.stop_details?.category ?? 'none'})`,
        );
        // A declined turn is not stored, so it doesn't colour the rest of the conversation.
        return {
          text:
            request.modality === 'voice'
              ? "Sorry, I can't help with that one."
              : "Sorry, I can't help with that request.",
          silent: false,
          outcome: 'refused',
          sources: [],
          model: servedBy,
        };
      }

      const content = contentForTurnReplay(message.content);
      output.push(...content);
      messages.push({ role: 'assistant', content: content as BetaContentBlockParam[] });
      turn.push({ role: 'assistant', content: content as BetaContentBlockParam[] });

      if (message.stop_reason === 'pause_turn') continue; // server tool loop paused; resend to resume

      const toolUses = content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      if (message.stop_reason === 'tool_use' && toolUses.length > 0) {
        const results: BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const result = await deps.tools.call(use.name, use.input, toolContext);
          if (result.isError) deps.logger.info(`Tool ${use.name} returned an error: ${result.content}`);
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: results });
        turn.push({ role: 'user', content: results });
        continue;
      }

      outcome = message.stop_reason === 'max_tokens' ? 'truncated' : 'answered';
      break;
    }

    if (outcome === 'incomplete') {
      deps.logger.warn(`Turn for ${request.scope.userId} hit the ${MAX_ITERATIONS}-iteration tool limit`);
    }

    const stored = finalizeTurn(turn);
    if (stored.length > 0 && stored[0]!.role === 'user') {
      await deps.conversations.appendTurn({ scope: request.scope, modality: request.modality, messages: stored, createdAt: now });
      await deps.conversations.trimWindow(request.scope, this.window);
    }

    const text = collectText(output);
    return {
      text:
        text.length > 0 || signals.silenceRequested
          ? text
          : outcome === 'incomplete'
            ? 'Sorry, I got stuck working on that. Could you try asking another way?'
            : '',
      silent: signals.silenceRequested,
      outcome,
      sources: collectSources(output),
      model: servedBy,
    };
  }

  private async callModel(
    modality: Modality,
    route: AssistantRoute,
    messages: BetaMessageParam[],
    signal: AbortSignal,
    onText: ((delta: string) => void) | undefined,
  ): Promise<BetaMessage> {
    const fallbacks = MODELS_WITH_SERVER_FALLBACK.has(route.model);
    const params = {
      model: route.model,
      max_tokens: route.maxTokens,
      system: this.systemByRoute.get(modality)!,
      messages,
      tools: this.toolsByRoute.get(modality)!,
      thinking: { type: 'adaptive' as const },
      output_config: { effort: route.effort },
      cache_control: { type: 'ephemeral' as const },
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

  private buildTools(route: AssistantRoute): BetaToolUnion[] {
    const tools: BetaToolUnion[] = this.deps.tools.definitions().map((definition) => ({
      name: definition.name,
      description: definition.description,
      input_schema: definition.inputSchema,
      // Requests are streamed; let tool inputs stream as they're generated (validated before running).
      eager_input_streaming: true,
    }));
    if (route.webSearchMaxUses !== undefined) {
      tools.push({
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: route.webSearchMaxUses,
        // Direct calls (no dynamic-filtering code execution): lower latency for voice, and the same
        // block shapes in history whichever model (Opus or Haiku) answers the shared thread.
        allowed_callers: ['direct'],
      });
    }
    return tools;
  }

  private logUsage(request: AssistantRequest, route: AssistantRoute, message: BetaMessage): void {
    const usage = message.usage;
    this.deps.logger.debug(
      `Claude ${message.model} (${request.modality}) stop=${message.stop_reason} in=${usage.input_tokens} ` +
        `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} out=${usage.output_tokens}`,
    );
    if (message.model !== route.model) {
      this.deps.logger.info(`Request was served by fallback model ${message.model} instead of ${route.model}`);
    }
  }
}

/** Keeps a file name on one line and short inside the stored placeholder. */
function oneLineName(name: string): string {
  const flat = name.replace(/[\s\]\[]+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat || 'image';
}
