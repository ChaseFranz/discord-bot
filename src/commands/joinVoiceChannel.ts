import { SlashCommandBuilder, CommandInteraction } from 'discord.js';
import { Logger } from 'winston';
import { VoiceConnectionService } from '../services/VoiceConnectionService.js';
import { RecordingService } from '../services/RecordingService.js';
import { IBotCommand } from './types/DiscordModels.js';
import OpenAI from 'openai';

interface IJoinVoiceChannelCommand extends IBotCommand {
	data: SlashCommandBuilder;
	usage: string;
	execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: OpenAI, logger: Logger, client: any, userSettings: any, openaiChatModel: string, openaiVoiceModel: string): Promise<void>;
}

class JoinVoiceChannelCommand implements IJoinVoiceChannelCommand {
	data: SlashCommandBuilder;
	usage: string;

	constructor() {		
		this.data = new SlashCommandBuilder()
			.setName('join')
			.setDescription('Join a voice channel');

		this.usage = '/join - Makes the bot join your current voice channel';
	}

	async execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: OpenAI, logger: Logger, client: any, userSettings: any, openaiChatModel: string, openaiVoiceModel: string): Promise<void> {	
		logger.info('Executing join command.');

		const voiceConnectionService = new VoiceConnectionService(logger);
		const recordingService = new RecordingService(logger, openaiVoiceModel);

		if (!interaction.deferred && !interaction.replied) {
			try {
				await interaction.deferReply({ ephemeral: true });
				logger.info('Interaction deferred successfully.');
			} catch (error) {
				logger.error('Error deferring reply:', error);
				return;
			}
		}

		const connection = await voiceConnectionService.joinVoiceChannel(interaction);
		if (!connection) return;

		const ENABLE_TTS_STT = true;
		if (ENABLE_TTS_STT) {
			const receiver = connection.receiver;
			receiver.speaking.on('start', (userId: string) => {
				recordingService.startRecording(receiver, userId, connection);
			});
		}
	}
}

export default new JoinVoiceChannelCommand();
