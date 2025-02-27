import { existsSync, mkdirSync, statSync, createWriteStream, unlinkSync } from 'fs';
import { pipeline } from 'stream';
import { spawn } from 'child_process';
import prism from 'prism-media';
import { EndBehaviorType } from '@discordjs/voice';
import { Logger } from 'winston';
import { TranscriptionService } from './TranscriptionService.js';
import { deleteFile } from '../utils/fileUtils.js';

const RECORDINGS_DIR = './content/recordings';
const ENABLE_TTS_STT = true;

export class RecordingService {
	private activeRecordings: Set<string> = new Set();

	constructor(private logger: Logger, private openaiVoiceModel: string) {}

	startRecording(receiver: any, userId: string, connection: any) {
		if (this.activeRecordings.has(userId)) {
			this.logger.info(`Already processing recording for user ${userId}.`);
			return;
		}
		this.activeRecordings.add(userId);
		this.logger.info(`User ${userId} started speaking.`);

		const audioStream = receiver.subscribe(userId, {
			end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 }
		});

		audioStream.on('end', () => {
			this.logger.info(`Audio stream for user ${userId} ended.`);
			this.activeRecordings.delete(userId);
		});

		if (!existsSync(RECORDINGS_DIR)) {
			mkdirSync(RECORDINGS_DIR, { recursive: true });
			this.logger.info(`Created directory: ${RECORDINGS_DIR}`);
		}

		const timestamp = Date.now();
		const pcmFilePath = `${RECORDINGS_DIR}/${userId}-${timestamp}.pcm`;
		const writeStream = createWriteStream(pcmFilePath);
		const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

		pipeline(audioStream, decoder, writeStream, (err) => {
			if (err) {
				this.logger.error('Error recording audio:', err);
				this.activeRecordings.delete(userId);
			} else {
				this.logger.info(`Recorded audio for user ${userId}`);
				try {
					const stats = statSync(pcmFilePath);
					this.logger.info(`PCM file size: ${stats.size} bytes`);
				} catch (error) {
					this.logger.error('Error reading PCM file stats:', error);
				}
				setTimeout(() => {
					const wavFilePath = pcmFilePath.replace('.pcm', '.wav');
					this.convertToWav(pcmFilePath, wavFilePath, connection, userId);
				}, 1000);
			}
		});
	}

	convertToWav(pcmPath: string, wavPath: string, connection: any, userId: string) {
		try {
			const pcmStats = statSync(pcmPath);
			const MIN_PCM_SIZE = 192000 * 0.1;
			if (pcmStats.size < MIN_PCM_SIZE) {
				this.logger.info(`PCM file ${pcmPath} is too short (${pcmStats.size} bytes), skipping transcription.`);
				return;
			}
		} catch (err) {
			this.logger.error('Error checking PCM file size:', err);
		}

		const ffmpeg = spawn('ffmpeg', [
			'-y',
			'-err_detect', 'ignore_err',
			'-f', 's16le',
			'-ar', '48000',
			'-ac', '2',
			'-i', pcmPath,
			wavPath
		]);

		ffmpeg.on('close', (code) => {
			if (code === 0) {
				this.logger.info(`Converted ${pcmPath} to ${wavPath}`);
				const transcriptionService = new TranscriptionService(this.logger, this.openaiVoiceModel);
				transcriptionService.processAudio(wavPath, connection, userId);
				unlinkSync(pcmPath);
				this.logger.info(`Deleted PCM file: ${pcmPath}`);
			} else {
				this.logger.error(`ffmpeg conversion failed with code ${code}`);
			}
		});

		ffmpeg.stderr.on('data', (data) => {
			this.logger.info(`ffmpeg: ${data}`);
		});
	}
}
