// client-heuristics.ts - Client detection and visibility logic for cross-client KB filtering
//
// Notes can contain client-specific content (paths, config references). This module
// provides heuristics to auto-detect which client a note targets, and filtering logic
// to hide notes scoped to other clients during search.

/** Known client identifiers. Used for soft validation — unrecognized clients are warned, not rejected. */
export const KNOWN_CLIENTS = new Set(['opencode', 'claude-code', 'cursor', 'windsurf', 'zed']);

/** Returns true if the client name is recognized. 'all' is always valid. */
export function isKnownClient(client: string): boolean {
  return client === 'all' || KNOWN_CLIENTS.has(client);
}

/** Strong path-prefix patterns per client. Only unambiguous signals — no bare filenames. */
export const CLIENT_CONTENT_PATTERNS: Record<string, RegExp[]> = {
  'opencode':    [/\.opencode\//],
  'claude-code': [/\.claude\//, /\bCLAUDE\.md\b/, /\bskills\/.*SKILL\.md/],
  'cursor':      [/\.cursor\//],
  'windsurf':    [/\.codeium\/windsurf\//],
  'zed':         [/\.config\/zed\//],
};

export const CLIENT_TAG_PREFIX = 'client:';

/** Build a `client:X` tag from a client name. */
export function clientTag(client: string): string {
  return `${CLIENT_TAG_PREFIX}${client}`;
}

/**
 * Scan content and guidance for client-specific patterns.
 * Returns a single client name if exactly one client is detected, or null
 * if the content is universal or ambiguous (mentions multiple clients).
 */
export function detectClient(content: string, guidance: string): string | null {
  const text = `${content}\n${guidance}`;
  const matched: string[] = [];

  for (const [client, patterns] of Object.entries(CLIENT_CONTENT_PATTERNS)) {
    if (patterns.some(re => re.test(text))) {
      matched.push(client);
    }
  }

  // Only auto-tag when exactly one client detected — ambiguous = universal
  return matched.length === 1 ? matched[0] : null;
}

/** Extract all `client:X` values from a tags array. */
export function getClientTags(tags: string[]): string[] {
  return tags
    .filter(t => t.startsWith(CLIENT_TAG_PREFIX))
    .map(t => t.slice(CLIENT_TAG_PREFIX.length));
}

/**
 * Determine whether a note (by its tags) should be visible to a given client.
 *
 * Rules:
 * 1. No `client:` tags → universal, visible to all
 * 2. Has `client:all` → visible to all
 * 3. Otherwise → visible only if querying client matches a `client:` tag
 */
export function isVisibleToClient(tags: string[], client: string): boolean {
  const clients = getClientTags(tags);
  if (clients.length === 0) return true;
  if (clients.includes('all')) return true;
  return clients.includes(client);
}
