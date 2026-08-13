// instruction-versions.ts - Detect installed instruction versions across clients

import * as fs from 'fs';
import * as path from 'path';
import { expandPath } from './utils/path.js';
import { getAgentDocsVersion } from './agent-docs.js';
import { getAgentDocsTargets } from './agent-docs-targets.js';
import { getSkillVersion } from './setup.js';

export interface InstalledClient {
  client: string;
  name: string;
  instructionVersion: string | null;
  instructionType: 'skill' | 'managed-block' | 'none';
  path: string | null;
}

export interface ClientInstructionConfig {
  client: string;
  name: string;
  skillPath?: string;
  agentDocsPath?: string;
}

export function getClientInstructionConfigs(): ClientInstructionConfig[] {
  return [
    {
      client: 'claude-code',
      name: 'Claude Code',
      skillPath: path.join(expandPath('~/.claude'), 'skills', 'open-zk-kb'),
    },
    ...getAgentDocsTargets().map(target => ({
      client: target.client,
      name: target.name,
      agentDocsPath: target.filePath,
    })),
  ];
}

/**
 * Get all installed clients with their instruction versions.
 * Only returns clients that have instructions installed (skill or managed block).
 */
export function getInstalledInstructionVersions(configs: ClientInstructionConfig[] = getClientInstructionConfigs()): InstalledClient[] {
  const results: InstalledClient[] = [];

  for (const config of configs) {
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
