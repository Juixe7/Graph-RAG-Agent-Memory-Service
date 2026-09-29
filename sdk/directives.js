/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Shared Directives
 *
 *  Hard rules injected verbatim into every system prompt that needs
 *  them, rather than each caller re-wording its own copy. Directives
 *  (hard rules, always injected verbatim) are a distinct mechanism
 *  from a caller's own task framing — that framing is task-specific
 *  and stays with the caller.
 *
 *  Kept as a single shared constant so the same rule doesn't drift
 *  across every LLM call site in the codebase (llm_router.js callers,
 *  dedup.js's judge prompt, etc.) — edit it here once and every
 *  caller picks it up.
 * ══════════════════════════════════════════════════════════════
 */

// The core rule, worded generically enough to fit any prompt that reasons
// over retrieved/contributed content. Callers may append a
// context-specific clause of their own — that framing is task-specific, so
// it stays with the caller rather than living here.
export const ANTI_FABRICATION_DIRECTIVE = [
  'CRITICAL: Ground every factual claim in the context or contributions actually given to you.',
  'Do not coin a technical-sounding term for a plain observation and present it as if it were',
  'established terminology, and do not state a guess or inference with the same confidence as',
  'something you actually verified. If you don\'t know something, or the material given to you',
  'doesn\'t cover it, say so plainly instead of inventing a plausible-sounding answer.',
].join('\n');
