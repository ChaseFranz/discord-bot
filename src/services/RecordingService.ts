import { spawn } from 'child_process';
import prism from 'prism-media';
import { EndBehaviorType } from '@discordjs/voice';
import { Logger } from 'winston';
import { TranscriptionService } from './TranscriptionService.js';

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

    // Subscribe to the user's audio stream
    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 }
    });

    // When the audio stream ends, remove the user from active recordings.
    audioStream.on('end', () => {
      this.logger.info(`Audio stream for user ${userId} ended.`);
      this.activeRecordings.delete(userId);
    });

    // Create an Opus decoder to convert the Discord audio to PCM.
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

    // Spawn ffmpeg to convert PCM to WAV, reading from stdin and writing WAV to stdout.
    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le',       // Input format: signed 16-bit little-endian PCM
      '-ar', '48000',      // Input sample rate: 48000 Hz
      '-ac', '2',          // Input channels: 2
      '-i', 'pipe:0',      // Read input from stdin
      '-f', 'wav',         // Output format: WAV
      'pipe:1'             // Write output to stdout
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    // Pipe the Discord audio stream: audioStream → decoder → ffmpeg.stdin.
    audioStream.pipe(decoder).pipe(ffmpeg.stdin);

    // ffmpeg.stdout now holds the WAV stream in memory.
    const wavStream = ffmpeg.stdout;

    // Pass the in-memory WAV stream directly to transcription.
    const transcriptionService = new TranscriptionService(this.logger, this.openaiVoiceModel);
    transcriptionService.processAudioStream(wavStream, connection, userId);
  }
}
