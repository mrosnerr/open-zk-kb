// review/graph-providers.ts
//
// Computational-only fact providers for the rule-driven contextual graph
// pipeline. Providers may parse supplied source bytes, resolve targets
// through the injected query function, deduplicate edges, and compute
// canonical applicability — but they never decide whether a note is
// defective, whether reciprocity is desirable, whether incomplete evidence
// suppresses a rule, or what impact/basis/message a finding has. Those
// judgments live only in `graph-rules.ts`.

import { parseKnowledgeApplicability } from '../knowledge-scope.js';
import type { ContextualLinkFailure, ContextualLinkReadResult, ContextualLinkResolution } from '../link-health/types.js';
import { extractContextualMarkdownFacts } from '../markdown/contextual-facts.js';
import type {
  ContextualLinkFacts,
  ContextualOccurrence,
  DocumentApplicabilityFacts,
  GraphDocument,
  GraphEdge,
  GraphEdgeFacts,
  ResolvedLinkFacts,
  ResolvedOccurrence,
} from './graph-types.js';

/** Diagnostic-only raw scan; never used to resolve or classify a link. */
const RAW_WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

function countRawCandidates(source: string): number {
  const pattern = new RegExp(RAW_WIKILINK_PATTERN.source, 'g');
  let count = 0;
  while (pattern.exec(source) !== null) count++;
  return count;
}

/**
 * Parses every supplied document once, in source order. A read or parse
 * failure becomes a note-identity-only failure — never a fallback to
 * unrestricted regex evaluation of the note's content.
 */
export function buildContextualLinkFacts(documents: readonly ContextualLinkReadResult[]): ContextualLinkFacts {
  const graphDocuments: GraphDocument[] = documents.map(entry => entry.document);
  const occurrences: ContextualOccurrence[] = [];
  const failures: ContextualLinkFailure[] = [];
  let documentsParsed = 0;
  let rawCandidates = 0;

  for (const entry of documents) {
    if (!entry.ok) {
      failures.push({ id: entry.document.id, title: entry.document.title });
      continue;
    }
    const parsed = extractContextualMarkdownFacts(entry.source);
    if (!parsed.ok) {
      failures.push({ id: entry.document.id, title: entry.document.title });
      continue;
    }
    documentsParsed++;
    rawCandidates += countRawCandidates(entry.source);
    for (const link of parsed.wikilinks) {
      occurrences.push({
        sourceId: entry.document.id,
        sourceTitle: entry.document.title,
        target: link.slug,
        line: link.range.start.line + 1,
        offset: link.range.start.offset,
      });
    }
  }

  failures.sort((a, b) => a.id.localeCompare(b.id));

  return {
    documents: graphDocuments,
    occurrences,
    failures,
    totals: {
      documentsParsed,
      rawCandidates,
      contextualLinks: occurrences.length,
      excludedCandidates: rawCandidates - occurrences.length,
      parseFailures: failures.length,
    },
  };
}

/**
 * Resolves every occurrence's target through `resolve`, calling it at most
 * once per distinct normalized slug per invocation while preserving every
 * authored occurrence and its own line/offset identity.
 */
export function buildResolvedLinkFacts(
  contextualLinks: ContextualLinkFacts,
  resolve: (slug: string) => ContextualLinkResolution,
): ResolvedLinkFacts {
  const memo = new Map<string, ContextualLinkResolution>();
  const resolveOnce = (slug: string): ContextualLinkResolution => {
    const cached = memo.get(slug);
    if (cached) return cached;
    const resolved = resolve(slug);
    const resolution: ContextualLinkResolution = resolved.kind === 'document'
      ? { kind: 'document', id: resolved.id }
      : { kind: resolved.kind };
    memo.set(slug, resolution);
    return resolution;
  };

  const occurrences: ResolvedOccurrence[] = contextualLinks.occurrences.map(occurrence => ({
    ...occurrence,
    resolution: resolveOnce(occurrence.target),
  }));

  return { occurrences };
}

/**
 * Deduplicates resolved source→target pairs between two active,
 * non-structural documents in this scan. A target resolving to any other
 * existing note — including a `vault-target` outside this scan's document
 * set — is a valid, non-broken link that never becomes a graph edge.
 */
export function buildGraphEdgeFacts(contextualLinks: ContextualLinkFacts, resolvedLinks: ResolvedLinkFacts): GraphEdgeFacts {
  const documentsById = new Map(contextualLinks.documents.map(document => [document.id, document] as const));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const occurrence of resolvedLinks.occurrences) {
    if (occurrence.resolution.kind !== 'document') continue;
    const target = documentsById.get(occurrence.resolution.id);
    if (!target) continue;
    const pairKey = `${occurrence.sourceId}\0${target.id}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    edges.push({ sourceId: occurrence.sourceId, sourceTitle: occurrence.sourceTitle, targetId: target.id, targetTitle: target.title });
  }

  return {
    edges,
    failedDocumentIds: contextualLinks.failures.map(failure => failure.id),
    outgoingCandidateIds: [...new Set(contextualLinks.occurrences.map(occurrence => occurrence.sourceId))],
  };
}

/** Canonical applicability classification for every document in this scan. */
export function buildDocumentApplicabilityFacts(contextualLinks: ContextualLinkFacts): DocumentApplicabilityFacts {
  return {
    values: contextualLinks.documents.map(document => ({
      id: document.id,
      type: parseKnowledgeApplicability([...document.tags]).type,
    })),
  };
}
