/** Conversational styles a person can pick with /customize. */
export const STYLES = {
  default: { label: 'Default', instruction: 'Helpful and natural; answer the latest request directly.' },
  casual: { label: 'Casual', instruction: 'Friendly and casual: a relaxed, conversational tone.' },
  formal: { label: 'Formal', instruction: 'Professional and formal: detailed, precise responses.' },
  humorous: { label: 'Humorous', instruction: 'Witty and humorous: work in light-hearted humor.' },
  sarcastic: { label: 'Sarcastic', instruction: 'Sarcastic and dry-witted: a touch of irony and wit, never mean-spirited.' },
} as const;

export type StyleId = keyof typeof STYLES;

export const DEFAULT_STYLE: StyleId = 'default';

export function isStyleId(value: string): value is StyleId {
  return Object.hasOwn(STYLES, value);
}

export function resolveStyle(value: string | undefined): StyleId {
  return value !== undefined && isStyleId(value) ? value : DEFAULT_STYLE;
}
