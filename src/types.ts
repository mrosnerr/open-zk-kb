/**
 * Type definitions for open-zk-kb
 * OpenCode plugin for Zettelkasten-based knowledge management
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

// ============ PLUGIN CONFIGURATION ============

export interface PluginConfig {
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  vault: string;
  grooming: {
    stalenessDays: number;
    minAccessCount: number;
    protectedKinds: NoteKind[];
  };
}

// NOTE: NoteMetadata and StoreResult are defined in storage/NoteRepository.ts
// (the canonical source). Import from there, not here.
