/**
 * Spoken commands the bot handles itself, without asking Claude, so they take effect at once.
 * Only an utterance that is nothing but the command counts ("stop", "never mind"); anything longer
 * ("stop the music", "cancel my reminder") goes to the assistant as a normal request.
 */
export type VoiceCommand = 'stop';

const STOP_PHRASES = new Set([
  'stop',
  'stop it',
  'stop that',
  'stop talking',
  'stop speaking',
  'stop stop',
  'be quiet',
  'quiet',
  'shut up',
  'hush',
  'shush',
  'shh',
  'sh',
  'silence',
  'enough',
  'that is enough',
  "that's enough",
  'thats enough',
  'never mind',
  'nevermind',
  'cancel',
  'cancel that',
  'forget it',
  'forget about it',
]);

const LEADING_FILLERS = new Set(['hey', 'hi', 'ok', 'okay', 'oh', 'um', 'uh', 'please', 'alright', 'all right', 'so', 'yo', 'just']);
const TRAILING_FILLERS = new Set(['please', 'now', 'right now', 'thanks', 'thank you', 'already']);

/** Recognises a local command in `text` (with the wake word already removed). */
export function parseVoiceCommand(text: string): VoiceCommand | undefined {
  let phrase = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  phrase = trimFillers(phrase);
  return STOP_PHRASES.has(phrase) ? 'stop' : undefined;
}

function trimFillers(phrase: string): string {
  let current = phrase;
  for (let changed = true; changed && current.length > 0; ) {
    changed = false;
    for (const filler of LEADING_FILLERS) {
      if (current === filler || !current.startsWith(`${filler} `)) continue;
      current = current.slice(filler.length + 1);
      changed = true;
    }
    for (const filler of TRAILING_FILLERS) {
      if (current === filler || !current.endsWith(` ${filler}`)) continue;
      current = current.slice(0, -(filler.length + 1));
      changed = true;
    }
  }
  return current;
}
