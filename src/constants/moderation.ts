// src/constants/moderation.ts
// Moderation and content filtering constants

/**
 * Number of reports required before a post is automatically hidden
 */
export const POST_REPORT_HIDE_THRESHOLD = 5;

/**
 * List of banned words/phrases for content filtering
 * Add words here to automatically flag or reject content
 */
export const BANNED_WORDS: string[] = [
  // Add banned words here, e.g.:
  // "somebadword",
  // "anotherbadphrase",
];

/**
 * Check if text contains any banned words
 */
export function hasBannedWords(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_WORDS.some((word) => word && lower.includes(word.toLowerCase()));
}

/**
 * Sanitize text input by trimming whitespace
 */
export function sanitizeText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim();
}