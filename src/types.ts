/**
 * Type definitions for open-zk-kb
 * Shared, persistent memory for AI assistants, built on the Zettelkasten method
 */

// ============ NOTE KIND ============

export type NoteKind = 'personalization' | 'reference' | 'decision' | 'procedure' | 'resource' | 'observation' | 'domain' | 'index' | 'log';
export type NoteStatus = 'fleeting' | 'permanent' | 'archived';
export type Lifecycle = 'living' | 'snapshot' | 'append-only';

/** Map kind to its default status */
export const KIND_DEFAULT_STATUS: Record<NoteKind, NoteStatus> = {
  personalization: 'permanent',
  reference: 'fleeting',
  decision: 'permanent',
  procedure: 'fleeting',
  resource: 'permanent',
  observation: 'fleeting',
  domain: 'permanent',
  index: 'permanent',
  log: 'permanent',
};

/** Map kind to its default lifecycle */
export const KIND_DEFAULT_LIFECYCLE: Record<NoteKind, Lifecycle> = {
  personalization: 'living',
  reference: 'living',
  decision: 'snapshot',
  procedure: 'living',
  resource: 'living',
  observation: 'snapshot',
  domain: 'living',
  index: 'living',
  log: 'append-only',
};

export const VALID_LIFECYCLES = new Set<string>(['living', 'snapshot', 'append-only']);

// ============ APP CONFIGURATION ============

export interface LifecycleDefaults {
  defaultForKind: Record<string, string>;
  detectSnapshotFromSlug: boolean;
}

export interface SearchConfig {
  alwaysIncludeDomainNote: boolean;
  excludeLogFromSearch: boolean;
}

export interface NavigationConfig {
  enableProjectIndex: boolean;
  enableProjectLog: boolean;
  enableGlobalIndex: boolean;
  enableGlobalLog: boolean;
  enableReviewMoc: boolean;
  mocSplitThreshold: number;
  mocPreviewCount: number;
  overviewLogEntryLimit: number;
}

export interface TelemetryConfig {
  enabled: boolean;
}

export interface ObsidianConfig {
  scaffold: boolean;
  autoUpgrade: boolean;
  readOnly: boolean;
}

export interface VersioningConfig {
  enabled: boolean;
  debounceMs: number;
}

export interface RelatedNotesConfig {
  enabled: boolean;
  maxResults: number;
  minSimilarity: number;
  excludeKinds: NoteKind[];
}

export interface StoreConfig {
  relatedNotes: RelatedNotesConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface AppConfig {
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  vault: string;
  lifecycle: {
    reviewAfterDays: number;
    promotionThreshold: number;
    exemptKinds: NoteKind[];
    autoArchiveFleetingDays: number;
  };
  lifecycleDefaults: LifecycleDefaults;
  search: SearchConfig;
  store: StoreConfig;
  navigation: NavigationConfig;
  telemetry: TelemetryConfig;
  obsidian: ObsidianConfig;
  versioning: VersioningConfig;
  server: ServerConfig;
}

// NOTE: NoteMetadata and StoreResult are defined in storage/NoteRepository.ts
// (the canonical source). Import from there, not here.
