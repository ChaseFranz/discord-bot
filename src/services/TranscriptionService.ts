import dotenv from 'dotenv';
import { Logger } from 'winston';
import { VoiceResponseService } from './VoiceResponseService.js';
import { KeywordDetector } from '../utils/keywordDetection.js';
import { File } from 'fetch-blob/file.js';

dotenv.config();

// Helper function to accumulate a readable stream into a Buffer.
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export class TranscriptionService {
  private ENABLE_TTS_STT: boolean;

  constructor(private logger: Logger, private openaiVoiceModel: string) {
    this.ENABLE_TTS_STT = true;
  }

  async processAudioStream(audioStream: NodeJS.ReadableStream, connection: any, userId: string) {
    if (!this.ENABLE_TTS_STT) return;
    this.logger.info(`Processing audio stream for user ${userId}`);

    // Dynamically import the OpenAI client.
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI();

    try {
      // Convert the in-memory WAV stream to a Buffer.
      const buffer = await streamToBuffer(audioStream);

      // Wrap the Buffer in a File-like object with a filename and content type.
      const audioFile = new File([buffer], 'audio.wav', { type: 'audio/wav' });

      // Pass the File object to the transcription API.
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1'
      });

      if (!transcription.text || transcription.text.trim() === '') {
        this.logger.info(`No transcription detected for user ${userId}.`);
        return;
      } else {
        this.logger.info(`Transcription for user ${userId}: "${transcription.text}"`);
      }

      const detector = new KeywordDetector();

      if (detector.containsKeyword(transcription.text.toLowerCase())) {
        this.logger.info('Keyword "Jarvis" detected.');
        const voiceResponseService = VoiceResponseService.getInstance(this.logger, this.openaiVoiceModel);
        const voiceResponse = await voiceResponseService.generateResponse(transcription.text, userId);
        this.logger.info(`Generated response: ${JSON.stringify(voiceResponse)}`);
        if (voiceResponse.speak) {
          await voiceResponseService.playResponse(voiceResponse.response, connection, userId);
        }
      } else {
        this.logger.info('Transcription does not contain keyword, no response generated.');
      }
    } catch (error) {
      this.logger.error('Error during transcription:', error);
    }
  }
}
