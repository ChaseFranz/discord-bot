import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { PRIVACY_LEVELS, type PrivacyLevel } from '../../storage/ports.js';
import type { AppServices, BotCommand } from '../types.js';

const CHOICES: Record<PrivacyLevel, string> = {
  full: 'Everything I say (default)',
  requests: 'Only what I say to the assistant',
  off: "Nothing: don't listen to me",
};

/** /privacy: each person chooses how much of what they say in voice channels gets transcribed. */
export const privacyCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('privacy')
    .setDescription('Choose what the assistant transcribes when you talk in voice channels')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('transcription')
        .setDescription('What it may transcribe (leave out to see your current choice)')
        .setRequired(false)
        .addChoices(...PRIVACY_LEVELS.map((value) => ({ name: CHOICES[value], value }))),
    ),
  usage: '/privacy transcription: Only what I say to the assistant',
  ephemeral: true,

  async execute(interaction, services) {
    const { guildId } = interaction;
    const userId = interaction.user.id;
    const choice = interaction.options.getString('transcription') as PrivacyLevel | null;
    if (choice === null) {
      const current = await services.privacy.level(guildId, userId);
      await interaction.editReply({
        content: `Your current choice: **${CHOICES[current]}**.\n${explain(services, current)}\nChange it with \`/privacy transcription:\`.`,
      });
      return;
    }
    if (!PRIVACY_LEVELS.includes(choice)) {
      await interaction.editReply({ content: 'Unknown choice.' });
      return;
    }
    // Takes effect at once, even mid-sentence (see the privacy listener in app.ts).
    await services.privacy.set(guildId, userId, choice);
    services.logger.info(`${interaction.user.tag} set transcription privacy to ${choice}.`);
    await interaction.editReply({ content: `Saved: **${CHOICES[choice]}**.\n${explain(services, choice)}` });
  },
};

function explain(services: AppServices, level: PrivacyLevel): string {
  const name = services.config.assistant.name;
  const days = services.config.storage.retentionDays;
  const kept = days > 0 ? ` Transcripts are deleted after ${days} day${days === 1 ? '' : 's'}.` : '';
  switch (level) {
    case 'full':
      return `${name} transcribes everything you say in voice channels it's listening in, so it can follow the conversation.${kept}`;
    case 'requests':
      return (
        `${name} only keeps what you say to it: lines with its name, and follow-ups right after it answers you. ` +
        `Everything else is dropped as soon as it's transcribed and never stored. (Your voice still goes to AWS ` +
        `Transcribe, which is how ${name} hears its name.)${kept}`
      );
    case 'off':
      return (
        `${name} doesn't listen to you at all: your audio is never sent anywhere. You can't talk to it by voice, ` +
        `but /chat and @mentions still work.`
      );
  }
}
