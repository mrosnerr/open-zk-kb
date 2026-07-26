// link-health/evaluator.ts
//
// Pure contextual link-health graph evaluator. Accepts only plain
// `ContextualLinkReadResult` values and a `resolveTarget` query function —
// no filesystem, repository, database, clock, or telemetry capability.
// Repeated calls on identical inputs return deeply equal, deterministic
// results.

import { parseKnowledgeApplicability } from '../knowledge-scope.js';
import { extractContextualMarkdownFacts } from '../markdown/contextual-facts.js';
import type {
  ContextualBrokenFinding,
  ContextualLinkDocument,
  ContextualLinkFailure,
  ContextualLinkGraphResult,
  ContextualLinkReadResult,
  ContextualOneWayFinding,
  ContextualUnlinkedFinding,
} from './types.js';

/** Diagnostic-only raw scan; never used to resolve or classify a link. */
const RAW_WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

function countRawCandidates(source: string): number {
  const pattern = new RegExp(RAW_WIKILINK_PATTERN.source, 'g');
  let count = 0;
  while (pattern.exec(source) !== null) count++;
  return count;
}

export function evaluateContextualLinkGraph(
  documents: readonly ContextualLinkReadResult[],
  resolveTarget: (slug: string) => string | null
): ContextualLinkGraphResult {
  const documentIds = new Set(documents.map(entry => entry.document.id));
  const docsById = new Map<string, ContextualLinkDocument>(documents.map(entry => [entry.document.id, entry.document]));
  const failedIds = new Set<string>();
  const failures: ContextualLinkFailure[] = [];

  let documentsParsed = 0;
  let rawCandidates = 0;
  let contextualLinks = 0;
  const broken: ContextualBrokenFinding[] = [];
  // Deduplicated resolved source→target edges (source id -> set of target ids).
  const outgoing = new Map<string, Set<string>>();
  const hasOutgoingCandidate = new Set<string>();

  for (const entry of documents) {
    const { document } = entry;
    if (!entry.ok) {
      failedIds.add(document.id);
      failures.push(Object.freeze({ id: document.id, title: document.title }));
      continue;
    }

    const facts = extractContextualMarkdownFacts(entry.source);
    if (!facts.ok) {
      failedIds.add(document.id);
      failures.push(Object.freeze({ id: document.id, title: document.title }));
      continue;
    }

    documentsParsed++;
    rawCandidates += countRawCandidates(entry.source);
    contextualLinks += facts.wikilinks.length;
    if (facts.wikilinks.length > 0) hasOutgoingCandidate.add(document.id);

    for (const link of facts.wikilinks) {
      const line = link.range.start.line + 1;
      const resolved = resolveTarget(link.slug);
      if (!resolved) {
        broken.push(Object.freeze({ sourceId: document.id, sourceTitle: document.title, brokenTarget: link.slug, line }));
        continue;
      }
      // Only a resolved edge between two active, non-structural documents
      // participates in the graph; a link to any other existing note is a
      // valid (non-broken) candidate but never a graph edge.
      if (documentIds.has(resolved)) {
        let targets = outgoing.get(document.id);
        if (!targets) {
          targets = new Set();
          outgoing.set(document.id, targets);
        }
        targets.add(resolved);
      }
    }
  }

  const incompleteGraph = failures.length > 0;

  const incomingTargets = new Set<string>();
  for (const targets of outgoing.values()) {
    for (const target of targets) incomingTargets.add(target);
  }

  const unlinked: ContextualUnlinkedFinding[] = [];
  if (!incompleteGraph) {
    for (const entry of documents) {
      if (!entry.ok) continue;
      const { document } = entry;
      if (!hasOutgoingCandidate.has(document.id) && !incomingTargets.has(document.id)) {
        unlinked.push(Object.freeze({
          id: document.id,
          title: document.title,
          kind: document.kind,
          status: document.status,
          tags: Object.freeze([...document.tags]),
        }));
      }
    }
  }

  const oneWay: ContextualOneWayFinding[] = [];
  for (const [sourceId, targets] of outgoing) {
    for (const targetId of targets) {
      // The target document failed to read/parse: its reverse edge is unknown.
      if (failedIds.has(targetId)) continue;
      const reverseExists = outgoing.get(targetId)?.has(sourceId) ?? false;
      if (reverseExists) continue;

      const sourceDoc = docsById.get(sourceId);
      const targetDoc = docsById.get(targetId);
      if (!sourceDoc || !targetDoc) continue;

      const sourceApplicability = parseKnowledgeApplicability([...sourceDoc.tags]);
      const targetApplicability = parseKnowledgeApplicability([...targetDoc.tags]);
      if (sourceApplicability.type === 'project-local' && targetApplicability.type === 'global') continue;

      oneWay.push(Object.freeze({ sourceId, sourceTitle: sourceDoc.title, targetId, targetTitle: targetDoc.title }));
    }
  }
  oneWay.sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle) || a.targetTitle.localeCompare(b.targetTitle));
  failures.sort((a, b) => a.id.localeCompare(b.id));

  return Object.freeze({
    totals: Object.freeze({
      documentsParsed,
      rawCandidates,
      contextualLinks,
      excludedCandidates: rawCandidates - contextualLinks,
      parseFailures: failures.length,
    }),
    failures: Object.freeze(failures),
    broken: Object.freeze(broken),
    unlinked: Object.freeze(unlinked),
    oneWay: Object.freeze(oneWay),
    incompleteGraph,
  });
}
