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
import { renderNoteForSearch, renderNoteForAgent } from './prompts.js';
import { buildIndexContent, buildGlobalIndexContent, buildGeneralIndexContent, buildPreferencesIndexContent, buildGeneralKindIndexContent } from './storage/IndexBuilder.js';
import { buildLogEntry, buildInitialLogContent, appendToLogContent, buildGlobalLogEntry, buildInitialGlobalLogContent } from './storage/LogAppender.js';
import { buildReviewContent } from './storage/ReviewBuilder.js';
import { resolveNotePath, extractProjectFromTags as extractProjectTag, KIND_DIR_MAP } from './storage/path-resolver.js';
import { getPendingMigrations, getMigrationById } from './data-migrations.js';
import { logToFile } from './logger.js';
import { computeSimHash } from './utils/simhash.js';
import type { EmbeddingConfig } from './embeddings.js';
import { generateEmbedding, generateEmbeddingBatch, buildEmbeddingText } from './embeddings.js';
import { getLatestVersion, isNewerVersion } from './utils/version-check.js';
import { getAgentDocsTargets } from './agent-docs-targets.js';
import { injectAgentDocs, inspectAgentDocs } from './agent-docs.js';
import { detectClient, isVisibleToClient, getClientTags, clientTag, isKnownClient } from './client-heuristics.js';
import { getInstalledInstructionVersions } from './instruction-versions.js';
import { classifyModel, MODEL_HINT } from './model-capabilities.js';
import { extractFromUrl, extractArticle } from './url-extractor.js';
import type { ExtractionResult } from './url-extractor.js';
import { splitSections, extractLinks, countWords } from './content-splitter.js';
import { detectObsidian, launchObsidian, formatNotInstalledMessage, formatSuccessMessage } from './obsidian.js';
import { contractPath } from './utils/path.js';

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

// ---- Helper functions ----

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

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function getRecommendation(note: NoteMetadata, daysOld: number, promotionThreshold: number = 2): string {
  const accesses = note.access_count || 0;
  if (accesses >= promotionThreshold) return '2caa Promote';
  if (accesses === 0 && daysOld > 30) return '1f44 Archive';
  return '1f914 Review';
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
    const dirIndexPathRel = path.join(brokenTarget, 'index.md');
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
  telemetry?: boolean;
  dryRun?: boolean;
  model?: string;
}

export interface IngestArgs {
  url?: string;
  html?: string;
  model?: string;
}

export interface OverviewArgs {
  project: string;
  logEntries?: number;
  model?: string;
}

export interface OpenArgs {
  project?: string;
  _detectObsidian?: typeof detectObsidian;
  _launchObsidian?: typeof launchObsidian;
}

interface RelatedNote {
  id: string;
  title: string;
  kind: string;
  similarity?: number;
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

function formatTelemetryStats(repo: NoteRepository): string {
  const telemetry = repo.getTelemetryAggregates(30);
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
  output += `Last 30 days (${telemetry.sessions} sessions):\n`;
  output += `  Searches: ${telemetry.searches} (avg ${formatTelemetryNumber(avgSearches)} per session)\n`;
  output += `  Stores: ${telemetry.stores} (avg ${formatTelemetryNumber(avgStores)} per session)\n`;
  output += `  Store / search ratio: ${storeSearchRatio.toFixed(2)}\n`;
  output += `  Most-stored kind: ${mostStored ? `${mostStored[0]} (${mostStored[1]})` : 'none (0)'}\n`;
  output += `  Most-used action: ${mostUsedAction ? `${mostUsedAction[0]} (${mostUsedAction[1]})` : 'none (0)'}\n`;
  output += `  Avg session duration: ${formatTelemetryNumber(avgDurationMin)} min\n`;
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
      output += `⚠️ ${existing.length} note(s) already reference this URL:\n`;
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
  for (const tag of tags) {
    if (tag.startsWith('project:')) return tag.replace('project:', '');
  }
  return null;
}

function rebuildProjectIndex(project: string, repo: NoteRepository, config?: AppConfig): void {
  if (config?.navigation?.enableProjectIndex === false) return;

  try {
    const notes = repo.getProjectNotes(project);
    const splitConfig = config?.navigation ? {
      threshold: config.navigation.mocSplitThreshold,
      previewCount: config.navigation.mocPreviewCount,
    } : undefined;
    const { content, subMocs } = buildIndexContent(project, notes, splitConfig);
    const existingIndex = repo.getIndexNote(project);

    repo.store(content, {
      existingId: existingIndex?.id,
      title: `${project} Index`,
      kind: 'index',
      status: 'permanent',
      lifecycle: 'living',
      tags: [`project:${project}`],
      summary: `Auto-generated catalog of all ${project} notes`,
      guidance: 'Auto-generated project catalog — use knowledge-overview to view.',
    });

    if (subMocs.length > 0 && config?.vault) {
      for (const subMoc of subMocs) {
        const subMocDir = path.join(config.vault, 'projects', project, subMoc.dirName);
        if (!fs.existsSync(subMocDir)) fs.mkdirSync(subMocDir, { recursive: true });
        fs.writeFileSync(path.join(subMocDir, 'index.md'), subMoc.content, 'utf-8');
      }
    }

    if (config?.vault) {
      const projectDir = path.join(config.vault, 'projects', project);
      const activeSubMocs = new Set(subMocs.map(subMoc => subMoc.dirName));
      if (fs.existsSync(projectDir)) {
        for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const subIndexPath = path.join(projectDir, entry.name, 'index.md');
          if (!activeSubMocs.has(entry.name) && fs.existsSync(subIndexPath)) {
            fs.unlinkSync(subIndexPath);
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
}

function appendProjectLog(project: string, event: string, repo: NoteRepository, config?: AppConfig): void {
  if (config?.navigation?.enableProjectLog === false) return;

  try {
    const entry = buildLogEntry(event);
    const existingLog = repo.getLogNote(project);

    if (existingLog) {
      const existingContent = existingLog.content || '';
      const newContent = appendToLogContent(existingContent, entry);
      repo.store(newContent, {
        existingId: existingLog.id,
        title: `${project} Operations Log`,
        kind: 'log',
        status: 'permanent',
        lifecycle: 'append-only',
        tags: [`project:${project}`],
        summary: `Chronological operations log for ${project}`,
        guidance: 'Auto-generated operations log — use knowledge-overview to view recent activity.',
      });
    } else {
      const content = buildInitialLogContent(project, entry);
      repo.store(content, {
        title: `${project} Operations Log`,
        kind: 'log',
        status: 'permanent',
        lifecycle: 'append-only',
        tags: [`project:${project}`],
        summary: `Chronological operations log for ${project}`,
        guidance: 'Auto-generated operations log — use knowledge-overview to view recent activity.',
      });
    }
  } catch (error) {
    logToFile('WARN', 'Failed to append to project log', {
      project,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function updateProjectNavigation(
  project: string,
  event: string,
  repo: NoteRepository,
  config?: AppConfig,
): void {
  rebuildProjectIndex(project, repo, config);
  appendProjectLog(project, event, repo, config);
}

function updateGlobalNavigation(
  project: string | null,
  event: string,
  repo: NoteRepository,
  config?: AppConfig,
): void {
  const vaultPath = config?.vault;
  if (!vaultPath) return;
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
      const prefsCount = repo.getPersonalizationNotes().length;
      const generalCount = getUnscopedNotes().length;
      const fleetingCount = getFleetingNotes().length;
      const content = buildGlobalIndexContent(projectStats, prefsCount, generalCount, fleetingCount);
      fs.writeFileSync(path.join(vaultPath, 'index.md'), content, 'utf-8');
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
        const existing = fs.readFileSync(globalLogPath, 'utf-8');
        fs.writeFileSync(globalLogPath, appendToLogContent(existing, entry), 'utf-8');
      } else {
        fs.writeFileSync(globalLogPath, buildInitialGlobalLogContent(entry), 'utf-8');
      }
    } catch (error) {
      logToFile('WARN', 'Failed to append global log', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config?.navigation?.enableReviewMoc !== false) {
    try {
      const content = buildReviewContent(getFleetingNotes());
      fs.writeFileSync(path.join(vaultPath, 'review.md'), content, 'utf-8');
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
        fs.writeFileSync(path.join(generalDir, 'index.md'), content, 'utf-8');

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
          fs.writeFileSync(
            path.join(kindDir, 'index.md'),
            buildGeneralKindIndexContent(kind, kindNotes),
            'utf-8',
          );
        }

        if (fs.existsSync(generalDir)) {
          for (const entry of fs.readdirSync(generalDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const kindIndex = path.join(generalDir, entry.name, 'index.md');
            if (!notesByKindDir.has(entry.name) && fs.existsSync(kindIndex)) {
              fs.unlinkSync(kindIndex);
            }
          }
        }
      }
      if (unscopedNotes.length === 0) {
        const generalIndex = path.join(generalDir, 'index.md');
        if (fs.existsSync(generalIndex)) fs.unlinkSync(generalIndex);
        if (fs.existsSync(generalDir)) {
          for (const entry of fs.readdirSync(generalDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const kindIndex = path.join(generalDir, entry.name, 'index.md');
            if (fs.existsSync(kindIndex)) fs.unlinkSync(kindIndex);
          }
        }
      }

      const preferencesDir = path.join(vaultPath, 'preferences');
      if (personalizationNotes.length > 0) {
        if (!fs.existsSync(preferencesDir)) fs.mkdirSync(preferencesDir, { recursive: true });
        fs.writeFileSync(
          path.join(preferencesDir, 'index.md'),
          buildPreferencesIndexContent(personalizationNotes),
          'utf-8',
        );
      } else {
        const preferencesIndex = path.join(preferencesDir, 'index.md');
        if (fs.existsSync(preferencesIndex)) fs.unlinkSync(preferencesIndex);
      }
    } catch (error) {
      logToFile('WARN', 'Failed to rebuild general index', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---- Handlers ----

export async function handleStore(args: StoreArgs, repo: NoteRepository, embeddingConfig?: EmbeddingConfig | null, config?: AppConfig): Promise<string> {
  const effectiveStatus = toNoteStatus(args.status, KIND_DEFAULT_STATUS[args.kind]);
  const lifecycleDefaults = config?.lifecycleDefaults;
  const kindDefault = (lifecycleDefaults?.defaultForKind?.[args.kind] as Lifecycle | undefined) || KIND_DEFAULT_LIFECYCLE[args.kind];
  const lifecycleExplicit = typeof args.lifecycle === 'string' && VALID_LIFECYCLES.has(args.lifecycle);
  let effectiveLifecycle = toLifecycle(args.lifecycle, kindDefault);
  if (!lifecycleExplicit && lifecycleDefaults?.detectSnapshotFromSlug !== false && /\d{4}-\d{2}-\d{2}/.test(args.title)) {
    effectiveLifecycle = 'snapshot';
  }
  const tags = [...(args.tags || [])];

  if (args.project) {
    const projectTag = `project:${args.project}`;
    if (!tags.includes(projectTag)) {
      tags.push(projectTag);
    }
  }

  if (STRUCTURAL_KINDS.has(args.kind)) {
    return `Error: ${args.kind} notes are auto-generated per project. Use knowledge-overview to view them.`;
  }

  if (args.kind === 'domain') {
    if (!args.project) {
      return 'Error: Domain notes require a project parameter. A domain note is a project operating manual — it must be scoped to a specific project.';
    }
    const existingDomain = repo.getDomainNote(args.project);
    if (existingDomain) {
      return `A domain note already exists for project "${args.project}" [${existingDomain.id}]: "${existingDomain.title}". Update the existing note instead of creating a duplicate.`;
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

  const result = repo.store(content, {
    title: args.title,
    kind: args.kind,
    status: effectiveStatus,
    lifecycle: effectiveLifecycle,
    tags,
    summary: args.summary,
    guidance: args.guidance,
    related: args.related,
  });

  scheduleTelemetryWrite('store', () => repo.recordToolInvocation('store', args.kind, 1));

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
          .map(n => ({ id: n.id, title: n.title, kind: n.kind, similarity: n.similarity }));
      } else {
        // FTS5 fallback — use title + summary as query
        const queryText = [args.title, args.summary].filter(Boolean).join(' ');
        if (queryText.trim()) {
          const ftsResults = repo.search(queryText, { limit: fetchLimit });
          relatedNotes = ftsResults
            .filter(n => isCandidate(n))
            .slice(0, maxResults)
            .map(n => ({ id: n.id, title: n.title, kind: n.kind }));
        }
      }
    } catch (error) {
      logToFile('WARN', 'Related notes lookup failed', {
        noteId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let output = `Knowledge stored (${result.action})\n`;
  output += `ID: ${result.id}\n`;
  output += `Kind: ${args.kind}\n`;
  output += `Status: ${effectiveStatus}\n`;
  output += `Lifecycle: ${effectiveLifecycle}\n`;
  output += `Path: ${result.path}`;

  const wordCount = countWords(args.content);
  const warning = atomicityWarning(args.kind, wordCount);
  if (warning) {
    output += warning;
  }

  if (relatedNotes.length > 0) {
    output += '\n\nRelated notes:';
    for (const rn of relatedNotes) {
      const sim = rn.similarity != null ? `, similarity: ${rn.similarity.toFixed(2)}` : '';
      output += `\n- [${rn.id}] "${rn.title}" (${rn.kind}${sim})`;
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

  if (args.project) {
    updateProjectNavigation(args.project, `Created ${args.kind}: "${args.title}"`, repo, config);
  }
  updateGlobalNavigation(args.project || null, `Stored ${args.kind}: "${args.title}"`, repo, config);

  return output;
}

export function handleSearch(args: SearchArgs, repo: NoteRepository, queryEmbedding?: number[] | null, config?: AppConfig): string {
  let results = repo.searchHybrid(args.query, queryEmbedding || null, {
    kind: args.kind,
    status: args.status ? toNoteStatus(args.status, 'fleeting') : undefined,
    tags: args.tags,
    limit: args.limit || 10,
  });

  if (config?.search?.excludeLogFromSearch !== false && !STRUCTURAL_KINDS.has(args.kind as string)) {
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
      return tags.some(t => t === projectPrefix || t.startsWith(projectPrefix));
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

  const accessedIds = [...(domainNote ? [domainNote.id] : []), ...results.map(note => note.id)];
  scheduleTelemetryWrite('search invocation', () => repo.recordToolInvocation('search', undefined, accessedIds.length));
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

export async function handleMaintain(args: MaintainArgs, repo: NoteRepository, config: AppConfig, embeddingConfig?: EmbeddingConfig | null, currentVersion?: string): Promise<string> {
  scheduleTelemetryWrite('maintain', () => repo.recordToolInvocation('maintain', args.action));
  switch (args.action) {
    case 'stats': {
      const stats = repo.getStats();
      const kindStats = repo.getStatsByKind();
      const upgradeStatus = repo.getUpgradeStatus();
      const embeddingStats = repo.getEmbeddingStats();
      let output = '# Knowledge Base Statistics\n\n';
      output += `## Vault (${stats.total} notes)\n`;
      output += `- Fleeting: ${stats.fleeting}\n`;
      output += `- Permanent: ${stats.permanent}\n`;
      output += `- Archived: ${stats.archived}\n`;
      if (stats.other > 0) {
        output += `- Other (unknown status): ${stats.other}\n`;
      }
      output += '\n## By Kind\n';
      for (const [kind, s] of Object.entries(kindStats)) {
        output += `- **${kind}**: ${s.total} total\n`;
      }
      if (stats.total > 0 && config.vault) {
        const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER);
        const flatCount = allNotes.filter(n => {
          const rel = path.relative(config.vault, n.path);
          return !rel.includes(path.sep) || rel.startsWith('..');
        }).length;
        const structuredCount = allNotes.length - flatCount;

        output += '\n## Vault Layout\n';
        if (flatCount > 0 && structuredCount === 0) {
          output += `- Layout: flat (all ${allNotes.length} notes in vault root)\n`;
          output += '- MigrationAvailable: true (action: migrate-layout)\n';
        } else if (flatCount > 0 && structuredCount > 0) {
          output += `- Layout: mixed (${structuredCount} structured, ${flatCount} flat)\n`;
          output += `- MigrationAvailable: true (action: migrate-layout, ${flatCount} flat notes remaining)\n`;
        } else {
          output += `- Layout: structured (${structuredCount} notes in kind-based directories)\n`;
        }
      }

      if (embeddingStats.total > 0 || embeddingConfig) {
        output += '\n## Embeddings\n';
        if (embeddingConfig) {
          output += `- Provider: ${embeddingConfig.provider} (${embeddingConfig.model})\n`;
        }
        output += `- Embedded: ${embeddingStats.withEmbedding}/${embeddingStats.total} notes\n`;
      }
      if (upgradeStatus.needsSummary > 0 || upgradeStatus.needsGuidance > 0) {
        output += '\n## Upgrade Status\n';
        output += `- Notes missing summary: ${upgradeStatus.needsSummary}/${upgradeStatus.total}\n`;
        output += `- Notes missing guidance: ${upgradeStatus.needsGuidance}/${upgradeStatus.total}\n`;
      }
      if (stats.total > 0) {
        const recentNotes = repo.getRecentNotes(5);
        output += '\n## Recent Notes\n';
        for (const note of recentNotes) {
          const status = note.status === 'permanent' ? '🔒' : note.status === 'archived' ? '📦' : '📝';
          output += `- ${status} **${note.title}** (${note.kind})\n`;
        }
        if (stats.total > 5) {
          output += `\nShowing 5 of ${stats.total}. Use \`knowledge-search\` to find specific notes.\n`;
        }
      }
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

        // Show instruction versions for installed clients
        const installedInstructions = getInstalledInstructionVersions();
        if (installedInstructions.length > 0) {
          output += '- Instructions:\n';
          for (const inst of installedInstructions) {
            const versionDisplay = inst.instructionVersion || 'unknown';
            let statusIcon: string;
            if (!inst.instructionVersion) {
              statusIcon = '?';  // Unknown version
            } else if (latest && isNewerVersion(inst.instructionVersion, latest)) {
              statusIcon = '⚠️';  // Outdated
            } else {
              statusIcon = '✓';  // Up to date
            }
            output += `  - ${inst.name}: ${versionDisplay} ${statusIcon}\n`;
          }
        }

        if (latest && isNewerVersion(currentVersion, latest)) {
          output += `\n**Update**: \`bunx open-zk-kb@latest install --client <name> --force\`\n`;
        }
      }
      if (args.telemetry) {
        output += formatTelemetryStats(repo);
      }
      return output;
    }
    case 'promote': {
      if (!args.noteId) return 'Error: noteId is required for promote action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      repo.promoteToPermanent(args.noteId);
      if (!STRUCTURAL_KINDS.has(note.kind)) {
        const project = extractProjectFromTags(Array.isArray(note.tags) ? note.tags : []);
        if (project) {
          updateProjectNavigation(project, `Promoted "${note.title}" from fleeting to permanent`, repo, config);
        }
        updateGlobalNavigation(project, `Promoted "${note.title}"`, repo, config);
      }
      return `Promoted "${note.title}" (${args.noteId}) to permanent status.`;
    }
    case 'archive': {
      if (!args.noteId) return 'Error: noteId is required for archive action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      repo.archive(args.noteId);
      if (!STRUCTURAL_KINDS.has(note.kind)) {
        const project = extractProjectFromTags(Array.isArray(note.tags) ? note.tags : []);
        if (project) {
          updateProjectNavigation(project, `Archived "${note.title}"`, repo, config);
        }
        updateGlobalNavigation(project, `Archived "${note.title}"`, repo, config);
      }
      return `Archived "${note.title}" (${args.noteId}).`;
    }
    case 'delete': {
      if (!args.noteId) return 'Error: noteId is required for delete action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      repo.remove(args.noteId);
      if (!STRUCTURAL_KINDS.has(note.kind)) {
        const project = extractProjectFromTags(Array.isArray(note.tags) ? note.tags : []);
        if (project) {
          updateProjectNavigation(project, `Deleted "${note.title}"`, repo, config);
        }
        updateGlobalNavigation(project, `Deleted "${note.title}"`, repo, config);
      }
      return `Deleted "${note.title}" (${args.noteId}).`;
    }
    case 'rebuild': {
      const result = repo.rebuildFromFiles();
      const projects = repo.getAllProjects();
      for (const project of projects) {
        rebuildProjectIndex(project, repo, config);
        appendProjectLog(project, 'Full DB rebuild', repo, config);
      }
      updateGlobalNavigation(null, 'Full DB rebuild', repo, config);
      return `Indexed ${result.indexed} notes, ${result.errors} errors\nRebuilt index for ${projects.length} project(s).\nRebuild complete.`;
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
      const queue = repo.getReviewQueue(args.filter, daysThreshold, limit, config.lifecycle.promotionThreshold, config.lifecycle.exemptKinds);

      const archiveDays = Math.max(1, config.lifecycle.autoArchiveFleetingDays);
      const archiveCutoff = Date.now() - (archiveDays * 24 * 60 * 60 * 1000);
      
      let output = '## Review Queue\n\n';
      
      const hasFleeting = queue.fleeting.total > 0;
      const hasPermanent = queue.permanent.total > 0;
      
      if (!hasFleeting && !hasPermanent) {
        return 'No notes pending review. All notes are up to date!';
      }
      
      if (hasFleeting) {
        const nonStaleNotes = queue.fleeting.notes.filter(n => n.created_at >= archiveCutoff);
        const staleInQueue = queue.fleeting.notes.length - nonStaleNotes.length;

        if (nonStaleNotes.length > 0) {
          output += `### Fleeting Notes for Review (${nonStaleNotes.length} total`;
          output += ')\n';

          for (let i = 0; i < nonStaleNotes.length; i++) {
            const note = nonStaleNotes[i];
            const daysOld = Math.floor((Date.now() - note.created_at) / (1000 * 60 * 60 * 24));
            const accessInfo = note.access_count === 0 ? 'never accessed' : `${note.access_count} access${note.access_count === 1 ? '' : 'es'}`;
            const rec = getRecommendation(note, daysOld, config.lifecycle.promotionThreshold);
            output += `${i + 1}. "${note.title}" | ${formatDate(note.created_at)} | ${accessInfo} | ${rec}\n`;
          }

          if (staleInQueue > 0) {
            output += `\n${staleInQueue} older note(s) moved to "Stale Fleeting Notes" below.\n`;
          }
          output += '\n';
        }
      }
      
      if (hasPermanent) {
        output += `### Permanent Notes for Review (${queue.permanent.total} total`;
        if (queue.permanent.notes.length < queue.permanent.total) {
          output += `, showing ${queue.permanent.notes.length}`;
        }
        output += ')\n';
        
        for (let i = 0; i < queue.permanent.notes.length; i++) {
          const note = queue.permanent.notes[i];
          output += `${i + 1}. "${note.title}" | ${formatDate(note.created_at)} | never accessed | 2999 Review relevance\n`;
        }
        
        if (queue.permanent.total > queue.permanent.notes.length) {
          output += `\n... ${queue.permanent.total - queue.permanent.notes.length} more. Use \`--filter permanent --limit 10\` to see all.\n`;
        }
        output += '\n';
      }
      
      // Flag oversized notes that may need splitting
      const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER);
      const oversized = allNotes
        .filter(n => n.status !== 'archived')
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

      const staleForArchive = allNotes
        .filter(n => n.status === 'fleeting' && n.created_at < archiveCutoff);

      if (staleForArchive.length > 0) {
        output += `### Stale Fleeting Notes (${staleForArchive.length} older than ${archiveDays} days)\n`;
        output += 'These fleeting notes were never promoted. Consider archiving:\n\n';
        for (const n of staleForArchive) {
          const daysOld = Math.floor((Date.now() - n.created_at) / (1000 * 60 * 60 * 24));
          output += `- "${n.title}" (${n.kind}) — ${daysOld} days old [${n.id}]\n`;
        }
        output += '\n';
      }

      output += '## Next Steps:\n';
      let stepIdx = 65;
      if (hasFleeting) output += `[${String.fromCharCode(stepIdx++)}] Show all fleeting notes for review\n`;
      if (hasPermanent) output += `[${String.fromCharCode(stepIdx++)}] Show all permanent notes for review\n`;
      output += `[${String.fromCharCode(stepIdx++)}] Promote specific note to permanent (requires --noteId)\n`;
      output += `[${String.fromCharCode(stepIdx++)}] Archive specific note (requires --noteId)\n`;
      if (oversized.length > 0) output += `[${String.fromCharCode(stepIdx++)}] Split an oversized note into atomic notes\n`;
      if (staleForArchive.length > 0) output += `[${String.fromCharCode(stepIdx)}] Archive stale fleeting notes\n`;

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
            const marker = isPermanent ? '🔒 (permanent - protected)' : (i === 0 ? '(keep)' : '(duplicate)');
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
            const marker = isPermanent ? '🔒 (permanent - protected)' : (i === 0 ? '(keep)' : '(near-duplicate)');
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
      output += '\n⚠️ Permanent notes (🔒) are never auto-archived. Promote the best version before archiving others.\n';

      return output;
    }
    case 'embed': {
      if (!embeddingConfig) {
        return 'Embedding not configured. Add provider + embeddings section to config.yaml to enable vector search.';
      }

      const notesWithout = repo.getNotesWithoutEmbeddings(args.limit || 50);
      if (notesWithout.length === 0) {
        return 'All notes already have embeddings. Nothing to backfill.';
      }

      if (args.dryRun) {
        return `Dry run: Would generate embeddings for ${notesWithout.length} notes using ${embeddingConfig.model}.`;
      }

      const texts = notesWithout.map(n => buildEmbeddingText(n.title, n.summary || '', n.content));
      const noteIds = notesWithout.map(n => n.id);

      try {
        const results = await generateEmbeddingBatch(texts, embeddingConfig, 60000);
        let stored = 0;
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result) {
            repo.storeEmbedding(noteIds[i], result.embedding, result.model);
            stored++;
          }
        }
        logToFile('INFO', 'Embed backfill completed', { requested: noteIds.length, stored });
        return `Embedded ${stored}/${notesWithout.length} notes using ${embeddingConfig.model}.`;
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
            const result = injectAgentDocs(target.filePath, target.instructionSize, false, target.client, currentVersion);
            output += `- Result: ${result.action}\n\n`;
          }
          continue;
        }

        if (inspection.status === 'multiple-markers') {
          output += '- Result: manual review recommended; skipped to avoid touching ambiguous content\n\n';
          continue;
        }

        if (dryRun) {
          output += '- Result: would repair markers and append a fresh managed block while preserving other content\n\n';
        } else {
          const result = injectAgentDocs(target.filePath, target.instructionSize, false, target.client, currentVersion);
          output += `- Result: ${result.action}\n\n`;
        }
      }

      output += `dryRun: ${dryRun} — ${dryRun ? 'no changes applied. Set dryRun: false to apply repairs.' : 'repairs applied.'}`;
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
    case 'orphans': {
      const orphans = repo.getOrphanNotes();
      if (orphans.length === 0) {
        return 'No orphan notes found. All non-archived notes have at least one incoming or outgoing wikilink.';
      }

      let output = `## Orphan Notes (${orphans.length})\n\n`;
      output += 'Notes with no incoming or outgoing wikilinks:\n\n';
      for (const note of orphans) {
        const wordCount = countWords(note.content || '');
        output += `- "${note.title}" [${note.id}] | ${note.kind} | ${note.status} | ${wordCount} words\n`;
      }
      output += '\n## Next Steps\n';
      output += '[A] Add wikilinks to connect orphan notes to related notes\n';
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
    case 'migrate-layout': {
      const dryRun = args.dryRun !== false;
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
        output += '- Navigation: index.md, log.md, review.md, and per-directory indexes will be auto-generated\n';
      } else if (!dryRun && moved > 0) {
        const emptyDirsRemoved = config.vault ? removeEmptyDirsRecursive(config.vault, true) : 0;
        if (emptyDirsRemoved > 0) {
          output += `Empty directories removed: ${emptyDirsRemoved}\n`;
        }

        const rebuildResult = repo.rebuildFromFiles();
        const projects = repo.getAllProjects();
        for (const proj of projects) {
          rebuildProjectIndex(proj, repo, config);
        }
        output += `\nPost-migration rebuild: indexed ${rebuildResult.indexed} notes, rebuilt ${projects.length} project index(es).`;
        updateGlobalNavigation(null, 'Layout migration completed', repo, config);

        const embeddingStats = repo.getEmbeddingStats();
        const brokenLinks = filterFalsePositiveBrokenLinks(repo.getBrokenLinks(), config?.vault);

        output += '\n\n## Health Summary\n';
        if (embeddingStats.withoutEmbedding > 0) {
          output += `Embeddings: ${embeddingStats.withoutEmbedding}/${embeddingStats.total} notes need backfill (run \`knowledge-maintain embed\`)\n`;
        }
        if (brokenLinks.length > 0) {
          output += `Link health: ${brokenLinks.length} broken wikilinks found (run \`knowledge-maintain broken-links\` for details)\n`;
        } else {
          output += 'Link health: all links resolve ✓\n';
        }

        output += '\n## Next Steps\n';
        if (embeddingStats.withoutEmbedding > 0) {
          output += '- Backfill embeddings: knowledge-maintain embed\n';
        }
        output += '- Check link health: knowledge-maintain broken-links\n';
        output += '- View vault stats: knowledge-maintain stats\n';
      }

      return output;
    }
    default:
      return `Unknown action: ${args.action}`;
  }
}

export function handleOverview(args: OverviewArgs, repo: NoteRepository, config?: AppConfig): string {
  const project = args.project;
  const logLimit = Math.max(1, args.logEntries ?? config?.navigation?.overviewLogEntryLimit ?? 10);

  const indexNote = repo.getIndexNote(project);
  const logNote = repo.getLogNote(project);
  const domainNote = repo.getDomainNote(project);

  if (!indexNote && !logNote && !domainNote) {
    return `No navigation notes found for project "${project}". Store a project-scoped note first (include project parameter).`;
  }

  let output = `## Project Overview: ${project}\n\n`;

  if (domainNote) {
    output += '### Domain\n';
    output += renderNoteForAgent(domainNote) + '\n\n';
    scheduleTelemetryWrite('overview access', () => repo.recordAccess(domainNote.id));
  }

  if (indexNote) {
    output += '### Index\n';
    const content = indexNote.content || '(empty index)';
    output += content + '\n\n';
  } else {
    output += '### Index\n(not yet generated — store a project-scoped note to trigger)\n\n';
  }

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
  } else {
    output += '### Recent Activity\n(not yet generated — store a project-scoped note to trigger)\n';
  }

  if (!args.model) {
    output += MODEL_HINT;
  }

  return output;
}

export function handleOpen(args: OpenArgs, config: AppConfig, repo?: NoteRepository): string {
  const vaultPath = config.vault;

  if (!fs.existsSync(vaultPath)) {
    return `Vault directory does not exist yet: ${contractPath(vaultPath)}\nStore a note first to create the vault, then try again.`;
  }

  const detect = args._detectObsidian || detectObsidian;
  const detection = detect();

  if (!detection.installed) {
    return formatNotInstalledMessage(vaultPath);
  }

  let filePath: string | undefined;
  let resolvedProject: string | undefined;
  if (args.project && repo) {
    const indexNote = repo.getIndexNote(args.project);
    if (indexNote?.path) {
      const noteFilename = path.basename(indexNote.path);
      filePath = noteFilename.replace(/\.md$/, '');
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
