// agent-docs.ts - Inject/remove managed agent instruction blocks in client docs files
//
// Each supported client has a global "agent docs" file (e.g. ~/.claude/CLAUDE.md)
// where we insert a managed block between sentinel comments. The block teaches the
// agent how to use the open-zk-kb MCP tools effectively.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export type InstructionSize = 'compact' | 'full';

const START_MARKER = '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->';
const END_MARKER = '<!-- OPEN-ZK-KB:END -->';

function loadAgentDocsTemplate(size: InstructionSize = 'full'): string {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const filename = size === 'compact' ? 'agent-instructions-compact.md' : 'agent-instructions-full.md';
  const instructionsPath = path.join(projectRoot, filename);
  const content = fs.readFileSync(instructionsPath, 'utf-8').trimEnd();
  return `${START_MARKER}\n${content}\n${END_MARKER}`;
}

function spliceManagedBlock(content: string, replacement: string): string {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    return content.slice(0, startIdx) + replacement + content.slice(endIdx + END_MARKER.length);
  }

  if (startIdx !== -1) {
    return content.slice(0, startIdx) + replacement;
  }

  if (endIdx !== -1) {
    return replacement + content.slice(endIdx + END_MARKER.length);
  }

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : content.length > 0 ? '\n' : '';
  return content + separator + replacement + '\n';
}

function joinRemainingContent(before: string, after: string): string {
  const left = before.replace(/\s*$/, '');
  const right = after.replace(/^\s*/, '');

  if (left && right) return `${left}\n\n${right}`;
  return left || right;
}

/**
 * Inject the managed agent docs block into a file.
 * If the file already contains the block, it is replaced (updated).
 * If the file doesn't exist, it is created.
 * Content outside the managed block is preserved.
 */
export function injectAgentDocs(filePath: string, size: InstructionSize = 'full', dryRun?: boolean): { action: 'created' | 'updated' | 'unchanged'; filePath: string } {
  let existing = '';
  const fileExists = fs.existsSync(filePath);

  if (fileExists) {
    existing = fs.readFileSync(filePath, 'utf-8');
  }

  let newContent: string;
  let action: 'created' | 'updated' | 'unchanged';
  const template = loadAgentDocsTemplate(size);

  if (existing.includes(START_MARKER) || existing.includes(END_MARKER)) {
    const candidate = spliceManagedBlock(existing, template);

    if (candidate === existing) {
      return { action: 'unchanged', filePath };
    }

    newContent = candidate;
    action = 'updated';
  } else if (fileExists) {
    newContent = spliceManagedBlock(existing, template);
    action = 'updated';
  } else {
    newContent = template + '\n';
    action = 'created';
  }

  if (!dryRun) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, newContent, 'utf-8');
  }

  return { action, filePath };
}

/**
 * Remove the managed agent docs block from a file.
 * Content outside the managed block is preserved.
 * If the file becomes empty (or whitespace-only) after removal, it is deleted.
 */
export function removeAgentDocs(filePath: string, dryRun?: boolean): { action: 'removed' | 'not-found' | 'file-deleted'; filePath: string } {
  if (!fs.existsSync(filePath)) {
    return { action: 'not-found', filePath };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 && endIdx === -1) {
    return { action: 'not-found', filePath };
  }

  let removeStart = 0;
  let removeEnd = content.length;

  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    removeStart = startIdx;
    removeEnd = endIdx + END_MARKER.length;
  } else if (startIdx !== -1) {
    removeStart = startIdx;
  } else if (endIdx !== -1) {
    removeEnd = endIdx + END_MARKER.length;
  }

  const before = content.slice(0, removeStart);
  const after = content.slice(removeEnd);

  const newContent = joinRemainingContent(before, after);

  if (!dryRun) {
    if (newContent.trim().length === 0) {
      fs.unlinkSync(filePath);
      return { action: 'file-deleted', filePath };
    }
    fs.writeFileSync(filePath, newContent + '\n', 'utf-8');
  } else if (newContent.trim().length === 0) {
    return { action: 'file-deleted', filePath };
  }

  return { action: 'removed', filePath };
}
