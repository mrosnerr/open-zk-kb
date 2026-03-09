// tests/harness.ts - Test harness for zettelkasten-mcp integration tests
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NoteRepository } from '../src/storage/NoteRepository.js';
import type { AppConfig } from '../src/types.js';

export interface TestContext {
  tempDir: string;
  engine: NoteRepository;
  config: AppConfig;
}

export function createTestHarness(): TestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));

  const config: AppConfig = {
    logLevel: 'ERROR',
    vault: tempDir,
    lifecycle: {
      reviewAfterDays: 14,
      promotionThreshold: 2,
      exemptKinds: ['personalization', 'decision'],
    },
  };

  const engine = new NoteRepository(tempDir);

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
  const fileName = filename || `${id}-${content.split('\n')[0].replace('# ', '').toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 40)}.md`;
  const filePath = path.join(context.tempDir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function readNoteFile(context: TestContext, filename: string): string {
  const filePath = path.join(context.tempDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Note file not found: ${filename}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

export function noteFileExists(context: TestContext, filename: string): boolean {
  return fs.existsSync(path.join(context.tempDir, filename));
}

export function listNoteFiles(context: TestContext): string[] {
  return fs.readdirSync(context.tempDir)
    .filter(f => f.endsWith('.md'))
    .sort();
}

export function getNoteCount(context: TestContext): number {
  return listNoteFiles(context).length;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
