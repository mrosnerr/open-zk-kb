import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { expandPath } from './utils/path.js';
import type { AppConfig, NoteKind } from './types.js';
import { KIND_DEFAULT_STATUS, KIND_DEFAULT_LIFECYCLE, VALID_LIFECYCLES } from './types.js';

const VALID_NOTE_KINDS = new Set<string>(Object.keys(KIND_DEFAULT_STATUS));

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
    autoArchiveFleetingDays?: number;
  };
  lifecycleDefaults?: {
    defaultForKind?: Record<string, string>;
    detectSnapshotFromSlug?: boolean;
  };
  search?: {
    alwaysIncludeDomainNote?: boolean;
    excludeLogFromSearch?: boolean;
  };
  store?: {
    relatedNotes?: {
      enabled?: boolean;
      maxResults?: number;
      minSimilarity?: number;
      excludeKinds?: string[];
    };
  };
  navigation?: {
    enableProjectIndex?: boolean;
    enableProjectLog?: boolean;
    enableGlobalIndex?: boolean;
    enableGlobalLog?: boolean;
    enableReviewMoc?: boolean;
    mocSplitThreshold?: number;
    mocPreviewCount?: number;
    overviewLogEntryLimit?: number;
  };
  telemetry?: {
    enabled?: boolean;
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
    autoArchiveFleetingDays: 90,
  },
  lifecycleDefaults: {
    defaultForKind: { ...KIND_DEFAULT_LIFECYCLE },
    detectSnapshotFromSlug: true,
  },
  search: {
    alwaysIncludeDomainNote: true,
    excludeLogFromSearch: true,
  },
  store: {
    relatedNotes: {
      enabled: true,
      maxResults: 5,
      minSimilarity: 0.70,
      excludeKinds: ['domain', 'index', 'log'],
    },
  },
  navigation: {
    enableProjectIndex: true,
    enableProjectLog: true,
    enableGlobalIndex: true,
    enableGlobalLog: true,
    enableReviewMoc: true,
    mocSplitThreshold: 30,
    mocPreviewCount: 5,
    overviewLogEntryLimit: 10,
  },
  telemetry: {
    enabled: false,
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

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

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
      autoArchiveFleetingDays: raw?.lifecycle?.autoArchiveFleetingDays ?? DEFAULT_CONFIG.lifecycle.autoArchiveFleetingDays,
    },
    lifecycleDefaults: {
      defaultForKind: {
        ...DEFAULT_CONFIG.lifecycleDefaults.defaultForKind,
        ...Object.fromEntries(
          Object.entries(raw?.lifecycleDefaults?.defaultForKind || {})
            .filter(([, v]) => typeof v === 'string' && VALID_LIFECYCLES.has(v))
        ),
      },
      detectSnapshotFromSlug: raw?.lifecycleDefaults?.detectSnapshotFromSlug ?? DEFAULT_CONFIG.lifecycleDefaults.detectSnapshotFromSlug,
    },
    search: {
      alwaysIncludeDomainNote: typeof raw?.search?.alwaysIncludeDomainNote === 'boolean'
        ? raw.search.alwaysIncludeDomainNote
        : DEFAULT_CONFIG.search.alwaysIncludeDomainNote,
      excludeLogFromSearch: typeof raw?.search?.excludeLogFromSearch === 'boolean'
        ? raw.search.excludeLogFromSearch
        : DEFAULT_CONFIG.search.excludeLogFromSearch,
    },
    store: {
      relatedNotes: {
        enabled: typeof raw?.store?.relatedNotes?.enabled === 'boolean'
          ? raw.store.relatedNotes.enabled
          : DEFAULT_CONFIG.store.relatedNotes.enabled,
        maxResults: positiveInt(raw?.store?.relatedNotes?.maxResults, DEFAULT_CONFIG.store.relatedNotes.maxResults),
        minSimilarity: typeof raw?.store?.relatedNotes?.minSimilarity === 'number'
          ? Math.max(0, Math.min(1, raw.store.relatedNotes.minSimilarity))
          : DEFAULT_CONFIG.store.relatedNotes.minSimilarity,
        excludeKinds: Array.isArray(raw?.store?.relatedNotes?.excludeKinds)
          ? raw.store.relatedNotes.excludeKinds.filter((k: string) => VALID_NOTE_KINDS.has(k)) as NoteKind[]
          : DEFAULT_CONFIG.store.relatedNotes.excludeKinds,
      },
    },
    navigation: {
      enableProjectIndex: typeof raw?.navigation?.enableProjectIndex === 'boolean'
        ? raw.navigation.enableProjectIndex
        : DEFAULT_CONFIG.navigation.enableProjectIndex,
      enableProjectLog: typeof raw?.navigation?.enableProjectLog === 'boolean'
        ? raw.navigation.enableProjectLog
        : DEFAULT_CONFIG.navigation.enableProjectLog,
      enableGlobalIndex: typeof raw?.navigation?.enableGlobalIndex === 'boolean'
        ? raw.navigation.enableGlobalIndex
        : DEFAULT_CONFIG.navigation.enableGlobalIndex,
      enableGlobalLog: typeof raw?.navigation?.enableGlobalLog === 'boolean'
        ? raw.navigation.enableGlobalLog
        : DEFAULT_CONFIG.navigation.enableGlobalLog,
      enableReviewMoc: typeof raw?.navigation?.enableReviewMoc === 'boolean'
        ? raw.navigation.enableReviewMoc
        : DEFAULT_CONFIG.navigation.enableReviewMoc,
      mocSplitThreshold: positiveInt(raw?.navigation?.mocSplitThreshold, DEFAULT_CONFIG.navigation.mocSplitThreshold),
      mocPreviewCount: positiveInt(raw?.navigation?.mocPreviewCount, DEFAULT_CONFIG.navigation.mocPreviewCount),
      overviewLogEntryLimit: typeof raw?.navigation?.overviewLogEntryLimit === 'number'
        ? raw.navigation.overviewLogEntryLimit
        : DEFAULT_CONFIG.navigation.overviewLogEntryLimit,
    },
    telemetry: {
      enabled: typeof raw?.telemetry?.enabled === 'boolean'
        ? raw.telemetry.enabled
        : DEFAULT_CONFIG.telemetry.enabled,
    },
  };
}

export function getEmbeddingsConfig(): EmbeddingsConfig | null {
  const raw = loadYamlConfig();

  return raw?.embeddings ?? null;
}
