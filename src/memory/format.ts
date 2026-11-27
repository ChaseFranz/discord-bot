import type {
  ConversationSearchHit,
  Memory,
  TranscriptSearchHit,
  TranscriptSegment,
  VoiceSessionSummary,
} from '../storage/ports.js';
import { isoUtc } from '../util/time.js';

/** Compact, model-friendly renderings of memory records. Plain text costs fewer tokens than JSON. */

export function speakerLabel(segment: TranscriptSegment): string {
  return segment.isAssistant ? `${segment.speakerName} (assistant)` : segment.speakerName;
}

export function formatSegmentLine(segment: TranscriptSegment): string {
  return `[${isoUtc(segment.startedAt)}] ${speakerLabel(segment)}: ${segment.text}`;
}

export function formatTranscriptSearch(hits: TranscriptSearchHit[]): string {
  if (hits.length === 0) {
    return 'No matching voice transcript lines. Try different or fewer keywords, a synonym, or widen the time range.';
  }
  const blocks = hits.map(({ hit, context, channelName }, index) => {
    const lines = context.map((segment) => `${segment.id === hit.id ? '»' : ' '} ${formatSegmentLine(segment)}`);
    return `Match ${index + 1} (session ${hit.sessionId}, #${channelName}):\n${lines.join('\n')}`;
  });
  return `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} (» marks the matching line).\n\n${blocks.join('\n\n')}`;
}

export function formatTranscriptRange(segments: TranscriptSegment[], hasMore: boolean, fromEnd: boolean): string {
  if (segments.length === 0) return 'No voice transcript lines in that range.';
  const header = `${segments.length} line${segments.length === 1 ? '' : 's'}, oldest first.`;
  const more = hasMore
    ? fromEnd
      ? `\n(Earlier lines exist before ${isoUtc(segments[0]!.startedAt)}; pass that as "until" to read further back.)`
      : `\n(More lines exist after ${isoUtc(segments.at(-1)!.startedAt)}; pass that as "since" to keep reading.)`
    : '';
  return `${header}${more}\n\n${segments.map(formatSegmentLine).join('\n')}`;
}

export function formatSessionList(sessions: VoiceSessionSummary[]): string {
  if (sessions.length === 0) return 'No voice sessions recorded in that period.';
  const lines = sessions.map((session) => {
    const ended = session.endedAt === null ? 'still active' : `ended ${isoUtc(session.endedAt)}`;
    const who = session.participants.length > 0 ? session.participants.join(', ') : 'nobody spoke';
    const line = `- session ${session.id}: #${session.channelName}, started ${isoUtc(session.startedAt)}, ${ended}; ${session.segmentCount} lines; speakers: ${who}`;
    return session.recap ? `${line}\n  Recap: ${session.recap.replace(/\s+/g, ' ').trim()}` : line;
  });
  return lines.join('\n');
}

export function formatConversationSearch(hits: ConversationSearchHit[]): string {
  if (hits.length === 0) return 'Nothing matching in this person\'s earlier conversation with you.';
  const lines = hits.map((hit) => {
    const who = hit.role === 'user' ? 'They said' : 'You said';
    const via = hit.modality === 'voice' ? 'by voice' : 'in text';
    return `- [${isoUtc(hit.createdAt)}] ${who} (${via}${hit.archived ? '' : ', still in view'}): ${hit.text}`;
  });
  return lines.join('\n');
}

/** One line per note: `#12 about Alice: Is vegetarian (from Alice, 2026-11-20)`. */
export function formatMemoryLine(memory: Memory): string {
  const from = memory.sourceUserId === memory.subjectId ? 'from them' : `from ${memory.sourceName}`;
  return `#${memory.id} about ${memory.subjectName}: ${memory.text} (${from}, ${isoUtc(memory.updatedAt).slice(0, 10)})`;
}

export function formatMemoryList(memories: Memory[]): string {
  if (memories.length === 0) return 'No matching notes.';
  return memories.map((memory) => `- ${formatMemoryLine(memory)}`).join('\n');
}
