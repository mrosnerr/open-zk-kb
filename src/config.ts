import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { expandPath } from './utils/path.js';
import type { PluginConfig, NoteKind } from './types.js';

const xdgDataHome = process.env.XDG_DATA_HOME || expandPath('~/.local/share');
const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');

const CONFIG_PATH = path.join(xdgConfigHome, 'open-zk-kb', 'config.yaml');

// ── Raw YAML shape ──

interface RawConfig {
  vault?: string;
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  grooming?: {
    stalenessDays?: number;
    minAccessCount?: number;
    protectedKinds?: NoteKind[];
  };
  opencode?: OpenCodeConfig;
}

export interface OpenCodeConfig {
  provider?: {
    base_url?: string;
    api_key?: string;
  };
  capture?: {
    auto?: boolean;
    model?: string;
    threshold?: number;
    max_calls_per_session?: number;
    base_url?: string;
    api_key?: string;
  };
  embeddings?: {
    enabled?: boolean;
    model?: string;
    dimensions?: number;
    base_url?: string;
    api_key?: string;
  };
  injection?: {
    enabled?: boolean;
    max_notes?: number;
    context_aware?: boolean;
    inject_capture_status?: boolean;
  };
  excluded_apps?: string[];
}

// ── Defaults ──

export const DEFAULT_CONFIG: PluginConfig = {
  logLevel: 'INFO',
  vault: path.join(xdgDataHome, 'open-zk-kb'),
  grooming: {
    stalenessDays: 14,
    minAccessCount: 2,
    protectedKinds: ['personalization', 'decision'],
  },
};

// ── Loader ──

let cachedRaw: RawConfig | null | undefined;

function loadYamlConfig(): RawConfig | null {
  if (cachedRaw !== undefined) return cachedRaw;

  if (!fs.existsSync(CONFIG_PATH)) {
    cachedRaw = null;
    return null;
  }

  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(content) as RawConfig | null;
    cachedRaw = parsed;
    return parsed;
  } catch {
    cachedRaw = null;
    return null;
  }
}

// ── Public API ──

/**
 * Core config used by both MCP server and OpenCode plugin.
 * Reads from ~/.config/open-zk-kb/config.yaml (top-level keys).
 */
export function getConfig(): PluginConfig {
  const raw = loadYamlConfig();

  const vault = raw?.vault ? expandPath(raw.vault) : DEFAULT_CONFIG.vault;

  return {
    vault,
    logLevel: raw?.logLevel ?? DEFAULT_CONFIG.logLevel,
    grooming: {
      stalenessDays: raw?.grooming?.stalenessDays ?? DEFAULT_CONFIG.grooming.stalenessDays,
      minAccessCount: raw?.grooming?.minAccessCount ?? DEFAULT_CONFIG.grooming.minAccessCount,
      protectedKinds: raw?.grooming?.protectedKinds ?? DEFAULT_CONFIG.grooming.protectedKinds,
    },
  };
}

/**
 * OpenCode-specific config (provider, capture, embeddings, injection).
 * Returns null if the `opencode` section is absent from config.yaml.
 */
export function getOpenCodeConfig(): OpenCodeConfig | null {
  const raw = loadYamlConfig();
  return raw?.opencode ?? null;
}
