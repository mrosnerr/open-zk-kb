// model-capabilities.ts - Model capability detection via agent self-report
//
// Classifies calling models into capability tiers based on self-reported model
// identifiers. Gates response richness — richer output for capable models,
// conservative output for weaker ones or when model is unknown.

export type CapabilityTier = 'high' | 'medium' | 'low';

// ---- Model family patterns ----
// Ordered: low-tier checked first (mini/nano/flash override high-tier bases). Everything else = medium.

const HIGH_TIER_PATTERNS: RegExp[] = [
  /\bopus\b/i,
  /\bgpt-?5\b/i,
  /\bo[34]-/i,             // o3-*, o4-* reasoning models
  /\bgemini[- ]?2\.?5[- ]?pro\b/i,
  /\bgemini[- ]?ultra\b/i,
  /\bdeepseek[- ]?r1\b/i,
  /\bkimi[- ]?k2/i,        // kimi-k2, kimi-k2.5
  /\bglm[- ]?5\b/i,
];

const LOW_TIER_PATTERNS: RegExp[] = [
  /\bhaiku\b/i,
  /\bmini\b/i,
  /\bflash\b/i,
  /\bnano\b/i,
  /\bgpt-?3\.?5\b/i,
  /\bgemma\b/i,
  /\bphi-/i,
  /\bqwen.*\b[0-3]b\b/i,  // ≤3B parameter models
  /\bllama.*\b[0-8]b\b/i, // ≤8B parameter models
];

/**
 * Classify a model identifier into a capability tier.
 * @param model Self-reported model identifier (e.g., 'claude-opus-4', 'gpt-4o-mini').
 * @returns 'high', 'medium', or 'low'. Returns 'medium' when model is undefined.
 */
export function classifyModel(model: string | undefined): CapabilityTier {
  if (!model || model.trim() === '') return 'medium';

  const normalized = model.trim();

  // Low-tier checked first: "mini"/"nano"/"flash" suffixes override high-tier bases
  // (e.g., gpt-5-mini → low, not high)
  for (const pattern of LOW_TIER_PATTERNS) {
    if (pattern.test(normalized)) return 'low';
  }

  for (const pattern of HIGH_TIER_PATTERNS) {
    if (pattern.test(normalized)) return 'high';
  }

  return 'medium';
}

export const MODEL_HINT = '\n\nⓘ Pass the `model` parameter (e.g., model="claude-opus-4") to enable richer responses including related note suggestions.';
