// tests/harness.ts - Test harness for zettelkasten-mcp integration tests
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NoteRepository } from '../src/storage/NoteRepository.js';
import { walkMarkdownFiles } from '../src/storage/path-resolver.js';
import type { AppConfig } from '../src/types.js';
import { KIND_DEFAULT_LIFECYCLE } from '../src/types.js';

export interface TestContext {
  tempDir: string;
  engine: NoteRepository;
  config: AppConfig;
}

export interface TestHarnessOptions {
  telemetryEnabled?: boolean;
}

export function createTestHarness(options: TestHarnessOptions = {}): TestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));

  const config: AppConfig = {
    logLevel: 'ERROR',
    vault: tempDir,
    lifecycle: {
      reviewAfterDays: 14,
      promotionThreshold: 2,
      exemptKinds: ['personalization', 'decision'],
      autoArchiveFleetingDays: 90,
    },
    lifecycleDefaults: {
      defaultForKind: { ...KIND_DEFAULT_LIFECYCLE },
      detectSnapshotFromSlug: true,
    },
    search: {
      alwaysIncludeDomainNote: true,
      excludeLogFromSearch: true,
    },
    store: {
      relatedNotes: {
        enabled: true,
        maxResults: 5,
        minSimilarity: 0.70,
        excludeKinds: ['domain', 'index', 'log'],
      },
    },
    navigation: {
      enableProjectIndex: true,
      enableProjectLog: true,
      enableGlobalIndex: true,
      enableGlobalLog: true,
      enableReviewMoc: true,
      mocSplitThreshold: 30,
      mocPreviewCount: 5,
      overviewLogEntryLimit: 10,
    },
    telemetry: {
      enabled: options.telemetryEnabled ?? false,
    },
  };

  const engine = new NoteRepository(tempDir, { telemetryEnabled: config.telemetry.enabled });

  return { tempDir, engine, config };
}

export function cleanupTestHarness(context: TestContext): void {
  context.engine.close();

  if (fs.existsSync(context.tempDir)) {
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
}

export function createNoteFile(
  context: TestContext,
  id: string,
  content: string,
  filename?: string
): string {
  const actualFilename = filename || `${id}-${content.split('\n')[0].replace('# ', '').toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 40)}.md`;
  const filePath = path.join(context.tempDir, actualFilename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function readNoteFile(context: TestContext, filenameOrRelPath: string): string {
  const directPath = path.join(context.tempDir, filenameOrRelPath);
  if (fs.existsSync(directPath)) return fs.readFileSync(directPath, 'utf-8');

  const allFiles = walkMarkdownFiles(context.tempDir);
  const matches = allFiles.filter(p => path.basename(p) === filenameOrRelPath);
  if (matches.length === 1) return fs.readFileSync(matches[0], 'utf-8');
  if (matches.length > 1) throw new Error(`Ambiguous note lookup: ${filenameOrRelPath} matches ${matches.length} files`);

  throw new Error(`Note file not found: ${filenameOrRelPath}`);
}

export function noteFileExists(context: TestContext, filenameOrRelPath: string): boolean {
  if (fs.existsSync(path.join(context.tempDir, filenameOrRelPath))) return true;

  const allFiles = walkMarkdownFiles(context.tempDir);
  return allFiles.filter(p => path.basename(p) === filenameOrRelPath).length === 1;
}

export function listNoteFiles(context: TestContext): string[] {
  return fs.readdirSync(context.tempDir)
    .filter(f => f.endsWith('.md'))
    .sort();
}

export function listAllNoteFiles(context: TestContext): string[] {
  return walkMarkdownFiles(context.tempDir)
    .map(p => path.relative(context.tempDir, p))
    .sort();
}

export function getNoteCount(context: TestContext): number {
  return listAllNoteFiles(context).length;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
