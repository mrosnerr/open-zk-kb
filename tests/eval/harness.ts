// tests/eval/harness.ts - Vault lifecycle, CLI adapters, and evaluation engine
// Spawns Claude Code or OpenCode with isolated vaults, runs scripted prompts,
// and evaluates both agent response text and resulting vault state.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, execFileSync } from 'child_process';
import { NoteRepository } from '../../src/storage/NoteRepository.js';

// ---- Types ----

export interface EvalScenario {
  name: string;
  feature: string;
  setup: (repo: NoteRepository) => void;
  prompt: string;
  responseCriteria: {
    mustContain?: (string | RegExp)[];
    mustNotContain?: (string | RegExp)[];
  };
  vaultCriteria?: (repo: NoteRepository) => string[];
  timeout?: number;
}

export type CLIAdapter = 'claude' | 'opencode';

export interface EvalResult {
  scenario: string;
  cli: CLIAdapter;
  passed: boolean;
  responseFailures: string[];
  vaultFailures: string[];
  duration: number;
  rawResponse: string;
}

interface IsolatedVault {
  parentDir: string;  // temp dir that becomes XDG_DATA_HOME
  vaultPath: string;  // parentDir/zettelkasten-mcp (actual vault)
  repo: NoteRepository;
  cleanup: () => void;
}

// ---- Vault lifecycle ----

export function createIsolatedVault(): IsolatedVault {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-vault-'));
  const vaultPath = path.join(parentDir, 'zettelkasten-mcp');
  fs.mkdirSync(vaultPath, { recursive: true });

  const repo = new NoteRepository(vaultPath);

  return {
    parentDir,
    vaultPath,
    repo,
    cleanup: () => {
      repo.close();
      fs.rmSync(parentDir, { recursive: true, force: true });
    },
  };
}

// ---- MCP config for Claude Code ----

const PROJECT_ROOT = path.resolve(import.meta.dir, '..', '..');

export function writeMcpConfig(vaultParentDir: string): string {
  const configPath = path.join(vaultParentDir, 'mcp-config.json');
  const serverPath = path.join(PROJECT_ROOT, 'dist', 'mcp-server.js');

  const config = {
    mcpServers: {
      'zettelkasten-mcp': {
        type: 'stdio',
        command: 'bun',
        args: ['run', serverPath],
        env: { XDG_DATA_HOME: vaultParentDir },
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ---- CLI adapters ----

export function runClaude(prompt: string, mcpConfigPath: string, timeout: number = 60_000): string {
  const result = execFileSync('claude', [
    '-p', prompt,
    '--mcp-config', mcpConfigPath,
    '--output-format', 'text',
  ], {
    encoding: 'utf-8',
    timeout,
    env: { ...process.env, DISABLE_AUTOUPDATE: '1' },
    maxBuffer: 1024 * 1024,
  });

  return result.trim();
}

export function runOpencode(prompt: string, vaultParentDir: string, timeout: number = 60_000): string {
  // Copy auth files so the overridden XDG_DATA_HOME doesn't break provider authentication.
  const realDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const realAuthDir = path.join(realDataHome, 'opencode');
  const tempAuthDir = path.join(vaultParentDir, 'opencode');
  fs.mkdirSync(tempAuthDir, { recursive: true });
  for (const file of ['auth.json', 'mcp-auth.json']) {
    const src = path.join(realAuthDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(tempAuthDir, file));
    }
  }

  const result = execFileSync('opencode', [
    'run', prompt,
    '--format', 'default',
  ], {
    encoding: 'utf-8',
    timeout,
    env: { ...process.env, XDG_DATA_HOME: vaultParentDir },
    maxBuffer: 1024 * 1024,
  });

  return result.trim();
}

// ---- Response evaluation ----

export function evaluateResponse(
  response: string,
  criteria: EvalScenario['responseCriteria'],
): string[] {
  const failures: string[] = [];

  if (criteria.mustContain) {
    for (const pattern of criteria.mustContain) {
      const matches = pattern instanceof RegExp
        ? pattern.test(response)
        : response.toLowerCase().includes(pattern.toLowerCase());

      if (!matches) {
        failures.push(`mustContain failed: ${pattern}`);
      }
    }
  }

  if (criteria.mustNotContain) {
    for (const pattern of criteria.mustNotContain) {
      const matches = pattern instanceof RegExp
        ? pattern.test(response)
        : response.toLowerCase().includes(pattern.toLowerCase());

      if (matches) {
        failures.push(`mustNotContain failed: ${pattern}`);
      }
    }
  }

  return failures;
}

// ---- Scenario runner ----

export async function runScenario(
  scenario: EvalScenario,
  cli: CLIAdapter,
): Promise<EvalResult> {
  const start = Date.now();
  const vault = createIsolatedVault();
  let rawResponse = '';
  let responseFailures: string[] = [];
  let vaultFailures: string[] = [];

  try {
    // Setup vault state
    scenario.setup(vault.repo);

    // Close setup repo before CLI runs — flushes WAL so the MCP subprocess
    // sees the populated state, and avoids double-close in cleanup.
    vault.repo.close();

    // Run CLI
    const timeout = scenario.timeout || 60_000;
    if (cli === 'claude') {
      const mcpConfigPath = writeMcpConfig(vault.parentDir);
      rawResponse = runClaude(scenario.prompt, mcpConfigPath, timeout);
    } else {
      rawResponse = runOpencode(scenario.prompt, vault.parentDir, timeout);
    }

    // Evaluate response text
    responseFailures = evaluateResponse(rawResponse, scenario.responseCriteria);

    // Evaluate vault state — open fresh repo to see changes from CLI subprocess
    if (scenario.vaultCriteria) {
      const freshRepo = new NoteRepository(vault.vaultPath);
      try {
        vaultFailures = scenario.vaultCriteria(freshRepo);
      } finally {
        freshRepo.close();
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    responseFailures.push(`CLI execution error: ${msg}`);
  } finally {
    // cleanup only removes the temp dir (repo already closed above)
    fs.rmSync(vault.parentDir, { recursive: true, force: true });
  }

  const passed = responseFailures.length === 0 && vaultFailures.length === 0;

  return {
    scenario: scenario.name,
    cli,
    passed,
    responseFailures,
    vaultFailures,
    duration: Date.now() - start,
    rawResponse,
  };
}

// ---- CLI availability check ----

export function isCliAvailable(cli: CLIAdapter): boolean {
  try {
    execSync(`which ${cli}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
