// content-guidelines.ts - Shared, host-neutral content-quality thresholds.
//
// These constants are the single source of truth for word-count and title
// guidance used by both the maintenance handlers (src/tool-handlers.ts) and
// the internal vault-review core (src/review/). Keeping them here avoids a
// circular import between the two.

import type { NoteKind } from './types.js';

/** Soft word-count guidelines per note kind (not hard limits). */
export const KIND_WORD_GUIDELINES: Record<NoteKind, { target: number; warn: number }> = {
  personalization: { target: 50, warn: 80 },
  decision:        { target: 150, warn: 250 },
  procedure:       { target: 150, warn: 250 },
  reference:       { target: 120, warn: 200 },
  observation:     { target: 100, warn: 200 },
  resource:        { target: 50, warn: 100 },
  domain:          { target: 500, warn: 1000 },
  index:           { target: 500, warn: 2000 },
  log:             { target: 500, warn: 5000 },
};

/** Absolute word-count ceiling — warns regardless of kind. */
export const ABSOLUTE_WARN_THRESHOLD = 300;

export const TITLE_SOFT_WARN_WORDS = 6;
export const TITLE_HARD_LIMIT_WORDS = 10;
export const TITLE_HARD_LIMIT_CHARS = 80;
