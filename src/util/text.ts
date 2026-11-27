/**
 * Turns a model reply into text suitable for text-to-speech: strips markdown syntax,
 * replaces links with their label (or drops bare URLs), and collapses whitespace.
 */
export function toSpeakableText(text: string, maxLength = 2_500): string {
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  out = out.replace(/https?:\/\/\S+/g, '');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/^\s*\d+[.)]\s+/gm, '');
  out = out.replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2');
  out = out.replace(/[*_~#>|]/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxLength) {
    const cut = out.slice(0, maxLength);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    out = lastStop > maxLength * 0.5 ? cut.slice(0, lastStop + 1) : cut;
  }
  return out;
}

/**
 * Splits text into chunks no longer than `limit`, preferring paragraph, then line,
 * then sentence, then word boundaries. Never returns empty chunks.
 */
export function chunkText(text: string, limit: number): string[] {
  if (limit <= 0) throw new RangeError('limit must be positive');
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const cut =
      lastBoundary(window, '\n\n') ??
      lastBoundary(window, '\n') ??
      lastBoundary(window, '. ') ??
      lastBoundary(window, ' ') ??
      limit;
    const piece = remaining.slice(0, cut).trimEnd();
    if (piece.length > 0) chunks.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function lastBoundary(window: string, separator: string): number | undefined {
  const index = window.lastIndexOf(separator);
  // Ignore boundaries in the first third so chunks don't get tiny.
  if (index < window.length / 3) return undefined;
  return index + separator.length;
}

/** Truncates a string to `max` characters, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
