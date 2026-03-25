// tests/client-heuristics.test.ts - Unit tests for client detection and visibility heuristics
import { describe, it, expect } from 'bun:test';
import { detectClient, isVisibleToClient, getClientTags, isKnownClient, KNOWN_CLIENTS, CLIENT_CONTENT_PATTERNS } from '../src/client-heuristics.js';

describe('detectClient', () => {
  it('should detect opencode from .opencode/ path in content', () => {
    expect(detectClient('Edit .opencode/config.json for settings', '')).toBe('opencode');
  });

  it('should detect claude-code from .claude/ path in content', () => {
    expect(detectClient('Check .claude/settings.json for MCP config', '')).toBe('claude-code');
  });

  it('should detect claude-code from CLAUDE.md reference', () => {
    expect(detectClient('Add instructions to CLAUDE.md in project root', '')).toBe('claude-code');
  });

  it('should detect claude-code from skills/SKILL.md reference', () => {
    expect(detectClient('Read skills/open-zk-kb/SKILL.md for usage', '')).toBe('claude-code');
  });

  it('should detect cursor from .cursor/ path', () => {
    expect(detectClient('Edit .cursor/rules for custom rules', '')).toBe('cursor');
  });

  it('should detect windsurf from .codeium/windsurf/ path', () => {
    expect(detectClient('Config at .codeium/windsurf/mcp_config.json', '')).toBe('windsurf');
  });

  it('should detect zed from .config/zed/ path', () => {
    expect(detectClient('Edit .config/zed/settings.json for config', '')).toBe('zed');
  });

  it('should detect client from guidance field', () => {
    expect(detectClient('General content', 'Edit .opencode/config.json')).toBe('opencode');
  });

  it('should return null for universal content', () => {
    expect(detectClient('User prefers TypeScript over JavaScript', 'Use TypeScript by default')).toBeNull();
  });

  it('should return null when multiple clients detected (ambiguous)', () => {
    expect(detectClient('Compare .opencode/config.json vs .claude/settings.json', '')).toBeNull();
  });

  it('should return null for empty strings', () => {
    expect(detectClient('', '')).toBeNull();
  });
});

describe('getClientTags', () => {
  it('should extract client names from client: tags', () => {
    expect(getClientTags(['client:opencode', 'project:myapp'])).toEqual(['opencode']);
  });

  it('should return multiple client names', () => {
    expect(getClientTags(['client:opencode', 'client:claude-code'])).toEqual(['opencode', 'claude-code']);
  });

  it('should return empty array when no client tags', () => {
    expect(getClientTags(['project:myapp', 'typescript'])).toEqual([]);
  });

  it('should return empty array for empty tags', () => {
    expect(getClientTags([])).toEqual([]);
  });

  it('should handle client:all', () => {
    expect(getClientTags(['client:all'])).toEqual(['all']);
  });
});

describe('isVisibleToClient', () => {
  it('should return true for notes with no client tags (universal)', () => {
    expect(isVisibleToClient([], 'opencode')).toBe(true);
    expect(isVisibleToClient(['project:myapp', 'typescript'], 'claude-code')).toBe(true);
  });

  it('should return true for notes with client:all tag', () => {
    expect(isVisibleToClient(['client:all'], 'opencode')).toBe(true);
    expect(isVisibleToClient(['client:all'], 'claude-code')).toBe(true);
    expect(isVisibleToClient(['client:all', 'project:myapp'], 'cursor')).toBe(true);
  });

  it('should return true when querying client matches', () => {
    expect(isVisibleToClient(['client:opencode'], 'opencode')).toBe(true);
    expect(isVisibleToClient(['client:claude-code', 'project:myapp'], 'claude-code')).toBe(true);
  });

  it('should return false when querying client does not match', () => {
    expect(isVisibleToClient(['client:opencode'], 'claude-code')).toBe(false);
    expect(isVisibleToClient(['client:claude-code'], 'cursor')).toBe(false);
  });

  it('should return true if note has multiple client tags and one matches', () => {
    expect(isVisibleToClient(['client:opencode', 'client:claude-code'], 'claude-code')).toBe(true);
  });

  it('should return false if note has multiple client tags and none match', () => {
    expect(isVisibleToClient(['client:opencode', 'client:claude-code'], 'cursor')).toBe(false);
  });
});

describe('CLIENT_CONTENT_PATTERNS', () => {
  it('should have patterns for all known clients', () => {
    expect(Object.keys(CLIENT_CONTENT_PATTERNS)).toEqual(
      expect.arrayContaining(['opencode', 'claude-code', 'cursor', 'windsurf', 'zed'])
    );
  });

  it('should have at least one pattern per client', () => {
    for (const [client, patterns] of Object.entries(CLIENT_CONTENT_PATTERNS)) {
      expect(patterns.length).toBeGreaterThan(0);
    }
  });
});

describe('isKnownClient', () => {
  it('should recognize all known clients', () => {
    for (const client of KNOWN_CLIENTS) {
      expect(isKnownClient(client)).toBe(true);
    }
  });

  it('should recognize "all" as valid', () => {
    expect(isKnownClient('all')).toBe(true);
  });

  it('should reject unrecognized client names', () => {
    expect(isKnownClient('vscode')).toBe(false);
    expect(isKnownClient('emacs')).toBe(false);
    expect(isKnownClient('')).toBe(false);
  });

  it('should be consistent with CLIENT_CONTENT_PATTERNS keys', () => {
    for (const client of Object.keys(CLIENT_CONTENT_PATTERNS)) {
      expect(isKnownClient(client)).toBe(true);
    }
  });
});
