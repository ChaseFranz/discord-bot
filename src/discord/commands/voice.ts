import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { budgetPausedMessage } from '../textChat.js';
import { requireVoice, type BotCommand } from '../types.js';

export const joinCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and start listening')
    .setContexts(InteractionContextType.Guild),
  usage: '/join - Makes the bot join your current voice channel',
  voice: 'starts-call',

  async execute(context, services) {
    const { voice } = requireVoice(services);
    const call = await services.calls.voiceChannelOf(context.guildId, context.userId);
    if (!call) {
      await context.editReply('You need to be in a voice channel to use this command.');
      return;
    }
    await voice.joinChannel(context.guildId, call.id, { listen: true });
    const { name, wakeWord } = services.config.assistant;
    const retention = services.config.storage.retentionDays;
    const kept = retention > 0 ? `Transcripts are kept for ${retention} day${retention === 1 ? '' : 's'}.` : 'Transcripts are kept until deleted.';
    const paused = services.usage.isPaused(context.guildId)
      ? `\n⏸️ ${budgetPausedMessage(services, context.guildId)} Until then it won't listen or answer.`
      : '';
    await context.editReply(
      `Joined **${call.name}**. 🎙️ I'm transcribing this channel so I can follow the conversation. ` +
        `Say "${wakeWord.charAt(0).toUpperCase()}${wakeWord.slice(1)}" to talk to ${name}. ${kept} ` +
        `Rather not be transcribed? Use \`/privacy\`.${paused}`,
    );
  },
};

export const leaveCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel')
    .setContexts(InteractionContextType.Guild),
  usage: '/leave - Makes the bot leave the current voice channel',
  voice: 'in-call',

  async execute(context, services) {
    const { voice } = requireVoice(services);
    const session = voice.get(context.guildId);
    if (!session) {
      await context.editReply('I am not in a voice channel.');
      return;
    }
    const channelName = session.channel.name;
    await voice.leave(context.guildId);
    await context.editReply(`Left ${channelName}`);
  },
};
