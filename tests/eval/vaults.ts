// tests/eval/vaults.ts - Vault state factories for eval scenarios
// Each factory receives a NoteRepository and populates it with a known state.

import { NoteRepository } from '../../src/storage/NoteRepository.js';

// ---- Factories ----

/** Fresh install — no notes at all */
export function emptyVault(_repo: NoteRepository): void {
  // no-op, vault is already empty
}

/** Notes exist but missing summary/guidance (simulates pre-v3 state) */
export function legacyVault(repo: NoteRepository): void {
  const notes = [
    { content: 'I prefer dark mode in all editors and terminals.', title: 'Prefers dark mode', kind: 'personalization' as const },
    { content: 'TypeScript strict mode catches null/undefined errors at compile time.', title: 'TypeScript strict mode benefits', kind: 'reference' as const },
    { content: 'All new services use PostgreSQL. Evaluated MongoDB but chose Postgres for consistency.', title: 'PostgreSQL for new services', kind: 'decision' as const },
    { content: 'To deploy: run bun build, then docker compose up -d.', title: 'Deployment procedure', kind: 'procedure' as const },
    { content: 'The auth middleware seems to add 50ms latency per request.', title: 'Auth middleware latency', kind: 'observation' as const },
  ];

  for (const note of notes) {
    repo.store(note.content, {
      title: note.title,
      kind: note.kind,
      status: note.kind === 'personalization' || note.kind === 'decision' ? 'permanent' : 'fleeting',
      tags: [],
    });
  }
}

/** Some notes upgraded, some not */
export function partialUpgradeVault(repo: NoteRepository): void {
  const upgraded = [
    {
      content: 'Always use bun instead of npm or yarn.',
      title: 'Use bun for package management',
      kind: 'personalization' as const,
      summary: 'User requires bun for all package management tasks.',
      guidance: 'Use bun instead of npm or yarn. Never suggest npm install or yarn add.',
    },
    {
      content: 'Tailwind CSS is preferred over Bootstrap for styling.',
      title: 'Prefers Tailwind over Bootstrap',
      kind: 'personalization' as const,
      summary: 'User prefers Tailwind CSS utility classes over Bootstrap.',
      guidance: 'Recommend Tailwind when suggesting CSS frameworks or reviewing CSS code.',
    },
    {
      content: 'REST API error responses follow RFC 7807 Problem Details format.',
      title: 'RFC 7807 error format',
      kind: 'decision' as const,
      summary: 'API errors use RFC 7807 Problem Details format.',
      guidance: 'Use RFC 7807 format when implementing or reviewing API error responses.',
    },
  ];

  for (const note of upgraded) {
    repo.store(note.content, {
      title: note.title,
      kind: note.kind,
      status: 'permanent',
      tags: [],
      summary: note.summary,
      guidance: note.guidance,
    });
  }

  const legacy = [
    { content: 'ESLint with typescript-eslint for all linting.', title: 'ESLint setup', kind: 'reference' as const },
    { content: 'Run tests before every commit.', title: 'Pre-commit testing', kind: 'procedure' as const },
    { content: 'The database connection pool maxes out at 20 connections.', title: 'DB pool limit', kind: 'observation' as const },
  ];

  for (const note of legacy) {
    repo.store(note.content, {
      title: note.title,
      kind: note.kind,
      status: 'fleeting',
      tags: [],
    });
  }
}

/** Everything clean — all fields populated, no pending migrations */
export function healthyVault(repo: NoteRepository): void {
  const notes = [
    {
      content: 'I prefer dark mode in all editors and terminals.',
      title: 'Prefers dark mode',
      kind: 'personalization' as const,
      summary: 'User prefers dark mode in all editors and terminals.',
      guidance: 'Use dark themes when suggesting editor or terminal configurations.',
      tags: ['preferences', 'editor'],
    },
    {
      content: 'TypeScript strict mode catches null/undefined errors at compile time.',
      title: 'TypeScript strict mode benefits',
      kind: 'reference' as const,
      summary: 'TypeScript strict mode catches null/undefined errors at compile time.',
      guidance: 'Reference when discussing TypeScript compiler options.',
      tags: ['typescript', 'compiler'],
    },
    {
      content: 'All new services use PostgreSQL. Evaluated MongoDB but chose Postgres for consistency.',
      title: 'PostgreSQL for new services',
      kind: 'decision' as const,
      summary: 'Team uses PostgreSQL for all new backend services.',
      guidance: 'Recommend PostgreSQL for new services. Do not suggest MongoDB without user raising it.',
      tags: ['database', 'architecture'],
    },
    {
      content: 'To deploy: run bun build, then docker compose up -d.',
      title: 'Deployment procedure',
      kind: 'procedure' as const,
      summary: 'Deployment is bun build followed by docker compose up.',
      guidance: 'Follow this procedure when assisting with deployments.',
      tags: ['deployment', 'docker'],
    },
    {
      content: 'Tailwind CSS is the preferred styling framework.',
      title: 'Prefers Tailwind CSS',
      kind: 'personalization' as const,
      summary: 'User prefers Tailwind CSS utility classes.',
      guidance: 'Recommend Tailwind when suggesting CSS frameworks.',
      tags: ['css', 'styling'],
    },
  ];

  for (const note of notes) {
    repo.store(note.content, {
      title: note.title,
      kind: note.kind,
      status: note.kind === 'personalization' || note.kind === 'decision' ? 'permanent' : 'fleeting',
      tags: note.tags,
      summary: note.summary,
      guidance: note.guidance,
    });
  }
}

// Alias for backward compatibility
export const fullSetupVault = healthyVault;
