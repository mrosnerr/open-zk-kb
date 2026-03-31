// instruction-versions.ts - Detect installed instruction versions across clients

import * as fs from 'fs';
import * as path from 'path';
import { expandPath } from './utils/path.js';
import { getAgentDocsVersion } from './agent-docs.js';

const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');

export interface InstalledClient {
  client: string;
  name: string;
  instructionVersion: string | null;
  instructionType: 'skill' | 'managed-block' | 'none';
  path: string | null;
}

interface ClientInstructionConfig {
  client: string;
  name: string;
  skillPath?: string;
  agentDocsPath?: string;
}

const CLIENT_INSTRUCTION_CONFIGS: ClientInstructionConfig[] = [
  {
    client: 'claude-code',
    name: 'Claude Code',
    skillPath: path.join(expandPath('~/.claude'), 'skills', 'open-zk-kb'),
  },
  {
    client: 'opencode',
    name: 'OpenCode',
    agentDocsPath: path.join(xdgConfigHome, 'opencode', 'AGENTS.md'),
  },
  {
    client: 'windsurf',
    name: 'Windsurf',
    agentDocsPath: path.join(expandPath('~/.codeium'), 'windsurf', 'memories', 'global_rules.md'),
  },
];

/**
 * Get the version from an installed Claude Code skill's SKILL.md frontmatter.
 * Returns null if skill doesn't exist or has no version.
 */
function getSkillVersion(skillPath: string): string | null {
  const skillMdPath = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return null;

  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const match = content.match(/^---[\s\S]*?version:\s*["']?([\d.]+)["']?[\s\S]*?---/m);
  return match ? match[1] : null;
}

/**
 * Get all installed clients with their instruction versions.
 * Only returns clients that have instructions installed (skill or managed block).
 */
export function getInstalledInstructionVersions(): InstalledClient[] {
  const results: InstalledClient[] = [];

  for (const config of CLIENT_INSTRUCTION_CONFIGS) {
    if (config.skillPath) {
      const version = getSkillVersion(config.skillPath);
      if (version !== null || fs.existsSync(config.skillPath)) {
        results.push({
          client: config.client,
          name: config.name,
          instructionVersion: version,
          instructionType: 'skill',
          path: config.skillPath,
        });
      }
    } else if (config.agentDocsPath) {
      const version = getAgentDocsVersion(config.agentDocsPath);
      if (version !== null || fs.existsSync(config.agentDocsPath)) {
        // Only include if we found a version (meaning the managed block exists)
        // or if we can detect the managed block exists even without version
        const hasBlock = version !== null || checkHasManagedBlock(config.agentDocsPath);
        if (hasBlock) {
          results.push({
            client: config.client,
            name: config.name,
            instructionVersion: version,
            instructionType: 'managed-block',
            path: config.agentDocsPath,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Check if a file contains the open-zk-kb managed block (even without version).
 */
function checkHasManagedBlock(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.includes('<!-- OPEN-ZK-KB:START');
}
