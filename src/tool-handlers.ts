// tool-handlers.ts - Handler functions for knowledge tools

import * as fs from 'fs';
import * as path from 'path';
import type { NoteKind, NoteStatus, Lifecycle, AppConfig } from './types.js';
import { KIND_DEFAULT_STATUS, KIND_DEFAULT_LIFECYCLE, VALID_LIFECYCLES } from './types.js';

const VALID_STATUSES = new Set<string>(['fleeting', 'permanent', 'archived']);

function toNoteStatus(status: string | undefined, fallback: NoteStatus): NoteStatus {
  if (status && VALID_STATUSES.has(status)) return status as NoteStatus;
  return fallback;
}

function toLifecycle(lifecycle: string | undefined, fallback: Lifecycle): Lifecycle {
  if (lifecycle && VALID_LIFECYCLES.has(lifecycle)) return lifecycle as Lifecycle;
  return fallback;
}
import type { NoteRepository, NoteMetadata } from './storage/NoteRepository.js';
import { formatWikiLink } from './utils/wikilink.js';
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
import type { EmbeddingConfig } from './embeddings.js';
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

// ---- Constants ----

/** Soft word-count guidelines per note kind (not hard limits). */
export const KIND_WORD_GUIDELINES: Record<NoteKind, { target: number; warn: number }> = {
  personalization: { target: 50, warn: 80 },
  decision:        { target: 150, warn: 250 },
  procedure:       { target: 150, warn: 250 },
  reference:       { target: 120, warn: 200 },
  observation:     { target: 100, warn: 200 },
  resource:        { target: 50, warn: 100 },
  domain:          { target: 500, warn: 1000 },
  index:           { target: 500, warn: 2000 },
  log:             { target: 500, warn: 5000 },
};

/** Absolute word-count ceiling — warns regardless of kind. */
export const ABSOLUTE_WARN_THRESHOLD = 300;
const EMBEDDING_BACKFILL_BATCH_SIZE = 50;

export const TITLE_SOFT_WARN_WORDS = 6;
export const TITLE_HARD_LIMIT_WORDS = 10;
export const TITLE_HARD_LIMIT_CHARS = 80;

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
  if (wordCount > ABSOLUTE_WARN_THRESHOLD) {
    return `\n\n⚠ This note is ${wordCount} words (target for ${kind}: ~${guide.target}). Consider splitting into separate atomic notes — each note should capture one concept.`;
  }
  if (wordCount > guide.warn) {
    return `\n\n⚠ This note is ${wordCount} words (target for ${kind}: ~${guide.target}). Consider whether it captures more than one concept.`;
  }
  return null;
}

function getRecommendation(
  note: NoteMetadata,
  daysOld: number,
  promotionThreshold: number,
  archiveAfterDays: number,
): { action: 'promote' | 'archive' | 'review'; rationale: string } {
  const accesses = note.access_count || 0;
  const backlinks = note.backlinks_count || 0;
  if (accesses >= promotionThreshold) {
    return { action: 'promote', rationale: `Accessed ${accesses} times (threshold: ${promotionThreshold})` };
  }
  if (accesses === 0 && daysOld > archiveAfterDays && backlinks === 0) {
    return { action: 'archive', rationale: `Zero accesses, ${daysOld} days old, no backlinks — likely stale` };
  }
  if (accesses === 0 && daysOld > archiveAfterDays) {
    return { action: 'review', rationale: `Zero accesses but ${backlinks} backlink(s) — referenced by other notes` };
  }
  return { action: 'review', rationale: `${daysOld} days old, ${accesses} accesses — needs manual review` };
}

type BrokenLink = {
  sourceId: string;
  sourceTitle: string;
  brokenTarget: string;
  line: number;
};

function filterFalsePositiveBrokenLinks(broken: BrokenLink[], vaultPath: string | undefined): BrokenLink[] {
  if (!vaultPath) return broken;
  const resolvedVault = path.resolve(vaultPath);
  const vaultPrefix = resolvedVault + path.sep;
  const insideVault = (candidate: string): boolean => {
    const resolved = path.resolve(vaultPath, candidate);
    return resolved === resolvedVault || resolved.startsWith(vaultPrefix);
  };
  return broken.filter(({ brokenTarget }) => {
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
  project?: string;
  client?: string;
  related?: string[];
  model?: string;
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

export interface MineArgs {
  candidates: MineCandidate[];
  project?: string;
  dry_run?: boolean;
  model?: string;
}

export interface SearchArgs {
  query: string;
  kind?: NoteKind;
  status?: string;
  lifecycle?: string;
  project?: string;
  client?: string;
  tags?: string[];
  limit?: number;
  model?: string;
}

export interface MaintainArgs {
  action: string;
  noteId?: string;
  filter?: 'fleeting' | 'permanent';
  days?: number;
  limit?: number;
  dryRun?: boolean;
  model?: string;
}

export interface IngestArgs {
  url?: string;
  html?: string;
  model?: string;
}

export interface ContextArgs {
  project?: string;
  logEntries?: number;
  model?: string;
  includePreferences?: boolean;
  client?: string;
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
  project?: string;
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
  const days = parsePeriodToDays(args.period);
  const periodLabel = `${days}d`;
  const project = args.project;
  const stats = repo.getStats(project);
  const embeddingStats = repo.getEmbeddingStats(project);
  const staleness = repo.getStalenessDistribution(project);

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
    const brokenLinks = filterFalsePositiveBrokenLinks(repo.getBrokenLinks(project), config?.vault);
    const oneWayLinks = repo.getOneWayLinks(project);
    const unlinkedNotes = repo.getUnlinkedNotes(project);
    const linkIssueCount = brokenLinks.length + oneWayLinks.length + unlinkedNotes.length;
    output += '\n## Link Health\n';
    if (linkIssueCount > 0) {
      const parts: string[] = [];
      if (unlinkedNotes.length > 0) parts.push(`${unlinkedNotes.length} unlinked`);
      if (brokenLinks.length > 0) parts.push(`${brokenLinks.length} broken`);
      if (oneWayLinks.length > 0) parts.push(`${oneWayLinks.length} one-way`);
      output += `- Issues: ${parts.join(', ')} (run \`knowledge-maintain link-health\` for details)\n`;
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
  const growth = repo.getGrowthByKind(sinceMs, project);
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
): string[] {
  const vaultPath = config?.vault;
  if (!vaultPath) return [];
  const changedPaths: string[] = [];
  let fleetingNotes: NoteMetadata[] | null = null;
  let unscopedNotes: NoteMetadata[] | null = null;

  const getFleetingNotes = (): NoteMetadata[] => {
    if (!fleetingNotes) fleetingNotes = repo.getFleetingNotes();
    return fleetingNotes;
  };

  const getUnscopedNotes = (): NoteMetadata[] => {
    if (!unscopedNotes) unscopedNotes = repo.getUnscopedNotes();
    return unscopedNotes;
  };

  if (config?.navigation?.enableGlobalIndex !== false) {
    try {
      const projectStats = repo.getProjectStats();
      const totalNoteCount = repo.getStats().total;
      const prefsCount = repo.getPersonalizationNotes().length;
      const generalCount = getUnscopedNotes().length;
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

  if (config?.navigation?.enableGlobalLog !== false) {
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
      const unscopedNotes = getUnscopedNotes();
      const personalizationNotes = repo.getPersonalizationNotes();
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

export async function handleStore(args: StoreArgs, repo: NoteRepository, embeddingConfig?: EmbeddingConfig | null, config?: AppConfig, gitVersioning?: GitVersioning | null): Promise<string> {
  const project = args.project === undefined ? undefined : extractProjectTag([`project:${args.project}`]);
  if (args.project !== undefined && !project) {
    return `Error: Invalid project name: "${args.project}"`;
  }

  const effectiveStatus = toNoteStatus(args.status, KIND_DEFAULT_STATUS[args.kind]);
  const lifecycleDefaults = config?.lifecycleDefaults;
  const kindDefault = (lifecycleDefaults?.defaultForKind?.[args.kind] as Lifecycle | undefined) || KIND_DEFAULT_LIFECYCLE[args.kind];
  const lifecycleExplicit = typeof args.lifecycle === 'string' && VALID_LIFECYCLES.has(args.lifecycle);
  let effectiveLifecycle = toLifecycle(args.lifecycle, kindDefault);
  if (!lifecycleExplicit && lifecycleDefaults?.detectSnapshotFromSlug !== false && /\d{4}-\d{2}-\d{2}/.test(args.title)) {
    effectiveLifecycle = 'snapshot';
  }
  const tags = [...(args.tags || [])];

  if (project) {
    for (let i = tags.length - 1; i >= 0; i--) {
      if (tags[i].startsWith('project:')) tags.splice(i, 1);
    }
    tags.push(`project:${project}`);
  }

  if (STRUCTURAL_KINDS.has(args.kind)) {
    return `Error: ${args.kind} notes are auto-generated per project. Use knowledge-context to view them.`;
  }

  if (args.kind === 'domain') {
    if (!project) {
      return 'Error: Domain notes require a project parameter. A domain note is a project operating manual — it must be scoped to a specific project.';
    }
    const existingDomain = repo.getDomainNote(project);
    if (existingDomain) {
      return `A domain note already exists for project "${project}" [${existingDomain.id}]: "${existingDomain.title}". Update the existing note instead of creating a duplicate.`;
    }
  }

  // Client tag — explicit or auto-detected from content/guidance
  const resolvedClient = args.client || detectClient(args.content, args.guidance);
  if (resolvedClient) {
    const tag = clientTag(resolvedClient);
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  let content = args.content;
  if (args.related && args.related.length > 0) {
    const links = args.related.map(id => {
      const existing = repo.getById(id);
      if (existing) {
        return formatWikiLink({ id, display: existing.title });
      }
      return formatWikiLink({ id });
    });
    content += '\n\n## Related\n' + links.map(l => `- ${l}`).join('\n');
  }

  const titleCheck = titleWarning(args.title);
  if (titleCheck && 'error' in titleCheck) {
    return titleCheck.error;
  }

  const result = repo.store(content, {
    title: args.title,
    kind: args.kind,
    status: effectiveStatus,
    lifecycle: effectiveLifecycle,
    tags,
    summary: args.summary,
    guidance: args.guidance,
  });


  scheduleTelemetryWrite('store', () => repo.recordToolInvocation('store', args.kind, 1, args.model));

  const hashContent = args.summary || args.content || args.title;
  const hash = computeSimHash(hashContent);
  repo.updateContentHash(result.id, hash);

  // Race embedding generation against 500ms timeout for related notes search.
  // If timeout wins, the embedding still persists in the background (no data loss).
  let noteEmbedding: number[] | null = null;
  if (embeddingConfig) {
    const text = buildEmbeddingText(args.title, args.summary, args.content);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const embeddingPromise = generateEmbedding(text, embeddingConfig);
      const embResult = await Promise.race([
        embeddingPromise,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 500); }),
      ]);
      if (embResult) {
        repo.storeEmbedding(result.id, embResult.embedding, embResult.model);
        noteEmbedding = embResult.embedding;
      } else {
        void embeddingPromise.then(slowResult => {
          if (slowResult) {
            repo.storeEmbedding(result.id, slowResult.embedding, slowResult.model);
          }
        }).catch(error => {
          logToFile('WARN', 'Background embedding generation failed', {
            noteId: result.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      logToFile('WARN', 'Embedding generation failed', {
        noteId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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
        const vecResults = repo.searchVector(noteEmbedding, { limit: fetchLimit });
        relatedNotes = vecResults
          .filter(n => isCandidate(n) && n.similarity >= minSimilarity)
          .slice(0, maxResults)
          .map(n => ({ id: n.id, title: n.title, kind: n.kind, similarity: n.similarity, created_at: n.created_at, last_accessed_at: n.last_accessed_at }));
      } else {
        // FTS5 fallback — use title + summary as query
        const queryText = [args.title, args.summary].filter(Boolean).join(' ');
        if (queryText.trim()) {
          const ftsResults = repo.search(queryText, { limit: fetchLimit });
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
  if (effectiveProject) {
    changedPaths.push(...updateProjectNavigation(effectiveProject, `Created ${args.kind}: "${args.title}"`, repo, config));
  }
  changedPaths.push(...updateGlobalNavigation(effectiveProject || null, `Stored ${args.kind}: "${args.title}"`, repo, config));
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
  const requestedLimit = args.limit || 10;
  const excludeStructuralKinds = config?.search?.excludeLogFromSearch !== false && !STRUCTURAL_KINDS.has(args.kind as string);
  const searchLimit = args.project || excludeStructuralKinds ? Math.min(requestedLimit * 10, 100) : requestedLimit;
  let results = repo.searchHybrid(args.query, queryEmbedding || null, {
    kind: args.kind,
    status: args.status ? toNoteStatus(args.status, 'fleeting') : undefined,
    tags: args.tags,
    limit: searchLimit,
  });

  if (excludeStructuralKinds) {
    results = results.filter(note => !STRUCTURAL_KINDS.has(note.kind));
  }

  if (args.lifecycle) {
    const lifecycleFilter = args.lifecycle;
    results = results.filter(note => note.lifecycle === lifecycleFilter);
  }

  if (args.project) {
    const projectPrefix = `project:${args.project}`;
    results = results.filter(note => {
      const tags = Array.isArray(note.tags) ? note.tags : [];
      return tags.some(t => t === projectPrefix || t.startsWith(`${projectPrefix}:`));
    });
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
  if (args.project && config?.search?.alwaysIncludeDomainNote !== false) {
    domainNote = repo.getDomainNote(args.project);
    if (domainNote) {
      const domainId = domainNote.id;
      results = results.filter(r => r.id !== domainId);
    }
  }

  if (results.length > requestedLimit) {
    results = results.slice(0, requestedLimit);
  }

  const accessedIds = [...(domainNote ? [domainNote.id] : []), ...results.map(note => note.id)];
  scheduleTelemetryWrite('search invocation', () => repo.recordToolInvocation('search', undefined, accessedIds.length, args.model));

  scheduleTelemetryWrite('search access update', () => repo.updateLastAccessed(accessedIds));

  if (results.length === 0 && !domainNote) {
    return 'No matching notes found. Try broader keywords or remove filters.' + clientWarning;
  }

  const totalCount = results.length + (domainNote ? 1 : 0);
  let output = `Found ${totalCount} note(s):\n\n`;

  if (domainNote) {
    output += renderNoteForSearch(domainNote) + '\n';
  }

  for (const note of results) {
    output += renderNoteForSearch(note) + '\n';
  }
  return output + clientWarning;
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

type PreferenceAuditSignal = { type: string; evidence: string[] };

function collectRegexEvidence(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)]
    .map(match => match[0].trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function detectPreferenceAuditSignals(note: NoteMetadata): PreferenceAuditSignal[] {
  const text = [note.title, note.summary, note.content, note.guidance].filter(Boolean).join('\n');
  const definitions: Array<{ type: string; pattern: RegExp }> = [
    { type: 'temporary-wording', pattern: /\b(?:temporary|temporarily|for now|currently|this (?:session|task)|until (?:further notice|tomorrow|next week))\b/gi },
    { type: 'exact-path', pattern: /(?:[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]+|(?:~|\.{1,2})?\/(?:[\w.-]+\/)*[\w.-]+|(?:^|\s)\.[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+)/gm },
    { type: 'hex-color', pattern: /#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?\b/gi },
    { type: 'model-identifier', pattern: /\b(?:gpt-?[34](?:[.\w-]*)?|claude-(?:\d|opus|sonnet|haiku)[\w.-]*|gemini-[\w.-]+|llama-?\d[\w.-]*)\b/gi },
    { type: 'model-routing', pattern: /\b(?:route|routing|fallback|default model|model selection)\b/gi },
    { type: 'configuration-language', pattern: /\b(?:configure|configured|configuration|set|install|implement|implementation|enable|disable)\b/gi },
  ];
  const signals = definitions
    .map(({ type, pattern }) => ({ type, evidence: collectRegexEvidence(text, pattern) }))
    .filter(signal => signal.evidence.length > 0);

  const tags = Array.isArray(note.tags) ? note.tags : [];
  const hasApplicability = tags.some(tag => tag.startsWith('project:') || tag.startsWith('client:'));
  if (!hasApplicability) {
    const technologyEvidence = collectRegexEvidence(text, /\b(?:OpenCode|Claude Code|Cursor|Windsurf|Zed|VS Code|React|Next\.js|TypeScript|Python|Bun)\b/gi);
    if (technologyEvidence.length > 0) {
      signals.push({ type: 'missing-applicability', evidence: technologyEvidence });
    }
  }
  return signals;
}

export async function handleMaintain(args: MaintainArgs, repo: NoteRepository, config: AppConfig, embeddingConfig?: EmbeddingConfig | null, currentVersion?: string, gitVersioning?: GitVersioning | null): Promise<string> {
  scheduleTelemetryWrite('maintain', () => repo.recordToolInvocation('maintain', args.action, undefined, args.model));

  switch (args.action) {
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
      const staleCutoff = Date.now() - (archiveDays * 24 * 60 * 60 * 1000);
      const queue = repo.getReviewQueue(args.filter, daysThreshold, limit, config.lifecycle.exemptKinds, staleCutoff);

      // Compute stale notes early — needed for the early return check
      const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER);
      const staleForArchive = allNotes
        .filter(n => n.status === 'fleeting' && computeStaleness(n) >= archiveDays);

      const hasCandidates = queue.fleeting.total > 0 || queue.permanent.total > 0;

      if (!hasCandidates && staleForArchive.length === 0) {
        return 'No notes pending review. All notes are up to date!';
      }

      let output = '';

      if (hasCandidates) {
        const candidates = [...queue.fleeting.notes, ...queue.permanent.notes];
        const candidateIds = new Set(candidates.map(n => n.id));
        const totalCandidates = queue.fleeting.total + queue.permanent.total;
        output += `## Review Candidates (${candidates.length} of ${totalCandidates})\n\n`;

        for (let i = 0; i < candidates.length; i++) {
          const note = candidates[i];
          const staleness = computeStaleness(note);
          const accesses = note.access_count || 0;
          const backlinks = note.backlinks_count || 0;
          const wordCount = countWords(note.content);
          const guide = KIND_WORD_GUIDELINES[note.kind as NoteKind];
          const wordSignal = guide && wordCount > guide.warn
            ? `${wordCount} (oversized, target: ~${guide.target})`
            : `${wordCount}`;
          const backlinkSignal = backlinks === 0 ? '0 (unlinked)' : `${backlinks}`;
          const archiveSuggestionDays = Math.max(1, Math.floor(archiveDays / 2));
        const rec = getRecommendation(note, staleness, config.lifecycle.promotionThreshold, archiveSuggestionDays);

          output += `### [${i + 1}] "${note.title}" (${note.id})\n`;
          output += `kind: ${note.kind} | status: ${note.status} | staleness: ${staleness} days\n`;
          output += `Accesses: ${accesses} | Backlinks: ${backlinkSignal} | Words: ${wordSignal}\n`;
          output += `⮕ Suggested: ${rec.action.toUpperCase()} — ${rec.rationale}\n\n`;
        }

        // Flag oversized notes that may need splitting (exclude already-shown candidates)
        const oversized = allNotes
          .filter(n => n.status !== 'archived')
          .filter(n => !candidateIds.has(n.id))
          .map(n => ({ ...n, wordCount: countWords(n.content) }))
          .filter(n => {
            const guide = KIND_WORD_GUIDELINES[n.kind as NoteKind];
            return guide ? n.wordCount > guide.warn : n.wordCount > ABSOLUTE_WARN_THRESHOLD;
          })
          .sort((a, b) => b.wordCount - a.wordCount);

        if (oversized.length > 0) {
          output += `### Oversized Notes (${oversized.length} may need splitting)\n`;
          for (const n of oversized) {
            const guide = KIND_WORD_GUIDELINES[n.kind as NoteKind];
            const target = guide ? guide.target : '?';
            output += `- "${n.title}" (${n.kind}) — ${n.wordCount} words (target: ~${target}) [${n.id}]\n`;
          }
          output += '\n';
        }

        const longTitles = allNotes
          .filter(n => n.status !== 'archived' && !['index', 'log'].includes(n.kind))
          .filter(n => {
            const words = n.title.trim().split(/\s+/).filter(Boolean).length;
            return words > TITLE_SOFT_WARN_WORDS;
          })
          .sort((a, b) => b.title.split(/\s+/).length - a.title.split(/\s+/).length);

        if (longTitles.length > 0) {
          output += `### Long Titles (${longTitles.length} exceed ${TITLE_SOFT_WARN_WORDS}-word target)\n`;
          for (const n of longTitles) {
            const words = n.title.trim().split(/\s+/).filter(Boolean).length;
            output += `- "${n.title}" (${n.kind}) — ${words} words [${n.id}]\n`;
          }
          output += '\n';
        }

        const remaining = Math.max(0, totalCandidates - candidates.length);
        if (remaining > 0) {
          output += `Remaining: ${remaining} more candidates (increase limit to see more)\n\n`;
        }
      }

      if (staleForArchive.length > 0) {
        output += `### Stale Fleeting Notes (${staleForArchive.length} older than ${archiveDays} days)\n`;
        output += 'These fleeting notes were never promoted. Consider archiving:\n\n';
        for (const n of staleForArchive) {
          output += `- "${n.title}" (${n.kind}) — ${computeStaleness(n)} days old [${n.id}]\n`;
        }
        output += '\n';
      }

      output += '---\n';
      output += 'Actions: `knowledge-maintain promote/archive/delete` with noteId=<id>\n';

      return output;
    }
    case 'dedupe': {
      const unhashed = repo.getNotesWithoutContentHash(500);
      let backfilled = 0;
      for (const note of unhashed) {
        const hashContent = note.summary || note.content || note.title;
        if (!hashContent) continue;
        const hash = computeSimHash(hashContent);
        repo.updateContentHash(note.id, hash);
        backfilled++;
      }
      if (backfilled > 0) {
        logToFile('INFO', 'Backfilled content hashes during dedupe', { count: backfilled });
      }

      const titleDuplicates = repo.findDuplicates();
      const simhashDuplicates = repo.findSimHashDuplicates();

      if (titleDuplicates.size === 0 && simhashDuplicates.size === 0) {
        const backfillMsg = backfilled > 0 ? ` Backfilled ${backfilled} content hash${backfilled === 1 ? '' : 'es'}.` : '';
        return `No duplicate notes found.${backfillMsg}`;
      }

      let output = '## Duplicate Detection\n\n';
      if (backfilled > 0) {
        output += `*Backfilled ${backfilled} content hash${backfilled === 1 ? '' : 'es'} for SimHash comparison.*\n\n`;
      }

      if (titleDuplicates.size > 0) {
        output += `### Title-Based Duplicates (${titleDuplicates.size} groups)\n\n`;

        let groupNum = 1;
        for (const [, notes] of titleDuplicates) {
          output += `**Group ${groupNum}: "${notes[0].title}" (${notes.length} notes)**\n`;
          notes.sort((a, b) => (b.access_count || 0) - (a.access_count || 0));

          for (let i = 0; i < notes.length; i++) {
            const note = notes[i];
            const isPermanent = note.status === 'permanent';
            const marker = isPermanent ? '⦸ (permanent - protected)' : (i === 0 ? '(keep)' : '(duplicate)');
            output += `- ${note.id} | ${note.status} | ${note.access_count || 0} accesses | ${marker}\n`;
          }

          const archivable = notes.filter((n, i) => i > 0 && n.status !== 'permanent');
          if (archivable.length > 0) {
            output += `\n**Recommendation:** Archive ${archivable.map((n) => n.id).join(', ')}\n`;
          } else {
            output += '\n**Note:** All duplicates are permanent — manual review needed.\n';
          }

          output += '\n';
          groupNum++;

          if (groupNum > 10) {
            output += `... and ${titleDuplicates.size - 10} more groups.\n\n`;
            break;
          }
        }
      }

      if (simhashDuplicates.size > 0) {
        output += `### Content-Based Near-Duplicates (${simhashDuplicates.size} groups)\n\n`;

        let groupNum = 1;
        for (const [, notes] of simhashDuplicates) {
          output += `**Group ${groupNum} (${notes.length} notes)**\n`;
          notes.sort((a, b) => (b.access_count || 0) - (a.access_count || 0));

          for (let i = 0; i < notes.length; i++) {
            const note = notes[i];
            const isPermanent = note.status === 'permanent';
            const marker = isPermanent ? '⦸ (permanent - protected)' : (i === 0 ? '(keep)' : '(near-duplicate)');
            output += `- ${note.id} | "${note.title}" | ${note.status} | ${marker}\n`;
          }

          const archivable = notes.filter((n, i) => i > 0 && n.status !== 'permanent');
          if (archivable.length > 0) {
            output += `\n**Recommendation:** Archive ${archivable.map((n) => n.id).join(', ')}\n`;
          }

          output += '\n';
          groupNum++;

          if (groupNum > 10) {
            output += `... and ${simhashDuplicates.size - 10} more groups.\n\n`;
            break;
          }
        }
      }

      output += '## Next Steps:\n';
      output += '[A] Archive specific duplicate (requires --noteId)\n';
      output += '[B] View specific note details (use knowledge-search)\n';
      output += '\n⚠ Permanent notes (⦸) are never auto-archived. Promote the best version before archiving others.\n';

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
      const findings = notes
        .map(note => ({ note, signals: detectPreferenceAuditSignals(note) }))
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
      const unlinked = repo.getUnlinkedNotes();
      if (unlinked.length === 0) {
        return 'No unlinked notes found. All non-archived notes have at least one incoming or outgoing wikilink.';
      }

      // Group by project, then by kind
      const byProject = new Map<string, NoteMetadata[]>();
      for (const note of unlinked) {
        const project = extractProjectFromTags(note.tags) || '(no project)';
        let group = byProject.get(project);
        if (!group) {
          group = [];
          byProject.set(project, group);
        }
        group.push(note);
      }

      const projectCount = [...byProject.keys()].filter(k => k !== '(no project)').length;
      const unscopedCount = byProject.get('(no project)')?.length ?? 0;
      let output = `## Unlinked Notes (${unlinked.length})\n\n`;
      const summaryParts: string[] = [];
      if (projectCount > 0) summaryParts.push(`${unlinked.length - unscopedCount} in ${projectCount} project${projectCount > 1 ? 's' : ''}`);
      if (unscopedCount > 0) summaryParts.push(`${unscopedCount} unscoped`);
      output += summaryParts.join(', ') + '\n\n';

      const displayCap = 20;
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
        output += `### ${project} (${notes.length})\n`;

        // Group by kind within project
        const byKind = new Map<string, NoteMetadata[]>();
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

      if (displayed < unlinked.length) {
        output += `(showing ${displayed} of ${unlinked.length} — use \`knowledge-search\` to find specific notes)\n\n`;
      }

      output += '## Next Steps\n';
      output += '[A] Add wikilinks to connect unlinked notes to related notes\n';
      output += '[B] Archive notes that are no longer relevant\n';
      return output;
    }
    case 'broken-links': {
      const broken = filterFalsePositiveBrokenLinks(repo.getBrokenLinks(), config?.vault);
      if (broken.length === 0) {
        return 'No broken wikilinks found. All links resolve to existing notes.';
      }

      let output = `## Broken Wikilinks (${broken.length})\n\n`;
      output += 'Links pointing to non-existent notes:\n\n';
      for (const { sourceId, sourceTitle, brokenTarget, line } of broken) {
        output += `- "${sourceTitle}" [${sourceId}] content:${line} → [[${brokenTarget}]] (not found)\n`;
      }
      output += '\n## Next Steps\n';
      output += '[A] Create the missing target notes\n';
      output += '[B] Update or remove the broken links\n';
      return output;
    }
    case 'link-health': {
      const unlinked = repo.getUnlinkedNotes();
      const broken = filterFalsePositiveBrokenLinks(repo.getBrokenLinks(), config?.vault);
      const oneWay = repo.getOneWayLinks();

      const total = unlinked.length + broken.length + oneWay.length;
      if (total === 0) {
        return 'Link health: all clear. No unlinked notes, broken links, or one-way links found.';
      }

      let output = '## Link Health Report\n\n';

      if (unlinked.length > 0) {
        output += `### Unlinked Notes (${unlinked.length})\n\n`;
        output += 'Notes with no incoming or outgoing wikilinks:\n\n';
        for (const note of unlinked) {
          output += `- "${note.title}" [${note.id}] | ${note.kind} | ${note.status}\n`;
        }
        output += '\n';
      }

      if (broken.length > 0) {
        output += `### Broken Wikilinks (${broken.length})\n\n`;
        output += 'Links pointing to non-existent notes:\n\n';
        for (const { sourceId, sourceTitle, brokenTarget, line } of broken) {
          output += `- "${sourceTitle}" [${sourceId}] content:${line} → [[${brokenTarget}]] (not found)\n`;
        }
        output += '\n';
      }

      if (oneWay.length > 0) {
        output += `### One-Way Links (${oneWay.length})\n\n`;
        output += 'A links to B but B does not link back to A:\n\n';
        for (const { sourceId, sourceTitle, targetId, targetTitle } of oneWay) {
          output += `- "${sourceTitle}" [${sourceId}] → "${targetTitle}" [${targetId}] (no reverse link)\n`;
        }
        output += '\n';
      }

      output += '## Summary\n';
      output += `Unlinked: ${unlinked.length} | Broken: ${broken.length} | One-way: ${oneWay.length}\n`;
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
          const result = await handleMaintain(step.stepArgs, repo, config, embeddingConfig, currentVersion, gitVersioning);
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

const CAPSULE_NOTE_LIMIT = 12;
const CAPSULE_TOKEN_LIMIT = 800;

export function buildPreferenceCapsule(
  repo: NoteRepository,
  targets: { project?: string; client?: string },
): PreferenceCapsule {
  const universal: NoteMetadata[] = [];
  const scoped: NoteMetadata[] = [];

  for (const note of repo.getPermanentPersonalizations()) {
    const projects = note.tags.filter(tag => tag.startsWith('project:')).map(tag => tag.slice('project:'.length));
    const clients = note.tags.filter(tag => tag.startsWith('client:')).map(tag => tag.slice('client:'.length));
    const projectMatches = projects.length === 0 || (targets.project !== undefined && projects.includes(targets.project));
    const clientMatches = clients.length === 0 || clients.includes('all') || (targets.client !== undefined && clients.includes(targets.client));
    if (!projectMatches || !clientMatches) continue;
    (projects.length === 0 && clients.length === 0 ? universal : scoped).push(note);
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
    const guidance = storedGuidance || `Honor this preference: ${(note.summary || note.title).trim()}`;
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
  const project = args.project;
  const logLimit = Math.max(1, args.logEntries ?? config?.navigation?.overviewLogEntryLimit ?? 10);
  const text = project
    ? formatProjectOverview(project, logLimit, repo, config, args.model)
    : formatGlobalOverview(logLimit, repo, config, args.model);

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

function formatProjectOverview(project: string, logLimit: number, repo: NoteRepository, config?: AppConfig, model?: string): string {
  const domainNote = repo.getDomainNote(project);
  const projectNotes = repo.getProjectNotes(project);
  const logNote = repo.getLogNote(project);

  if (projectNotes.length === 0 && !domainNote && !logNote) {
    return `No notes found for project "${project}". Store a project-scoped note first (include project parameter).`;
  }

  let output = `## Project Overview: ${project}\n\n`;

  // Domain note (operating manual)
  if (domainNote) {
    output += '### Domain\n';
    output += renderNoteForAgent(domainNote) + '\n\n';
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

function formatGlobalOverview(logLimit: number, repo: NoteRepository, config?: AppConfig, model?: string): string {
  const projectStats = repo.getProjectStats();
  const kindStats = repo.getStatsByKind();
  const stats = repo.getStats();
  const recentNotes = repo.getRecentNotes(logLimit);

  let output = '## Knowledge Base Overview\n\n';

  // Projects
  if (projectStats.length > 0) {
    output += '### Projects\n';
    for (const ps of projectStats) {
      output += `- **${ps.project}**: ${ps.noteCount} notes\n`;
    }
    output += '\n';
  }

  // Inventory by kind
  const kindEntries = Object.entries(kindStats)
    .filter(([kind]) => kind !== 'index' && kind !== 'log')
    .sort((a, b) => b[1].total - a[1].total);
  if (kindEntries.length > 0) {
    output += '### Inventory\n';
    const parts = kindEntries.map(([kind, s]) => `${s.total} ${kind}`);
    output += parts.join(', ') + `  (${stats.total} total)\n\n`;
  }

  // Unscoped count — use direct DB count to avoid double-counting multi-project notes
  const scopedCount = repo.getScopedNoteCount();
  const unscopedCount = stats.total - stats.archived - scopedCount;
  if (unscopedCount > 0) {
    output += `Unscoped notes: ${unscopedCount}\n\n`;
  }

  // Recent notes
  if (recentNotes.length > 0) {
    output += '### Recent Notes\n';
    for (const note of recentNotes) {
      const status = note.status === 'permanent' ? '⦸' : note.status === 'archived' ? '▪' : '▫';
      const project = extractProjectFromTags(note.tags);
      const projectSuffix = project ? ` [${project}]` : '';
      output += `- ${status} **${note.title}** (${note.kind})${projectSuffix}\n`;
    }
    if (stats.total > recentNotes.length) {
      output += `\n(showing ${recentNotes.length} of ${stats.total})\n`;
    }
    output += '\n';
  }

  // Resources
  const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER);
  const resources = allNotes.filter(n => n.kind === 'resource' && n.status !== 'archived');
  if (resources.length > 0) {
    output += '### Resources\n';
    for (const note of resources.slice(0, 20)) {
      output += `- **${note.title}** [${note.id}]\n`;
    }
    if (resources.length > 20) {
      output += `\n(showing 20 of ${resources.length})\n`;
    }
    output += '\n';
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
  return formatSuccessMessage(vaultPath, resolvedProject);
}

export interface TemplateArgs {
  kind: string;
  project?: string;
  model?: string;
}

export interface GetArgs {
  noteId: string;
  model?: string;
}

export function handleGet(args: GetArgs, repo: NoteRepository): string {
  const note = repo.getById(args.noteId);
  if (!note) return `Note not found: ${args.noteId}`;
  scheduleTelemetryWrite('get access', () => repo.updateLastAccessed([note.id]));

  return renderNoteForSearch(note);
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
  if (args.candidates.length === 0) {
    return 'No mining candidates provided. Extract candidate notes first, then call knowledge-mine with at least one candidate.';
  }
  if (args.candidates.length > 50) {
    return `Error: knowledge-mine accepts at most 50 candidates per batch; received ${args.candidates.length}.`;
  }

  const validationErrors: string[] = [];
  for (let i = 0; i < args.candidates.length; i++) {
    const validation = validateMineCandidate(args.candidates[i], i + 1, args.project);
    if (validation) validationErrors.push(validation);
  }
  if (validationErrors.length > 0) {
    return `Error: ${validationErrors.join('\n')}`;
  }

  scheduleTelemetryWrite('mine', () => repo.recordToolInvocation('mine', undefined, args.candidates.length, args.model));


  const dryRun = args.dry_run ?? true;
  const embeddingTexts = args.candidates.map(candidate => buildEmbeddingText(candidate.title, candidate.summary, candidate.content));
  let embeddings: Array<{ embedding: number[] } | null> = args.candidates.map(() => null);
  let embeddingsAvailable = false;

  if (embeddingConfig) {
    try {
      const batchTimeout = Math.max(60000, args.candidates.length * 2000);
      const batchResults = await generateEmbeddingBatch(embeddingTexts, embeddingConfig, batchTimeout);
      embeddings = batchResults.map(result => result ? { embedding: result.embedding } : null);
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
      const vectorMatches = repo.searchVector(embedding, { limit: 5 }).filter(note => note.status !== 'archived');
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
      const simHashMatches = repo.findNearDuplicates(hash);
      if (simHashMatches.length > 0) {
        classification = 'SKIP';
        rationale = 'Similar to existing note by SimHash';
        matches = simHashMatches.slice(0, 5).map(note => ({ id: note.id, title: note.title }));
      } else {
        const query = [candidate.title, candidate.summary].filter(Boolean).join(' ');
        const ftsMatches = query.trim() ? repo.search(query, { limit: 5 }).filter(note => note.status !== 'archived') : [];
        if (ftsMatches.length > 0) {
          classification = 'REVIEW';
          rationale = 'Keyword overlap found (FTS5 fallback)';
          matches = ftsMatches.map(note => ({ id: note.id, title: note.title }));
        }
      }
    }

    results.push({ index: i + 1, candidate, wordCount, hash, classification, rationale, matches });
  }

  if (!dryRun) {
    for (const result of results) {
      if (result.classification === 'SKIP') continue;
      const tags = [...(result.candidate.tags || [])];
      if (result.candidate.source) tags.push(`mined:${result.candidate.source}`);
      const project = result.candidate.project ?? args.project;
      try {
        const storeResult = await handleStore({
          title: result.candidate.title,
          content: result.candidate.content,
          kind: result.candidate.kind,
          tags,
          summary: result.candidate.summary,
          guidance: result.candidate.guidance,
          project,
          model: args.model,
        }, repo, embeddingConfig, config, gitVersioning);
        const storedId = extractStoredId(storeResult);
        if (storedId) {
          result.storedId = storedId;
        } else {
          result.error = storeResult;
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  let output = `## Mining Candidates (${args.candidates.length})\n\n`;
  if (!embeddingsAvailable) {
    output += '⚠ Embeddings disabled — dedup accuracy reduced (SimHash + FTS5 only).\n\n';
  }

  for (const result of results) {
    const tags = result.candidate.tags?.length ? ` | Tags: ${result.candidate.tags.join(', ')}` : '';
    output += `### [${result.index}] "${result.candidate.title}" (${result.candidate.kind})\n`;
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
    output += '\nTo store confirmed candidates: call again with dry_run=false';
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
