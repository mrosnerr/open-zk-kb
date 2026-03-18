import * as path from 'path';
import { expandPath } from './utils/path.js';
import type { InstructionSize } from './agent-docs.js';

export interface AgentDocsTarget {
  client: 'opencode' | 'windsurf';
  name: string;
  filePath: string;
  instructionSize: InstructionSize;
}

export function getAgentDocsTargets(): AgentDocsTarget[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');

  // Claude Code uses a native skill instead of agent docs injection (see setup.ts skillPath)
  return [
    {
      client: 'opencode',
      name: 'OpenCode',
      filePath: path.join(xdgConfigHome, 'opencode', 'AGENTS.md'),
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
