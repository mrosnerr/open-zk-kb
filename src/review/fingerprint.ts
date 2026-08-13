import { createHash } from 'node:crypto';
import type { Scalar } from './types.js';

export const FINGERPRINT_SCHEMA_VERSION = 1;

/**
 * Canonical logical-subject fingerprint: `[schemaVersion, ruleId, ...identity]`,
 * JSON-serialized and hashed as UTF-8 bytes. `identity` must contain only the
 * note ID plus the minimal state/signal needed to distinguish findings —
 * never messages, evidence, excerpts, ages, or word counts, so presentation
 * changes never churn the fingerprint. `ruleVersion` is intentionally kept
 * out of the tuple and reported separately on `Finding`.
 */
export function canonicalFingerprint(ruleId: string, identity: readonly Scalar[]): string {
  for (const part of identity) {
    if (typeof part === 'number' && (!Number.isFinite(part) || !Number.isInteger(part))) {
      throw new TypeError('Review fingerprint identity numbers must be finite integers');
    }
  }
  const tuple = [FINGERPRINT_SCHEMA_VERSION, ruleId, ...identity];
  return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
}
