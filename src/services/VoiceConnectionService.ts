import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { GuildMember, CommandInteraction } from 'discord.js';
import { Logger } from 'winston';

export class VoiceConnectionService {
	constructor(private logger: Logger) {}

	async joinVoiceChannel(interaction: CommandInteraction): Promise<any> {
		const member = interaction.member as GuildMember;
		const voiceChannel = member.voice.channel;
		if (!voiceChannel) {
			await interaction.reply({ content: 'You need to be in a voice channel to use this command.', ephemeral: true });
			return null;
		}

		const connection = joinVoiceChannel({
			channelId: voiceChannel.id,
			guildId: voiceChannel.guild.id,
			adapterCreator: voiceChannel.guild.voiceAdapterCreator,
			selfMute: false,
			selfDeaf: false,
		});

		connection.on('stateChange', (oldState, newState) => {
			this.logger.info(`Voice connection state changed from ${oldState.status} to ${newState.status}`);
		});

		connection.on('error', (error) => {
			this.logger.error('Voice connection encountered an error:', error);
		});

		try {
			await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
			await interaction.editReply({ content: `Joined ${voiceChannel.name}` });
			return connection;
		} catch (error) {
			this.logger.error('Error joining voice channel:', error);
			await interaction.editReply({ content: 'Failed to join the voice channel.' });
			connection.destroy();
			return null;
		}
	}
}
