import { createReadStream, unlinkSync, statSync } from 'fs';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { Logger } from 'winston';
import { VoiceResponseService } from './VoiceResponseService.js';
import { deleteFile } from '../utils/fileUtils.js';

export class TranscriptionService {
	private ENABLE_TTS_STT: boolean;

	constructor(private logger: Logger, private openaiVoiceModel: string) {
		dotenv.config();
		this.ENABLE_TTS_STT = true;
	}

	async processAudio(filePath: string, connection: any, userId: string) {
		if (!this.ENABLE_TTS_STT) return;
		this.logger.info(`Processing audio file: ${filePath}`);
		const OpenAI = (await import('openai')).default;
		const openai = new OpenAI();

		try {
			const transcription = await openai.audio.transcriptions.create({
				file: createReadStream(filePath),
				model: 'whisper-1'
			});

			if (!transcription.text || transcription.text.trim() === '') {
				this.logger.info(`No transcription detected for user ${userId}.`);
				deleteFile(filePath, this.logger);
				return;
			} else {
				this.logger.info(`Transcription for user ${userId}: "${transcription.text}"`);
			}

			if (transcription.text.toLowerCase().includes('jarvis')) {
				this.logger.info('Keyword "Jarvis" detected.');
				const voiceResponseService = VoiceResponseService.getInstance(this.logger, this.openaiVoiceModel);
				const voiceResponse = await voiceResponseService.generateResponse(transcription.text, userId);
				this.logger.info(`Generated response: ${JSON.stringify(voiceResponse)}`);
				if (voiceResponse.speak) {
					await voiceResponseService.playResponse(voiceResponse.response, connection, userId);
				}
				deleteFile(filePath, this.logger);
			} else {
				this.logger.info('Transcription does not contain keyword, no response generated.');
				deleteFile(filePath, this.logger);
			}
		} catch (error) {
			this.logger.error('Error during transcription:', error);
			deleteFile(filePath, this.logger);
		}
	}
}
