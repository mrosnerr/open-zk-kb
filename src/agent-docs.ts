// agent-docs.ts - Inject/remove managed agent instruction blocks in client docs files
//
// Each supported client has a global "agent docs" file (e.g. ~/.claude/CLAUDE.md)
// where we insert a managed block between sentinel comments. The block teaches the
// agent how to use the open-zk-kb MCP tools effectively.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export type InstructionSize = 'compact' | 'full';
export type AgentDocsStatus = 'missing' | 'healthy' | 'start-only' | 'end-only' | 'out-of-order' | 'multiple-markers';

export interface AgentDocsInspection {
  filePath: string;
  exists: boolean;
  status: AgentDocsStatus;
  startCount: number;
  endCount: number;
}

// Start marker prefix - used for detection (matches both versioned and unversioned)
const START_MARKER_PREFIX = '<!-- OPEN-ZK-KB:START';
const START_MARKER_SUFFIX = ' -- managed by open-zk-kb, do not edit -->';
const END_MARKER = '<!-- OPEN-ZK-KB:END -->';

// Regex to match start marker with optional version: <!-- OPEN-ZK-KB:START v1.0.0 -- managed... -->
const START_MARKER_REGEX = /<!-- OPEN-ZK-KB:START(?: v[\d.]+)? -- managed by open-zk-kb, do not edit -->/g;

function buildStartMarker(version?: string): string {
  if (version) {
    return `${START_MARKER_PREFIX} v${version}${START_MARKER_SUFFIX}`;
  }
  return `${START_MARKER_PREFIX}${START_MARKER_SUFFIX}`;
}

/**
 * Find the start marker in content (handles versioned and unversioned markers).
 * Returns { index, length } or null if not found.
 */
function findStartMarker(content: string): { index: number; length: number; fullMatch: string } | null {
  const regex = new RegExp(START_MARKER_REGEX.source);
  const match = regex.exec(content);
  if (!match) return null;
  return { index: match.index, length: match[0].length, fullMatch: match[0] };
}

/**
 * Count occurrences of start markers (versioned or unversioned).
 */
function countStartMarkers(content: string): number {
  const matches = content.match(START_MARKER_REGEX);
  return matches ? matches.length : 0;
}

/**
 * Extract the version from a managed block's start marker.
 * Returns null if no version is found or marker doesn't exist.
 */
export function extractManagedBlockVersion(content: string): string | null {
  const match = content.match(/<!-- OPEN-ZK-KB:START v([\d.]+)/);
  return match ? match[1] : null;
}

/**
 * Get the instruction version from an installed agent docs file.
 * Returns null if file doesn't exist or has no version.
 */
export function getAgentDocsVersion(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  return extractManagedBlockVersion(content);
}

function loadAgentDocsTemplate(size: InstructionSize = 'full', clientName?: string, version?: string): string {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const filename = size === 'compact' ? 'agent-instructions-compact.md' : 'agent-instructions-full.md';
  const instructionsPath = path.join(projectRoot, filename);
  let content = fs.readFileSync(instructionsPath, 'utf-8').trimEnd();
  if (clientName) {
    content = content.replace(/\{\{CLIENT_NAME\}\}/g, clientName);
  }
  const startMarker = buildStartMarker(version);
  return `${startMarker}\n${content}\n${END_MARKER}`;
}

function countOccurrences(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

function inspectAgentDocsContent(content: string): Omit<AgentDocsInspection, 'filePath' | 'exists'> {
  const startCount = countStartMarkers(content);
  const endCount = countOccurrences(content, END_MARKER);
  const startMatch = findStartMarker(content);
  const startIdx = startMatch?.index ?? -1;
  const endIdx = content.indexOf(END_MARKER);

  let status: AgentDocsStatus;
  if (startCount === 0 && endCount === 0) {
    status = 'missing';
  } else if (startCount === 1 && endCount === 1 && startIdx < endIdx) {
    status = 'healthy';
  } else if (startCount === 1 && endCount === 0) {
    status = 'start-only';
  } else if (startCount === 0 && endCount === 1) {
    status = 'end-only';
  } else if (startCount === 1 && endCount === 1) {
    status = 'out-of-order';
  } else {
    status = 'multiple-markers';
  }

  return { status, startCount, endCount };
}

function stripManagedMarkers(content: string): string {
  return content
    .replace(START_MARKER_REGEX, '')
    .split(END_MARKER).join('')
    .replace(/\n{3,}/g, '\n\n');
}

export function inspectAgentDocs(filePath: string): AgentDocsInspection {
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      status: 'missing',
      startCount: 0,
      endCount: 0,
    };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return {
    filePath,
    exists: true,
    ...inspectAgentDocsContent(content),
  };
}

function spliceManagedBlock(content: string, replacement: string): string {
  const startMatch = findStartMarker(content);
  const startIdx = startMatch?.index ?? -1;
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    return content.slice(0, startIdx) + replacement + content.slice(endIdx + END_MARKER.length);
  }

  if (startIdx !== -1) {
    return content.slice(0, startIdx) + replacement;
  }

  if (endIdx !== -1) {
    const cleaned = joinRemainingContent(
      content.slice(0, endIdx),
      content.slice(endIdx + END_MARKER.length)
    );
    return appendManagedBlock(cleaned, replacement);
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

function appendManagedBlock(content: string, replacement: string): string {
  const separator = content.length > 0 ? '\n\n' : '';
  return `${content}${separator}${replacement}\n`;
}

/**
 * Inject the managed agent docs block into a file.
 * If the file already contains the block, it is replaced (updated).
 * If the file doesn't exist, it is created.
 * Content outside the managed block is preserved.
 * @param version - Version string to embed in the start marker (e.g., "1.0.0")
 */
export function injectAgentDocs(filePath: string, size: InstructionSize = 'full', dryRun?: boolean, clientName?: string, version?: string): { action: 'created' | 'updated' | 'unchanged'; filePath: string } {
  let existing = '';
  const fileExists = fs.existsSync(filePath);

  if (fileExists) {
    existing = fs.readFileSync(filePath, 'utf-8');
  }

  let newContent: string;
  let action: 'created' | 'updated' | 'unchanged';
  const template = loadAgentDocsTemplate(size, clientName, version);
  const inspection = inspectAgentDocsContent(existing);

  if (inspection.status === 'healthy') {
    const candidate = spliceManagedBlock(existing, template);

    if (candidate === existing) {
      return { action: 'unchanged', filePath };
    }

    newContent = candidate;
    action = 'updated';
  } else if (inspection.status !== 'missing') {
    const candidate = appendManagedBlock(stripManagedMarkers(existing).trimEnd(), template);
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
  const startMatch = findStartMarker(content);
  const startIdx = startMatch?.index ?? -1;
  const endIdx = content.indexOf(END_MARKER);
  const inspection = inspectAgentDocsContent(content);

  if (inspection.status === 'missing') {
    return { action: 'not-found', filePath };
  }

  if (inspection.status !== 'healthy') {
    const newContent = stripManagedMarkers(content).replace(/\n{3,}/g, '\n\n').trimEnd();

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

  let removeStart = 0;
  let removeEnd = content.length;

  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    removeStart = startIdx;
    removeEnd = endIdx + END_MARKER.length;
  } else if (startIdx !== -1) {
    removeStart = startIdx;
  } else if (endIdx !== -1) {
    removeStart = endIdx;
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
