// utils/deep-freeze.ts - Recursive freeze for plain, JSON-compatible data.
//
// Used to make invocation-local snapshots (review facts, findings, plans)
// immutable before they are shared across rules or returned to callers.
// Intended only for plain objects/arrays; it does not need to special-case
// `Map`, `Set`, or functions because those values must never cross a
// provider/rule boundary in the first place.

function freezeValue(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const entry of Object.values(value) as readonly unknown[]) {
    freezeValue(entry);
  }
}

/** Deep-freezes `value` in place and returns it, without mutating any already-frozen sub-value. */
export function deepFreeze<T>(value: T): T {
  freezeValue(value);
  return value;
}
