/**
 * Type definitions for open-zk-kb
 * Shared, persistent memory for AI coding assistants, built on the Zettelkasten method
 */

// ============ NOTE KIND ============

export type NoteKind = 'personalization' | 'reference' | 'decision' | 'procedure' | 'resource' | 'observation';
export type NoteStatus = 'fleeting' | 'permanent' | 'archived';

/** Map kind to its default status */
export const KIND_DEFAULT_STATUS: Record<NoteKind, NoteStatus> = {
  personalization: 'permanent',
  reference: 'fleeting',
  decision: 'permanent',
  procedure: 'fleeting',
  resource: 'permanent',
  observation: 'fleeting',
};

// ============ APP CONFIGURATION ============

export interface AppConfig {
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  vault: string;
  lifecycle: {
    reviewAfterDays: number;
    promotionThreshold: number;
    exemptKinds: NoteKind[];
  };
}

// NOTE: NoteMetadata and StoreResult are defined in storage/NoteRepository.ts
// (the canonical source). Import from there, not here.
