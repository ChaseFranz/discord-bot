import AWS from 'aws-sdk';
import { createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import { Readable } from 'stream';
import dotenv from 'dotenv';
import { Logger } from 'winston';

dotenv.config();

export interface VoiceResponse {
  response: string;
  speak: boolean;
}

export class VoiceResponseService {
  private static instance: VoiceResponseService;
  private conversationHistories: Map<string, any[]> = new Map();
  private openaiVoiceModel: string;

  private constructor(private logger: Logger, openaiVoiceModel: string) {
    this.openaiVoiceModel = openaiVoiceModel;
  }

  public static getInstance(logger: Logger, openaiVoiceModel: string): VoiceResponseService {
    if (!VoiceResponseService.instance) {
      VoiceResponseService.instance = new VoiceResponseService(logger, openaiVoiceModel);
    }
    return VoiceResponseService.instance;
  }

  async playResponse(response: string, connection: any, userId: string) {
    this.logger.info('Playing response');
    const polly = new AWS.Polly({ region: process.env.AWS_REGION });
    const params = {
      Text: response,
      OutputFormat: 'mp3',
      VoiceId: 'Joanna',
      Engine: 'generative'
    };

    const data = await polly.synthesizeSpeech(params).promise();
    if (!data.AudioStream) throw new Error('Failed to synthesize speech');

    // Convert the AudioStream into a Buffer (if not already a Buffer)
    const buffer = data.AudioStream instanceof Buffer ? data.AudioStream : Buffer.from(data.AudioStream as any);

    // Create a readable stream from the buffer.
    // This avoids writing the audio data to disk.
    const audioStream = Readable.from([buffer]);

    const player = createAudioPlayer();
    const resource = createAudioResource(audioStream);

    player.play(resource);
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      player.stop();
      this.logger.info('Audio playback finished.');
    });
  }

  async generateResponse(prompt: string, userId: string): Promise<VoiceResponse> {
    const ENABLE_TTS_STT = true;
    if (!ENABLE_TTS_STT) return { response: '', speak: false };

    const conversationKey = userId;
    let history = this.conversationHistories.get(conversationKey) || [];

    if (history.length === 0 || history[0].role !== 'system') {
      history.unshift({
        role: 'system',
        content: 'You are Jarvis, a helpful and efficient voice assistant. Your reply must be a JSON object with exactly two keys: "response" (a string) and "speak" (a boolean). Respond concisely and neutrally. For commands like "jarvis stop", return {"response": "ok", "speak": false} with no extra text. Response with {"response": "<insert your response here>", "speak": true} for other responses.'
      });
    }

    history.push({ role: 'user', content: prompt });
    const MAX_HISTORY_LENGTH = 20;
    if (history.length > MAX_HISTORY_LENGTH) {
      history = [history[0], ...history.slice(-(MAX_HISTORY_LENGTH - 1))];
    }

    this.logger.info(`Generating response for voice prompt: ${prompt}`);
    this.logger.info(`Sending prompt to OpenAI: ${JSON.stringify(history)}`);
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI();
    const aiResponse = await openai.chat.completions.create({
      model: this.openaiVoiceModel,
      messages: history,
    });
    const rawReply = aiResponse.choices[0].message.content ?? '{"response": "Sorry, I could not generate a response.", "speak": true}';

    let voiceResponse: VoiceResponse;
    try {
      voiceResponse = JSON.parse(rawReply);
    } catch (error) {
      this.logger.error("Failed to parse JSON from GPT:", error);
      voiceResponse = { response: rawReply, speak: true };
    }

    history.push({ role: 'assistant', content: rawReply });
    this.conversationHistories.set(conversationKey, history);

    return voiceResponse;
  }
}
