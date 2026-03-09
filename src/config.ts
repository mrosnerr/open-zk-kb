import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { expandPath } from './utils/path.js';
import type { AppConfig, NoteKind } from './types.js';

const xdgDataHome = process.env.XDG_DATA_HOME || expandPath('~/.local/share');
const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');

const CONFIG_PATH = path.join(xdgConfigHome, 'open-zk-kb', 'config.yaml');

// ── Raw YAML shape ──

export interface EmbeddingsConfig {
  enabled?: boolean;
  provider?: 'local' | 'api';
  model?: string;
  dimensions?: number;
  base_url?: string;
  api_key?: string;
}

interface RawConfig {
  vault?: string;
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  lifecycle?: {
    reviewAfterDays?: number;
    promotionThreshold?: number;
    exemptKinds?: NoteKind[];
  };
  embeddings?: EmbeddingsConfig;
}

// ── Defaults ──

export const DEFAULT_CONFIG: AppConfig = {
  logLevel: 'INFO',
  vault: path.join(xdgDataHome, 'open-zk-kb'),
  lifecycle: {
    reviewAfterDays: 14,
    promotionThreshold: 2,
    exemptKinds: ['personalization', 'decision'],
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

export function getConfig(): AppConfig {
  const raw = loadYamlConfig();

  const vault = raw?.vault ? expandPath(raw.vault) : DEFAULT_CONFIG.vault;

  return {
    vault,
    logLevel: raw?.logLevel ?? DEFAULT_CONFIG.logLevel,
    lifecycle: {
      reviewAfterDays: raw?.lifecycle?.reviewAfterDays ?? DEFAULT_CONFIG.lifecycle.reviewAfterDays,
      promotionThreshold: raw?.lifecycle?.promotionThreshold ?? DEFAULT_CONFIG.lifecycle.promotionThreshold,
      exemptKinds: raw?.lifecycle?.exemptKinds ?? DEFAULT_CONFIG.lifecycle.exemptKinds,
    },
  };
}

export function getEmbeddingsConfig(): EmbeddingsConfig | null {
  const raw = loadYamlConfig();

  return raw?.embeddings ?? null;
}
