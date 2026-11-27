# Nimbus

Nimbus is an Alexa-style assistant for your Discord voice calls, powered by Claude. It sits in a voice channel, follows the conversation, and answers whoever says its name ("Nimbus, …"). In a call it talks with the group, not to one person at a time: it can answer two people in one breath, take a correction mid-sentence, and keep out of it when people are talking to each other. You can also type to it with `/chat` or by @mentioning it. That typed thread is your own, and what you asked it in calls is kept there too.

- **Claude** handles the thinking: Claude Opus 5.5 for typed replies, Claude Haiku 5.5 for spoken replies, which need to be fast. Both can be changed in `.env`. It's reached through **Claude Platform on AWS**, so requests use your AWS credentials and show up on your AWS bill.
- **AWS Transcribe** turns speech into text (streamed while people are still talking), and **AWS Polly** speaks the replies, sentence by sentence as Claude writes them.
- **Conversations feel natural**: after Nimbus answers, anyone can keep talking to it for a few seconds without saying its name. Talk over its answer and it pauses to hear you. "Nimbus, stop" cuts it off instantly.
- An **MCP memory server** gives Claude tools to search and read past voice conversations, short recaps of past calls, and each person's own history. Old context is fetched when it's needed instead of always being stuffed into the prompt.
- **Reminders and timers**, said out loud in the call or posted as a mention ("Nimbus, remind us at 9 to start the raid").
- **Music** from YouTube, by slash command or by voice ("Nimbus, play some lo-fi"). Music pauses while the assistant talks. On AWS, where YouTube won't serve the bot, a small [music helper](helper/README.md) that someone runs on their own computer fetches it.
- **Web search** for anything recent (news, scores, prices, weather).
- **Privacy and cost controls**: everyone chooses what gets transcribed with `/privacy`, and a daily spending cap (default $5) with `/usage` keeps the bill predictable.

## How it works

```text
voice channel ─► each person's audio ─► AWS Transcribe ─► transcript line ─► SQLite (ambient transcript)
   (skipped for people who opted out)                           │
                                  says "Nimbus", or could be carrying on right after a reply?
                                                                │ yes ("stop" is handled right here)
                                                                ▼
   the call's conversation so far ─┐
   notes about the people in it ───┼─► Claude (Haiku) ◄─► tools: memory (MCP), music, reminders,
   situation note ─────────────────┘        │                  say_nothing, stop_speaking, web search
                                            ▼ streamed, one sentence at a time
                              AWS Polly ─► spoken in the channel ─► also saved to the transcript
```

When a call ends, Claude Haiku writes a short private recap of it, which Nimbus can consult later.

### Memory

There are five kinds. All but the second are stored locally with SQLite:

1. **Each person's thread** with the assistant (`data/bot.db`): what they typed, with tool calls, and a copy of what they asked in calls with the reply (turn the copies off with `VOICE_SAVE_TO_THREADS=false`). The most recent stretch is sent with every typed request. Older turns move out of view but stay stored and searchable. Images people attach are seen with that message only; the thread keeps a placeholder.
2. **The call's conversation** (in memory, for as long as Nimbus is listening): everything said in the call in order, what Nimbus said back, and notes on what was actually heard of each reply. Everyone in the call shares it, and it's what Claude reads for every spoken turn.
3. **The ambient transcript** (`data/bot.db`): everything said in a voice channel while the bot is listening, including its own spoken replies, grouped into sessions.
4. **Call recaps** (`data/bot.db`): when a call ends, Claude Haiku summarises it in about 120 words (who was there, topics, decisions and who said they'd do what). Recaps are for Nimbus's own use and aren't posted anywhere. Calls shorter than six lines aren't recapped. If the bot stops before writing one, it catches up on the next start.
5. **Long-term notes about people** (`data/memories.db`, a separate database): short facts Nimbus saves when someone tells it something worth remembering, such as "Is vegetarian" or "Birthday: May 3", plus a few facts about the server itself.

In a call, Claude sees the whole conversation since Nimbus started listening (in a very long call the oldest part drops out of view). Earlier calls, and what people typed, it looks up with the memory tools when someone refers back to them:

| Tool | Used for |
| --- | --- |
| `search_voice_transcripts` | "What did Sam say about the trip?": keyword search with speaker/time filters, returns matches with surrounding lines |
| `read_voice_transcript` | "Sum up last night": reads a session or time range in order, with paging |
| `list_voice_sessions` | Lists past calls with their recaps, which often answer "what did we talk about yesterday?" on their own |
| `search_my_conversation_history` | "Like I told you last week…": the person's *own* older history only |
| `remember`, `update_memory`, `forget_memory` | Save, correct or delete a long-term note about someone (or the server) |
| `search_memories` | Notes about people who aren't in the conversation ("what's Sam's favourite game?") |

**Long-term notes.** Nimbus saves a note when someone tells it something lasting, but only from things said to it directly, never from chatter it overhears. It won't save secrets, and only saves sensitive details if asked to. Notes about whoever is talking, anyone else in the call, and the server are attached to each message as information (not instructions), so there's no extra lookup before replying. Notes are shared across the server: Nimbus can use what it knows about Sam when Alex asks. Only the person a note is about, or whoever gave it, can change or delete it. Everyone can see and delete what Nimbus remembers about them with `/memories`. Notes don't expire.

**Why keyword search instead of embeddings (for now).** The memory server uses SQLite FTS5 with BM25 ranking and stemming. Search is free and instant, and adds no extra vendor or model download. A Discord group's transcripts are small (thousands of lines, not millions), and Claude is good at writing several targeted keyword queries, adding speaker and time filters, and trying synonyms when a search misses. If paraphrase misses turn out to matter in practice ("vacation" vs "trip to Japan"), semantic search slots in behind the same `search_voice_transcripts` tool. Add an embedding model (Voyage AI, a local model, or Bedrock Titan on AWS), store vectors (`sqlite-vec` locally, pgvector or OpenSearch on AWS), and merge the two rankings. The assistant's prompts and tools don't change.

**Scoping and privacy.** The memory tools always run scoped to the server, and the personal-history tool to the person speaking. The bot fills those parameters in itself, so a conversation can't read another server's transcripts or another person's thread. `/join` announces that the channel is being transcribed. Transcripts, their recaps, out-of-view conversation turns and finished reminders are deleted after `MEMORY_RETENTION_DAYS` (default 30; `0` keeps everything). `/reset` deletes your whole thread.

**Choosing what gets transcribed.** Each person picks one of three levels with `/privacy`, and it takes effect within a second, even mid-sentence and in a call that's already going:

| Level | What happens |
| --- | --- |
| Everything I say (default) | Everything is transcribed and kept, so Nimbus can follow the conversation. |
| Only what I say to the assistant | Only lines with its name, and follow-ups right after it answers you, are kept. Everything else is dropped as soon as it's transcribed, and never stored or logged. Your audio still goes to Transcribe, because that's how Nimbus hears its name. |
| Nothing | Your audio is never captured or sent anywhere. You can't talk to Nimbus by voice, but `/chat` and @mentions still work. |

The choice applies from then on; it doesn't delete lines already transcribed (retention does that).

### Prompt caching and history

The system prompt and tool list never change while the bot runs, so they're cached. Each person's history is only ever appended to. Per-request details (time, who's speaking, music status, style) go in a short system message after the newest turn, so they don't break the cache. Thinking blocks are not stored, because the same thread is answered by different models (Opus for text, Haiku for voice) and thinking blocks are tied to the model and conversation that produced them. Stripping them once, when the turn is stored, keeps every later request valid and byte-identical. Set `LOG_LEVEL=debug` to see `cache_read` / `cache_write` token counts per request.

## Setup

### 1. Prerequisites

- **Node.js 24.15+** (for the built-in `node:sqlite`; yt-dlp also uses it to read YouTube's player)
- **ffmpeg** on your `PATH` (decodes music)
- **yt-dlp** on your `PATH` for music, or set `YT_DLP_PATH`. Use a current release from <https://github.com/yt-dlp/yt-dlp/releases> (the standalone `yt-dlp_linux`, `yt-dlp_macos` or `yt-dlp.exe`); distribution packages are usually too old to keep up with YouTube. When music stops playing after YouTube changes something, a newer yt-dlp usually fixes it.
- **Build tools** may be needed for `@discordjs/opus` if no prebuilt binary matches your platform

### 2. Discord application

1. Create an application at <https://discord.com/developers/applications>, add a **Bot**, and copy its token.
2. No privileged intents are needed. Discord delivers the text of messages that mention a bot without the Message Content intent, and that's all @mention chat reads.
3. Invite it with the `bot` and `applications.commands` scopes and these permissions: **View Channels, Send Messages, Send Messages in Threads, Read Message History, Embed Links, Connect, Speak, Use Voice Activity**. (Read Message History lets it reply to the message that mentioned it. If you invited the bot before @mention chat existed, add the two new permissions to its role in Server Settings.)
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

Without Discord, this checks Claude through your configured provider and AWS (Polly speech, transcribed back by Transcribe). The Claude part covers the MCP memory tools, prompt caching, streamed spoken replies, reminders and a call recap, and prints what the run cost (about $0.08):

```bash
npm run smoke                 # both
npm run smoke -- --claude     # Claude only
npm run smoke -- --aws        # AWS only
```

## Commands

| Command | What it does |
| --- | --- |
| `/join` | Joins your voice channel and starts listening. Say the wake word ("Nimbus") to talk. |
| `/leave` | Leaves the voice channel (and stops music). It also leaves when someone in the call tells it to ("Nimbus, you can go now"), and by itself after `AUTO_LEAVE_MINUTES` (default 2) with nobody else in the channel. |
| `/chat prompt:` | Type to the assistant; shares your conversation with voice. Up to 200 characters; @mention it for longer messages or images. |
| @Nimbus *message* | Mention it (or reply to one of its messages) in any channel or thread. No length limit, and it can see attached images. |
| `/privacy transcription:` | Choose what Nimbus transcribes when you talk (see Privacy above). Without an option, shows your current choice. |
| `/usage` | Today's estimated spending against the daily budget, broken down by Claude model, web search, Transcribe and Polly, plus the last 7 days. |
| `/customize style:` | Default, Casual, Formal, Humorous or Sarcastic, for text and voice. |
| `/reset` | Deletes your conversation (asks for confirmation). Long-term notes stay; see `/memories`. |
| `/memories` | Shows only you what Nimbus remembers about you, with options to forget one note or everything. |
| `/play query:` | Plays a YouTube URL or search; queues if something is playing. |
| `/skip` `/pause` `/resume` `/stop` `/queue` | Music controls. |
| `/musichelper` | On AWS: shows who is running a [music helper](helper/README.md) and gives you the code to set up your own. Shown only to you. |
| `/help` | Lists commands. |

By voice: "Nimbus, play Bohemian Rhapsody", "Nimbus, skip this", "Nimbus, what did Alex say about the game?", "Nimbus, what's the weather tomorrow?", "Nimbus, remind me in 10 minutes to take the pizza out", "Nimbus, stop", "Nimbus, you can go now" (it says goodbye and leaves the call).

### Talking to Nimbus

- **The chime.** When Nimbus hears its name, it plays a short chime and pauses any music, so everyone knows it's thinking. The music comes back after the reply. Turn the chime off with `WAKE_SOUND_ENABLED=false`.
- **Fast replies.** Nimbus starts on a request the moment you stop talking, speaks its first sentence while Claude is still writing the rest, and prepares each next sentence while the current one plays. Each reply logs where the time went (`Timing for …`).
- **Several people at once.** If two people ask at almost the same moment, they get one reply that answers both by name. Nobody has heard the first answer yet, so Nimbus starts over with both questions.
- **Pausing mid-sentence.** "Nimbus, what's the weather… in Chicago tomorrow?" is one question. If you carry on before Nimbus has started answering, it waits for you and answers the whole thing.
- **Follow-ups.** For `FOLLOW_UP_SECONDS` (default 8) after Nimbus finishes a reply, anyone in the call can carry on without its name ("and what about tomorrow?"). Claude decides whether each such line was meant for it, and stays quiet when it wasn't. Set it to `0` to always require the name.
- **Corrections.** Start talking while Nimbus is answering you and it pauses mid-word to listen. If what you said changes the answer, it picks up from there ("Oh, Saturday? Then…"). If it doesn't ("mm-hm"), it carries on from where it stopped.
- **Waiting your turn.** Ask for something while Nimbus is answering someone else, and it says "one sec" between sentences, finishes, then answers everyone who asked.
- **Stop.** "Nimbus, stop" (or "never mind", "be quiet", "cancel"…) is handled on the spot, without asking Claude, even before you've finished saying it: it stops talking and drops any reply still being written and anyone waiting. While it's answering you, plain "stop" works too. If it isn't talking, "Nimbus, stop" pauses the music; "Nimbus, resume" brings it back.

These can be tuned in `.env` (on AWS, through the `BOT_SETTINGS` variable; see "Running on AWS"):

| Setting | Default | What it does |
| --- | --- | --- |
| `VOICE_FOLLOW_UPS` | `everyone` | Who can carry on without the name after a reply: `everyone`, only the `askers` it just answered, or `always` (every line is put to Claude, at any time, with no name needed; costs more and it may join in more than you'd like). |
| `FOLLOW_UP_SECONDS` | `8` | How long after a reply that lasts. |
| `VOICE_SILENCE_MS` | `600` | How long you must be quiet before Nimbus takes what you said as finished. Lower is faster; a pause longer than this splits a sentence in two, which Nimbus joins back together if it hasn't started answering. |
| `VOICE_BARGE_IN` | `askers` | Whose voice pauses a reply: the `askers` it's answering, `everyone`, or `off` (it finishes, then turns to what was said). |
| `VOICE_BARGE_IN_MS` | `500` | How much you must say before it pauses. Shorter sounds (a cough, "mm") don't count. |
| `VOICE_ACKNOWLEDGE` | `true` | Say "one sec" to someone who asks while a reply to someone else is playing. |
| `VOICE_SAVE_TO_THREADS` | `true` | Keep what each person asked in a call, and the reply, in their own typed thread. |

### Reminders and timers

Ask in any way: "Nimbus, set a timer for 10 minutes", "remind me at 9 to start the raid", "remind us every Friday at 8 to pick a movie", "what reminders do I have?", "cancel reminder 3". Repeats can be every N minutes (5 or more), hours, days, weeks, months or years, or on chosen weekdays. Times are in the server's `TIMEZONE`, and daily or longer repeats keep their local time across daylight saving changes.

When one is due, Nimbus says it out loud if you're in a call with it. For "remind us", it says it to whoever is in the call. Otherwise it posts a mention in the channel where you set it; for one set by voice, that's the voice channel's chat. If it can't post there, it sends you a direct message. Each person can have 25 active reminders, and only the person who set one can cancel it.

Reminders are stored in the database, so they survive restarts. **Running on your PC:** a scheduler inside the bot delivers them. A reminder due while the PC is off or asleep goes out as soon as the bot is running again, marked as late. A repeating one then skips ahead to its next future time instead of firing for every one it missed. **Running on AWS:** nothing runs between uses, so each reminder wakes a Lambda function just before it's due (through EventBridge Scheduler, or directly when it's minutes away). The Lambda waits for the exact second and then delivers it, so reminders are on time whether or not anyone is in a call.

## Costs

You pay each provider directly. Rough guide:

- **Claude**: Opus 5.5 is $4 / $20 per million input/output tokens and Haiku 5.5 is $0.10 / $0.50 (prompts up to 100K tokens), with cache reads far cheaper than fresh input. Web search is $10 per 1,000 searches, capped at 5 per text turn and 2 per spoken turn. Turn it off with `WEB_SEARCH_ENABLED=false`. Through Claude Platform on AWS these same rates appear on your AWS bill, metered as Claude Consumption Units ($0.01 each). Call recaps use Haiku and cost a fraction of a cent each.
- **AWS Transcribe streaming**: $0.0001667 per second of audio ($0.01 a minute) in us-east-1, with no per-request minimum. Every utterance in a listening channel is transcribed, because that's what builds the group memory; sounds under 0.4 s are ignored.
- **AWS Polly**: billed per character spoken: $30 per million characters for generative voices, $16 neural, $4 standard.

### Daily budget

Nimbus meters every Claude request, web search, second of transcription and character of speech, prices them at the list prices above, and keeps a running total per day (in your `TIMEZONE`). `/usage` shows the breakdown. When a day's total reaches `DAILY_BUDGET_USD` (default $5), Nimbus says so once in the call, then stops listening and answering until midnight. Typed requests get a short "taking a break" reply. Music, reminders and the other slash commands keep working. Text replies get a note once 80% is used. Set `DAILY_BUDGET_USD=0` to track spending without a cap.

The totals are estimates. A request in progress when the cap is reached finishes first. Your Anthropic or AWS bill is authoritative. If your region's Transcribe or Polly prices differ, set `TRANSCRIBE_USD_PER_MINUTE` and `POLLY_USD_PER_MILLION_CHARACTERS`.

## Running on AWS

Nimbus can also run in your AWS account, where it uses nothing between uses:

```text
slash command ─► Lambda "edge" (function URL) ─► answers "thinking…" within Discord's 3 seconds
                       │ hands it on
                       ▼
               Lambda "worker" ─► text commands are answered here (Claude, DynamoDB)
                       │ voice commands
                       ▼
     SQS queue ─► Fargate voice task: started by /join or /play, finishes ~2 minutes after the call
reminder due ─► EventBridge Scheduler ─► Lambda "reminders" ─► said in the call, or posted as a mention
```

Compared with running on your PC:

- **`/join` and `/play`** take about 30–60 seconds the first time, while the voice task starts. Nimbus replies "On my way…" right away.
- **@mention chat** is off: it needs a connection that's always open. `/chat` works as usual.
- **Music** needs a helper: YouTube won't hand audio to AWS addresses ("Sign in to confirm you're not a bot"). So here the audio is fetched by a [music helper](helper/README.md), a one-file script that anyone in the server can run on their own computer after getting a code from `/musichelper`. It uploads each song in pieces to a private S3 bucket, and the voice task plays them as they arrive; a song is deleted a day later. Live streams work too, and are sent only for as long as they are being played. While nobody is running a helper, `/play` and Nimbus say so and link to the instructions.
- **Data** is kept in two on-demand DynamoDB tables. Old transcripts and conversation turns expire by themselves (DynamoDB's TTL). Nothing is copied from your PC's SQLite files.
- **Reminders** arrive on time even when nobody is in a call.

It costs roughly **$5 a month** at about 3 hours of calls a day, on top of Claude, Transcribe and Polly usage. The voice task is about $0.025 an hour, plus a public IP while it runs. Lambda, SQS, EventBridge and DynamoDB stay within or near their free tiers at this size, and the two secrets are $0.80 a month. A music helper checks in every couple of seconds while it runs, which comes to under a dollar a month for one that's left running around the clock and a few cents for one that runs only during calls; the audio passing through S3 is a fraction of a cent a song. With `ALERT_EMAIL` set, an AWS Budgets alert emails you at 80% of `MONTHLY_BUDGET_USD` (default $25).

### One-time setup

1. Deploy the stack you only deploy by hand: GitHub's access to AWS and the two secrets. Then copy the secrets from `.env`:

   ```bash
   cd infra && npx cdk deploy NimbusDeploy --profile admin && cd ..
   AWS_PROFILE=admin npm run aws:secrets   # DISCORD_BOT_TOKEN (and ANTHROPIC_API_KEY) from .env, never printed
   ```

   Note the `DeployRoleArn` it prints. If your account already has a GitHub OIDC provider, add `-c githubOidcProviderArn=<its ARN>`.
2. In GitHub, open **Settings → Environments**, create `production`, add yourself as a **required reviewer**, and add these environment variables:

   | Variable | Value |
   | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | The `DeployRoleArn` from step 1 |
   | `AWS_REGION` | `us-east-1` |
   | `DISCORD_CLIENT_ID` | The Application ID |
   | `DISCORD_GUILD_ID` | Your server ID |
   | `DISCORD_PUBLIC_KEY` | Developer Portal → General Information → Public Key |
   | `TIMEZONE` | Your time zone, e.g. `America/Chicago`. AWS runs in UTC otherwise, and reminders would be off. |
   | `CLAUDE_PROVIDER` | `anthropic` for now (uses the API key from step 1). Change it to `aws` and add `ANTHROPIC_AWS_WORKSPACE_ID` once Claude Platform on AWS is set up. |
   | `ALERT_EMAIL` | Optional: gets Lambda error alerts and the spending alert |
   | `MUSIC_ENABLED` | Optional: `false` turns music off altogether. By default it's on, fetched by music helpers. |
| `BOT_SETTINGS` | Optional: other settings from `.env.example` for the bot on AWS, as `NAME=value` pairs separated by commas or new lines, e.g. `VOICE_SILENCE_MS=500, VOICE_BARGE_IN=everyone`. They take effect at the next deploy. Not for secrets. |
| `DAILY_BUDGET_USD`, `MONTHLY_BUDGET_USD` | Optional: the bot's daily cap (default $5) and the AWS Budgets alert (default $25) |

3. Merge to `main` (or run the **Deploy** workflow by hand) and approve it. The first deploy takes about 10 minutes, mostly building the voice task image.
4. Stop the bot on your PC, then send slash commands to AWS:

   ```bash
   AWS_PROFILE=admin npm run aws:on
   ```

### Switching between AWS and your PC

Discord sends slash commands to one place only. `npm run aws:off` sends them back to a bot on your PC (start it with `npm start`), and `npm run aws:on` sends them to AWS again. Don't run both at once: either copy can join a call, so two could end up answering in the same one. Your PC keeps its own SQLite data, so what's said while testing locally doesn't reach AWS's memory.

### CI and deploys

- **Every push and pull request** (`.github/workflows/ci.yml`): type-check, tests against SQLite and DynamoDB Local, build, and the CDK tests and synth.
- **Merging to `main`** (`.github/workflows/deploy.yml`): deploys the `NimbusCloud` stack once you approve it, then registers the slash commands. GitHub signs in to AWS with OIDC, using a role that only this repository's `production` environment can assume, so no AWS keys are stored in GitHub.

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

Everything external sits behind a small interface (a "port"). The programs that pick implementations are `src/app.ts` (the PC) and `src/aws/` (AWS), sharing their wiring through `src/runtime/`:

| Port | On your PC | On AWS |
| --- | --- | --- |
| `ConversationRepository`, `TranscriptRepository`, `SettingsRepository`, `MemoryRepository`, `ReminderRepository`, `UsageRepository` (`src/storage/ports.ts`) | SQLite (`src/storage/sqlite/`), with notes in their own `memories.db` | DynamoDB (`src/storage/dynamodb/`), with notes in their own table; keyword search ranked in code (`src/storage/search/`) |
| Slash commands (`CommandContext` in `src/discord/context.ts`) | The live Gateway connection (discord.js) | HTTPS interactions to Lambda, answered through the REST API |
| `ReminderAlarm` (`src/reminders/alarm.ts`) | The in-process scheduler | EventBridge Scheduler waking a Lambda |
| Calls (`src/calls/voiceTask.ts`) | Handled in the one process | An on-demand Fargate task, given orders through SQS, with a status record in DynamoDB |
| `SpeechToText` (`src/speech/ports.ts`) | AWS Transcribe streaming | same |
| `TextToSpeech` | AWS Polly | same |
| `TrackSource` (`src/music/types.ts`) | YouTube through yt-dlp (`src/music/YtDlpTrackSource.ts`) | YouTube through music helpers (`src/music/relay/`): requests and registrations in DynamoDB, audio relayed through S3, a small Lambda for helpers to talk to |
| Claude access (`src/claude/client.ts`) | Claude Platform on AWS (`AnthropicAws`), or the Claude API directly | same, through IAM roles instead of access keys |
| Memory tools | MCP server in-process (`src/memory/inProcess.ts`) | same |
| `ToolProvider` (`src/assistant/tools/types.ts`) | native tools + MCP adapter | same |

```text
src/
  app.ts                 the bot on a PC: builds and wires everything in one process
  index.ts               entry point: config, logging, start/stop
  runtime/               wiring shared by every program: core services and the call stack
  aws/                   the AWS programs: edge, worker and reminder Lambdas, and the voice task
  calls/                 the on-demand voice task: status record, orders queue, control, main loop
  config/                environment validation (zod)
  claude/                Claude client for the configured provider + startup check
  assistant/             Claude agent loop for typed threads and for calls, the call's shared
                         conversation, prompts, history sanitising, styles
    tools/               tool registry, MCP adapter, music + voice tools
  memory/                memory MCP server (+ standalone stdio entry)
  reminders/             reminder tools, repeat rules, scheduler, delivery
  recaps/                end-of-call recaps
  usage/                 price list, usage meter and daily budget
  privacy/               per-person transcription choice
  storage/               repository ports; SQLite and DynamoDB implementations; in-code search
  speech/                STT/TTS ports + AWS adapters
  voice/                 voice sessions, audio capture, speech queue, wake word, and the turn-taking
                         that decides when to answer, start over, wait, pause or stop
  music/                 queue service + YouTube source
    relay/               music helpers: registrations, song requests, the address helpers talk to,
                         and the track source that plays what they upload
  discord/               client, command dispatch (Gateway and HTTPS), slash commands, @mention chat
  scripts/               smoke test, command registration, switching between AWS and a PC
helper/                  the music helper people run on their own computers, and how to set it up
infra/                   AWS CDK app: Nimbus (PC identity), NimbusDeploy (GitHub access, secrets),
                         NimbusCloud (the bot on AWS)
.github/workflows/       CI and deploys
Dockerfile               the voice task's image
test/                    unit and integration tests (jest)
```

## Development

```bash
npm test               # jest (ESM); storage tests run against SQLite
npm run test:dynamodb  # the same, plus DynamoDB, against a DynamoDB Local on port 8000
npm run typecheck      # strict TypeScript over src and tests
npm run dev            # tsc --watch
```

For `test:dynamodb`, start DynamoDB Local first, for example `docker run -p 8000:8000 amazon/dynamodb-local`. CI always runs it.

## License

MIT License
