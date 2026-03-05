// tests/eval/features/core-kb.eval.ts - Core knowledge base eval scenarios
// Covers: status checks, store/retrieve, migrations, implicit knowledge retrieval

import type { EvalScenario } from '../harness.js';
import { emptyVault, healthyVault, legacyVault } from '../vaults.js';

export const coreKbScenarios: EvalScenario[] = [
  // ---- Explicit status checks ----

  {
    name: 'empty-kb-status',
    feature: 'core-kb',
    setup: emptyVault,
    prompt: "What's the status of the knowledge base?",
    responseCriteria: {
      mustContain: [/0 notes|empty|no notes|nothing stored/i],
      mustNotContain: [/<note/, /note_id/, /```xml/],
    },
    timeout: 90_000,
  },

  {
    name: 'healthy-kb-status',
    feature: 'core-kb',
    setup: healthyVault,
    prompt: "What's the status of the knowledge base?",
    responseCriteria: {
      mustContain: [/\d+ notes/i],
      mustNotContain: [/upgrade|migration/i, /<note/],
    },
  },

  {
    name: 'legacy-kb-shows-upgrade-notice',
    feature: 'core-kb',
    setup: legacyVault,
    prompt: "What's the status of the knowledge base?",
    responseCriteria: {
      mustContain: [/upgrade|migration|missing/i, /summary|guidance/i],
      mustNotContain: [/<note/],
    },
  },

  // ---- Store and retrieve ----

  {
    name: 'store-and-retrieve',
    feature: 'core-kb',
    setup: emptyVault,
    prompt: 'Remember that I prefer TypeScript over JavaScript for all new projects. Then search the knowledge base for my language preferences and tell me what you find.',
    responseCriteria: {
      mustContain: [/typescript/i],
      mustNotContain: [/<note/, /note_id/],
    },
    vaultCriteria: (repo) => {
      const stats = repo.getStats();
      return stats.total === 0 ? ['No note was stored'] : [];
    },
  },

  // ---- Migration workflow ----

  {
    name: 'migration-completes',
    feature: 'core-kb',
    setup: legacyVault,
    prompt: 'Run all pending knowledge base migrations to completion.',
    responseCriteria: {
      mustContain: [/complete|applied|updated|upgraded|migrated|done/i],
    },
    vaultCriteria: (repo) => {
      const status = repo.getUpgradeStatus();
      const failures: string[] = [];
      if (status.needsSummary > 0) failures.push(`${status.needsSummary} notes still missing summary`);
      if (status.needsGuidance > 0) failures.push(`${status.needsGuidance} notes still missing guidance`);
      return failures;
    },
    timeout: 90_000,
  },

  // ---- Implicit knowledge retrieval ----

  {
    name: 'implicit-preference-retrieval',
    feature: 'core-kb',
    setup: (repo) => {
      repo.store('I strongly prefer Tailwind CSS utility classes over Bootstrap for styling.', {
        title: 'Prefers Tailwind over Bootstrap',
        kind: 'personalization',
        status: 'permanent',
        tags: ['css', 'styling'],
        summary: 'User prefers Tailwind CSS utility classes over Bootstrap.',
        guidance: 'Recommend Tailwind when suggesting CSS frameworks or reviewing CSS code.',
      });
    },
    prompt: "I'm starting a new web project. What CSS framework would you recommend?",
    responseCriteria: {
      mustContain: [/tailwind/i],
      mustNotContain: [/knowledge base|stored note|I found a note/i],
    },
  },

  {
    name: 'implicit-decision-retrieval',
    feature: 'core-kb',
    setup: (repo) => {
      repo.store('All new backend services use PostgreSQL. We evaluated MongoDB and DynamoDB but chose Postgres for consistency.', {
        title: 'PostgreSQL for all new services',
        kind: 'decision',
        status: 'permanent',
        tags: ['database', 'architecture'],
        summary: 'Team uses PostgreSQL for all new backend services.',
        guidance: 'Recommend PostgreSQL for new services. Do not suggest MongoDB or DynamoDB without the user raising it first.',
      });
    },
    prompt: 'I need to set up a database for a new microservice. What should I use?',
    responseCriteria: {
      mustContain: [/postgres/i],
      mustNotContain: [/knowledge base|I found|stored/i],
    },
    timeout: 90_000,
  },

  // ---- Proactive maintenance notices ----

  {
    name: 'proactive-upgrade-notice',
    feature: 'core-kb',
    setup: legacyVault,
    prompt: 'Check the knowledge base for any needed maintenance or upgrades.',
    responseCriteria: {
      mustContain: [/upgrade|migration|maintenance/i],
    },
  },

  {
    name: 'proactive-agent-setup-notice',
    feature: 'core-kb',
    setup: (repo) => {
      // Notes exist but no agent maps — noAgentMapsVault inline
      healthyVault(repo);
    },
    prompt: 'Check the knowledge base status and report any setup issues.',
    responseCriteria: {
      mustContain: [/agent|map|setup|bootstrap/i],
    },
  },
];
