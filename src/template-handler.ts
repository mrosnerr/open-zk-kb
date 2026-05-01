// template-handler.ts - Template retrieval and conformance checking

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logToFile } from './logger.js';

// Distinct from STRUCTURAL_KINDS in tool-handlers.ts (auto-generated kinds) — opposite meaning.
export const CONFORMANCE_KINDS = new Set(['decision', 'procedure', 'domain', 'reference', 'observation']);

export const CATEGORY_MAPS: Record<string, Record<string, string[]>> = {
  decision: {
    context:       ['context', 'background', 'motivation', 'problem', 'why'],
    options:       ['options', 'alternatives', 'options considered', 'approaches', 'candidates'],
    decision:      ['decision', 'chosen', 'selected', 'verdict', 'choice'],
    tradeoffs:     ['tradeoffs', 'trade-offs', 'tradeoffs accepted', 'downsides', 'costs', 'giving up'],
    consequences:  ['consequences', 'impact', 'downstream', 'what changes', 'implications'],
    reversibility: ['reversibility', 'revisit', 'exit strategy', 'migration path', 'when to reconsider'],
  },
  procedure: {
    trigger:       ['trigger', 'when to run', 'invocation', 'activation'],
    prerequisites: ['prerequisites', 'requirements', 'before you start', 'setup', 'pre-conditions'],
    steps:         ['steps', 'procedure', 'instructions', 'process', 'workflow', 'how to'],
    verification:  ['verification', 'validate', 'confirm', 'check', 'done when', 'success criteria'],
    failures:      ['failure', 'failure modes', 'troubleshoot', 'common issues', 'if it breaks', 'recovery'],
  },
  observation: {
    what:          ['what i saw', 'what happened', 'observation', 'finding', 'noticed'],
    where:         ['where', 'location', 'context', 'file', 'source'],
    why:           ['why it matters', 'significance', 'relevance', 'so what'],
    implications:  ['implications', 'next steps', 'follow-up', 'action', 'future work'],
  },
  domain: {
    role:          ['agent role', 'role', 'purpose', 'mission'],
    scope:         ['scope', 'in scope', 'out of scope', 'boundaries'],
    conventions:   ['conventions', 'note conventions', 'patterns', 'standards'],
    playbook:      ['playbook', 'operations', 'workflows', 'procedures', 'how to'],
    boundaries:    ['boundaries', 'always', 'never', 'ask first', 'rules'],
  },
  reference: {
    summary:       ['summary', 'overview', 'abstract', 'tldr', 'key takeaway'],
    excerpts:      ['excerpts', 'key excerpts', 'quotes', 'highlights', 'key points'],
    content:       ['content', 'original content', 'full text', 'body', 'source material'],
  },
};

export function getTemplatesDir(): string {
  // One level up from src/ or dist/ — templates/ lives at project root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

/** Never throws — returns descriptive error string on failure. */
export function getTemplate(kind: string, projectOverridePath?: string): string {
  if (projectOverridePath) {
    try {
      if (fs.existsSync(projectOverridePath)) {
        const content = fs.readFileSync(projectOverridePath, 'utf-8');
        return `<template_content source="project-override">\n${content}\n</template_content>`;
      }
    } catch (err) {
      logToFile('WARN', 'Failed to read project template override', {
        path: projectOverridePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const packagePath = path.join(getTemplatesDir(), `${kind}.md`);
  if (!fs.existsSync(packagePath)) {
    return `No template found for kind "${kind}". Expected at: ${packagePath}`;
  }

  try {
    const content = fs.readFileSync(packagePath, 'utf-8');
    return `<template_content source="package">\n${content}\n</template_content>`;
  } catch (err) {
    return `Failed to read template for kind "${kind}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Strips <examples> block so example headers don't inflate conformance scores. */
export function stripExamplesBlock(content: string): string {
  return content.replace(/<examples>[\s\S]*?<\/examples>/gi, '').trim();
}

export function extractHeaders(content: string): string[] {
  const headerRegex = /^##\s+(.+)$/gm;
  const headers: string[] = [];
  let match;
  while ((match = headerRegex.exec(content)) !== null) {
    headers.push(match[1].trim().toLowerCase());
  }
  return headers;
}

export function getExpectedCategories(kind: string): Record<string, string[]> | null {
  if (!CONFORMANCE_KINDS.has(kind)) return null;
  return CATEGORY_MAPS[kind] ?? null;
}

export function matchCategories(
  categories: Record<string, string[]>,
  actualHeaders: string[],
): Set<string> {
  const matched = new Set<string>();

  for (const [category, synonyms] of Object.entries(categories)) {
    for (const header of actualHeaders) {
      const headerLower = header.toLowerCase();
      for (const synonym of synonyms) {
        if (headerLower.includes(synonym) || headerLower.startsWith(synonym)) {
          matched.add(category);
          break;
        }
      }
      if (matched.has(category)) break;
    }
  }

  return matched;
}

export interface ConformanceRecord {
  noteId: string;
  kind: string;
  action: string;
  model: string | null;
  coverage: number;
  matchedCategories: string[];
  missingCategories: string[];
  hintTriggered: boolean;
}

export interface ConformanceAggregates {
  totalChecked: number;
  avgCoverage: number;
  hintTriggerRate: number;
  hintCount: number;
  byKind: Record<string, {
    count: number;
    avgCoverage: number;
    hintCount: number;
  }>;
  templateRetrievals: number;
}
