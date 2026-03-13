import * as path from 'path';
import { expandPath } from './utils/path.js';
import type { InstructionSize } from './agent-docs.js';

export interface AgentDocsTarget {
  client: 'opencode' | 'claude-code' | 'windsurf';
  name: string;
  filePath: string;
  instructionSize: InstructionSize;
}

export function getAgentDocsTargets(): AgentDocsTarget[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');

  return [
    {
      client: 'opencode',
      name: 'OpenCode',
      filePath: path.join(xdgConfigHome, 'opencode', 'AGENTS.md'),
      instructionSize: 'full',
    },
    {
      client: 'claude-code',
      name: 'Claude Code',
      filePath: path.join(expandPath('~/.claude'), 'CLAUDE.md'),
      instructionSize: 'full',
    },
    {
      client: 'windsurf',
      name: 'Windsurf',
      filePath: path.join(expandPath('~/.codeium'), 'windsurf', 'memories', 'global_rules.md'),
      instructionSize: 'compact',
    },
  ];
}
