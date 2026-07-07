import * as path from 'path';
import { expandPath } from './utils/path.js';
import type { InstructionSize } from './agent-docs.js';

export interface AgentDocsTarget {
  client: 'opencode' | 'windsurf' | 'pi' | 'omp';
  name: string;
  filePath: string;
  instructionSize: InstructionSize;
  /** Content prepended before the managed block when creating the file (e.g. YAML frontmatter for OMP rules) */
  preamble?: string;
  /** Stale file path to clean up when migrating to a new location */
  legacyFilePath?: string;
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
    {
      client: 'pi',
      name: 'Pi',
      filePath: path.join(expandPath('~/.pi/agent'), 'AGENTS.md'),
      instructionSize: 'full',
    },
    {
      client: 'omp',
      name: 'OMP',
      filePath: path.join(expandPath('~/.omp/agent'), 'rules', 'open-zk-kb.md'),
      instructionSize: 'preflight',
      preamble: '---\nalwaysApply: true\ndescription: Knowledge base (open-zk-kb) persistent memory instructions\n---\n',
      legacyFilePath: path.join(expandPath('~/.omp/agent'), 'RULES.md'),
    },
  ];
}
