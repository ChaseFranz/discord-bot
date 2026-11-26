# Nimbus

Nimbus is an Alexa-style assistant for your Discord voice calls, powered by Claude. It sits in a voice channel, follows the conversation, and answers whoever says its name ("Nimbus, …"). It keeps a separate conversation with each person, and it can look back over what the whole group said. You can also type to it with `/chat`. Your typed and spoken conversation is one thread, so it remembers both.

- **Claude** handles the thinking: Claude Opus 5.5 for typed `/chat` replies, Claude Haiku 5.5 for spoken replies, which need to be fast. Both can be changed in `.env`. It's reached through **Claude Platform on AWS**, so requests use your AWS credentials and show up on your AWS bill.
- **AWS Transcribe** turns speech into text (streamed while people are still talking), and **AWS Polly** speaks the replies.
- An **MCP memory server** gives Claude tools to search and read past voice conversations and each person's own history. Old context is fetched when it's needed instead of always being stuffed into the prompt.
- **Music** from YouTube, by slash command or by voice ("Nimbus, play some lo-fi"). Music pauses while the assistant talks.
- **Web search** for anything recent (news, scores, prices, weather).

## How it works

```text
voice channel ─► each person's audio ─► AWS Transcribe ─► transcript line ─► SQLite (ambient transcript)
                                                                │
                                                      contains "Nimbus"?
                                                                │ yes
                                                                ▼
   last few minutes of the call ─┐
   that person's thread ─────────┼─► Claude (Haiku) ◄─► tools: memory (MCP), music,
   situation note ───────────────┘          │                  stop_speaking, web search
                                            ▼
                              AWS Polly ─► spoken in the channel ─► also saved to the transcript
```

### Memory

There are three kinds, all stored locally with SQLite:

1. **Each person's thread** with the assistant (`data/bot.db`): typed and spoken turns, with tool calls. The most recent stretch is sent with every request. Older turns move out of view but stay stored and searchable.
2. **The ambient transcript** (`data/bot.db`): everything said in a voice channel while the bot is listening, including its own spoken replies, grouped into sessions.
3. **Long-term notes about people** (`data/memories.db`, a separate database): short facts Nimbus saves when someone tells it something worth remembering, such as "Is vegetarian" or "Birthday: May 3", plus a few facts about the server itself.

With each spoken request, Claude sees the last few minutes of the call (`AMBIENT_CONTEXT_MINUTES`, default 3). Anything older it looks up with the memory tools when someone refers back to it:

| Tool | Used for |
| --- | --- |
| `search_voice_transcripts` | "What did Sam say about the trip?": keyword search with speaker/time filters, returns matches with surrounding lines |
| `read_voice_transcript` | "Sum up last night": reads a session or time range in order, with paging |
| `list_voice_sessions` | Finds which session to read ("what did we talk about yesterday?") |
| `search_my_conversation_history` | "Like I told you last week…": the person's *own* older history only |
| `remember`, `update_memory`, `forget_memory` | Save, correct or delete a long-term note about someone (or the server) |
| `search_memories` | Notes about people who aren't in the conversation ("what's Sam's favourite game?") |

**Long-term notes.** Nimbus saves a note when someone tells it something lasting, but only from things said to it directly, never from chatter it overhears. It won't save secrets, and only saves sensitive details if asked to. Notes about whoever is talking, anyone else in the call, and the server are attached to each message as information (not instructions), so there's no extra lookup before replying. Notes are shared across the server: Nimbus can use what it knows about Sam when Alex asks. Only the person a note is about, or whoever gave it, can change or delete it. Everyone can see and delete what Nimbus remembers about them with `/memories`. Notes don't expire.

**Why keyword search instead of embeddings (for now).** The memory server uses SQLite FTS5 with BM25 ranking and stemming. Search is free and instant, and adds no extra vendor or model download. A Discord group's transcripts are small (thousands of lines, not millions), and Claude is good at writing several targeted keyword queries, adding speaker and time filters, and trying synonyms when a search misses. If paraphrase misses turn out to matter in practice ("vacation" vs "trip to Japan"), semantic search slots in behind the same `search_voice_transcripts` tool. Add an embedding model (Voyage AI, a local model, or Bedrock Titan on AWS), store vectors (`sqlite-vec` locally, pgvector or OpenSearch on AWS), and merge the two rankings. The assistant's prompts and tools don't change.

**Scoping and privacy.** The memory tools always run scoped to the server, and the personal-history tool to the person speaking. The bot fills those parameters in itself, so a conversation can't read another server's transcripts or another person's thread. `/join` announces that the channel is being transcribed. Transcripts and out-of-view conversation turns are deleted after `MEMORY_RETENTION_DAYS` (default 30; `0` keeps everything). `/reset` deletes your whole thread.

### Prompt caching and history

The system prompt and tool list never change while the bot runs, so they're cached. Each person's history is only ever appended to. Per-request details (time, who's speaking, music status, style) go in a short system message after the newest turn, so they don't break the cache. Thinking blocks are not stored, because the same thread is answered by different models (Opus for text, Haiku for voice) and thinking blocks are tied to the model and conversation that produced them. Stripping them once, when the turn is stored, keeps every later request valid and byte-identical. Set `LOG_LEVEL=debug` to see `cache_read` / `cache_write` token counts per request.

## Setup

### 1. Prerequisites

- **Node.js 24.15+** (the built-in `node:sqlite` and the YouTube library need it)
- **ffmpeg** on your `PATH` (decodes music and speech audio)
- **Build tools** may be needed for `@discordjs/opus` if no prebuilt binary matches your platform

### 2. Discord application

1. Create an application at <https://discord.com/developers/applications>, add a **Bot**, and copy its token.
2. No privileged intents are needed (it uses slash commands and voice only).
3. Invite it with the `bot` and `applications.commands` scopes and these permissions: **View Channels, Send Messages, Embed Links, Connect, Speak, Use Voice Activity**.
4. Copy the **Application ID** (`CLIENT_ID`) and your **server ID** (`GUILD_ID`). Commands are registered to that server, so they appear immediately.

### 3. Claude Platform on AWS

By default the bot reaches Claude through **Claude Platform on AWS**: Anthropic's Claude API, signed with your AWS credentials (the same identity Transcribe and Polly use) and billed on your AWS bill through AWS Marketplace. One-time setup:

1. In the AWS Console, open the **Claude Platform on AWS** service page and click **Sign up**. This creates a new Anthropic organization tied to your AWS account, separate from any existing Anthropic account.
2. Follow the emailed setup link to fill in the organization details.
3. Create a workspace in the region you'll use, and copy its ID (`wrkspc_…`) into `ANTHROPIC_AWS_WORKSPACE_ID`. Each workspace is bound to one region; if yours isn't `AWS_REGION`, also set `CLAUDE_AWS_REGION`.
4. Once per AWS account, enable the identity federation the gateway relies on. Without it, every request fails with "Outbound web identity federation is disabled".

   ```bash
   aws iam enable-outbound-web-identity-federation
   ```

New organizations start on the lowest rate-limit tier; you can request higher limits in the Claude Console. At startup the bot checks the workspace, permissions and both model IDs, and exits with a checklist if anything is wrong.

To use the Claude API directly instead, set `CLAUDE_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.

### 4. AWS resources (CDK)

Nimbus's AWS resources are defined with the AWS CDK in [infra/](infra/) and deployed as a CloudFormation stack named `Nimbus`. It creates:

- **`NimbusBot` managed policy**, from [infra/nimbus-bot-policy.json](infra/nimbus-bot-policy.json): Transcribe, Polly, Claude inference and model lookups in your Claude Platform on AWS workspaces, and the two `sts` actions the Claude Platform on AWS gateway uses to authenticate to Anthropic on your behalf.
- **`nimbus-bot` IAM user** with only that policy, so the bot doesn't run on your admin credentials.
- **An access key for that user**, stored in Secrets Manager as `nimbus/bot-access-key` (about $0.40 a month) and never shown in stack outputs.

With an admin profile, from the repo root:

```bash
cd infra && npm install
npx cdk bootstrap --profile admin   # once per account and region
npx cdk deploy --profile admin
cd ..
cp .env.example .env                # if you haven't already
aws secretsmanager get-secret-value --secret-id nimbus/bot-access-key --query SecretString --output text --profile admin \
  | node infra/scripts/write-bot-credentials.mjs   # writes the key into .env without printing it
```

To rotate the key, increase `accessKeySerial` in [infra/bin/nimbus.ts](infra/bin/nimbus.ts), deploy again, and re-run the last command. When the bot moves onto AWS compute, attach the same policy to that compute's role and remove the user and key. `cd infra && npm test` checks the stack's template.

To limit Claude access to one workspace, replace `workspace/*` in the policy with that workspace's ARN, `arn:aws:aws-external-anthropic:<region>:<account-id>:workspace/<workspace-id>`. With `CLAUDE_PROVIDER=anthropic`, only the first statement is needed.

Pick a region where your Polly voice supports your engine. The default, `Joanna` with `generative`, works in `us-east-1`. The bot checks this at startup.

### 5. Configure, build, run

```bash
npm install
cp .env.example .env     # then fill it in; every setting is documented there
npm run build            # runs the tests first
npm start
```

### 6. Smoke test (optional, uses real APIs)

Without Discord, this checks Claude through your configured provider (including the MCP memory tools and prompt caching) and AWS (Polly speech, transcribed back by Transcribe):

```bash
npm run smoke                 # both
npm run smoke -- --claude     # Claude only
npm run smoke -- --aws        # AWS only
```

## Commands

| Command | What it does |
| --- | --- |
| `/join` | Joins your voice channel and starts listening. Say the wake word ("Nimbus") to talk. |
| `/leave` | Leaves the voice channel (and stops music). |
| `/chat prompt:` | Type to the assistant; shares your conversation with voice. |
| `/customize style:` | Default, Casual, Formal, Humorous or Sarcastic, for text and voice. |
| `/reset` | Deletes your conversation (asks for confirmation). Long-term notes stay; see `/memories`. |
| `/memories` | Shows only you what Nimbus remembers about you, with options to forget one note or everything. |
| `/play query:` | Plays a YouTube URL or search; queues if something is playing. |
| `/skip` `/pause` `/resume` `/stop` `/queue` | Music controls. |
| `/help` | Lists commands. |

By voice: "Nimbus, play Bohemian Rhapsody", "Nimbus, skip this", "Nimbus, what did Alex say about the game?", "Nimbus, what's the weather tomorrow?", "Nimbus, stop".

When Nimbus hears its name, it plays a short chime and pauses any music, so everyone knows it's thinking. The music comes back after the reply. Turn the chime off with `WAKE_SOUND_ENABLED=false`.

## Costs

You pay each provider directly. Rough guide:

- **Claude**: Opus 5.5 is $4 / $20 per million input/output tokens and Haiku 5.5 is $0.10 / $0.50 (prompts up to 100K tokens), with cache reads far cheaper than fresh input. Web search is $10 per 1,000 searches, capped at 5 per text turn and 2 per spoken turn. Turn it off with `WEB_SEARCH_ENABLED=false`. Through Claude Platform on AWS these same rates appear on your AWS bill, metered as Claude Consumption Units ($0.01 each).
- **AWS Transcribe streaming**: billed per second of audio, with no per-request minimum (the AWS pricing page's example is $0.01/minute in us-east-1). Every utterance in a listening channel is transcribed, because that's what builds the group memory; sounds under 0.4 s are ignored.
- **AWS Polly**: billed per character spoken; see the Polly pricing page for your engine.

## Using the memory from other MCP clients

The memory server is a normal MCP server. Run it standalone over stdio against the bot's database, for example from Claude Desktop or Claude Code:

```json
{
  "mcpServers": {
    "discord-memory": {
      "command": "node",
      "args": ["/path/to/discord-bot/dist/memory/stdio.js"],
      "env": {
        "DATABASE_PATH": "/path/to/discord-bot/data/bot.db",
        "MEMORY_DATABASE_PATH": "/path/to/discord-bot/data/memories.db"
      }
    }
  }
}
```

In this mode `guild_id` and `user_id` are ordinary tool arguments.

## Architecture

Everything external sits behind a small interface (a "port"), and the one place that picks implementations is `src/app.ts`:

| Port | Today (runs on your PC) | Later on AWS |
| --- | --- | --- |
| `ConversationRepository`, `TranscriptRepository`, `SettingsRepository`, `MemoryRepository` (`src/storage/ports.ts`) | SQLite (`src/storage/sqlite/`), with notes in their own `memories.db` | DynamoDB / Aurora; OpenSearch or pgvector for semantic search |
| `SpeechToText` (`src/speech/ports.ts`) | AWS Transcribe streaming | same |
| `TextToSpeech` | AWS Polly | same |
| `TrackSource` (`src/music/types.ts`) | YouTube (`@distube/ytdl-core`) | same |
| Claude access (`src/claude/client.ts`) | Claude Platform on AWS (`AnthropicAws`), or the Claude API directly | same; use an IAM role instead of access keys |
| Memory tools | MCP server in-process (`src/memory/inProcess.ts`) | same server over Streamable HTTP as its own service |
| `ToolProvider` (`src/assistant/tools/types.ts`) | native tools + MCP adapter | add more MCP servers without touching the assistant |

```text
src/
  app.ts                 composition root: builds and wires everything
  index.ts               entry point: config, logging, start/stop
  config/                environment validation (zod)
  claude/                Claude client for the configured provider + startup check
  assistant/             Claude agent loop, prompts, history sanitising, styles
    tools/               tool registry, MCP adapter, music + voice tools
  memory/                memory MCP server (+ standalone stdio entry)
  storage/               repository ports + SQLite implementations
  speech/                STT/TTS ports + AWS adapters
  voice/                 voice sessions, audio capture, wake word, voice conversation flow
  music/                 queue service + YouTube source
  discord/               client, interaction router, slash commands
  scripts/smoke.ts       live smoke test
infra/                   AWS CDK app: the Nimbus CloudFormation stack (bot IAM user, policy, key)
test/                    unit and integration tests (jest)
```

## Development

```bash
npm test           # jest (ESM)
npm run typecheck  # strict TypeScript over src and tests
npm run dev        # tsc --watch
```

## License

MIT License
