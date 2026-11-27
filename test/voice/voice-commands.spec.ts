import { parseVoiceCommand } from '../../src/voice/voiceCommands.js';

describe('parseVoiceCommand', () => {
  it.each(['stop', ', stop.', 'Stop!', 'please stop', 'hey , shut up please', 'never mind', 'Nevermind.', 'okay, be quiet now', "that's enough", 'cancel', 'shh'])(
    'treats %p as stop',
    (text) => expect(parseVoiceCommand(text)).toBe('stop'),
  );

  it.each(['stop the music', 'cancel my reminder', 'what should I stop doing', 'quiet music please', 'never mind the weather, what time is it', ''])(
    'leaves %p to the assistant',
    (text) => expect(parseVoiceCommand(text)).toBeUndefined(),
  );
});
