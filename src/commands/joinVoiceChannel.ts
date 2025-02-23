import { SlashCommandBuilder, CommandInteraction } from 'discord.js';
import dotenv from 'dotenv';
import { Logger } from 'winston';
import { VoiceConnectionService } from '../services/VoiceConnectionService.js';
import { RecordingService } from '../services/RecordingService.js';

dotenv.config();

class JoinVoiceChannelCommand {
	data = new SlashCommandBuilder()
		.setName('join')
		.setDescription('Join a voice channel');

	usage = '/join - Makes the bot join your current voice channel';
	private logger: Logger;
	private voiceConnectionService: VoiceConnectionService;
	private recordingService: RecordingService;

	constructor(logger: Logger) {
		this.logger = logger;
		this.voiceConnectionService = new VoiceConnectionService(logger);
		this.recordingService = new RecordingService(logger);
	}

	async execute(interaction: CommandInteraction): Promise<void> {
		this.logger.info('Executing join command.');
		if (!interaction.deferred && !interaction.replied) {
			try {
				await interaction.deferReply({ ephemeral: true });
				this.logger.info('Interaction deferred successfully.');
			} catch (error) {
				this.logger.error('Error deferring reply:', error);
				return;
			}
		}

		const connection = await this.voiceConnectionService.joinVoiceChannel(interaction);
		if (!connection) return;

		const ENABLE_TTS_STT = true;
		if (ENABLE_TTS_STT) {
			const receiver = connection.receiver;
			receiver.speaking.on('start', (userId: string) => {
				this.recordingService.startRecording(receiver, userId, connection);
			});
		}
	}
}

export default (logger: Logger) => new JoinVoiceChannelCommand(logger);
