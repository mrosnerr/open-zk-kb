// tool-handlers.ts - Handler functions for knowledge tools

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { NoteKind, NoteStatus, Lifecycle, AppConfig } from './types.js';
import { KIND_DEFAULT_STATUS, KIND_DEFAULT_LIFECYCLE, VALID_LIFECYCLES } from './types.js';

const VALID_STATUSES = new Set<string>(['fleeting', 'permanent', 'archived']);

function validateCurrentProject(project: string | undefined): string | undefined {
  if (typeof project !== 'string' || project.trim() === '') return undefined;
  return extractProjectTag([`project:${project}`]) || undefined;
}

function toNoteStatus(status: string | undefined, fallback: NoteStatus): NoteStatus {
  if (status && VALID_STATUSES.has(status)) return status as NoteStatus;
  return fallback;
}

function toLifecycle(lifecycle: string | undefined, fallback: Lifecycle): Lifecycle {
  if (lifecycle && VALID_LIFECYCLES.has(lifecycle)) return lifecycle as Lifecycle;
  return fallback;
}
import type { KnowledgeMutationContext, NoteRepository, NoteMetadata, StoreResult } from './storage/NoteRepository.js';
import { extractWikiLinks } from './utils/wikilink.js';
import { renderNoteForSearch, renderNoteForAgent, computeStaleness } from './prompts.js';
import { buildIndexContent, buildGlobalIndexContent, buildProjectsIndexContent, buildGeneralIndexContent, buildPreferencesIndexContent, buildGeneralKindIndexContent } from './storage/IndexBuilder.js';
import { buildLogEntry, buildInitialLogContent, appendToLogContent, buildGlobalLogEntry, buildInitialGlobalLogContent, migrateGlobalLogContent } from './storage/LogAppender.js';
import { buildReviewContent } from './storage/ReviewBuilder.js';
import {
  resolveNotePath,
  extractProjectFromTags as extractProjectTag,
  KIND_DIR_MAP,
  getGeneralFolderNotePath,
  getGlobalHomeNoteBasename,
  getGlobalHomeNotePath,
  getKindFolderNotePath,
  getPreferencesFolderNotePath,
  getProjectsFolderNotePath,
} from './storage/path-resolver.js';
import { getPendingMigrations, getMigrationById } from './data-migrations.js';
import { logToFile } from './logger.js';
import { computeSimHash, isNearDuplicate } from './utils/simhash.js';
import { evaluateScreeningCandidate, reviewedOperationToken, reviewedOperationTokens, reviewedUpdateCandidate, screeningEvidenceDigest, targetFirstComparator, type ScreeningCandidate } from './reviewed-storage.js';
import { extractGeneratedRelatedIds, stripGeneratedRelatedSection } from './related-section.js';
import { evaluateDuplicates } from './maintenance/duplicates.js';
import type { EmbeddingConfig, EmbeddingResult } from './embeddings.js';
import { generateEmbedding, generateEmbeddingBatch, buildEmbeddingText } from './embeddings.js';
import { getLatestVersion, isNewerVersion } from './utils/version-check.js';
import { getAgentDocsTargets } from './agent-docs-targets.js';
import { injectAgentDocs, inspectAgentDocs, removeAgentDocs } from './agent-docs.js';
import { detectClient, isVisibleToClient, getClientTags, clientTag, isKnownClient } from './client-heuristics.js';
import { getInstalledInstructionVersions } from './instruction-versions.js';
import { classifyModel, MODEL_HINT } from './model-capabilities.js';
import { extractFromUrl, extractArticle } from './url-extractor.js';
import type { ExtractionResult } from './url-extractor.js';
import { splitSections, extractLinks, countWords } from './content-splitter.js';
import { detectObsidian, launchObsidian, formatNotInstalledMessage, formatSuccessMessage } from './obsidian.js';
import { ensureObsidianScaffold, getObsidianScaffoldStatus } from './obsidian-scaffold.js';
import { contractPath } from './utils/path.js';
import { getTemplate, getExpectedCategories, matchCategories, extractHeaders, stripExamplesBlock, CONFORMANCE_KINDS } from './template-handler.js';
import type { GitVersioning } from './git-versioning.js';
import { parseKnowledgeApplicability } from './knowledge-scope.js';
import { PUBLISHABLE_KINDS } from './tool-meta.js';
import { buildReviewSnapshot } from './review/facts.js';
import { createRepositoryReviewReader } from './review/reader.js';
import { evaluateReview } from './review/registry.js';
import { materializeGraphReview, type GraphDocument, type GraphReviewResult } from './review/graph.js';
import type { EvaluationResult, Finding, FindingGroup, ReviewScope } from './review/types.js';
import { createRepositoryContextualLinkReader } from './link-health/reader.js';
import type { ContextualScanTotals } from './link-health/types.js';

// ---- Constants ----

import { KIND_WORD_GUIDELINES, ABSOLUTE_WARN_THRESHOLD, atomicityWarnThreshold, TITLE_SOFT_WARN_WORDS, TITLE_HARD_LIMIT_WORDS, TITLE_HARD_LIMIT_CHARS } from './content-guidelines.js';
export { KIND_WORD_GUIDELINES, ABSOLUTE_WARN_THRESHOLD, TITLE_SOFT_WARN_WORDS, TITLE_HARD_LIMIT_WORDS, TITLE_HARD_LIMIT_CHARS };

const EMBEDDING_BACKFILL_BATCH_SIZE = 50;
const EMBEDDING_FOREGROUND_TIMEOUT_MS = 10_000;
const REVIEW_EVIDENCE_MAX_CHARS = 240;

function normalizeAndTruncate(value: string | undefined, maxChars = REVIEW_EVIDENCE_MAX_CHARS): { value?: string; truncated: boolean } {
  if (!value || maxChars <= 0) return { truncated: false };
  const normalized = value.replace(/\s+/g, ' ').trim();
  const points = Array.from(normalized);
  if (points.length <= maxChars) return { value: normalized, truncated: false };
  return { value: `${points.slice(0, maxChars - 1).join('').trimEnd()}…`, truncated: true };
}

function boundedReviewEvidence(value: string | undefined, maxChars = REVIEW_EVIDENCE_MAX_CHARS): string | undefined {
  return normalizeAndTruncate(value, maxChars).value;
}

// ---- Helper functions ----

function titleWarning(title: string): { error: string } | { warning: string } | null {
  const words = title.trim().split(/\s+/).filter(Boolean).length;
  const chars = title.trim().length;
  if (words > TITLE_HARD_LIMIT_WORDS || chars > TITLE_HARD_LIMIT_CHARS) {
    return { error: `Title rejected: ${words} words / ${chars} chars (max ${TITLE_HARD_LIMIT_WORDS} words / ${TITLE_HARD_LIMIT_CHARS} chars). Titles are scannable labels — detail belongs in the summary field.` };
  }
  if (words > TITLE_SOFT_WARN_WORDS) {
    return { warning: `\n\n⚠ Title is ${words} words (target: 3–6). Consider shortening — titles are scannable labels, not summaries.` };
  }
  return null;
}

function atomicityWarning(kind: NoteKind, wordCount: number): string | null {
  const guide = KIND_WORD_GUIDELINES[kind];
  // The absolute-tier message only applies once the kind's own guideline is
  // already exceeded, so large-document kinds are never told to split at 300.
  if (wordCount <= atomicityWarnThreshold(kind)) return null;
  if (wordCount > ABSOLUTE_WARN_THRESHOLD) {
    return `\n\n⚠ This note is ${wordCount} words (target for ${kind}: ~${guide.target}). Consider splitting into separate atomic notes — each note should capture one concept.`;
  }
  return `\n\n⚠ This note is ${wordCount} words (target for ${kind}: ~${guide.target}). Consider whether it captures more than one concept.`;
}

type BrokenLink = {
  sourceId: string;
  sourceTitle: string;
  brokenTarget: string;
  line: number;
};

function filterFalsePositiveBrokenLinks<T extends BrokenLink>(
  broken: readonly T[],
  vaultPath: string | undefined,
  isIndexedTarget: (target: string) => boolean = () => false,
): T[] {
  if (!vaultPath) return [...broken];
  const resolvedVault = path.resolve(vaultPath);
  const vaultPrefix = resolvedVault + path.sep;
  const insideVault = (candidate: string): boolean => {
    const resolved = path.resolve(vaultPath, candidate);
    return resolved === resolvedVault || resolved.startsWith(vaultPrefix);
  };
  return broken.filter(({ brokenTarget }) => {
    // A target indexed in another scope is deliberately invisible, not a
    // filesystem false positive. Keep it in scoped health results as broken.
    if (isIndexedTarget(brokenTarget)) return true;
    const notePathRel = `${brokenTarget}.md`;
    const basename = path.basename(brokenTarget);
    const dirIndexPathRel = path.join(brokenTarget, `${basename}.md`);
    const noteResolves = insideVault(notePathRel)
      && fs.existsSync(path.resolve(vaultPath, notePathRel));
    const dirResolves = insideVault(dirIndexPathRel)
      && fs.existsSync(path.resolve(vaultPath, dirIndexPathRel));
    return !noteResolves && !dirResolves;
  });
}

const CONTEXTUAL_FAILURE_DISPLAY_CAP = 20;

/**
 * Runs one ephemeral contextual graph review: selects rules, reads active
 * non-structural documents through the query-only production reader, and
 * materializes only their shared fact dependency closure. No fact, edge,
 * plan, resolution cache, or finding is persisted.
 */
function runContextualLinkScan(repo: NoteRepository, ruleIds: readonly string[]): { result: GraphReviewResult; elapsedMs: number } {
  const reader = createRepositoryContextualLinkReader(repo);
  const start = Date.now();
  const result = materializeGraphReview(reader.listDocuments(), reader.resolveTarget, ruleIds);
  const elapsedMs = Date.now() - start;
  return { result, elapsedMs };
}

/** Aggregate-only log event: counts and duration, never note ids, titles, paths, content, or link targets. */
function logContextualLinkScan(action: string, totals: ContextualScanTotals, elapsedMs: number, config?: AppConfig): void {
  logToFile('INFO', 'Contextual link scan completed', {
    action,
    documentsParsed: totals.documentsParsed,
    rawCandidates: totals.rawCandidates,
    contextualLinks: totals.contextualLinks,
    excludedCandidates: totals.excludedCandidates,
    parseFailures: totals.parseFailures,
    elapsedMs,
  }, config);
}

function renderContextualScanSummary(totals: ContextualScanTotals, elapsedMs: number): string {
  return `## Contextual Markdown Scan\n\n`
    + `Documents: ${totals.documentsParsed} | Raw candidates: ${totals.rawCandidates} | Contextual links: ${totals.contextualLinks} | `
    + `Excluded: ${totals.excludedCandidates} | Parse failures: ${totals.parseFailures} | Elapsed: ${elapsedMs}ms\n`;
}

function renderContextualFailures(failures: GraphReviewResult['failures']): string {
  if (failures.length === 0) return '';
  let output = `\n### Parse/Read Failures (${failures.length})\n\n`;
  for (const failure of failures.slice(0, CONTEXTUAL_FAILURE_DISPLAY_CAP)) {
    output += `- "${failure.title}" [${failure.id}]\n`;
  }
  if (failures.length > CONTEXTUAL_FAILURE_DISPLAY_CAP) {
    output += `…and ${failures.length - CONTEXTUAL_FAILURE_DISPLAY_CAP} more\n`;
  }
  return output;
}

const INCOMPLETE_GRAPH_NOTICE = '\n⚠ Contextual graph incomplete — read/parse failures suppress unlinked findings.\n';

/** Default per-category display bound applied after complete graph-rule evaluation. */
const DEFAULT_CONTEXTUAL_DISPLAY_LIMIT = 20;

/** Positive-integer `limit` overrides the default; anything else uses the default. */
function contextualDisplayLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_CONTEXTUAL_DISPLAY_LIMIT;
}

function graphGroup(graph: EvaluationResult, ruleId: string): FindingGroup {
  const group = graph.groups.find(candidate => candidate.ruleId === ruleId);
  if (!group) throw new Error(`Missing graph rule group ${ruleId}`);
  return group;
}

function findingEvidence(finding: Finding, label: string): string {
  const match = finding.evidence.find(entry => entry.label === label);
  return match ? String(match.value) : '';
}

/** Renders `links.broken` findings in their existing item format with a display bound. */
function renderContextualBrokenFindings(findings: readonly Finding[], cap: number): string {
  let output = '';
  for (const finding of findings.slice(0, cap)) {
    const sourceTitle = findingEvidence(finding, 'sourceTitle');
    const target = findingEvidence(finding, 'target');
    const line = findingEvidence(finding, 'line');
    output += `- "${sourceTitle}" [${finding.primary.id}] content:${line} → [[${target}]] (not found)\n`;
  }
  if (findings.length > cap) {
    output += `(showing ${cap} of ${findings.length})\n`;
  }
  return output;
}

function removeEmptyDirsRecursive(dir: string, isRoot: boolean): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isRoot && entry.name.startsWith('.')) continue;
    removed += removeEmptyDirsRecursive(path.join(dir, entry.name), false);
  }

  if (!isRoot) {
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        removed++;
      }
    } catch {
      // Non-fatal: another process may have removed the directory.
    }
  }

  return removed;
}

// ---- Arg types ----

export interface StoreArgs {
  title: string;
  content: string;
  kind: NoteKind;
  status?: string;
  lifecycle?: string;
  tags?: string[];
  summary: string;
  guidance: string;
  project: string;
  client?: string;
  related?: string[];
  model?: string;
  dryRun?: boolean;
  disposition?: 'create' | 'update' | 'skip';
  noteId?: string;
  expectedUpdatedAt?: number;
  confirm?: boolean;
  token?: string;
}

export interface MineCandidate {
  title: string;
  content: string;
  kind: NoteKind;
  summary: string;
  guidance: string;
  project?: string;
  tags?: string[];
  source?: string;
}

export interface MineDisposition {
  candidateKey: string;
  action: 'store' | 'update' | 'skip';
  noteId?: string;
  expectedUpdatedAt?: number;
  token?: string;
  evidenceDigest?: string;
}

export interface MineArgs {
  candidates: MineCandidate[];
  project: string;
  client?: string;
  dry_run?: boolean;
  dispositions?: MineDisposition[];
  confirm?: boolean;
  batchToken?: string;
  model?: string;
}

export interface SearchArgs {
  query: string;
  kind?: NoteKind;
  status?: string;
  lifecycle?: string;
  project: string;
  client?: string;
  tags?: string[];
  limit?: number;
  model?: string;
  mode?: 'full' | 'compact';
}

export interface PublishGlobalCandidate {
  title: string;
  content: string;
  kind: NoteKind;
  summary: string;
  guidance: string;
  tags?: string[];
}

export interface MaintainArgs {
  action: string;
  noteId?: string;
  filter?: 'fleeting' | 'permanent';
  days?: number;
  limit?: number;
  dryRun?: boolean;
  candidate?: PublishGlobalCandidate;
  confirm?: boolean;
  token?: string;
  project?: string;
  model?: string;
}

export interface IngestArgs {
  url?: string;
  html?: string;
  model?: string;
}

export interface ContextArgs {
  project: string;
  logEntries?: number;
  model?: string;
  includePreferences?: boolean;
  client?: string;
  preferenceOnly?: boolean;
}

export interface PreferenceCapsuleLine {
  scope: string;
  guidance: string;
  id: string;
  line: string;
}

export interface PreferenceCapsule {
  lines: PreferenceCapsuleLine[];
  text: string;
  eligible: number;
  selected: number;
  omitted: number;
  estimatedTokens: number;
}

export interface ContextResult {
  text: string;
  preferenceCapsule?: PreferenceCapsule;
}

export interface HealthArgs {
  project: string;
  client?: string;
  period?: string;
  telemetry?: boolean;
  model?: string;
}

export interface OpenArgs {
  project?: string;
  _detectObsidian?: typeof detectObsidian;
  _launchObsidian?: typeof launchObsidian;
  _ensureScaffold?: typeof ensureObsidianScaffold;
}

interface RelatedNote {
  id: string;
  title: string;
  kind: string;
  similarity?: number;
  created_at: number;
  last_accessed_at?: number;
}

function sanitizeMetadata(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatTelemetryNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function scheduleTelemetryWrite(label: string, fn: () => void): void {
  queueMicrotask(() => {
    try {
      fn();
    } catch (e) {
      logToFile('WARN', `Telemetry write failed in ${label}`, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function formatTelemetryStats(repo: NoteRepository, days: number = 30): string {
  const telemetry = repo.getTelemetryAggregates(days);
  const avgSearches = telemetry.sessions > 0 ? telemetry.searches / telemetry.sessions : 0;
  const avgStores = telemetry.sessions > 0 ? telemetry.stores / telemetry.sessions : 0;
  const storeSearchRatio = telemetry.searches > 0 ? telemetry.stores / telemetry.searches : 0;
  const avgDurationMs = telemetry.sessionDurations.length > 0
    ? telemetry.sessionDurations.reduce((sum, duration) => sum + duration, 0) / telemetry.sessionDurations.length
    : 0;
  const avgDurationMin = avgDurationMs / 60000;
  const mostStored = Object.entries(telemetry.storesByKind)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const mostUsedAction = Object.entries(telemetry.maintainByAction)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  let output = '\n## Tool Telemetry\n\n';
  output += `Last ${days} days (${telemetry.sessions} sessions):\n`;
  output += `  Searches: ${telemetry.searches} (avg ${formatTelemetryNumber(avgSearches)} per session)\n`;
  output += `  Stores: ${telemetry.stores} (avg ${formatTelemetryNumber(avgStores)} per session)\n`;
  output += `  Store / search ratio: ${storeSearchRatio.toFixed(2)}\n`;
  output += `  Most-stored kind: ${mostStored ? `${mostStored[0]} (${mostStored[1]})` : 'none (0)'}\n`;
  output += `  Most-used action: ${mostUsedAction ? `${mostUsedAction[0]} (${mostUsedAction[1]})` : 'none (0)'}\n`;
  output += `  Avg session duration: ${formatTelemetryNumber(avgDurationMin)} min\n`;
  output += `  Contextual link scans: ${telemetry.contextualLinkScans.runs} (excluded ${telemetry.contextualLinkScans.excludedCandidates})\n`;
  return output;
}

function formatConformanceStats(repo: NoteRepository, days: number = 30): string {
  const agg = repo.getConformanceAggregates(days);
  if (agg.totalChecked === 0) return '';

  let output = '\n## Template Conformance\n\n';
  output += `Last ${days} days:\n`;
  output += `  Stores checked: ${agg.totalChecked}\n`;
  output += `  Avg coverage: ${agg.avgCoverage.toFixed(2)}\n`;
  output += `  Hint trigger rate: ${(agg.hintTriggerRate * 100).toFixed(0)}% (${agg.hintCount}/${agg.totalChecked})\n`;

  const kindEntries = Object.entries(agg.byKind).sort((a, b) => a[0].localeCompare(b[0]));
  if (kindEntries.length > 0) {
    output += '  By kind:\n';
    for (const [kind, data] of kindEntries) {
      output += `    ${kind}: ${data.avgCoverage.toFixed(2)} avg (${data.count} notes, ${data.hintCount} hints)\n`;
    }
  }

  output += `  Template retrieval: ${agg.templateRetrievals} calls`;
  if (agg.totalChecked > 0) {
    const adoption = agg.templateRetrievals / agg.totalChecked;
    output += ` (L3 adoption: ${(adoption * 100).toFixed(0)}%)`;
  }
  output += '\n';

  return output;
}

function parsePeriodToDays(period?: string): number {
  if (!period) return 30;
  const match = period.match(/^(\d+)d$/);
  if (!match) return 30;
  const days = parseInt(match[1], 10);
  return days > 0 ? days : 30;
}

export async function handleHealth(args: HealthArgs, repo: NoteRepository, config: AppConfig, embeddingConfig?: EmbeddingConfig | null, currentVersion?: string, gitVersioning?: GitVersioning | null): Promise<string> {
  const project = validateCurrentProject(args.project);
  if (!project) return 'Error: A valid project is required for knowledge health metrics.';
  const days = parsePeriodToDays(args.period);
  const periodLabel = `${days}d`;
  const stats = repo.getStats(project, args.client);
  const embeddingStats = repo.getEmbeddingStats(project, args.client);
  const staleness = repo.getStalenessDistribution(project, args.client);

  let output = project ? `# Knowledge Base Stats — ${project}\n\n` : '# Knowledge Base Stats\n\n';

  // --- Health indicators ---
  output += `## Health (${stats.total} notes)\n`;
  output += `- Fleeting: ${stats.fleeting}\n`;
  output += `- Permanent: ${stats.permanent}\n`;
  output += `- Archived: ${stats.archived}\n`;
  if (stats.other > 0) {
    output += `- Other (unknown status): ${stats.other}\n`;
  }

  if (embeddingStats.total > 0 || embeddingConfig) {
    output += '\n## Embeddings\n';
    if (embeddingConfig) {
      output += `- Provider: ${embeddingConfig.provider} (${embeddingConfig.model})\n`;
    }
    output += `- Embedded: ${embeddingStats.withEmbedding}/${embeddingStats.total} notes`;
    if (embeddingStats.withoutEmbedding > 0) {
      output += ` (${embeddingStats.withoutEmbedding} missing)`;
    }
    output += '\n';
  }

  {
    const brokenLinks = filterFalsePositiveBrokenLinks(
      repo.getBrokenLinks(project, args.client),
      config?.vault,
      target => repo.resolveLink(target) !== null,
    );
    const oneWayLinks = repo.getOneWayLinks(project, args.client);
    const unlinkedNotes = repo.getUnlinkedNotes(project, args.client);
    const linkIssueCount = brokenLinks.length + oneWayLinks.length + unlinkedNotes.length;
    output += '\n## Link Health\n';
    if (linkIssueCount > 0) {
      const parts: string[] = [];
      if (unlinkedNotes.length > 0) parts.push(`${unlinkedNotes.length} unlinked`);
      if (brokenLinks.length > 0) parts.push(`${brokenLinks.length} broken`);
      if (oneWayLinks.length > 0) parts.push(`${oneWayLinks.length} one-way`);
      output += `- Issues: ${parts.join(', ')}\n`;

      const detailLimit = 5;
      if (unlinkedNotes.length > 0) {
        output += '- Scoped unlinked notes:\n';
        for (const note of unlinkedNotes.slice(0, detailLimit)) {
          output += `  - "${note.title}" [${note.id}]\n`;
        }
        if (unlinkedNotes.length > detailLimit) output += `  - …and ${unlinkedNotes.length - detailLimit} more\n`;
      }
      if (brokenLinks.length > 0) {
        output += '- Scoped broken links:\n';
        for (const link of brokenLinks.slice(0, detailLimit)) {
          output += `  - "${link.sourceTitle}" [${link.sourceId}] content:${link.line} → [[${link.brokenTarget}]]\n`;
        }
        if (brokenLinks.length > detailLimit) output += `  - …and ${brokenLinks.length - detailLimit} more\n`;
      }
      if (oneWayLinks.length > 0) {
        output += '- Scoped one-way links:\n';
        for (const link of oneWayLinks.slice(0, detailLimit)) {
          output += `  - "${link.sourceTitle}" [${link.sourceId}] → "${link.targetTitle}" [${link.targetId}]\n`;
        }
        if (oneWayLinks.length > detailLimit) output += `  - …and ${oneWayLinks.length - detailLimit} more\n`;
      }
    } else {
      output += '- All clear ✓\n';
    }
  }

  output += '\n## Staleness\n';
  output += `- 0–7d: ${staleness.fresh}\n`;
  output += `- 7–30d: ${staleness.recent}\n`;
  output += `- 30–90d: ${staleness.aging}\n`;
  output += `- 90d+: ${staleness.stale}\n`;

  // --- Growth & activity ---
  const sinceMs = Date.now() - days * 86400000;
  const growth = repo.getGrowthByKind(sinceMs, project, args.client);
  const totalCreated = Object.values(growth).reduce((s, n) => s + n, 0);
  output += `\n## Growth (last ${periodLabel})\n`;
  output += `- Notes created: ${totalCreated}\n`;
  if (totalCreated > 0) {
    for (const [kind, count] of Object.entries(growth).sort((a, b) => b[1] - a[1])) {
      output += `  - ${kind}: ${count}\n`;
    }
    const avgPerDay = totalCreated / days;
    output += `- Avg per day: ${formatTelemetryNumber(avgPerDay)}\n`;
  }

  // --- Infrastructure ---
  if (stats.total > 0 && config.vault) {
    const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER);
    const flatCount = allNotes.filter(n => {
      const rel = path.relative(config.vault, n.path);
      return !rel.includes(path.sep) || rel.startsWith('..');
    }).length;
    const structuredCount = allNotes.length - flatCount;

    output += '\n## Infrastructure\n';
    if (flatCount > 0 && structuredCount === 0) {
      output += `- Layout: flat (all ${allNotes.length} notes in vault root)\n`;
    } else if (flatCount > 0 && structuredCount > 0) {
      output += `- Layout: mixed (${structuredCount} structured, ${flatCount} flat)\n`;
    } else {
      output += `- Layout: structured (${structuredCount} notes in kind-based directories)\n`;
    }
  }

  if (config.vault) {
    const scaffoldStatus = getObsidianScaffoldStatus(config.vault, config.obsidian);
    if (!output.includes('## Infrastructure')) output += '\n## Infrastructure\n';
    output += `- Obsidian scaffold: ${scaffoldStatus.scaffolded ? 'present' : 'not installed'}`;
    if (scaffoldStatus.scaffoldVersion != null) {
      output += ` (v${scaffoldStatus.scaffoldVersion}, latest: ${scaffoldStatus.latestVersion})`;
    }
    output += '\n';
    output += `- Plugins: ${scaffoldStatus.pluginsInstalled}/${scaffoldStatus.pluginsExpected} installed`;
    if (scaffoldStatus.pluginsNeedingUpdate > 0) {
      output += `, ${scaffoldStatus.pluginsNeedingUpdate} need update`;
    }
    output += '\n';
  }

  if (gitVersioning) {
    const vStats = gitVersioning.getStats();
    if (!output.includes('## Infrastructure')) output += '\n## Infrastructure\n';
    if (vStats) {
      output += `- Git: enabled (${vStats.commitCount} commits)\n`;
      if (vStats.lastCommitAge) output += `- Last commit: ${vStats.lastCommitAge}\n`;
    } else {
      output += '- Git: disabled\n';
    }
  }

  // --- Version ---
  if (currentVersion) {
    const latest = await getLatestVersion('open-zk-kb');
    output += '\n## Version\n';
    output += `- Server: ${currentVersion}`;
    if (latest) {
      if (isNewerVersion(currentVersion, latest)) {
        output += ` → ${latest} available`;
      } else {
        output += ' (latest)';
      }
    }
    output += '\n';

    const installedInstructions = getInstalledInstructionVersions();
    if (installedInstructions.length > 0) {
      output += '- Instructions:\n';
      for (const inst of installedInstructions) {
        const versionDisplay = inst.instructionVersion || 'unknown';
        let statusIcon: string;
        if (!inst.instructionVersion) {
          statusIcon = '?';
        } else if (latest && isNewerVersion(inst.instructionVersion, latest)) {
          statusIcon = '⚠';
        } else {
          statusIcon = '✓';
        }
        output += `  - ${inst.name}: ${versionDisplay} ${statusIcon}\n`;
      }
    }

    if (latest && isNewerVersion(currentVersion, latest)) {
      output += `\n**Update**: \`bunx open-zk-kb@latest install --client <name> --force\`\n`;
    }
  }

  // --- Telemetry (opt-in) ---
  if (args.telemetry) {
    output += formatTelemetryStats(repo, days);
    output += formatConformanceStats(repo, days);
  }

  if (!args.model) {
    output += MODEL_HINT;
  }

  scheduleTelemetryWrite('health', () => repo.recordToolInvocation('health', undefined, undefined, args.model));
  return output;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5MB

export async function handleIngest(args: IngestArgs, repo?: NoteRepository): Promise<string> {
  let result: ExtractionResult;
  if (args.html) {
    if (Buffer.byteLength(args.html, 'utf8') > MAX_HTML_BYTES) {
      throw new Error(`HTML content too large: exceeds ${MAX_HTML_BYTES} byte limit`);
    }
    const sourceUrl = args.url || 'about:blank';
    const article = extractArticle(args.html, sourceUrl);
    if (!article) {
      throw new Error('Could not extract article content from provided HTML. The content may not contain enough readable text.');
    }
    result = article;
  } else if (args.url) {
    result = await extractFromUrl(args.url);
  } else {
    throw new Error('Either url or html must be provided');
  }

  const title = sanitizeMetadata(result.title);
  const byline = result.byline ? sanitizeMetadata(result.byline) : null;
  const siteName = result.siteName ? sanitizeMetadata(result.siteName) : null;
  const excerpt = result.excerpt ? sanitizeMetadata(result.excerpt) : null;

  const sections = splitSections(result.content);
  const links = extractLinks(result.content, result.url !== 'about:blank' ? result.url : undefined);

  let output = `## Extracted Content\n\n`;
  output += `**Title:** ${title}\n`;
  output += `**URL:** ${result.url}\n`;
  output += `**Words:** ${result.wordCount}`;
  if (byline) output += `  |  **Author:** ${byline}`;
  if (siteName) output += `  |  **Site:** ${siteName}`;
  output += '\n';
  if (excerpt) output += `**Excerpt:** ${excerpt}\n`;
  output += `**Extracted:** ${result.extractedAt}\n`;

  if (sections.length > 1) {
    output += `**Sections:** ${sections.length}\n`;
    output += '\n---\n';
    for (const section of sections) {
      const flag = section.wordCount > 200 ? ' — exceeds 200w note target' : '';
      const heading = section.heading || '(preamble)';
      output += `\n### § ${heading} (${section.wordCount} words${flag})\n\n`;
      output += section.content + '\n';
    }
  } else {
    output += `\n---\n\n${result.content}`;
  }

  if (links.length > 0) {
    output += '\n---\n\n## Links Found (' + links.length + ')\n';
    for (const link of links.slice(0, 10)) {
      const sectionNote = link.section ? ` — § ${link.section}` : '';
      output += `- [${link.anchor}](${link.url})${sectionNote}\n`;
    }
    if (links.length > 10) {
      output += `- ...and ${links.length - 10} more\n`;
    }
  }

  const sourceUrl = result.url !== 'about:blank' ? result.url : args.url;
  if (repo && sourceUrl) {
    const existing = repo.findByUrl(sourceUrl);
    if (existing.length > 0) {
      output += '\n## Existing KB Coverage\n';
      output += `⚠ ${existing.length} note(s) already reference this URL:\n`;
      for (const note of existing) {
        output += `- ${note.title} [${note.id}]\n`;
      }
      output += 'Review before creating duplicates.\n';
    }
  }

  output += '\n## Next Steps\n';
  output += 'Review each section. For each worth saving, call knowledge-store with title, content, kind, summary, guidance.\n';
  if (sections.some(s => s.wordCount > 200)) {
    output += 'Sections over ~200 words may need splitting into separate atomic notes.\n';
  }
  if (links.length > 0) {
    output += `${links.length} link(s) found. Follow at most 1-2 per ingest. Do not follow links from followed articles.\n`;
  }

  if (!args.model) {
    output += MODEL_HINT;
  }

  if (repo) scheduleTelemetryWrite('ingest', () => repo.recordToolInvocation('ingest', undefined, sections.length, args.model));
  return output;
}

function describeAgentDocsStatus(status: ReturnType<typeof inspectAgentDocs>['status']): string {
  switch (status) {
    case 'healthy': return 'healthy';
    case 'start-only': return 'malformed (start marker only)';
    case 'end-only': return 'malformed (end marker only)';
    case 'out-of-order': return 'malformed (markers out of order)';
    case 'multiple-markers': return 'malformed (multiple markers)';
    default: return 'no managed block';
  }
}

// ---- Navigation hooks ----

const STRUCTURAL_KINDS = new Set(['index', 'log']);
const CONTEXTUAL_LINK_ACTIONS = new Set(['unlinked', 'broken-links', 'link-health']);

function extractProjectFromTags(tags: string[]): string | null {
  return extractProjectTag(tags);
}

function rebuildProjectIndex(project: string, repo: NoteRepository, config?: AppConfig): string[] {
  if (config?.navigation?.enableProjectIndex === false) return [];

  const changedPaths: string[] = [];
  try {
    const notes = repo.getProjectNotes(project);
    const splitConfig = config?.navigation ? {
      threshold: config.navigation.mocSplitThreshold,
      previewCount: config.navigation.mocPreviewCount,
    } : undefined;
    const { content, subMocs } = buildIndexContent(project, notes, splitConfig);
    const existingIndex = repo.getIndexNote(project);

    const indexResult = repo.store(content, {
      existingId: existingIndex?.id,
      title: project,
      kind: 'index',
      status: 'permanent',
      lifecycle: 'living',
      tags: [`project:${project}`],
      summary: `Auto-generated home note for ${project}`,
      guidance: 'Auto-generated project folder note — use knowledge-context to view.',
      extraFrontmatter: {
        'BC-folder-note-field': 'up',
        'BC-folder-note': true,
        cssclasses: ['folder-note-shell'],
        up: `[[${getGlobalHomeNoteBasename()}|Home]]`,
      },
    });
    changedPaths.push(indexResult.path);

    if (subMocs.length > 0 && config?.vault) {
      for (const subMoc of subMocs) {
        const subMocDir = path.join(config.vault, 'projects', project, subMoc.dirName);
        if (!fs.existsSync(subMocDir)) fs.mkdirSync(subMocDir, { recursive: true });
        const subMocPath = getKindFolderNotePath(subMocDir, subMoc.dirName);
        fs.writeFileSync(subMocPath, subMoc.content, 'utf-8');
        changedPaths.push(subMocPath);
        const legacySubIndexPath = path.join(subMocDir, 'index.md');
        if (fs.existsSync(legacySubIndexPath)) {
          fs.unlinkSync(legacySubIndexPath);
          changedPaths.push(legacySubIndexPath);
        }
      }
    }

    if (config?.vault) {
      const projectDir = path.join(config.vault, 'projects', project);
      const activeSubMocs = new Set(subMocs.map(subMoc => subMoc.dirName));
      if (fs.existsSync(projectDir)) {
        for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const subIndexPath = getKindFolderNotePath(path.join(projectDir, entry.name), entry.name);
          const legacySubIndexPath = path.join(projectDir, entry.name, 'index.md');
          if (!activeSubMocs.has(entry.name) && fs.existsSync(subIndexPath)) {
            fs.unlinkSync(subIndexPath);
            changedPaths.push(subIndexPath);
          }
          if (fs.existsSync(legacySubIndexPath)) {
            fs.unlinkSync(legacySubIndexPath);
            changedPaths.push(legacySubIndexPath);
          }
        }
      }
    }
  } catch (error) {
    logToFile('WARN', 'Failed to rebuild project index', {
      project,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return changedPaths;
}

function appendProjectLog(project: string, event: string, repo: NoteRepository, config?: AppConfig): string[] {
  if (config?.navigation?.enableProjectLog === false) return [];

  try {
    const entry = buildLogEntry(event);
    const existingLog = repo.getLogNote(project);

    const result = existingLog
      ? repo.store(appendToLogContent(existingLog.content || '', entry), {
          existingId: existingLog.id,
          title: `${project} Operations Log`,
          kind: 'log',
          status: 'permanent',
          lifecycle: 'append-only',
          tags: [`project:${project}`],
          summary: `Chronological operations log for ${project}`,
          guidance: 'Auto-generated operations log — use knowledge-context to view recent activity.',
        })
      : repo.store(buildInitialLogContent(project, entry), {
          title: `${project} Operations Log`,
          kind: 'log',
          status: 'permanent',
          lifecycle: 'append-only',
          tags: [`project:${project}`],
          summary: `Chronological operations log for ${project}`,
          guidance: 'Auto-generated operations log — use knowledge-context to view recent activity.',
        });
    return [result.path];
  } catch (error) {
    logToFile('WARN', 'Failed to append to project log', {
      project,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function updateProjectNavigation(
  project: string,
  event: string,
  repo: NoteRepository,
  config?: AppConfig,
): string[] {
  return [
    ...rebuildProjectIndex(project, repo, config),
    ...appendProjectLog(project, event, repo, config),
  ];
}
function updateGlobalNavigation(
  project: string | null,
  event: string,
  repo: NoteRepository,
  config?: AppConfig,
  options: { appendLog?: boolean } = {},
): string[] {
  const vaultPath = config?.vault;
  if (!vaultPath) return [];
  const changedPaths: string[] = [];
  let fleetingNotes: NoteMetadata[] | null = null;
  let generalGlobalNotes: NoteMetadata[] | null = null;
  let applicablePersonalizations: NoteMetadata[] | null = null;

  const getFleetingNotes = (): NoteMetadata[] => {
    if (!fleetingNotes) fleetingNotes = repo.getFleetingNotes();
    return fleetingNotes;
  };

  const getGeneralGlobalNotes = (): NoteMetadata[] => {
    if (!generalGlobalNotes) generalGlobalNotes = repo.getGeneralGlobalNotes();
    return generalGlobalNotes;
  };

  const getApplicablePersonalizations = (): NoteMetadata[] => {
    if (!applicablePersonalizations) {
      applicablePersonalizations = repo.getPersonalizationNotes()
        .filter(note => parseKnowledgeApplicability(note.tags).type !== 'unclassified');
    }
    return applicablePersonalizations;
  };

  if (config?.navigation?.enableGlobalIndex !== false) {
    try {
      const projectStats = repo.getProjectStats();
      const totalNoteCount = repo.getStats().total;
      const prefsCount = getApplicablePersonalizations().length;
      const generalCount = getGeneralGlobalNotes().length;
      const fleetingCount = getFleetingNotes().length;
      const content = buildGlobalIndexContent(projectStats, prefsCount, generalCount, fleetingCount, totalNoteCount, {
        includeReviewLink: config?.navigation?.enableReviewMoc !== false,
        includeGlobalLogLink: config?.navigation?.enableGlobalLog !== false,
      });
      const globalHomePath = getGlobalHomeNotePath(vaultPath);
      fs.writeFileSync(globalHomePath, content, 'utf-8');
      changedPaths.push(globalHomePath);
      const legacyGlobalIndex = path.join(vaultPath, 'index.md');
      if (fs.existsSync(legacyGlobalIndex)) {
        fs.unlinkSync(legacyGlobalIndex);
        changedPaths.push(legacyGlobalIndex);
      }

      const projectsDir = path.join(vaultPath, 'projects');
      if (fs.existsSync(projectsDir)) {
        const projectsContent = buildProjectsIndexContent(projectStats);
        const projectsFolderNote = getProjectsFolderNotePath(vaultPath);
        fs.writeFileSync(projectsFolderNote, projectsContent, 'utf-8');
        changedPaths.push(projectsFolderNote);
      }
    } catch (error) {
      logToFile('WARN', 'Failed to rebuild global index', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config?.navigation?.enableGlobalLog !== false && options.appendLog !== false) {
    try {
      const globalLogPath = path.join(vaultPath, 'log.md');
      const entry = buildGlobalLogEntry(project, event);
      if (fs.existsSync(globalLogPath)) {
        let existing = fs.readFileSync(globalLogPath, 'utf-8');
        if (!existing.includes('`[!!scroll-text]`')) {
          existing = migrateGlobalLogContent(existing);
        }
        fs.writeFileSync(globalLogPath, appendToLogContent(existing, entry), 'utf-8');
      } else {
        fs.writeFileSync(globalLogPath, buildInitialGlobalLogContent(entry), 'utf-8');
      }
      changedPaths.push(globalLogPath);
    } catch (error) {
      logToFile('WARN', 'Failed to append global log', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config?.navigation?.enableReviewMoc !== false) {
    try {
      const content = buildReviewContent(getFleetingNotes());
      const reviewPath = path.join(vaultPath, 'review.md');
      fs.writeFileSync(reviewPath, content, 'utf-8');
      changedPaths.push(reviewPath);
    } catch (error) {
      logToFile('WARN', 'Failed to rebuild review MOC', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config?.navigation?.enableGlobalIndex !== false) {
    try {
      const unscopedNotes = getGeneralGlobalNotes();
      const personalizationNotes = getApplicablePersonalizations();
      const generalDir = path.join(vaultPath, 'general');
      if (unscopedNotes.length > 0) {
        const content = buildGeneralIndexContent(unscopedNotes);
        if (!fs.existsSync(generalDir)) fs.mkdirSync(generalDir, { recursive: true });
        const generalFolderNote = getGeneralFolderNotePath(vaultPath);
        fs.writeFileSync(generalFolderNote, content, 'utf-8');
        changedPaths.push(generalFolderNote);
        const legacyGeneralIndex = path.join(generalDir, 'index.md');
        if (fs.existsSync(legacyGeneralIndex)) {
          fs.unlinkSync(legacyGeneralIndex);
          changedPaths.push(legacyGeneralIndex);
        }

        const notesByKindDir = new Map<string, { kind: string; notes: NoteMetadata[] }>();
        for (const note of unscopedNotes) {
          const kind = note.kind;
          const dirName = KIND_DIR_MAP[kind] || `${kind}s`;
          const bucket = notesByKindDir.get(dirName);
          if (bucket) {
            bucket.notes.push(note);
          } else {
            notesByKindDir.set(dirName, { kind, notes: [note] });
          }
        }

        for (const [dirName, { kind, notes: kindNotes }] of notesByKindDir) {
          const kindDir = path.join(generalDir, dirName);
          if (!fs.existsSync(kindDir)) fs.mkdirSync(kindDir, { recursive: true });
          const kindFolderNote = getKindFolderNotePath(kindDir, dirName);
          fs.writeFileSync(kindFolderNote, buildGeneralKindIndexContent(kind, kindNotes), 'utf-8');
          changedPaths.push(kindFolderNote);
          const legacyKindIndex = path.join(kindDir, 'index.md');
          if (fs.existsSync(legacyKindIndex)) {
            fs.unlinkSync(legacyKindIndex);
            changedPaths.push(legacyKindIndex);
          }
        }

        if (fs.existsSync(generalDir)) {
          for (const entry of fs.readdirSync(generalDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const kindIndex = getKindFolderNotePath(path.join(generalDir, entry.name), entry.name);
            if (!notesByKindDir.has(entry.name) && fs.existsSync(kindIndex)) {
              fs.unlinkSync(kindIndex);
              changedPaths.push(kindIndex);
            }
            const legacyKindIndex = path.join(generalDir, entry.name, 'index.md');
            if (fs.existsSync(legacyKindIndex)) {
              fs.unlinkSync(legacyKindIndex);
              changedPaths.push(legacyKindIndex);
            }
          }
        }
      } else {
        const generalIndex = getGeneralFolderNotePath(vaultPath);
        if (fs.existsSync(generalIndex)) {
          fs.unlinkSync(generalIndex);
          changedPaths.push(generalIndex);
        }
        const legacyGeneralIndex = path.join(generalDir, 'index.md');
        if (fs.existsSync(legacyGeneralIndex)) {
          fs.unlinkSync(legacyGeneralIndex);
          changedPaths.push(legacyGeneralIndex);
        }
        if (fs.existsSync(generalDir)) {
          for (const entry of fs.readdirSync(generalDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const kindIndex = getKindFolderNotePath(path.join(generalDir, entry.name), entry.name);
            if (fs.existsSync(kindIndex)) {
              fs.unlinkSync(kindIndex);
              changedPaths.push(kindIndex);
            }
            const legacyKindIndex = path.join(generalDir, entry.name, 'index.md');
            if (fs.existsSync(legacyKindIndex)) {
              fs.unlinkSync(legacyKindIndex);
              changedPaths.push(legacyKindIndex);
            }
          }
        }
      }

      const preferencesDir = path.join(vaultPath, 'preferences');
      if (personalizationNotes.length > 0) {
        if (!fs.existsSync(preferencesDir)) fs.mkdirSync(preferencesDir, { recursive: true });
        const preferencesFolderNote = getPreferencesFolderNotePath(vaultPath);
        fs.writeFileSync(preferencesFolderNote, buildPreferencesIndexContent(personalizationNotes), 'utf-8');
        changedPaths.push(preferencesFolderNote);
        const legacyPreferencesIndex = path.join(preferencesDir, 'index.md');
        if (fs.existsSync(legacyPreferencesIndex)) {
          fs.unlinkSync(legacyPreferencesIndex);
          changedPaths.push(legacyPreferencesIndex);
        }
      } else {
        const preferencesIndex = getPreferencesFolderNotePath(vaultPath);
        if (fs.existsSync(preferencesIndex)) {
          fs.unlinkSync(preferencesIndex);
          changedPaths.push(preferencesIndex);
        }
        const legacyPreferencesIndex = path.join(preferencesDir, 'index.md');
        if (fs.existsSync(legacyPreferencesIndex)) {
          fs.unlinkSync(legacyPreferencesIndex);
          changedPaths.push(legacyPreferencesIndex);
        }
      }
    } catch (error) {
      logToFile('WARN', 'Failed to rebuild general index', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return changedPaths;
}

// ---- Handlers ----

async function persistSemanticMetadata(
  noteId: string,
  note: { title: string; summary: string; content: string },
  repo: NoteRepository,
  embeddingConfig?: EmbeddingConfig | null,
  backgroundAfterMs?: number,
  existingPromise?: Promise<EmbeddingResult | null>,
): Promise<number[] | null> {
  // Semantic metadata writes queue behind any in-flight knowledge mutation instead
  // of failing fast, so ordinary contention never discards a hash or embedding.
  const hash = computeSimHash(note.summary || note.content || note.title);
  await repo.withKnowledgeMutationLockAsync(async () => {
    repo.persistSemanticMetadataIfCurrent(noteId, note, hash);
  });
  if (!embeddingConfig) return null;

  const embeddingPromise = existingPromise ?? generateEmbedding(buildEmbeddingText(note.title, note.summary, note.content), embeddingConfig);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = backgroundAfterMs === undefined
      ? await embeddingPromise
      : await Promise.race([
        embeddingPromise,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), backgroundAfterMs); }),
      ]);
    if (result) {
      const persisted = await repo.withKnowledgeMutationLockAsync(async () =>
        repo.persistSemanticMetadataIfCurrent(noteId, note, hash, {
          values: result.embedding,
          model: result.model,
        }));
      return persisted ? result.embedding : null;
    }
    if (backgroundAfterMs !== undefined) {
      void embeddingPromise.then(async slowResult => {
        if (slowResult) {
          await repo.withKnowledgeMutationLockAsync(async () => {
            repo.persistSemanticMetadataIfCurrent(noteId, note, hash, {
              values: slowResult.embedding,
              model: slowResult.model,
            });
          });
        }
      }).catch(error => {
        logToFile('WARN', 'Background embedding generation failed', {
          noteId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    logToFile('WARN', 'Embedding generation failed', {
      noteId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  return null;
}

export function buildStoreEmbeddingText(title: string, summary: string, content: string): string {
  return buildEmbeddingText(title, summary, stripGeneratedRelatedSection(content));
}

export async function handleStore(args: StoreArgs, repo: NoteRepository, embeddingConfig?: EmbeddingConfig | null, config?: AppConfig, gitVersioning?: GitVersioning | null, lockedContext?: KnowledgeMutationContext, internal?: { embeddingPromise?: Promise<EmbeddingResult | null>; suppressTelemetry?: boolean }): Promise<string> {
  const project = validateCurrentProject(args.project);
  if (!project) {
    return 'Error: A valid project is required for routine knowledge storage.';
  }
  const recordStoreOutcome = (outcome: 'preview' | 'collision-review' | 'create' | 'update' | 'skip' | 'stale' | 'reconciliation') => {
    if (!internal?.suppressTelemetry) {
      scheduleTelemetryWrite('store', () => repo.recordToolInvocation('store', `${args.kind}:${outcome}`, outcome === 'create' || outcome === 'update' ? 1 : 0, args.model));
    }
  };
  const suppliedTags = args.tags || [];
  const projectTags = suppliedTags.filter(tag => tag.startsWith('project:'));
  if (suppliedTags.includes('scope:global')) {
    return 'Error: Routine storage cannot create global knowledge. Global creation requires maintenance publication.';
  }
  if (projectTags.length > 1 || projectTags.some(tag => tag !== `project:${project}`)) {
    return `Error: Tags must contain at most the current project tag project:${project}.`;
  }

  // Updates are read first, so omitted optional metadata means "preserve" rather
  // than silently applying create defaults. This read is query-only; the locked
  // read below remains authoritative for optimistic concurrency.
  const visibility = { project, client: args.client || undefined };
  const preflightSnapshot = repo.getScreeningSnapshot(visibility);
  const preflightScreeningNote = args.disposition === 'update' && args.noteId
    ? preflightSnapshot.notes.find(note => note.id === args.noteId)
    : undefined;
  const preflightTarget = preflightScreeningNote
    ? repo.getByIdVisible(preflightScreeningNote.id, visibility)
    : null;
  if (args.disposition === 'update' && !preflightTarget) {
    return 'Error: Update target is not active and visible.';
  }
  const updateKind = preflightTarget ? preflightTarget.kind : args.kind;
  const updateStatus = preflightTarget && args.status === undefined ? preflightTarget.status : undefined;
  const updateLifecycle = preflightTarget && args.lifecycle === undefined ? preflightTarget.lifecycle : undefined;
  const effectiveStatus = updateStatus || toNoteStatus(args.status, KIND_DEFAULT_STATUS[updateKind]);
  const lifecycleDefaults = config?.lifecycleDefaults;
  const kindDefault = (lifecycleDefaults?.defaultForKind?.[args.kind] as Lifecycle | undefined) || KIND_DEFAULT_LIFECYCLE[args.kind];
  const lifecycleExplicit = typeof args.lifecycle === 'string' && VALID_LIFECYCLES.has(args.lifecycle);
  let effectiveLifecycle = updateLifecycle || toLifecycle(args.lifecycle, kindDefault);
  if (!preflightTarget && !lifecycleExplicit && lifecycleDefaults?.detectSnapshotFromSlug !== false && /\d{4}-\d{2}-\d{2}/.test(args.title)) {
    effectiveLifecycle = 'snapshot';
  }
  const tags = preflightTarget && args.tags === undefined
    ? [...preflightTarget.tags]
    : suppliedTags.filter(tag => !tag.startsWith('project:'));
  if (!tags.some(tag => tag === `project:${project}`)) tags.push(`project:${project}`);

  if (preflightTarget && preflightTarget.kind !== args.kind) {
    return 'Error: Reviewed update cannot change note kind.';
  }

  if (STRUCTURAL_KINDS.has(args.kind)) {
    return `Error: ${args.kind} notes are auto-generated per project. Use knowledge-context to view them.`;
  }

  if (args.kind === 'domain' && !preflightTarget) {
    if (!project) {
      return 'Error: Domain notes require a project parameter. A domain note is a project operating manual — it must be scoped to a specific project.';
    }
    const existingDomain = repo.getDomainNote(project);
    if (existingDomain) {
      return `A domain note already exists for project "${project}" [${existingDomain.id}]: "${existingDomain.title}". Update the existing note instead of creating a duplicate.`;
    }
  }

  // Client tag — explicit or auto-detected from content/guidance
  const resolvedClient = args.client || (preflightTarget
    ? preflightTarget.tags.find(tag => tag.startsWith('client:'))?.slice(7)
    : detectClient(args.content, args.guidance));
  if (resolvedClient && !(preflightTarget && args.tags === undefined)) {
    const tag = clientTag(resolvedClient);
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  // Omitted `related` preserves only the marked system-generated relations of the
  // stored target (or of the submitted content on create). Generic note links are
  // never promoted into the managed Related section.
  const explicitRelated = args.related !== undefined;
  const effectiveRelated = [...new Set(args.related
    ?? (preflightTarget
      ? repo.getGeneratedRelatedIds(preflightTarget.id)
      : extractGeneratedRelatedIds(args.content)))];
  const content = stripGeneratedRelatedSection(args.content);
  if (explicitRelated) {
    const hiddenId = effectiveRelated.find(id => !repo.getByIdVisible(id, { project, client: resolvedClient || undefined }));
    if (hiddenId) return `Error: Related note not found or not visible: ${hiddenId}`;
  }

  const titleCheck = titleWarning(args.title);
  if (titleCheck && 'error' in titleCheck) {
    return titleCheck.error;
  }

  const candidateEmbeddingPromise = internal?.embeddingPromise ?? (embeddingConfig
    ? generateEmbedding(buildStoreEmbeddingText(args.title, args.summary, content), embeddingConfig)
    : undefined);
  let previewEmbedding: EmbeddingResult | null = null;
  if (candidateEmbeddingPromise) {
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      previewEmbedding = await Promise.race([
        candidateEmbeddingPromise.catch(error => {
          logToFile('WARN', 'Preview embedding generation failed', { error: error instanceof Error ? error.message : String(error) }, config);
          return null;
        }),
        new Promise<null>(resolve => { previewTimer = setTimeout(() => resolve(null), 500); }),
      ]);
    } finally {
      if (previewTimer) clearTimeout(previewTimer);
    }
  }

  const screeningCandidate: ScreeningCandidate = {
    title: args.title,
    content: args.content,
    summary: args.summary,
    guidance: args.guidance,
    kind: updateKind,
    status: effectiveStatus,
    lifecycle: effectiveLifecycle,
    tags,
    related: effectiveRelated,
    embedding: previewEmbedding?.embedding,
    embeddingModel: previewEmbedding?.model,
  };
  const reviewedVisibility = { project, client: resolvedClient || undefined };
  const configVersion = 'reviewed-storage-v1';
  const screen = (snapshot: ReturnType<NoteRepository['getScreeningSnapshot']>) => {
    const evaluation = evaluateScreeningCandidate(screeningCandidate, snapshot);
    const tokens = reviewedOperationTokens({
      candidate: screeningCandidate,
      evaluation,
      snapshotVersion: snapshot.schemaVersion,
      configVersion,
      targetId: preflightTarget?.id,
      updateCandidate: (candidate, match) => {
        const note = snapshot.notes.find(item => item.id === match.id);
        return note ? reviewedUpdateCandidate(candidate, note, {
          tags: args.tags === undefined,
          related: false,
        }) : candidate;
      },
    });
    return { snapshot, evaluation, tokens };
  };
  // The preflight snapshot already reflects the reviewed visibility unless the
  // resolved client differs from the supplied one, so it is reused for the
  // initial evaluation. Only the locked re-evaluation refreshes the snapshot.
  const initialSnapshot = reviewedVisibility.client === visibility.client
    ? preflightSnapshot
    : repo.getScreeningSnapshot(reviewedVisibility);
  const initial = screen(initialSnapshot);
  const collisions = initial.evaluation.matches.filter(match => match.highConfidence);
  const previewResult = (review = initial) => {
    const targetId = preflightTarget?.id;
    const evidenceMatches = [...review.evaluation.matches].sort(targetFirstComparator(targetId));
    return JSON.stringify({
      mutated: false,
      state: review.evaluation.matches.some(match => match.highConfidence) ? 'review-required' : 'preview',
      evidence: { ...review.evaluation, digest: screeningEvidenceDigest(review.evaluation), matches: evidenceMatches.slice(0, 20) },
      createToken: review.tokens.createToken,
      updateTokens: review.tokens.updateTokens.slice(0, 20),
      validDispositions: ['create', ...(review.tokens.updateTokens.length > 0 ? ['update'] : []), 'skip'],
    });
  };
  if (args.disposition === 'skip') {
    recordStoreOutcome('skip');
    return JSON.stringify({ mutated: false, state: 'skipped' });
  }
  if (args.dryRun || (collisions.length > 0 && !args.disposition)) {
    recordStoreOutcome(collisions.length > 0 ? 'collision-review' : 'preview');
    return previewResult();
  }
  if (args.disposition && args.disposition !== 'create' && args.disposition !== 'update') return 'Error: Invalid reviewed disposition.';
  if (args.disposition === 'create' && (!args.confirm || !args.token)) return 'Error: Reviewed create requires confirm and token.';
  if (args.disposition === 'update' && (!args.confirm || !args.token || !args.noteId || args.expectedUpdatedAt === undefined)) {
    return 'Error: Reviewed update requires noteId, expectedUpdatedAt, confirm, and token.';
  }

  let result: StoreResult | null = null;
  let lockedPreview: string | null = null;
  const applyWithContext = (context: KnowledgeMutationContext): StoreResult | null => {
      const currentSnapshot = context.getScreeningSnapshot(reviewedVisibility);
      const currentReview = screen(currentSnapshot);
      const currentEvaluation = currentReview.evaluation;
      const currentTargetFacts = args.noteId
        ? currentSnapshot.notes.find(note => note.id === args.noteId)
        : undefined;
      if (!args.disposition && currentEvaluation.matches.some(match => match.highConfidence)) {
        lockedPreview = previewResult(currentReview);
        return null;
      }
      if (args.disposition === 'create') {
        const expected = reviewedOperationToken({ candidate: screeningCandidate, evaluation: currentEvaluation, operation: 'create', snapshotVersion: currentSnapshot.schemaVersion, configVersion });
        if (args.token !== expected) throw new Error('Reviewed create token is stale or does not match this operation; reconcile with a fresh preview.');
      }
      let existingId: string | undefined;
      if (args.disposition === 'update') {
        if (!args.noteId) throw new Error('Reviewed update target is required.');
        const target = repo.getByIdVisible(args.noteId, reviewedVisibility);
        if (!target) throw new Error('Update target is not active and visible.');
        if (target.status === 'archived' || target.lifecycle === 'snapshot') throw new Error('Update target lifecycle is immutable.');
        if (target.updated_at !== args.expectedUpdatedAt) throw new Error('Update target version is stale.');
        const targetScope = parseKnowledgeApplicability(target.tags);
        const candidateScope = parseKnowledgeApplicability(tags);
        const protectedTags = (values: string[]) => values
          .filter(tag => tag.startsWith('project:') || tag.startsWith('client:') || tag === 'scope:global')
          .sort();
        if (JSON.stringify(targetScope) !== JSON.stringify(candidateScope)
          || JSON.stringify(protectedTags(target.tags)) !== JSON.stringify(protectedTags(tags))
          || target.kind !== updateKind || target.status !== effectiveStatus || target.lifecycle !== effectiveLifecycle) {
          throw new Error('Update cannot change kind, status, lifecycle, project, or client applicability.');
        }
        if (explicitRelated) {
          for (const relatedId of effectiveRelated) {
            if (!repo.getByIdVisible(relatedId, reviewedVisibility)) throw new Error(`Related note ${relatedId} is not active and visible.`);
          }
        }
        if (target.lifecycle === 'append-only') {
          const oldContent = stripGeneratedRelatedSection(target.content);
          const newContent = stripGeneratedRelatedSection(args.content);
          const targetGeneratedRelated = [...new Set(repo.getGeneratedRelatedIds(target.id))].sort();
          const sameMetadata = target.title === args.title && (target.summary || '') === args.summary && (target.guidance || '') === args.guidance
            && JSON.stringify([...target.tags].sort()) === JSON.stringify([...tags].sort())
            && JSON.stringify(targetGeneratedRelated) === JSON.stringify([...effectiveRelated].sort());
          if (!sameMetadata || newContent.length <= oldContent.length || !newContent.startsWith(oldContent)) throw new Error('Append-only update must be an exact metadata-preserving content extension.');
        }
        if (!currentTargetFacts) throw new Error('Current reviewed update target is unavailable.');
        const updateCandidate = reviewedUpdateCandidate(screeningCandidate, currentTargetFacts, {
          tags: args.tags === undefined,
          related: false,
        });
        const expected = reviewedOperationToken({ candidate: updateCandidate, evaluation: currentEvaluation, operation: 'update', target: { id: target.id, updatedAt: target.updated_at }, snapshotVersion: currentSnapshot.schemaVersion, configVersion });
        if (args.token !== expected) throw new Error('Reviewed update token is stale or bound to another target; reconcile with a fresh preview.');
        existingId = target.id;
      }
      return context.store(content, { title: args.title, kind: updateKind, status: effectiveStatus, lifecycle: effectiveLifecycle, tags, summary: args.summary, guidance: args.guidance, existingId, related: effectiveRelated });
  };
  try {
    result = lockedContext
      ? applyWithContext(lockedContext)
      : await repo.withKnowledgeMutationLockAsync(async context => applyWithContext(context));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordStoreOutcome(message.includes('stale') ? 'stale' : 'reconciliation');
    return `Error: ${message}`;
  }
  if (!result) {
    recordStoreOutcome(lockedPreview ? 'collision-review' : 'reconciliation');
    return lockedPreview ?? 'Error: Reviewed store did not produce a result.';
  }

  recordStoreOutcome(result.action === 'updated' ? 'update' : 'create');

  // Race embedding generation against 500ms timeout for related notes search.
  // If timeout wins, the embedding still persists in the background (no data loss).
  const noteEmbedding = await persistSemanticMetadata(result.id, {
    title: args.title,
    summary: args.summary,
    content,
  }, repo, embeddingConfig, 500, candidateEmbeddingPromise);

  const relatedConfig = config?.store?.relatedNotes;
  const relatedEnabled = relatedConfig?.enabled !== false;
  const maxResults = relatedConfig?.maxResults ?? 5;
  const minSimilarity = relatedConfig?.minSimilarity ?? 0.70;
  const excludeKinds = new Set<string>(relatedConfig?.excludeKinds ?? ['domain', 'index', 'log']);

  let relatedNotes: RelatedNote[] = [];

  if (relatedEnabled) {
    const isCandidate = (n: { id: string; kind: string; status?: string }) =>
      n.id !== result.id && !excludeKinds.has(n.kind) && n.status !== 'archived';

    const fetchLimit = maxResults * 3 + excludeKinds.size;

    try {
      if (noteEmbedding) {
        // Embedding-based similarity search
        const vecResults = repo.searchVector(noteEmbedding, { limit: fetchLimit, visibility: { project, client: resolvedClient || undefined } });
        relatedNotes = vecResults
          .filter(n => isCandidate(n) && n.similarity >= minSimilarity)
          .slice(0, maxResults)
          .map(n => ({ id: n.id, title: n.title, kind: n.kind, similarity: n.similarity, created_at: n.created_at, last_accessed_at: n.last_accessed_at }));
      } else {
        // FTS5 fallback — use title + summary as query
        const queryText = [args.title, args.summary].filter(Boolean).join(' ');
        if (queryText.trim()) {
          const ftsResults = repo.search(queryText, { limit: fetchLimit, visibility: { project, client: resolvedClient || undefined } });
          relatedNotes = ftsResults
            .filter(n => isCandidate(n))
            .slice(0, maxResults)
            .map(n => ({ id: n.id, title: n.title, kind: n.kind, created_at: n.created_at, last_accessed_at: n.last_accessed_at }));
        }
      }
    } catch (error) {
      logToFile('WARN', 'Related notes lookup failed', {
        noteId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const verb = result.action === 'created' ? 'Stored' : result.action.charAt(0).toUpperCase() + result.action.slice(1);
  let output = `${verb} ${args.kind}: "${args.title}" → ${result.id}`;

  if (titleCheck && 'warning' in titleCheck) {
    output += titleCheck.warning;
  }

  const wordCount = countWords(args.content);
  const warning = atomicityWarning(args.kind, wordCount);
  if (warning) {
    output += warning;
  }

  if (CONFORMANCE_KINDS.has(args.kind)) {
    const categories = getExpectedCategories(args.kind);
    if (categories) {
      const strippedContent = stripExamplesBlock(args.content);
      const actualHeaders = extractHeaders(strippedContent);
      const matched = matchCategories(categories, actualHeaders);
      const totalCategories = Object.keys(categories).length;
      const coverage = totalCategories > 0 ? matched.size / totalCategories : 1;
      const hintTriggered = coverage < 0.5;

      scheduleTelemetryWrite('conformance', () => repo.recordConformance({
        noteId: result.id,
        kind: args.kind,
        action: result.action,
        model: args.model ?? null,
        coverage,
        matchedCategories: [...matched],
        missingCategories: Object.keys(categories).filter(c => !matched.has(c)),
        hintTriggered,
      }));

      if (actualHeaders.length === 0) {
        output += `\n\nℹ Conformance: 0% (0/${totalCategories} categories matched, no headings found).`;
      } else if (hintTriggered) {
        const missing = Object.keys(categories).filter(c => !matched.has(c));
        output += `\n\nℹ Conformance: ${(coverage * 100).toFixed(0)}% (${matched.size}/${totalCategories} categories matched). Missing: ${missing.join(', ')}.`;
      }
    }
  }

  if (relatedNotes.length > 0) {
    output += '\n\nRelated notes:';
    for (const rn of relatedNotes) {
      const sim = rn.similarity != null ? `, similarity: ${rn.similarity.toFixed(2)}` : '';
      const staleness = computeStaleness(rn);
      output += `\n- [${rn.id}] "${rn.title}" (${rn.kind}${sim}, ${staleness} days old)`;
    }
  }

  if (args.client && !isKnownClient(args.client)) {
    output += `\n\n⚠ Unrecognized client "${args.client}". Known clients: opencode, claude-code, cursor, windsurf, zed.`;
  }

  const tier = classifyModel(args.model);
  if (!args.model) {
    output += MODEL_HINT;
  } else if (tier === 'high') {
    output += `\n\nCapability: ${tier}`;
  }

  const effectiveProject = project || extractProjectFromTags(tags);
  const changedPaths = [result.path];
  const updated = result.action === 'updated';
  if (effectiveProject) {
    changedPaths.push(...updateProjectNavigation(effectiveProject, `${updated ? 'Updated' : 'Created'} ${args.kind}: "${args.title}"`, repo, config));
  }
  changedPaths.push(...updateGlobalNavigation(effectiveProject || null, `${updated ? 'Updated' : 'Stored'} ${args.kind}: "${args.title}"`, repo, config));
  if (gitVersioning) {
    gitVersioning.recordOp({
      op: result.action === 'updated' ? 'update' : 'store',
      noteId: result.id,
      title: args.title,
      kind: args.kind,
      project: effectiveProject || undefined,
    }, changedPaths);
  }
  return output;
}

export function handleSearch(args: SearchArgs, repo: NoteRepository, queryEmbedding?: number[] | null, config?: AppConfig): string {
  if (args.mode === 'compact' && args.limit !== undefined
    && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10)) {
    return 'Error: compact search limit must be an integer from 1 to 10.';
  }
  const requestedLimit = args.mode === 'compact' ? (args.limit ?? 5) : (args.limit || 10);
  const excludeStructuralKinds = config?.search?.excludeLogFromSearch !== false && !STRUCTURAL_KINDS.has(args.kind as string);
  const project = validateCurrentProject(args.project);
  if (!project) return 'Error: A valid project is required for knowledge search.';
  const searchLimit = excludeStructuralKinds ? Math.min(requestedLimit * 10, 100) : requestedLimit;
  let results = repo.searchHybrid(args.query, queryEmbedding || null, {
    kind: args.kind,
    status: args.status ? toNoteStatus(args.status, 'fleeting') : undefined,
    tags: args.tags,
    limit: searchLimit,
    visibility: { project, client: args.client },
  });

  if (excludeStructuralKinds) {
    results = results.filter(note => !STRUCTURAL_KINDS.has(note.kind));
  }

  if (args.lifecycle) {
    const lifecycleFilter = args.lifecycle;
    results = results.filter(note => note.lifecycle === lifecycleFilter);
  }

  if (args.client) {
    const clientFilter = args.client;
    results = results.filter(note => {
      const tags = Array.isArray(note.tags) ? note.tags : [];
      return isVisibleToClient(tags, clientFilter);
    });
  }

  const clientWarning = args.client && !isKnownClient(args.client)
    ? `\n⚠ Unrecognized client "${args.client}". Known clients: opencode, claude-code, cursor, windsurf, zed.\n`
    : '';

  // Always-include domain note for project-scoped searches
  let domainNote: NoteMetadata | null = null;
  const requestedStatus = args.status ? toNoteStatus(args.status, 'fleeting') : undefined;
  if (args.project && config?.search?.alwaysIncludeDomainNote !== false &&
      (!requestedStatus || requestedStatus === 'permanent')) {
    const domainCandidate = repo.getDomainNote(project);
    domainNote = domainCandidate
      ? repo.getByIdVisible(domainCandidate.id, { project, client: args.client })
      : null;
    if (domainNote) {
      const domainId = domainNote.id;
      results = results.filter(r => r.id !== domainId);
    }
  }

  const availableCount = results.length + (domainNote ? 1 : 0);
  if (args.mode === 'compact') {
    const reservedResultLimit = Math.max(0, requestedLimit - (domainNote ? 1 : 0));
    if (results.length > reservedResultLimit) results = results.slice(0, reservedResultLimit);
  } else if (results.length > requestedLimit) {
    results = results.slice(0, requestedLimit);
  }

  const accessedIds = [...(domainNote ? [domainNote.id] : []), ...results.map(note => note.id)];
  scheduleTelemetryWrite('search invocation', () => repo.recordToolInvocation('search', undefined, accessedIds.length, args.model));

  scheduleTelemetryWrite('search access update', () => repo.updateLastAccessed(accessedIds));

  if (results.length === 0 && !domainNote) {
    // Compact callers parse JSON, so the empty result stays structured.
    if (args.mode === 'compact') return compactSearchPayload([], availableCount, project, args, clientWarning);
    return 'No matching notes found. Try broader keywords or remove filters.' + clientWarning;
  }

  const totalCount = results.length + (domainNote ? 1 : 0);
  if (args.mode === 'compact') {
    return compactSearchPayload([...(domainNote ? [domainNote] : []), ...results], availableCount, project, args, clientWarning);
  }

  let output = `Found ${totalCount} note(s):\n\n`;

  if (domainNote) {
    output += renderNoteForSearch(domainNote, project) + '\n';
  }

  for (const note of results) {
    output += renderNoteForSearch(note, project) + '\n';
  }
  return output + clientWarning;
}

/** Compact mode is machine-read, so warnings stay inside the JSON payload. */
function compactSearchPayload(notes: NoteMetadata[], availableCount: number, project: string, args: SearchArgs, clientWarning: string): string {
  const compactNotes = notes.map(note => ({
    identity: { id: note.id, title: note.title },
    scope: parseKnowledgeApplicability(note.tags),
    kind: note.kind,
    status: note.status,
    lifecycle: note.lifecycle,
    ...compactSearchField('summary', note.summary || note.title),
    ...compactSearchField('guidance', note.guidance || ''),
    get: {
      tool: 'knowledge-get',
      noteId: note.id,
      project,
      ...(args.client ? { client: args.client } : {}),
    },
  }));
  return JSON.stringify({
    mode: 'compact',
    count: compactNotes.length,
    availableCount,
    truncated: compactNotes.length < availableCount,
    results: compactNotes,
    warnings: clientWarning ? [clientWarning.trim()] : [],
  }, null, 2);
}

function compactSearchField(name: 'summary' | 'guidance', value: string): Record<string, string | boolean> {
  const normalized = normalizeAndTruncate(value);
  return {
    [name]: normalized.value ?? '',
    [`${name}Truncated`]: normalized.truncated,
  };
}

async function backfillEmbeddings(
  repo: NoteRepository,
  embeddingConfig: EmbeddingConfig,
  limit: number = 999999,
  timeoutMs: number = 120000,
): Promise<{ requested: number; stored: number }> {
  const notesWithout = repo.getNotesWithoutEmbeddings(limit);
  if (notesWithout.length === 0) return { requested: 0, stored: 0 };

  const texts = notesWithout.map(n => buildEmbeddingText(n.title, n.summary || '', n.content));
  const noteIds = notesWithout.map(n => n.id);

  let stored = 0;
  for (let start = 0; start < texts.length; start += EMBEDDING_BACKFILL_BATCH_SIZE) {
    const batchTexts = texts.slice(start, start + EMBEDDING_BACKFILL_BATCH_SIZE);
    const results = await generateEmbeddingBatch(batchTexts, embeddingConfig, timeoutMs);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result) {
        repo.storeEmbedding(noteIds[start + i], result.embedding, result.model);
        stored++;
      }
    }
  }
  logToFile('INFO', 'Embedding backfill completed', { requested: notesWithout.length, stored });
  return { requested: notesWithout.length, stored };
}

const PUBLISHABLE_KIND_SET = new Set<NoteKind>(PUBLISHABLE_KINDS);

function resolvedPublishTags(candidate: PublishGlobalCandidate): string[] {
  const tags = [...new Set([...(candidate.tags || []), 'scope:global'])];
  const detectedClient = detectClient(
    [candidate.title, candidate.content, candidate.summary, candidate.guidance].join('\n'),
    '',
  );
  if (detectedClient) {
    const detectedTag = clientTag(detectedClient);
    if (!tags.includes(detectedTag)) tags.push(detectedTag);
  }
  return tags;
}

function canonicalPublishCandidate(candidate: PublishGlobalCandidate): string {
  return JSON.stringify({
    title: candidate.title.trim(),
    content: candidate.content.trim(),
    kind: candidate.kind,
    summary: candidate.summary.trim(),
    guidance: candidate.guidance.trim(),
    tags: [...new Set(candidate.tags || [])].sort(),
  });
}

function publicationToken(source: NoteMetadata, candidate: PublishGlobalCandidate): string {
  const persistedSourceHash = createHash('sha256').update(fs.readFileSync(source.path)).digest('hex');
  return createHash('sha256')
    .update(JSON.stringify({ sourceId: source.id, persistedSourceHash, candidate: canonicalPublishCandidate(candidate), scope: 'global' }))
    .digest('hex');
}

function projectAssignmentToken(note: NoteMetadata, project: string): string {
  // Assignment rewrites the note file after moving it. Bind confirmation to its
  // persisted bytes as well as the index so an out-of-band edit cannot be lost.
  const persistedNoteHash = createHash('sha256').update(fs.readFileSync(note.path)).digest('hex');
  return createHash('sha256')
    .update(JSON.stringify({ noteId: note.id, noteUpdatedAt: note.updated_at, currentTags: [...note.tags].sort(), persistedNoteHash, project }))
    .digest('hex');
}

function escapeReferenceRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globalReferenceEvidence(candidate: PublishGlobalCandidate, repo: NoteRepository, allowGlobalTag = false): {
  projectReferences: string[];
  outboundLinks: string[];
} {
  const projectReferences: string[] = [];
  const outboundLinks: string[] = [];
  const fields = ['title', 'content', 'summary', 'guidance'] as const;
  const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER);
  const scopedNotes = allNotes.map(note => ({ note, applicability: parseKnowledgeApplicability(note.tags) }));
  const localNotes = scopedNotes
    .filter(item => item.applicability.type === 'project-local')
    .map(item => item.note);
  const nonGlobalNotes = scopedNotes.filter(item => item.applicability.type !== 'global');
  const registeredNames = new Set(repo.getAllProjects());
  for (const note of localNotes) {
    if (note.kind === 'index') registeredNames.add(note.title);
  }
  const values: Array<[string, string]> = fields.map(field => [field, candidate[field] || '']);
  values.push(['tags', (candidate.tags || []).join('\n')]);
  for (const [field, value] of values) {
    for (const name of [...registeredNames].sort()) {
      const match = value.match(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeReferenceRegex(name)}(?=$|[^\\p{L}\\p{N}])`, 'iu'));
      if (match) projectReferences.push(`${field}:project-name:${name}`);
    }
    const projectPath = value.match(/(?:^|\b|[\\/])projects[\\/][^\s\]|)]+/iu);
    if (projectPath) projectReferences.push(`${field}:project-path:${projectPath[0].trim().replace(/^[/\\]/, '')}`);
    for (const { note, applicability } of nonGlobalNotes) {
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeReferenceRegex(note.id)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(value)) {
        projectReferences.push(`${field}:${applicability.type === 'project-local' ? 'local' : 'unclassified'}-id:${note.id}`);
      }
      if (applicability.type === 'project-local') {
        const slug = path.basename(note.path, '.md').replace(`${note.id}-`, '');
        if (slug && new RegExp(`\\[\\[[^\\]]*${escapeReferenceRegex(slug)}(?:\\||\\]\\])`, 'iu').test(value)) {
          projectReferences.push(`${field}:local-wikilink:${slug}`);
        }
      }
    }
  }
  for (const tag of candidate.tags || []) {
    const allowedGlobalTag = allowGlobalTag && tag === 'scope:global';
    if (!allowedGlobalTag && (tag.startsWith('project:') || tag.startsWith('scope:'))) {
      projectReferences.push(`tag:${tag}`);
    }
  }
  for (const field of fields) {
    for (const link of extractWikiLinks(candidate[field] || '')) {
      const targetId = repo.resolveLink(link.slug);
      const prefix = field === 'content' ? '' : `${field}:`;
      if (!targetId) outboundLinks.push(`${prefix}unresolved:[[${link.slug}]]`);
      else {
        const target = repo.getById(targetId);
        const targetScope = target?.status === 'archived'
          ? 'archived'
          : target ? parseKnowledgeApplicability(target.tags).type : 'missing';
        outboundLinks.push(`${prefix}${targetScope === 'global' ? 'global' : targetScope}:[[${link.slug}]]->${targetId}`);
      }
    }
  }
  return { projectReferences: [...new Set(projectReferences)].sort(), outboundLinks: [...new Set(outboundLinks)].sort() };
}

function isGlobalOutboundEvidence(evidence: string): boolean {
  return /^(?:(?:title|summary|guidance):)?global:/.test(evidence);
}

function isUnresolvedOutboundEvidence(evidence: string): boolean {
  return /^(?:(?:title|summary|guidance):)?unresolved:/.test(evidence);
}

function publicationValidation(source: NoteMetadata | null, candidate: PublishGlobalCandidate | undefined, repo: NoteRepository): {
  errors: string[];
  duplicates: string[];
  projectReferences: string[];
  outboundLinks: string[];
} {
  const errors: string[] = [];
  const duplicates: string[] = [];
  const projectReferences: string[] = [];
  const outboundLinks: string[] = [];
  if (!source) errors.push('source: not found');
  else {
    const scope = parseKnowledgeApplicability(source.tags);
    if (source.status === 'archived') errors.push('source: must be active');
    if (scope.type !== 'project-local') errors.push('source: must have exactly one project scope');
  }
  if (!candidate) {
    errors.push('candidate: required');
    return { errors, duplicates, projectReferences, outboundLinks };
  }
  for (const field of ['title', 'content', 'summary', 'guidance'] as const) {
    if (!candidate[field]?.trim()) errors.push(`candidate.${field}: required`);
  }
  if (!PUBLISHABLE_KIND_SET.has(candidate.kind)) errors.push('candidate.kind: must be non-domain and non-structural');
  const referenceEvidence = globalReferenceEvidence(candidate, repo);
  projectReferences.push(...referenceEvidence.projectReferences);
  outboundLinks.push(...referenceEvidence.outboundLinks);
  if ((candidate.tags || []).some(tag => tag === 'scope:global' || tag.startsWith('project:') || tag.startsWith('scope:'))) {
    errors.push('candidate.tags: project and scope tags are server-managed');
  }
  if (projectReferences.length > 0) errors.push('candidate: contains project-specific evidence');

  const canonical = canonicalPublishCandidate(candidate);
  for (const note of repo.getAllGlobalNotes(Number.MAX_SAFE_INTEGER)) {
    const noteCanonical = canonicalPublishCandidate({
      title: note.title,
      content: note.content,
      kind: note.kind,
      summary: note.summary || '',
      guidance: note.guidance || '',
      tags: note.tags.filter(tag => tag !== 'scope:global'),
    });
    if (noteCanonical === canonical || note.title.trim().toLowerCase() === candidate.title.trim().toLowerCase()) {
      duplicates.push(`${note.id}:${note.title}`);
    }
  }
  for (const evidence of outboundLinks) {
    if (isUnresolvedOutboundEvidence(evidence)) errors.push(`candidate: ${evidence}`);
    else if (!isGlobalOutboundEvidence(evidence)) errors.push(`candidate: outbound target is not active global (${evidence})`);
  }
  return { errors: [...new Set(errors)], duplicates, projectReferences, outboundLinks };
}

async function handleMaintainCore(args: MaintainArgs, repo: NoteRepository, config: AppConfig, embeddingConfig?: EmbeddingConfig | null, currentVersion?: string, gitVersioning?: GitVersioning | null, nowProvider: () => number = Date.now, suppressTelemetry = false): Promise<string> {
  switch (args.action) {
    case 'project-authority-review': {
      const project = validateCurrentProject(args.project);
      if (!project) return 'Error: a valid project is required for project-authority-review action.';
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
      const now = nowProvider();
      const notes = repo.getRecentNotes(Number.MAX_SAFE_INTEGER, { project })
        .filter(note => {
          const scope = parseKnowledgeApplicability(note.tags);
          return scope.type === 'project-local' && scope.project === project && note.status !== 'archived' && !STRUCTURAL_KINDS.has(note.kind);
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      const findings = notes.slice(0, limit).map(note => ({
        identity: { id: note.id, title: note.title },
        kind: note.kind,
        ...compactSearchField('summary', note.summary || ''),
        status: note.status,
        lifecycle: note.lifecycle,
        scope: parseKnowledgeApplicability(note.tags),
        ageDays: Math.max(0, Math.floor((now - note.updated_at) / 86_400_000)),
      }));
      return JSON.stringify({ action: 'project-authority-review', mutated: false, project, scanned: notes.length, returned: findings.length, truncated: findings.length < notes.length, findings }, null, 2);
    }
    case 'scope-inventory': {
      const notes = repo.getAll(Number.MAX_SAFE_INTEGER)
        .filter(note => note.status !== 'archived' && !STRUCTURAL_KINDS.has(note.kind))
        .map(note => ({ note, applicability: parseKnowledgeApplicability(note.tags || []) }))
        .filter((item): item is typeof item & { applicability: { type: 'unclassified'; reason: 'missing' | 'multiple-projects' | 'conflict' } } => item.applicability.type === 'unclassified')
        .sort((a, b) => a.note.id.localeCompare(b.note.id));
      const groups: Record<string, unknown[]> = {};
      for (const { note, applicability } of notes) {
        const relativePath = path.relative(config.vault, note.path).split(path.sep).join('/');
        const pathProject = relativePath.match(/^projects\/([^/]+)\//)?.[1];
        const tagProjects = [...new Set(note.tags.filter(tag => tag.startsWith('project:')).map(tag => tag.slice(8)).filter(Boolean))].sort();
        const key = `${applicability.reason}|${note.kind}|${relativePath}|${note.status}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push({ id: note.id, title: note.title, evidence: { tagProjects, pathProject: pathProject || null } });
      }
      return JSON.stringify({
        action: 'scope-inventory', mutated: false,
        strictVisibility: { active: true, mode: 'fail-closed', unclassifiedExcluded: true },
        counts: { activeUnclassified: notes.length, ready: notes.length === 0 }, groups,
      }, null, 2);
    }
    case 'assign-project': {
      if (!args.noteId) return 'Error: noteId is required for assign-project action.';
      const targetProject = validateCurrentProject(args.project);
      if (!targetProject) return 'Error: a valid project is required for assign-project action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      const applicability = parseKnowledgeApplicability(note.tags || []);
      if (note.status === 'archived' || STRUCTURAL_KINDS.has(note.kind) || applicability.type !== 'unclassified') {
        return 'Error: assign-project accepts only active unclassified non-structural notes.';
      }
      const tags = [...note.tags.filter(tag => !tag.startsWith('project:') && !tag.startsWith('scope:')), `project:${targetProject}`];
      const token = projectAssignmentToken(note, targetProject);
      const preview = { action: 'assign-project', noteId: note.id, project: targetProject, removedScopeTags: note.tags.filter(tag => tag.startsWith('project:') || tag.startsWith('scope:')), tags };
      if (args.dryRun !== false) return JSON.stringify({ ...preview, mode: 'preview', mutated: false, confirmationToken: token }, null, 2);
      if (!args.confirm) return 'Error: confirm=true is required to apply assign-project.';
      if (!args.token) return 'Error: confirmation token is required to apply assign-project.';
      if (args.token !== token) return 'Error: confirmation token is stale or does not match the note and target project.';
      const moved = repo.assignProject(note.id, targetProject, tags);
      if (!moved) return `Error: project assignment failed for note ${args.noteId}; the note was not changed.`;
      const changedPaths = [...new Set([moved.oldPath, moved.newPath, ...updateProjectNavigation(targetProject, `Assigned "${note.title}" to project ${targetProject}`, repo, config), ...updateGlobalNavigation(targetProject, `Assigned "${note.title}" to project ${targetProject}`, repo, config)])];
      logToFile('INFO', 'Assigned legacy note to project', { noteId: note.id, project: targetProject });
      if (gitVersioning) await gitVersioning.recordImmediate({ op: 'assign-project', noteId: note.id, title: note.title, kind: note.kind, project: targetProject }, changedPaths);
      return JSON.stringify({ ...preview, mode: 'apply', mutated: true, oldPath: moved.oldPath, path: moved.newPath }, null, 2);
    }
    case 'global-reference-audit': {
      const notes = repo.getAllGlobalNotes(Number.MAX_SAFE_INTEGER).sort((a, b) => a.id.localeCompare(b.id));
      const findings = notes.map(note => {
        const evidence = globalReferenceEvidence({
          title: note.title, content: note.content, kind: note.kind,
          summary: note.summary || '', guidance: note.guidance || '', tags: note.tags,
        }, repo, true);
        return { id: note.id, title: note.title, ...evidence };
      }).filter(item => item.projectReferences.length > 0 || item.outboundLinks.some(link => !isGlobalOutboundEvidence(link)));
      return JSON.stringify({ action: 'global-reference-audit', mutated: false, scanned: notes.length, findings }, null, 2);
    }
    case 'publish-global': {
      if (!args.noteId) return 'Error: noteId is required for publish-global action.';
      const previewSource = repo.getById(args.noteId);
      const evidence = publicationValidation(previewSource, args.candidate, repo);
      const isPreview = args.dryRun !== false;
      if (!previewSource || !args.candidate) {
        return JSON.stringify({ action: 'publish-global', mode: isPreview ? 'preview' : 'apply', valid: false, ...evidence }, null, 2);
      }
      const candidate = args.candidate;
      const valid = evidence.errors.length === 0 && evidence.duplicates.length === 0;
      if (isPreview) {
        const token = publicationToken(previewSource, candidate);
        const preview = { action: 'publish-global', mode: 'preview', valid, source: { id: previewSource.id, updated_at: previewSource.updated_at }, targetScope: 'global', targetTags: resolvedPublishTags(candidate), candidateHash: createHash('sha256').update(canonicalPublishCandidate(candidate)).digest('hex'), ...evidence };
        return JSON.stringify(valid ? { ...preview, confirmationToken: token } : preview, null, 2);
      }
      if (!args.confirm) return 'Error: confirm=true is required to apply publish-global.';
      if (!args.token) return 'Error: confirmation token is required to apply publish-global.';
      const noteId = args.noteId;
      const suppliedToken = args.token;
      // One lease covers the fresh source lookup, revalidation, token check, the
      // derivative write, the source relation edit, and rollback, so a concurrent
      // mutation cannot invalidate the publication between validation and write.
      // Embeddings, navigation, and git run afterwards without the lock.
      const application = await repo.withKnowledgeMutationLockAsync(async (): Promise<{ error: string } | { source: NoteMetadata; derivative: StoreResult }> => {
        const source = repo.getById(noteId);
        const freshEvidence = publicationValidation(source, candidate, repo);
        if (!source) {
          return { error: JSON.stringify({ action: 'publish-global', mode: 'apply', valid: false, ...freshEvidence }, null, 2) };
        }
        if (suppliedToken !== publicationToken(source, candidate)) {
          return { error: 'Error: confirmation token is stale or does not match the source and canonical candidate.' };
        }
        if (freshEvidence.errors.length > 0 || freshEvidence.duplicates.length > 0) {
          return { error: JSON.stringify({ action: 'publish-global', mode: 'apply', valid: false, ...freshEvidence }, null, 2) };
        }
        const created = repo.store(candidate.content.trim(), {
          title: candidate.title.trim(),
          kind: candidate.kind,
          status: 'permanent',
          lifecycle: KIND_DEFAULT_LIFECYCLE[candidate.kind],
          tags: resolvedPublishTags(candidate),
          summary: candidate.summary.trim(),
          guidance: candidate.guidance.trim(),
        });
        try {
          repo.addLocalToGlobalRelation(source.id, created.id);
        } catch (error) {
          repo.remove(created.id);
          return { error: `Error: Failed to link the local source to its global derivative; publication was rolled back (${error instanceof Error ? error.message : String(error)}).` };
        }
        return { source, derivative: created };
      });
      if ('error' in application) return application.error;
      const { source, derivative } = application;
      await persistSemanticMetadata(derivative.id, {
        title: candidate.title.trim(),
        summary: candidate.summary.trim(),
        content: candidate.content.trim(),
      }, repo, embeddingConfig, EMBEDDING_FOREGROUND_TIMEOUT_MS);
      const projectScope = parseKnowledgeApplicability(source.tags);
      const changedPaths = [source.path, derivative.path];
      if (projectScope.type === 'project-local') {
        changedPaths.push(...updateProjectNavigation(projectScope.project, `Published global derivative "${candidate.title.trim()}" from "${source.title}"`, repo, config));
      }
      changedPaths.push(...updateGlobalNavigation(null, `Published global note "${candidate.title.trim()}"`, repo, config, { appendLog: false }));
      logToFile('INFO', 'Published global derivative', { sourceId: source.id, derivativeId: derivative.id });
      if (gitVersioning) {
        await gitVersioning.recordImmediate({ op: 'publish-global', noteId: source.id, title: candidate.title.trim(), kind: candidate.kind, project: projectScope.type === 'project-local' ? projectScope.project : undefined }, changedPaths);
      }
      return JSON.stringify({ action: 'publish-global', mode: 'apply', created: derivative.id, source: source.id, relation: `${source.id}->${derivative.id}` }, null, 2);
    }
    case 'promote': {
      if (!args.noteId) return 'Error: noteId is required for promote action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      repo.promoteToPermanent(args.noteId);
      const changedPaths = [note.path];
      const project = extractProjectFromTags(Array.isArray(note.tags) ? note.tags : []);
      if (!STRUCTURAL_KINDS.has(note.kind)) {
        if (project) {
          changedPaths.push(...updateProjectNavigation(project, `Promoted "${note.title}" from fleeting to permanent`, repo, config));
        }
        changedPaths.push(...updateGlobalNavigation(project, `Promoted "${note.title}"`, repo, config));
      }
      if (gitVersioning) {
        await gitVersioning.recordImmediate({ op: 'promote', noteId: note.id, title: note.title, kind: note.kind, project: project || undefined }, changedPaths);
      }
      return `Promoted "${note.title}" (${args.noteId}) to permanent status.`;
    }
    case 'archive': {
      if (!args.noteId) return 'Error: noteId is required for archive action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      repo.archive(args.noteId);
      const changedPaths = [note.path];
      const project = extractProjectFromTags(Array.isArray(note.tags) ? note.tags : []);
      if (!STRUCTURAL_KINDS.has(note.kind)) {
        if (project) {
          changedPaths.push(...updateProjectNavigation(project, `Archived "${note.title}"`, repo, config));
        }
        changedPaths.push(...updateGlobalNavigation(project, `Archived "${note.title}"`, repo, config));
      }
      if (gitVersioning) {
        await gitVersioning.recordImmediate({ op: 'archive', noteId: note.id, title: note.title, kind: note.kind, project: project || undefined }, changedPaths);
      }
      return `Archived "${note.title}" (${args.noteId}).`;
    }
    case 'delete': {
      if (!args.noteId) return 'Error: noteId is required for delete action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      if (gitVersioning) {
        await gitVersioning.preCommit(`Pre-delete snapshot: "${note.title}"`, []);
      }
      repo.remove(args.noteId);
      const changedPaths = [note.path];
      const project = extractProjectFromTags(Array.isArray(note.tags) ? note.tags : []);
      if (!STRUCTURAL_KINDS.has(note.kind)) {
        if (project) {
          changedPaths.push(...updateProjectNavigation(project, `Deleted "${note.title}"`, repo, config));
        }
        changedPaths.push(...updateGlobalNavigation(project, `Deleted "${note.title}"`, repo, config));
      }
      if (gitVersioning) {
        await gitVersioning.recordImmediate({ op: 'delete', noteId: note.id, title: note.title, kind: note.kind, project: project || undefined }, changedPaths);
      }
      return `Deleted "${note.title}" (${args.noteId}).`;
    }
    case 'rebuild': {
      if (gitVersioning) await gitVersioning.checkpoint('Pre-rebuild snapshot', []);
      const result = repo.rebuildFromFiles();
      let output = `Indexed ${result.indexed} notes, ${result.errors} errors\nRebuild complete.`;
      const projects = repo.getAllProjects();
      const changedPaths: string[] = [];
      for (const project of projects) {
        changedPaths.push(...rebuildProjectIndex(project, repo, config));
        changedPaths.push(...appendProjectLog(project, 'Full DB rebuild', repo, config));
      }
      changedPaths.push(...updateGlobalNavigation(null, 'Full DB rebuild', repo, config));
      output += `\nRebuilt index for ${projects.length} project(s).`;
      if (embeddingConfig) {
        try {
          const embResult = await backfillEmbeddings(repo, embeddingConfig);
          if (embResult.requested > 0) {
            output += `\nEmbeddings: backfilled ${embResult.stored}/${embResult.requested} notes.`;
          }
        } catch (err) {
          output += `\nEmbedding backfill failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (gitVersioning) await gitVersioning.checkpoint(`Full DB rebuild (${result.indexed} indexed)`, changedPaths);
      return output;
    }
    case 'format': {
      const formattedPaths = repo.getAll(Number.MAX_SAFE_INTEGER)
        .filter(note => note.kind !== 'index' && fs.existsSync(note.path))
        .map(note => note.path);
      const result = repo.formatAllFiles();
      const projects = repo.getAllProjects();
      const changedPaths = [...formattedPaths];
      for (const proj of projects) {
        changedPaths.push(...rebuildProjectIndex(proj, repo, config));
      }
      changedPaths.push(...updateGlobalNavigation(null, 'Format all files', repo, config));
      if (gitVersioning) await gitVersioning.checkpoint(`Format ${result.formatted} notes`, changedPaths);
      return `Formatted ${result.formatted} note files (${result.skipped} skipped, ${result.errors} errors).\nRegenerated navigation for ${projects.length} project(s).`;
    }
    case 'upgrade': {
      const pending = getPendingMigrations(repo);
      if (pending.length === 0) {
        const status = repo.getUpgradeStatus();
        if (status.needsSummary === 0 && status.needsGuidance === 0) {
          return 'All notes have summary and guidance fields. No upgrade needed.';
        }
      }
      let output = '## Upgrade Status\n\n';
      const status = repo.getUpgradeStatus();
      output += `${status.needsSummary} of ${status.total} notes are missing summary fields.\n`;
      output += `${status.needsGuidance} of ${status.total} notes are missing guidance fields.\n`;
      if (pending.length > 0) {
        output += '\n## Pending Migrations\n';
        for (const m of pending) {
          output += `- **${m.id}** (v${m.version}): ${m.description} — ${m.pending} pending [${m.status}]\n`;
        }
      }
      return output;
    }
    case 'upgrade-vault': {
      const manifest = await ensureObsidianScaffold(config.vault, config.obsidian);
      if (!manifest) {
        return 'Obsidian scaffold is disabled in config.';
      }

      const status = getObsidianScaffoldStatus(config.vault, config.obsidian);
      let output = '## Obsidian Vault Upgrade\n\n';
      output += `Scaffold version: ${status.scaffoldVersion} (latest: ${status.latestVersion})\n`;
      output += `Theme: ${status.theme ? `${status.theme.name} ${status.theme.version}` : 'not installed'}\n`;
      output += `Plugins: ${status.pluginsInstalled}/${status.pluginsExpected} installed\n`;
      output += `Auto-upgrade: ${status.autoUpgrade ? 'enabled' : 'disabled'}\n`;
      output += `Read-only: ${status.readOnly ? 'enabled' : 'disabled'}\n`;
      return output;
    }
    case 'upgrade-read': {
      const migrationId = args.noteId; // reuse noteId field for migration ID
      if (!migrationId) return 'Error: noteId (migration ID) is required for upgrade-read action.';
      const migration = getMigrationById(migrationId);
      if (!migration) return `Unknown migration: ${migrationId}`;
      const notes = migration.detect(repo);
      if (notes.length === 0) return 'No pending notes for this migration.';
      let output = `## Migration: ${migration.id}\n\n`;
      output += `${migration.instructions}\n\n`;
      output += `### Pending Notes (${notes.length})\n\n`;
      for (const note of notes.slice(0, 10)) {
        output += `<note id="${note.id}" title="${note.title}" kind="${note.kind}">\n`;
        for (const field of migration.readFields) {
          const value = note[field as keyof typeof note];
          if (value) output += `  <${field}>${value}</${field}>\n`;
        }
        output += `</note>\n\n`;
      }
      if (notes.length > 10) {
        output += `... and ${notes.length - 10} more. Use offset/limit to paginate.\n`;
      }
      return output;
    }
    case 'upgrade-apply': {
      // This action expects noteId and fields passed through args
      // In practice the agent calls this per-note
      if (!args.noteId) return 'Error: noteId is required for upgrade-apply action.';
      return `Use knowledge-store with existingId to update note ${args.noteId}.`;
    }
    case 'review': {
      const daysThreshold = args.days || config.lifecycle.reviewAfterDays;
      const limit = args.limit || 3;
      const archiveDays = Math.max(1, config.lifecycle.autoArchiveFleetingDays);
      const now = nowProvider();
      const scope: ReviewScope = { kind: 'full' };
      const snapshot = buildReviewSnapshot(createRepositoryReviewReader(repo), scope, now);
      const factsById = new Map(snapshot.map(fact => [fact.note.id, fact] as const));
      const lifecycleEvaluation = evaluateReview({
        scope,
        profile: 'lifecycle',
        now,
        policy: {
          reviewAfterDays: daysThreshold,
          archiveAfterDays: archiveDays,
          promotionThreshold: config.lifecycle.promotionThreshold,
          exemptKinds: config.lifecycle.exemptKinds,
        },
      }, snapshot);
      const contentEvaluation = evaluateReview({ scope, profile: 'content', now }, snapshot);
      const reviewDue = lifecycleEvaluation.groups.find(group => group.ruleId === 'lifecycle.review-due')?.findings ?? [];
      const staleForArchive = lifecycleEvaluation.groups.find(group => group.ruleId === 'lifecycle.stale-fleeting')?.findings ?? [];
      const fleetingAll = args.filter === 'permanent'
        ? []
        : reviewDue.filter(finding => factsById.get(finding.primary.id)?.note.status === 'fleeting');
      const permanentAll = args.filter === 'fleeting'
        ? []
        : reviewDue.filter(finding => factsById.get(finding.primary.id)?.note.status === 'permanent');
      const limitQueue = (findings: readonly Finding[]): readonly Finding[] => limit < 0 ? findings : findings.slice(0, limit);
      const candidates = [...limitQueue(fleetingAll), ...limitQueue(permanentAll)];
      const totalCandidates = fleetingAll.length + permanentAll.length;
      const hasCandidates = totalCandidates > 0;

      if (!hasCandidates && staleForArchive.length === 0) {
        return 'No notes pending review. All notes are up to date!';
      }

      let output = '';

      if (hasCandidates) {
        const candidateIds = new Set(candidates.map(finding => finding.primary.id));
        output += `## Review Candidates (${candidates.length} of ${totalCandidates})\n\n`;

        for (let i = 0; i < candidates.length; i++) {
          const finding = candidates[i];
          const fact = factsById.get(finding.primary.id);
          if (!fact) continue;
          const note = fact.note;
          const guide = KIND_WORD_GUIDELINES[note.kind];
          const wordSignal = guide && fact.contentWords > guide.warn
            ? `${fact.contentWords} (oversized, target: ~${guide.target})`
            : `${fact.contentWords}`;
          const backlinkSignal = fact.backlinks === 0 ? '0 (unlinked)' : `${fact.backlinks}`;
          const resolution = finding.resolutions?.[0];

          output += `### [${i + 1}] "${note.title}" (${note.id})\n`;
          output += `kind: ${note.kind} | status: ${note.status} | staleness: ${fact.staleDays} days\n`;
          output += `Accesses: ${note.access_count} | Backlinks: ${backlinkSignal} | Words: ${wordSignal}\n`;
          const hasSummary = Boolean(note.summary?.trim());
          const hasGuidance = Boolean(note.guidance?.trim());
          const fieldBudget = hasSummary && hasGuidance
            ? Math.floor(REVIEW_EVIDENCE_MAX_CHARS / 2)
            : REVIEW_EVIDENCE_MAX_CHARS;
          const summary = boundedReviewEvidence(note.summary, fieldBudget);
          const guidance = boundedReviewEvidence(note.guidance, fieldBudget);
          if (summary) output += `Summary: ${summary}\n`;
          if (guidance) output += `Guidance: ${guidance}\n`;
          if (!summary && !guidance) {
            output += `Evidence: ${boundedReviewEvidence(note.content) ?? '(no textual evidence)'}\n`;
          }
          if (resolution) output += `⮕ Suggested: ${resolution.label} — ${resolution.rationale}\n\n`;
        }

        const oversized = (contentEvaluation.groups.find(group => group.ruleId === 'content.oversized')?.findings ?? [])
          .filter(finding => !candidateIds.has(finding.primary.id));
        const displayedOversized = limitQueue(oversized);
        if (oversized.length > 0) {
          output += `### Oversized Notes (showing ${displayedOversized.length} of ${oversized.length})\n`;
          for (const finding of displayedOversized) {
            const fact = factsById.get(finding.primary.id);
            if (!fact) continue;
            output += `- "${boundedReviewEvidence(fact.note.title)}" (${fact.note.kind}) — ${fact.contentWords} words (target: ~${fact.wordGuidance.target}) [${fact.note.id}] — Evidence: ${boundedReviewEvidence(fact.note.summary) ?? boundedReviewEvidence(fact.note.content) ?? '(no textual evidence)'}\n`;
          }
          output += '\n';
        }

        const longTitles = (contentEvaluation.groups.find(group => group.ruleId === 'title.too-long')?.findings ?? [])
          .filter(finding => !candidateIds.has(finding.primary.id));
        const displayedLongTitles = limitQueue(longTitles);
        if (longTitles.length > 0) {
          output += `### Long Titles (showing ${displayedLongTitles.length} of ${longTitles.length}; exceed ${TITLE_SOFT_WARN_WORDS}-word target)\n`;
          for (const finding of displayedLongTitles) {
            const fact = factsById.get(finding.primary.id);
            if (!fact) continue;
            output += `- "${boundedReviewEvidence(fact.note.title)}" (${fact.note.kind}) — ${fact.titleWords} words [${fact.note.id}] — Evidence: ${boundedReviewEvidence(fact.note.summary) ?? boundedReviewEvidence(fact.note.content) ?? '(no textual evidence)'}\n`;
          }
          output += '\n';
        }

        const remaining = Math.max(0, totalCandidates - candidates.length);
        if (remaining > 0) {
          output += `Remaining: ${remaining} more candidates (increase limit to see more)\n\n`;
        }
      }

      if (staleForArchive.length > 0) {
        const displayedStale = limitQueue(staleForArchive);
        output += `### Stale Fleeting Notes (showing ${displayedStale.length} of ${staleForArchive.length}; older than ${archiveDays} days)\n`;
        output += 'These fleeting notes were never promoted. Consider archiving:\n\n';
        for (const finding of displayedStale) {
          const fact = factsById.get(finding.primary.id);
          if (!fact) continue;
          const evidence = boundedReviewEvidence(fact.note.summary)
            ?? boundedReviewEvidence(fact.note.guidance)
            ?? boundedReviewEvidence(fact.note.content)
            ?? '(no textual evidence)';
          output += `- "${fact.note.title}" (${fact.note.kind}) — ${fact.staleDays} days old [${fact.note.id}] — Evidence: ${evidence}\n`;
        }
        output += '\n';
      }

      output += '---\n';
      output += 'Actions: `knowledge-maintain promote/archive/delete` with noteId=<id>\n';
      return output;
    }
    case 'dedupe': {
      const evaluation = evaluateDuplicates(repo.getDuplicateAuditSnapshot());
      const { coverage } = evaluation;
      let output = '## Duplicate Detection\n\n';
      output += `Coverage: eligible=${coverage.eligible} | hashed-at-start=${coverage.hashedAtStart} | computed-ephemerally=${coverage.computedEphemerally} | evaluated=${coverage.evaluated} | omitted=${coverage.omitted} | status=${coverage.complete ? 'complete' : 'incomplete'}\n`;
      if (coverage.omitted > 0) output += `Omission reasons: ${JSON.stringify(coverage.omissionReasons)}\n`;
      output += `Groups: exact-title=${evaluation.titleGroups.length} | SimHash=${evaluation.simhashGroups.length} (complete totals)\n\n`;

      if (evaluation.titleGroups.length === 0 && evaluation.simhashGroups.length === 0) {
        return `${output}No duplicate notes found.`;
      }

      if (evaluation.titleGroups.length > 0) {
        output += `### Title-Based Duplicates (${evaluation.titleGroups.length} groups)\n\n`;
        for (const [index, group] of evaluation.titleGroups.slice(0, 10).entries()) {
          output += `**Group ${index + 1}: normalized title "${group.normalizedTitle}" (${group.notes.length} notes)**\n`;
          for (const note of group.notes) {
            const protectedStatus = note.status === 'permanent' ? ' | ⦸ permanent - protected' : '';
            output += `- ${note.id} | "${note.title}" | ${note.status}${protectedStatus}\n`;
          }
          output += '\n';
        }
        if (evaluation.titleGroups.length > 10) output += `... and ${evaluation.titleGroups.length - 10} more groups.\n\n`;
      }

      if (evaluation.simhashGroups.length > 0) {
        output += `### Content-Based Near-Duplicates (${evaluation.simhashGroups.length} groups; SimHash threshold ≤ ${evaluation.threshold})\n\n`;
        for (const [index, group] of evaluation.simhashGroups.slice(0, 10).entries()) {
          output += `**Group ${index + 1}: seed ${group.seedId} (${group.notes.length} notes)**\n`;
          for (const note of group.notes) {
            const evidence = group.evidence.find(item => item.noteId === note.id);
            const distance = evidence ? ` | distance-from-seed=${evidence.distanceFromSeed}` : ' | seed';
            const protectedStatus = note.status === 'permanent' ? ' | ⦸ permanent - protected' : '';
            output += `- ${note.id} | "${note.title}" | ${note.status}${distance}${protectedStatus}\n`;
          }
          output += '\n';
        }
        if (evaluation.simhashGroups.length > 10) output += `... and ${evaluation.simhashGroups.length - 10} more groups.\n\n`;
      }

      output += 'Findings are similarity evidence for review, not confirmed semantic duplicates.\n';
      output += 'Actions remain explicit: `knowledge-maintain archive/delete` with noteId=<id>.\n';
      output += '⚠ Permanent notes (⦸) are never auto-archived.\n';
      return output;
    }
    case 'embed': {
      if (!embeddingConfig) {
        return 'Embedding not configured. Add provider + embeddings section to config.yaml to enable vector search.';
      }

      const limit = args.limit ?? 999999;
      const pending = repo.getNotesWithoutEmbeddings(limit);
      if (pending.length === 0) {
        return 'All notes already have embeddings. Nothing to backfill.';
      }

      if (args.dryRun) {
        return `Dry run: Would generate embeddings for ${pending.length} notes using ${embeddingConfig.model}.`;
      }

      try {
        const embResult = await backfillEmbeddings(repo, embeddingConfig, limit);
        const remaining = repo.getEmbeddingStats().withoutEmbedding;
        const suffix = remaining > 0 ? ` (${remaining} still pending)` : '';
        return `Embedded ${embResult.stored}/${embResult.requested} notes using ${embeddingConfig.model}.${suffix}`;
      } catch (err) {
        return `Embedding failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case 'agent-docs': {
      const dryRun = args.dryRun !== false;
      const targets = getAgentDocsTargets();
      let output = '## Agent Docs Maintenance\n\n';
      output += dryRun
        ? 'Dry run only. No files were modified.\n\n'
        : 'Repaired eligible agent docs files while preserving non-marker content.\n\n';

      for (const target of targets) {
        const inspection = inspectAgentDocs(target.filePath);
        output += `### ${target.name}\n`;
        output += `- Path: ${target.filePath}\n`;
        output += `- Status: ${describeAgentDocsStatus(inspection.status)}\n`;

        if (!inspection.exists) {
          output += '- Result: file not found\n\n';
          continue;
        }

        if (inspection.status === 'healthy') {
          if (dryRun) {
            output += '- Result: would refresh managed instructions to current template\n\n';
          } else {
            const result = injectAgentDocs(target.filePath, target.instructionSize, false, target.client, currentVersion, target.preamble);
            output += `- Result: ${result.action}\n\n`;
          }
          continue;
        }

        if (inspection.status === 'multiple-markers') {
          if (dryRun) {
            output += '- Result: would strip all duplicate markers and inject a single fresh block\n\n';
          } else {
            const result = injectAgentDocs(target.filePath, target.instructionSize, false, target.client, currentVersion, target.preamble);
            output += `- Result: ${result.action} (repaired duplicate markers)\n\n`;
          }
          continue;
        }

        if (dryRun) {
          output += '- Result: would repair markers and append a fresh managed block while preserving other content\n\n';
        } else {
          const result = injectAgentDocs(target.filePath, target.instructionSize, false, target.client, currentVersion, target.preamble);
          output += `- Result: ${result.action}\n\n`;
        }
      }

      // Clean up legacy file paths
      for (const target of targets) {
        if (!target.legacyFilePath || target.legacyFilePath === target.filePath) continue;
        // Skip symlinked legacy paths to avoid modifying shared files (mirrors install/doctor guard)
        try { if (fs.lstatSync(target.legacyFilePath).isSymbolicLink()) continue; } catch { /* doesn't exist */ }
        const legacyInspection = inspectAgentDocs(target.legacyFilePath);
        if (legacyInspection.exists && legacyInspection.status !== 'missing') {
          if (dryRun) {
            output += `### ${target.name} (legacy cleanup)\n`;
            output += `- Path: ${target.legacyFilePath}\n`;
            output += `- Result: would remove stale managed block\n\n`;
          } else {
            const result = removeAgentDocs(target.legacyFilePath);
            output += `### ${target.name} (legacy cleanup)\n`;
            output += `- Path: ${target.legacyFilePath}\n`;
            output += `- Result: ${result.action}\n\n`;
          }
        }
      }

      output += `dryRun: ${dryRun} — ${dryRun ? 'no changes applied. Set dryRun: false to apply repairs.' : 'repairs applied.'}`;
      return output;
    }
    case 'preference-audit': {
      const notes = repo.getAll(Number.MAX_SAFE_INTEGER)
        .filter(note => note.kind === 'personalization' && note.status !== 'archived')
        .sort((a, b) => a.id.localeCompare(b.id));

      const scope: ReviewScope = { kind: 'full' };
      const now = nowProvider();
      const snapshot = buildReviewSnapshot(createRepositoryReviewReader(repo), scope, now);
      const evaluation = evaluateReview({ scope, profile: 'preference', now }, snapshot);
      const findingsByNote = new Map<string, Finding[]>();
      for (const group of evaluation.groups) {
        for (const finding of group.findings) {
          const bucket = findingsByNote.get(finding.primary.id) ?? [];
          bucket.push(finding);
          findingsByNote.set(finding.primary.id, bucket);
        }
      }
      const findings = notes
        .map(note => ({
          note,
          signals: (findingsByNote.get(note.id) ?? []).map(finding => ({
            type: finding.ruleId.replace(/^preference\./, ''),
            evidence: finding.evidence.map(entry => String(entry.value)),
          })),
        }))
        .filter(finding => finding.signals.length > 0);

      let output = '## Preference Audit (Read-only)\n\n';
      output += `Active personalization notes scanned: ${notes.length}\n`;
      output += 'Mutation: none\n';
      if (findings.length === 0) {
        return output + '\nNo preference quality signals found.';
      }

      output += `Notes with deterministic signals: ${findings.length}\n`;
      for (const { note, signals } of findings) {
        output += `\n### "${note.title}" [${note.id}]\n`;
        for (const signal of signals) {
          output += `- ${signal.type}: ${signal.evidence.map(value => JSON.stringify(value)).join(', ')}\n`;
        }
      }
      return output;
    }
    case 'scope-audit': {
      const dryRun = args.dryRun !== false;
      const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER).filter(n => n.status !== 'archived');
      const misScoped: Array<{ note: NoteMetadata; detected: string }> = [];
      const perClient = new Map<string, number>();
      let universalCount = 0;

      for (const note of allNotes) {
        const tags = Array.isArray(note.tags) ? note.tags : [];
        const currentClients = getClientTags(tags);
        const detected = detectClient(note.content, note.guidance || '');

        if (currentClients.length === 0 && !detected) {
          universalCount++;
        } else if (currentClients.length > 0) {
          for (const c of currentClients) {
            perClient.set(c, (perClient.get(c) || 0) + 1);
          }
        }

        if (detected && currentClients.length === 0) {
          misScoped.push({ note, detected });
        }
      }

      let output = '## Scope Audit\n\n';
      output += `Total non-archived notes: ${allNotes.length}\n`;
      output += `Universal (no client tag): ${universalCount}\n`;
      if (perClient.size > 0) {
        output += '\nPer-client:\n';
        for (const [client, count] of [...perClient.entries()].sort()) {
          const marker = isKnownClient(client) ? '' : ' ⚠ unrecognized';
          output += `- ${clientTag(client)}: ${count}${marker}\n`;
        }
      }

      // Flag notes with unrecognized client tags
      const unknownClientNotes = allNotes.filter(n => {
        const clients = getClientTags(Array.isArray(n.tags) ? n.tags : []);
        return clients.some(c => !isKnownClient(c));
      });

      if (misScoped.length === 0 && unknownClientNotes.length === 0) {
        output += '\nNo mis-scoped notes found. All notes are correctly tagged.';
        return output;
      }

      output += `\n### Mis-scoped Notes (${misScoped.length})\n`;
      output += dryRun ? '*Dry run — no changes applied.*\n\n' : '';

      for (const { note, detected } of misScoped) {
        output += `- "${note.title}" [${note.id}] — detected: ${clientTag(detected)}, current: (none)\n`;

        if (!dryRun) {
          const updatedTags = [...(note.tags || []), clientTag(detected)];
          repo.updateTags(note.id, updatedTags);
        }
      }

      if (unknownClientNotes.length > 0) {
        output += `\n### Unrecognized Client Tags (${unknownClientNotes.length})\n`;
        output += 'Known clients: opencode, claude-code, cursor, windsurf, zed.\n\n';
        for (const note of unknownClientNotes) {
          const unknown = getClientTags(note.tags).filter(c => !isKnownClient(c));
          output += `- "${note.title}" [${note.id}] — unknown: ${unknown.map(c => clientTag(c)).join(', ')}\n`;
        }
      }

      if (misScoped.length > 0 && dryRun) {
        output += '\ndryRun: true — no changes applied. Set dryRun: false to fix mis-scoped notes.';
      } else if (misScoped.length > 0) {
        output += `\nFixed ${misScoped.length} mis-scoped note(s).`;
      }

      return output;
    }
    case 'unlinked': {
      const { result, elapsedMs } = runContextualLinkScan(repo, ['links.unlinked']);
      logContextualLinkScan('unlinked', result.totals, elapsedMs, config);
      if (!suppressTelemetry) {
        scheduleTelemetryWrite('maintain', () => repo.recordToolInvocation('maintain', 'unlinked', result.totals.excludedCandidates, args.model));
      }

      let output = renderContextualScanSummary(result.totals, elapsedMs);
      output += renderContextualFailures(result.failures);
      if (result.incompleteGraph) {
        output += INCOMPLETE_GRAPH_NOTICE;
        return output;
      }

      const unlinkedGroup = graphGroup(result.review, 'links.unlinked');
      const total = unlinkedGroup.total;
      if (total === 0) {
        output += '\nNo unlinked notes found. All non-archived notes have at least one incoming or outgoing wikilink.';
        return output;
      }

      // Formal findings drive order, totals, and the display bound; the frozen
      // graph facts carry the tags/kind/title needed for project grouping.
      const unlinkedNotes: readonly GraphDocument[] = result.facts.contextualLinks?.documents ?? [];
      const factsById = new Map(unlinkedNotes.map(note => [note.id, note]));

      // Keep complete per-project counts for headings and the summary, but
      // derive membership only from formal unlinked findings. The document
      // index also contains linked notes used by the other graph rules.
      const allByProject = new Map<string, number>();
      for (const finding of unlinkedGroup.findings) {
        const note = factsById.get(finding.primary.id);
        if (!note) continue;
        const project = extractProjectFromTags([...note.tags]) || '(no project)';
        allByProject.set(project, (allByProject.get(project) ?? 0) + 1);
      }

      // Group the first N formal findings, rather than applying the cap
      // after presentation sorting, so the displayed subset follows rule order.
      const displayCap = contextualDisplayLimit(args.limit);
      const displayedFindings = unlinkedGroup.findings.slice(0, displayCap);

      // Group the selected findings by project, then by kind.
      const byProject = new Map<string, GraphDocument[]>();
      for (const finding of displayedFindings) {
        const note = factsById.get(finding.primary.id);
        if (!note) continue;
        const project = extractProjectFromTags([...note.tags]) || '(no project)';
        let group = byProject.get(project);
        if (!group) {
          group = [];
          byProject.set(project, group);
        }
        group.push(note);
      }

      const projectCount = [...allByProject.keys()].filter(k => k !== '(no project)').length;
      const unscopedCount = allByProject.get('(no project)') ?? 0;
      output += `\n## Unlinked Notes (${total})\n\n`;
      output += 'Advisory: isolated notes are linking candidates, not confirmed defects — not every note needs a backlink.\n\n';
      const summaryParts: string[] = [];
      if (projectCount > 0) summaryParts.push(`${total - unscopedCount} in ${projectCount} project${projectCount > 1 ? 's' : ''}`);
      if (unscopedCount > 0) summaryParts.push(`${unscopedCount} unscoped`);
      output += summaryParts.join(', ') + '\n\n';

      let displayed = 0;

      // Sort projects alphabetically, but put (no project) last
      const sortedProjects = [...byProject.keys()].sort((a, b) => {
        if (a === '(no project)') return 1;
        if (b === '(no project)') return -1;
        return a.localeCompare(b);
      });

      for (const project of sortedProjects) {
        if (displayed >= displayCap) break;
        const notes = byProject.get(project) ?? [];
        output += `### ${project} (${allByProject.get(project) ?? notes.length})\n`;

        // Group by kind within project
        const byKind = new Map<string, GraphDocument[]>();
        for (const note of notes) {
          let group = byKind.get(note.kind);
          if (!group) {
            group = [];
            byKind.set(note.kind, group);
          }
          group.push(note);
        }

        for (const [kind, kindNotes] of byKind) {
          if (displayed >= displayCap) break;
          output += `**${kind}**:\n`;
          for (const note of kindNotes) {
            if (displayed >= displayCap) break;
            output += `- "${note.title}" [${note.id}] | ${note.status}\n`;
            displayed++;
          }
        }
        output += '\n';
      }

      if (displayed < total) {
        output += `(showing ${displayed} of ${total} — use \`knowledge-search\` to find specific notes)\n\n`;
      }

      output += '## Next Steps\n';
      output += '[A] Add wikilinks to connect unlinked notes to related notes\n';
      output += '[B] Archive notes that are no longer relevant\n';
      return output;
    }
    case 'broken-links': {
      const { result, elapsedMs } = runContextualLinkScan(repo, ['links.broken']);
      logContextualLinkScan('broken-links', result.totals, elapsedMs, config);
      if (!suppressTelemetry) {
        scheduleTelemetryWrite('maintain', () => repo.recordToolInvocation('maintain', 'broken-links', result.totals.excludedCandidates, args.model));
      }

      const brokenGroup = graphGroup(result.review, 'links.broken');

      let output = renderContextualScanSummary(result.totals, elapsedMs);
      output += renderContextualFailures(result.failures);

      if (brokenGroup.total === 0) {
        output += result.incompleteGraph
          ? '\nNo broken wikilinks were confirmed in successfully parsed documents. Results are incomplete because some documents failed.'
          : '\nNo broken wikilinks found. All links resolve to existing notes.';
        return output;
      }

      output += `\n## Broken Wikilinks (${brokenGroup.total})\n\n`;
      output += 'Links pointing to non-existent notes:\n\n';
      output += renderContextualBrokenFindings(brokenGroup.findings, contextualDisplayLimit(args.limit));
      if (result.incompleteGraph) output += INCOMPLETE_GRAPH_NOTICE;
      output += '\n## Next Steps\n';
      output += '[A] Create the missing target notes\n';
      output += '[B] Update or remove the broken links\n';
      return output;
    }
    case 'link-health': {
      const { result, elapsedMs } = runContextualLinkScan(repo, ['links.broken', 'links.unlinked', 'links.reciprocal-missing']);
      logContextualLinkScan('link-health', result.totals, elapsedMs, config);
      if (!suppressTelemetry) {
        scheduleTelemetryWrite('maintain', () => repo.recordToolInvocation('maintain', 'link-health', result.totals.excludedCandidates, args.model));
      }

      const graph = result.review;
      const unlinkedGroup = graphGroup(graph, 'links.unlinked');
      const brokenGroup = graphGroup(graph, 'links.broken');
      const reciprocalGroup = graphGroup(graph, 'links.reciprocal-missing');

      let output = renderContextualScanSummary(result.totals, elapsedMs);
      output += renderContextualFailures(result.failures);
      if (result.incompleteGraph) {
        output += INCOMPLETE_GRAPH_NOTICE;
      }

      const total = unlinkedGroup.total + brokenGroup.total + reciprocalGroup.total;
      if (total === 0) {
        output += result.incompleteGraph
          ? '\nNo broken or one-way links were confirmed. Unlinked evaluation was suppressed because the contextual graph is incomplete.'
          : '\nLink health: all clear. No unlinked notes, broken links, or one-way links found.';
        return output;
      }

      const displayCap = contextualDisplayLimit(args.limit);
      const factsById = new Map((result.facts.contextualLinks?.documents ?? []).map(note => [note.id, note]));
      output += '\n## Link Health Report\n\n';

      if (unlinkedGroup.total > 0) {
        output += `### Unlinked Notes (${unlinkedGroup.total})\n\n`;
        output += 'Advisory: notes with no incoming or outgoing wikilinks — linking candidates, not confirmed defects:\n\n';
        let shown = 0;
        for (const finding of unlinkedGroup.findings.slice(0, displayCap)) {
          const note = factsById.get(finding.primary.id);
          if (!note) continue;
          output += `- "${note.title}" [${note.id}] | ${note.kind} | ${note.status}\n`;
          shown++;
        }
        if (unlinkedGroup.total > shown) output += `(showing ${shown} of ${unlinkedGroup.total})\n`;
        output += '\n';
      }

      if (brokenGroup.total > 0) {
        output += `### Broken Wikilinks (${brokenGroup.total})\n\n`;
        output += 'Links pointing to non-existent notes:\n\n';
        output += renderContextualBrokenFindings(brokenGroup.findings, displayCap);
        output += '\n';
      }

      if (reciprocalGroup.total > 0) {
        output += `### One-Way Links (${reciprocalGroup.total})\n\n`;
        output += 'Advisory: A links to B but B does not link back to A — reciprocity is a judgment call:\n\n';
        let shown = 0;
        for (const finding of reciprocalGroup.findings.slice(0, displayCap)) {
          const sourceTitle = findingEvidence(finding, 'sourceTitle');
          const targetTitle = findingEvidence(finding, 'targetTitle');
          const targetId = finding.related?.[0]?.id ?? '';
          output += `- "${sourceTitle}" [${finding.primary.id}] → "${targetTitle}" [${targetId}] (no reverse link)\n`;
          shown++;
        }
        if (reciprocalGroup.total > shown) output += `(showing ${shown} of ${reciprocalGroup.total})\n`;
        output += '\n';
      }

      output += '## Summary\n';
      output += `Unlinked: ${unlinkedGroup.total} | Broken: ${brokenGroup.total} | One-way: ${reciprocalGroup.total}\n`;
      return output;
    }
    case 'migrate-layout': {
      const dryRun = args.dryRun !== false;
      const commitsPaused = !dryRun && !!gitVersioning;
      if (commitsPaused && gitVersioning) {
        await gitVersioning.checkpoint('Pre-migration snapshot', []);
        gitVersioning.pauseCommits();
      }
      try {
      repo.rebuildFromFiles();
      const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER);
      let moved = 0;
      let skipped = 0;
      let errors = 0;
      const moves: Array<{ id: string; title: string; from: string; to: string }> = [];

      for (const note of allNotes) {
        try {
          const tags = Array.isArray(note.tags) ? note.tags : [];
          const project = extractProjectTag(tags);
          const slug = path.basename(note.path).replace(/\.md$/, '').replace(/^\d{12,16}-/, '');
          const targetPath = resolveNotePath(config.vault, note.kind, project, note.id, slug);

          if (note.path === targetPath) {
            skipped++;
            continue;
          }

          moves.push({
            id: note.id,
            title: note.title,
            from: path.relative(config.vault, note.path),
            to: path.relative(config.vault, targetPath),
          });

          if (!dryRun) {
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            if (!fs.existsSync(note.path)) {
              if (fs.existsSync(targetPath)) {
                repo.updatePath(note.id, targetPath);
                moved++;
                continue;
              }
              throw new Error(`Source missing: ${note.path}`);
            }
            if (fs.existsSync(targetPath)) {
              throw new Error(`Target already exists: ${targetPath}`);
            }
            fs.renameSync(note.path, targetPath);
            repo.updatePath(note.id, targetPath);
            moved++;
          }
        } catch (err) {
          errors++;
          logToFile('WARN', 'Failed to migrate note', {
            noteId: note.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      let output = `## Vault Layout Migration${dryRun ? ' (Dry Run)' : ''}\n\n`;
      output += `Total notes: ${allNotes.length}\n`;
      output += `Already in place: ${skipped}\n`;
      output += `${dryRun ? 'Would move' : 'Moved'}: ${dryRun ? moves.length : moved}\n`;
      if (errors > 0) output += `Errors: ${errors}\n`;

      if (moves.length > 0) {
        output += '\n### Moves\n';
        for (const m of moves.slice(0, 50)) {
          output += `- "${m.title}" [${m.id}]\n  ${m.from} → ${m.to}\n`;
        }
        if (moves.length > 50) {
          output += `\n...and ${moves.length - 50} more.\n`;
        }
      }

      if (dryRun && moves.length > 0) {
        output += '\ndryRun: true — no changes applied. Set dryRun: false to apply migration.';
        output += '\n\n## Impact Preview\n';
        output += '- Post-migration: full DB rebuild + project index regeneration + global navigation update\n';
        if (embeddingConfig) {
          output += '- Embeddings: will need backfill after migration (semantic search temporarily unavailable)\n';
        }
      output += `- Navigation: ${getGlobalHomeNoteBasename()}.md, log.md, review.md, and per-directory folder notes will be auto-generated\n`;
      } else if (!dryRun && moved > 0) {
        const emptyDirsRemoved = config.vault ? removeEmptyDirsRecursive(config.vault, true) : 0;
        if (emptyDirsRemoved > 0) {
          output += `Empty directories removed: ${emptyDirsRemoved}\n`;
        }

        const rebuildResult = repo.rebuildFromFiles();
        const changedPaths = moves.flatMap(move => [move.from, move.to]);
        const projects = repo.getAllProjects();
        for (const proj of projects) {
          changedPaths.push(...rebuildProjectIndex(proj, repo, config));
        }
        output += `\nPost-migration rebuild: indexed ${rebuildResult.indexed} notes, rebuilt ${projects.length} project index(es).`;
        changedPaths.push(...updateGlobalNavigation(null, 'Layout migration completed', repo, config));
        if (commitsPaused && gitVersioning) {
          gitVersioning.resumeCommits();
          await gitVersioning.checkpoint(`Layout migration (${moved} moved)`, changedPaths);
        }

        const embeddingStats = repo.getEmbeddingStats();
        const brokenLinks = filterFalsePositiveBrokenLinks(repo.getBrokenLinks(), config?.vault);
        const oneWayLinks = repo.getOneWayLinks();
        const unlinkedNotes = repo.getUnlinkedNotes();
        const linkIssues = brokenLinks.length + oneWayLinks.length + unlinkedNotes.length;

        output += '\n\n## Health Summary\n';
        if (embeddingStats.withoutEmbedding > 0) {
          output += `Embeddings: ${embeddingStats.withoutEmbedding}/${embeddingStats.total} notes need backfill (run \`knowledge-maintain embed\`)\n`;
        }
        if (linkIssues > 0) {
          const parts: string[] = [];
          if (unlinkedNotes.length > 0) parts.push(`${unlinkedNotes.length} unlinked`);
          if (brokenLinks.length > 0) parts.push(`${brokenLinks.length} broken`);
          if (oneWayLinks.length > 0) parts.push(`${oneWayLinks.length} one-way`);
          output += `Link health: ${parts.join(', ')} (run \`knowledge-maintain link-health\` for details)\n`;
        } else {
          output += 'Link health: all clear ✓\n';
        }

        output += '\n## Next Steps\n';
        if (embeddingStats.withoutEmbedding > 0) {
          output += '- Backfill embeddings: knowledge-maintain embed\n';
        }
        output += '- Check link health: knowledge-maintain link-health\n';
        output += '- View vault stats: knowledge-health\n';
      }

      return output;
      } finally {
        if (commitsPaused && gitVersioning) {
          gitVersioning.resumeCommits();
        }
      }
    }
    case 'full': {
      const steps: Array<{ action: string; label: string; stepArgs: MaintainArgs }> = [
        { action: 'rebuild', label: 'Rebuild', stepArgs: { action: 'rebuild' } },
        { action: 'migrate-layout', label: 'Migrate Layout', stepArgs: { action: 'migrate-layout', dryRun: args.dryRun ?? false } },
        { action: 'format', label: 'Format', stepArgs: { action: 'format' } },
        { action: 'dedupe', label: 'Dedupe', stepArgs: { action: 'dedupe' } },
        { action: 'embed', label: 'Embed', stepArgs: { action: 'embed', limit: 999999 } },
        { action: 'link-health', label: 'Link Health', stepArgs: { action: 'link-health' } },
      ];

      const sections: string[] = ['# Full Maintenance\n'];
      let stepNum = 1;

      for (const step of steps) {
        sections.push(`## ${stepNum}. ${step.label}\n`);
        try {
          const result = await handleMaintainCore(step.stepArgs, repo, config, embeddingConfig, currentVersion, gitVersioning, nowProvider, true);
          sections.push(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sections.push(`⚠ Failed: ${msg}`);
          logToFile('WARN', `Full maintenance step "${step.action}" failed`, { error: msg });
        }
        stepNum++;
      }

      return sections.join('\n');
    }
    default:
      return `Unknown action: ${args.action}`;
  }
}

export async function handleMaintain(args: MaintainArgs, repo: NoteRepository, config: AppConfig, embeddingConfig?: EmbeddingConfig | null, currentVersion?: string, gitVersioning?: GitVersioning | null, nowProvider: () => number = Date.now): Promise<string> {
  const result = await handleMaintainCore(args, repo, config, embeddingConfig, currentVersion, gitVersioning, nowProvider);
  const rejected = result.startsWith('Error:') || result.startsWith('Unknown action:') || result.startsWith('Failed:');
  if (!rejected && !CONTEXTUAL_LINK_ACTIONS.has(args.action)) {
    scheduleTelemetryWrite('maintain', () => repo.recordToolInvocation('maintain', args.action, undefined, args.model));
  }
  return result;
}

const CAPSULE_NOTE_LIMIT = 12;
const CAPSULE_TOKEN_LIMIT = 800;

export function buildPreferenceCapsule(
  repo: NoteRepository,
  targets: { project?: string; client?: string },
): PreferenceCapsule {
  const universal: NoteMetadata[] = [];
  const scoped: NoteMetadata[] = [];

  for (const note of repo.getPermanentPersonalizations()) {
    const applicability = parseKnowledgeApplicability(note.tags);
    const clients = note.tags.filter(tag => tag.startsWith('client:')).map(tag => tag.slice('client:'.length));
    const projectMatches = applicability.type === 'global'
      || (applicability.type === 'project-local' && applicability.project === targets.project);
    const clientMatches = clients.length === 0 || clients.includes('all') || (targets.client !== undefined && clients.includes(targets.client));
    if (!projectMatches || !clientMatches) continue;
    (applicability.type === 'global' && clients.length === 0 ? universal : scoped).push(note);
  }

  const ranked: NoteMetadata[] = [];
  const groupLength = Math.max(universal.length, scoped.length);
  for (let index = 0; index < groupLength; index++) {
    if (universal[index]) ranked.push(universal[index]);
    if (scoped[index]) ranked.push(scoped[index]);
  }

  const lines: PreferenceCapsuleLine[] = [];
  let characters = 0;
  for (const note of ranked) {
    if (lines.length >= CAPSULE_NOTE_LIMIT) break;
    const scopeTags = note.tags.filter(tag => tag.startsWith('project:') || tag.startsWith('client:'));
    const scope = scopeTags.length > 0 ? scopeTags.join(', ') : 'universal';
    const storedGuidance = note.guidance?.trim();
    const guidance = (storedGuidance || (note.summary || note.title).trim())
      .replace(/\s+/g, ' ');
    const line = `- [${scope}] ${guidance} [${note.id}]`;
    const nextCharacters = characters + line.length + (lines.length > 0 ? 1 : 0);
    // Skip an oversized preference rather than stopping selection entirely: a
    // later, more concise preference may still fit within the capsule budget.
    if (Math.ceil(nextCharacters / 4) > CAPSULE_TOKEN_LIMIT) continue;
    lines.push({ scope, guidance, id: note.id, line });
    characters = nextCharacters;
  }

  const eligible = ranked.length;
  return {
    lines,
    text: lines.map(item => item.line).join('\n'),
    eligible,
    selected: lines.length,
    omitted: eligible - lines.length,
    estimatedTokens: Math.ceil(characters / 4),
  };
}

export function handleContextResult(args: ContextArgs, repo: NoteRepository, config?: AppConfig): ContextResult {
  const project = validateCurrentProject(args.project);
  if (!project) return { text: 'Error: A valid project is required for knowledge context.' };
  if (args.preferenceOnly) {
    const preferenceCapsule = buildPreferenceCapsule(repo, { project, client: args.client });
    scheduleTelemetryWrite('context', () => repo.recordToolInvocation('context', 'preference-only', preferenceCapsule.selected, args.model));
    return { text: preferenceCapsule.text, preferenceCapsule };
  }
  const logLimit = Math.max(1, args.logEntries ?? config?.navigation?.overviewLogEntryLimit ?? 10);
  const text = formatProjectOverview(project, logLimit, repo, args.client, args.model);
  scheduleTelemetryWrite('context', () => repo.recordToolInvocation('context', undefined, undefined, args.model));

  return {
    text,
    ...(args.includePreferences
      ? { preferenceCapsule: buildPreferenceCapsule(repo, { project, client: args.client }) }
      : {}),
  };
}

export function handleContext(args: ContextArgs, repo: NoteRepository, config?: AppConfig): string {
  return handleContextResult(args, repo, config).text;
}

function formatProjectOverview(project: string, logLimit: number, repo: NoteRepository, client?: string, model?: string): string {
  const visibility = { project, client };
  const domainCandidate = repo.getDomainNote(project);
  const domainNote = domainCandidate ? repo.getByIdVisible(domainCandidate.id, visibility) : null;
  const projectNotes = repo.getRecentNotes(Number.MAX_SAFE_INTEGER, visibility)
    .filter(note => {
      const scope = parseKnowledgeApplicability(note.tags);
      return scope.type === 'project-local' && scope.project === project;
    });
  // Project logs contain titles for every client-scoped event and cannot be
  // losslessly filtered because historical entries do not carry note IDs.
  const logNote = client ? null : repo.getLogNote(project);

  if (projectNotes.length === 0 && !domainNote && !logNote) {
    return `No notes found for project "${project}". Authority context is unavailable: no exactly matching project-scoped notes were found, and no other project's context was substituted.`;
  }

  let output = `## Project Overview: ${project}\n\n`;
  output += `Authority scope: exactly project:${project}. This is retained agent memory, not current project truth; consult canonical project artifacts for authority. Other projects are excluded and are not substituted.\n\n`;

  // Domain note (operating manual)
  if (domainNote) {
    output += '### Domain\n';
    output += renderNoteForAgent(domainNote, project) + '\n\n';
    scheduleTelemetryWrite('overview access', () => repo.recordAccess(domainNote.id));
  }

  // Inventory by kind
  const kindCounts: Record<string, number> = {};
  for (const note of projectNotes) {
    kindCounts[note.kind] = (kindCounts[note.kind] || 0) + 1;
  }
  if (Object.keys(kindCounts).length > 0) {
    output += '### Inventory\n';
    const parts = Object.entries(kindCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${count} ${kind}${count > 1 ? 's' : ''}`);
    output += parts.join(', ') + '\n\n';
  }

  // Recent notes
  const recentNotes = [...projectNotes]
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, logLimit);
  if (recentNotes.length > 0) {
    output += '### Recent Notes\n';
    for (const note of recentNotes) {
      const status = note.status === 'permanent' ? '⦸' : note.status === 'archived' ? '▪' : '▫';
      output += `- ${status} **${note.title}** (${note.kind})\n`;
    }
    if (projectNotes.length > recentNotes.length) {
      output += `\n(showing ${recentNotes.length} of ${projectNotes.length})\n`;
    }
    output += '\n';
  }

  // Resources
  const resources = projectNotes.filter(n => n.kind === 'resource');
  if (resources.length > 0) {
    output += '### Resources\n';
    for (const note of resources) {
      output += `- **${note.title}** [${note.id}]\n`;
    }
    output += '\n';
  }

  // Recent activity from log note
  if (logNote) {
    output += '### Recent Activity\n';
    const content = logNote.content || '';
    const lines = content.split('\n');
    const entryLines = lines.filter(l => l.startsWith('- **'));
    const recentEntries = entryLines.slice(-logLimit);
    if (recentEntries.length > 0) {
      output += recentEntries.join('\n') + '\n';
      if (entryLines.length > logLimit) {
        output += `\n(showing ${logLimit} of ${entryLines.length} entries)\n`;
      }
    } else {
      output += '(no log entries yet)\n';
    }
  }

  if (!model) {
    output += MODEL_HINT;
  }

  return output;
}

export async function handleOpen(args: OpenArgs, config: AppConfig, repo?: NoteRepository): Promise<string> {
  const vaultPath = config.vault;

  if (!fs.existsSync(vaultPath)) {
    return `Vault directory does not exist yet: ${contractPath(vaultPath)}\nStore a note first to create the vault, then try again.`;
  }

  const detect = args._detectObsidian || detectObsidian;
  const detection = detect();

  if (!detection.installed) {
    return formatNotInstalledMessage(vaultPath);
  }

  const ensureScaffold = args._ensureScaffold || ensureObsidianScaffold;
  try {
    await ensureScaffold(vaultPath, config.obsidian);
  } catch (error) {
    logToFile('WARN', 'Failed to scaffold Obsidian vault config before launch', {
      error: error instanceof Error ? error.message : String(error),
      vaultPath,
    });
  }

  let filePath: string | undefined;
  let resolvedProject: string | undefined;
  if (args.project && repo) {
    const indexNote = repo.getIndexNote(args.project);
    if (indexNote?.path) {
      const relativePath = path.relative(vaultPath, indexNote.path).replace(/\\/g, '/');
      filePath = relativePath.replace(/\.md$/, '');
      resolvedProject = args.project;
    }
  }

  const launch = args._launchObsidian || launchObsidian;
  const error = launch(detection, vaultPath, filePath);
  if (error) {
    return `Failed to launch Obsidian: ${error}`;
  }
  if (repo) scheduleTelemetryWrite('open', () => repo.recordToolInvocation('open'));
  return `${formatSuccessMessage(vaultPath, resolvedProject)}\nObsidian is a full-vault human browsing surface; project focus does not isolate other projects.`;
}

export interface TemplateArgs {
  kind: string;
  project?: string;
  model?: string;
}

export interface GetArgs {
  noteId: string;
  project: string;
  client?: string;
  model?: string;
}

export function handleGet(args: GetArgs, repo: NoteRepository): string {
  const project = validateCurrentProject(args.project);
  if (!project) return 'Error: A valid project is required to retrieve knowledge.';
  const note = repo.getByIdVisible(args.noteId, { project, client: args.client });
  if (!note) return `Note not found: ${args.noteId}`;
  scheduleTelemetryWrite('get access', () => repo.updateLastAccessed([note.id]));
  scheduleTelemetryWrite('get', () => repo.recordToolInvocation('get', undefined, 1, args.model));

  return renderNoteForSearch(note, project);
}

export function handleTemplate(args: TemplateArgs, repo?: NoteRepository): string {
  let projectOverridePath: string | undefined;

  if (args.project && repo) {
    const domainNote = repo.getDomainNote(args.project);
    if (domainNote) {
      const vaultPath = path.dirname(domainNote.path || '');
      const overridePath = path.join(vaultPath, 'templates', `${args.kind}.md`);
      if (fs.existsSync(overridePath)) {
        projectOverridePath = overridePath;
      }
    }
  }

  if (repo) {
    scheduleTelemetryWrite('template', () => repo.recordToolInvocation('template', args.kind, undefined, args.model));

  }

  return getTemplate(args.kind, projectOverridePath);
}

type MineClassification = 'STORE' | 'SKIP' | 'REVIEW';

interface MineResult {
  index: number;
  candidateKey?: string;
  candidate: MineCandidate;
  wordCount: number;
  hash: string;
  classification: MineClassification;
  rationale: string;
  matches: Array<{ id: string; title: string; similarity?: number }>;
  storedId?: string;
  error?: string;
}

function validateMineCandidate(candidate: MineCandidate, index: number, project?: string): string | null {
  const required: Array<keyof MineCandidate> = ['title', 'content', 'kind', 'summary', 'guidance'];
  for (const field of required) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return `Candidate ${index}: missing required field "${field}".`;
    }
  }
  if (STRUCTURAL_KINDS.has(candidate.kind)) {
    return `Candidate ${index}: ${candidate.kind} notes are structural and auto-generated; they cannot be mined.`;
  }
  if (candidate.kind === 'domain' && !(candidate.project ?? project)) {
    return `Candidate ${index}: domain notes require a project parameter.`;
  }
  return null;
}

function formatMineWordCount(candidate: MineCandidate, wordCount: number): string {
  const guide = KIND_WORD_GUIDELINES[candidate.kind];
  const suffix = wordCount > guide.warn ? ` (oversized, target: ~${guide.target})` : '';
  return `${wordCount}${suffix}`;
}

function extractStoredId(result: string): string | undefined {
  // handleStore emits `... "${title}" → ${id}` where id is a 12/16-digit note id.
  // Anchor to the LAST arrow so a title containing "→ <digits>" can't be mistaken for the id.
  return /.*→\s*(\d{12,16})\b/.exec(result)?.[1] ?? /ID:\s*(\S+)/.exec(result)?.[1];
}

export async function handleMine(args: MineArgs, repo: NoteRepository, embeddingConfig?: EmbeddingConfig | null, config?: AppConfig, gitVersioning?: GitVersioning | null): Promise<string> {
  const project = validateCurrentProject(args.project);
  if (!project) return 'Error: A valid project is required for knowledge mining.';
  if (args.candidates.length === 0) {
    return 'No mining candidates provided. Extract candidate notes first, then call knowledge-mine with at least one candidate.';
  }
  if (args.candidates.length > 50) {
    return `Error: knowledge-mine accepts at most 50 candidates per batch; received ${args.candidates.length}.`;
  }

  const validationErrors: string[] = [];
  for (let i = 0; i < args.candidates.length; i++) {
    const candidate = args.candidates[i];
    const validation = validateMineCandidate(candidate, i + 1, project);
    if (validation) validationErrors.push(validation);
    const tags = candidate.tags || [];
    const projectTags = tags.filter(tag => tag.startsWith('project:'));
    if (tags.includes('scope:global')) validationErrors.push(`Candidate ${i + 1}: routine mining cannot create global knowledge.`);
    if (projectTags.length > 1 || projectTags.some(tag => tag !== `project:${project}`)) {
      validationErrors.push(`Candidate ${i + 1}: project tags conflict with project:${project}.`);
    }
    if (candidate.project !== undefined && candidate.project !== project) {
      validationErrors.push(`Candidate ${i + 1}: candidate project conflicts with project:${project}.`);
    }
  }
  if (validationErrors.length > 0) {
    return `Error: ${validationErrors.join('\n')}`;
  }

  const recordMineOutcome = (outcome: 'preview' | 'plan' | 'migration' | 'applied' | 'stale' | 'reconciliation') => {
    scheduleTelemetryWrite('mine', () => repo.recordToolInvocation('mine', outcome, args.candidates.length, args.model));
  };

  const canonicalCandidate = (candidate: MineCandidate) => ({
    title: candidate.title,
    content: candidate.content,
    kind: candidate.kind,
    summary: candidate.summary,
    guidance: candidate.guidance,
    project: candidate.project ?? null,
    tags: candidate.tags ?? null,
    source: candidate.source ?? null,
  });
  const canonicalCandidates = args.candidates.map((candidate, index) => ({ index, candidate: canonicalCandidate(candidate) }));
  const batchHash = createHash('sha256').update(JSON.stringify(canonicalCandidates)).digest('hex');
  const candidateKeys = args.candidates.map((candidate, index) => createHash('sha256').update(`${batchHash}:${index}:${JSON.stringify(canonicalCandidate(candidate))}`).digest('hex'));
  const dispositions = args.dispositions ?? [];
  const dryRun = args.dry_run ?? true;
  const embeddingTexts = args.candidates.map(candidate => buildEmbeddingText(candidate.title, candidate.summary, candidate.content));
  let embeddings: Array<EmbeddingResult | null> = args.candidates.map(() => null);
  let embeddingsAvailable = false;

  if (embeddingConfig) {
    try {
      const batchTimeout = Math.max(60000, args.candidates.length * 2000);
      const batchResults = await generateEmbeddingBatch(embeddingTexts, embeddingConfig, batchTimeout);
      embeddings = batchResults;
      embeddingsAvailable = embeddings.some(Boolean);
    } catch (error) {
      logToFile('WARN', 'Mining batch embedding failed', {
        error: error instanceof Error ? error.message : String(error),
        count: args.candidates.length,
      }, config);
    }
  }

  const hashes = args.candidates.map(candidate => computeSimHash(candidate.summary || candidate.content || candidate.title));
  const results: MineResult[] = [];

  for (let i = 0; i < args.candidates.length; i++) {
    const candidate = args.candidates[i];
    const hash = hashes[i];
    const wordCount = countWords(candidate.content);
    const priorDuplicateIndex = hashes.slice(0, i).findIndex(priorHash => isNearDuplicate(hash, priorHash));

    if (priorDuplicateIndex >= 0) {
      results.push({
        index: i + 1,
        candidateKey: candidateKeys[i],
        candidate,
        wordCount,
        hash,
        classification: 'SKIP',
        rationale: `Duplicate of candidate ${priorDuplicateIndex + 1}`,
        matches: [],
      });
      continue;
    }

    let classification: MineClassification = 'STORE';
    let rationale = 'No similar notes found';
    let matches: MineResult['matches'] = [];
    const embedding = embeddings[i]?.embedding;

    if (embedding) {
      const vectorMatches = repo.searchVector(embedding, { limit: 5, visibility: { project, client: args.client } });
      const best = vectorMatches[0];
      matches = vectorMatches.map(note => ({ id: note.id, title: note.title, similarity: note.similarity }));

      if (best && best.similarity >= 0.85) {
        classification = 'SKIP';
        rationale = `Similar to existing note (similarity: ${best.similarity.toFixed(2)})`;
      } else if (best && best.similarity >= 0.70) {
        classification = 'REVIEW';
        rationale = `Partial match (similarity: ${best.similarity.toFixed(2)})`;
      }
    } else {
      const simHashMatches = repo.findNearDuplicates(hash, 3, { project, client: args.client });
      if (simHashMatches.length > 0) {
        classification = 'SKIP';
        rationale = 'Similar to existing note by SimHash';
        matches = simHashMatches.slice(0, 5).map(note => ({ id: note.id, title: note.title }));
      } else {
        const query = [candidate.title, candidate.summary].filter(Boolean).join(' ');
        const ftsMatches = query.trim() ? repo.search(query, { limit: 5, visibility: { project, client: args.client } }) : [];
        if (ftsMatches.length > 0) {
          classification = 'REVIEW';
          rationale = 'Keyword overlap found (FTS5 fallback)';
          matches = ftsMatches.map(note => ({ id: note.id, title: note.title }));
        }
      }
    }

    results.push({ index: i + 1, candidateKey: candidateKeys[i], candidate, wordCount, hash, classification, rationale, matches });
  }

  const knownKeys = new Set(candidateKeys);
  if (new Set(dispositions.map(item => item.candidateKey)).size !== dispositions.length || dispositions.some(item => !knownKeys.has(item.candidateKey))) {
    return 'Error: Disposition plan contains duplicate or unknown candidate keys; no candidates were mutated.';
  }
  const updateTargets = dispositions.filter(item => item.action === 'update').map(item => item.noteId);
  if (new Set(updateTargets).size !== updateTargets.length) {
    return 'Error: Disposition plan contains conflicting updates for one target; no candidates were mutated.';
  }
  if (args.dry_run === false && dispositions.length === 0) {
    recordMineOutcome('migration');
    return JSON.stringify({ mutated: false, state: 'migration-required', candidateKeys, message: 'dry_run=false now requires explicit dispositions and a confirmed batch token.' });
  }

  const storeArgsFor = (result: MineResult, disposition: MineDisposition): StoreArgs => {
    let tags = result.candidate.tags ? [...result.candidate.tags] : undefined;
    if (result.candidate.source) {
      const sourceTag = `mined:${result.candidate.source}`;
      if (tags) tags.push(sourceTag);
      else if (disposition.action === 'update' && disposition.noteId) {
        const target = repo.getByIdVisible(disposition.noteId, { project, client: args.client });
        if (target) tags = [...target.tags, sourceTag];
      } else {
        tags = [sourceTag];
      }
    }
    return {
      title: result.candidate.title,
      content: result.candidate.content,
      kind: result.candidate.kind,
      tags,
      summary: result.candidate.summary,
      guidance: result.candidate.guidance,
      project,
      client: args.client,
      model: args.model,
      disposition: disposition.action === 'store' ? 'create' : disposition.action,
      noteId: disposition.noteId,
      expectedUpdatedAt: disposition.expectedUpdatedAt,
      dryRun: true,
    };
  };

  const preparePlan = async (lockedContext?: KnowledgeMutationContext): Promise<{ plan?: MineDisposition[]; error?: string; batchToken?: string }> => {
    const plan: MineDisposition[] = [];
    for (const result of results) {
      const disposition = dispositions.find(item => item.candidateKey === result.candidateKey);
      if (!disposition) continue;
      if (disposition.action === 'skip') {
        plan.push({ candidateKey: disposition.candidateKey, action: 'skip' });
        continue;
      }
      if (disposition.action === 'update' && (!disposition.noteId || disposition.expectedUpdatedAt === undefined)) {
        return { error: `Update disposition for ${disposition.candidateKey} requires noteId and expectedUpdatedAt.` };
      }
      const preparedEmbedding = embeddings[result.index - 1];
      const preview = await handleStore(storeArgsFor(result, disposition), repo, embeddingConfig, config, gitVersioning, lockedContext, {
        embeddingPromise: Promise.resolve(preparedEmbedding),
        suppressTelemetry: true,
      });
      let review: { evidence?: { digest?: string }; createToken?: string; updateTokens?: Array<{ id: string; token: string }> };
      try {
        review = JSON.parse(preview) as typeof review;
      } catch {
        return { error: `Disposition for ${disposition.candidateKey} is invalid: ${preview}` };
      }
      const token = disposition.action === 'store'
        ? review.createToken
        : review.updateTokens?.find(item => item.id === disposition.noteId)?.token;
      if (!token) return { error: `Disposition for ${disposition.candidateKey} cannot be confirmed against the current visible snapshot: ${preview}` };
      plan.push({ ...disposition, token, evidenceDigest: review.evidence?.digest });
    }
    const batchToken = createHash('sha256').update(JSON.stringify({ batchHash, plan })).digest('hex');
    return { plan, batchToken };
  };

  if (dispositions.length > 0 && dryRun) {
    const prepared = await preparePlan();
    if (prepared.error) return `Error: ${prepared.error} No candidates were mutated.`;
    recordMineOutcome('plan');
    return JSON.stringify({
      mutated: false,
      state: 'plan-ready',
      batchToken: prepared.batchToken,
      candidates: results.map(result => ({ candidateKey: result.candidateKey, classification: result.classification, matches: result.matches })),
      plan: prepared.plan,
    });
  }

  if (!dryRun) {
    if (!args.confirm || !args.batchToken) {
      recordMineOutcome('stale');
      return JSON.stringify({ mutated: false, state: 'confirmation-required', message: 'Confirmation and the current batch token are required.' });
    }
    const application = await repo.withKnowledgeMutationLockAsync(async lockedContext => {
      const prepared = await preparePlan(lockedContext);
      if (prepared.error) return { mutated: false, state: 'invalid-plan', message: prepared.error };
      if (prepared.batchToken !== args.batchToken) {
        return { mutated: false, state: 'stale-plan', message: 'The batch, dispositions, targets, or reviewed evidence changed.' };
      }
      const completed: Array<{ candidateKey: string; action: MineDisposition['action']; noteId?: string }> = [];
      const plan = prepared.plan ?? [];
      for (let index = 0; index < plan.length; index++) {
        const disposition = plan[index];
        const result = results.find(item => item.candidateKey === disposition.candidateKey);
        if (!result) continue;
        if (disposition.action === 'skip') {
          completed.push({ candidateKey: disposition.candidateKey, action: 'skip' });
          continue;
        }
        try {
          const preparedEmbedding = embeddings[result.index - 1];
          const mineStoreInternal = { embeddingPromise: Promise.resolve(preparedEmbedding), suppressTelemetry: true };
          const freshPreviewText = await handleStore(storeArgsFor(result, disposition), repo, embeddingConfig, config, gitVersioning, lockedContext, mineStoreInternal);
          const freshPreview = JSON.parse(freshPreviewText) as { createToken?: string; updateTokens?: Array<{ id: string; token: string }> };
          const operationToken = disposition.action === 'store'
            ? freshPreview.createToken
            : freshPreview.updateTokens?.find(item => item.id === disposition.noteId)?.token;
          if (!operationToken) throw new Error('Current reviewed operation token is unavailable.');
          const storeResult = await handleStore({
            ...storeArgsFor(result, disposition),
            dryRun: false,
            confirm: true,
            token: operationToken,
          }, repo, embeddingConfig, config, gitVersioning, lockedContext, mineStoreInternal);
          const storedId = extractStoredId(storeResult);
          if (!storedId) throw new Error(storeResult);
          result.storedId = storedId;
          completed.push({ candidateKey: disposition.candidateKey, action: disposition.action, noteId: storedId });
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
          return {
            mutated: completed.some(item => item.action !== 'skip'),
            state: 'partial-failure',
            completed,
            failed: { candidateKey: disposition.candidateKey, action: disposition.action, error: result.error },
            ambiguousRemainder: plan.slice(index + 1).map(item => item.candidateKey),
            message: 'Completed operations were not rolled back. Reconcile vault state before retrying.',
          };
        }
      }
      return { mutated: completed.some(item => item.action !== 'skip'), state: 'applied', completed };
    });
    if (application.state !== 'applied') {
      recordMineOutcome(application.state === 'stale-plan' ? 'stale' : 'reconciliation');
      return JSON.stringify(application);
    }
    recordMineOutcome('applied');
  } else if (dispositions.length === 0) {
    recordMineOutcome('preview');
  }

  let output = `## Mining Candidates (${args.candidates.length})\n\n`;
  if (!embeddingsAvailable) {
    output += '⚠ Embeddings disabled — dedup accuracy reduced (SimHash + FTS5 only).\n\n';
  }

  for (const result of results) {
    const tags = result.candidate.tags?.length ? ` | Tags: ${result.candidate.tags.join(', ')}` : '';
    output += `### [${result.index}] "${result.candidate.title}" (${result.candidate.kind})\n`;
    output += `Candidate key: ${result.candidateKey}\n`;
    output += `summary: ${result.candidate.summary}\n`;
    output += `Words: ${formatMineWordCount(result.candidate, result.wordCount)}${tags}\n`;
    const mineTitleCheck = titleWarning(result.candidate.title);
    if (mineTitleCheck && 'error' in mineTitleCheck) {
      output += `⚠ Title too long — will be rejected on store. Shorten to ≤${TITLE_HARD_LIMIT_WORDS} words / ${TITLE_HARD_LIMIT_CHARS} chars.\n`;
    } else if (mineTitleCheck && 'warning' in mineTitleCheck) {
      output += `⚠ Title is long — consider shortening to 3–6 words.\n`;
    }
    output += `⮕ ${result.classification} — ${result.rationale}\n`;
    for (const match of result.matches) {
      const similarity = match.similarity != null ? ` (${match.similarity.toFixed(2)})` : '';
      output += `  ↳ [${match.id}] "${match.title}"${similarity}\n`;
    }
    if (result.storedId) {
      output += `  ✅ Stored as ${result.storedId}\n`;
    }
    if (result.error) {
      output += `  ⚠ Store failed: ${result.error}\n`;
    }
    output += '\n';
  }

  const storeCount = results.filter(result => result.classification === 'STORE').length;
  const skipCount = results.filter(result => result.classification === 'SKIP').length;
  const reviewCount = results.filter(result => result.classification === 'REVIEW').length;
  output += '---\n';
  output += `Summary: ${storeCount} STORE, ${skipCount} SKIP, ${reviewCount} REVIEW`;
  if (dryRun) {
    output += '\nTo prepare a reviewed plan: call again with explicit candidate-keyed dispositions. Apply that returned plan with dry_run=false, confirm=true, and its batchToken.';
    if (reviewCount > 0) {
      output += `\n⚠ ${reviewCount} REVIEW candidate(s) have partial matches with existing notes — see matches listed above.`;
    }
  } else {
    const storedCount = results.filter(r => r.storedId).length;
    const failedCount = results.filter(r => r.error).length;
    output += `\nStored: ${storedCount}`;
    if (failedCount > 0) output += ` | Failed: ${failedCount}`;
    const storedReviewCount = results.filter(r => r.classification === 'REVIEW' && r.storedId).length;
    if (storedReviewCount > 0) {
      output += `\n⚠ ${storedReviewCount} of ${storedCount} stored candidate(s) had partial matches with existing notes.`;
    }
  }

  return output;
}
