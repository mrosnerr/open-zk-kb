#!/usr/bin/env bun
// setup.ts - Install/uninstall open-zk-kb MCP server to client configs
// Can be run as CLI or used as module by MCP tools

if (typeof globalThis.Bun === 'undefined') {
  console.error(
    'open-zk-kb requires the Bun runtime (uses bun:sqlite).\n' +
    'Install Bun: https://bun.sh\n' +
    'Then run: bunx open-zk-kb'
  );
  process.exit(1);
}

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as p from '@clack/prompts';
import color from 'picocolors';
import { expandPath } from './utils/path.js';

const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');
const xdgDataHome = process.env.XDG_DATA_HOME || expandPath('~/.local/share');

export type McpClient = 'opencode' | 'claude-code' | 'cursor' | 'windsurf';

export interface InstallArgs {
  client: McpClient;
  serverPath?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface UninstallArgs {
  client: McpClient;
  removeVault?: boolean;
  confirm?: boolean;
  dryRun?: boolean;
}

export interface ClientConfig {
  name: string;
  configPath: string;
  configFormat: 'json' | 'jsonc';
  mcpPath: string[];
  mcpFormat: 'opencode' | 'standard';
}

const CLIENT_CONFIGS: Record<McpClient, ClientConfig> = {
  'opencode': {
    name: 'OpenCode',
    configPath: path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    configFormat: 'json',
    mcpPath: ['mcp', 'open-zk-kb'],
    mcpFormat: 'opencode',
  },
  'claude-code': {
    name: 'Claude Code',
    configPath: path.join(expandPath('~/.claude'), 'settings.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
  },
  'cursor': {
    name: 'Cursor',
    configPath: path.join(expandPath('~/.cursor'), 'mcp.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
  },
  'windsurf': {
    name: 'Windsurf',
    configPath: path.join(expandPath('~/.codeium'), 'windsurf', 'mcp_config.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
  },
};

const ALL_CLIENTS: McpClient[] = ['opencode', 'claude-code', 'cursor', 'windsurf'];

const INSTRUCTION_MARKER_PREFIX = '<!-- OPEN-ZK-KB:START';
const INSTRUCTION_MARKER_START = '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->';
const INSTRUCTION_MARKER_END = '<!-- OPEN-ZK-KB:END -->';

const INSTRUCTION_FILE_PATHS: Record<McpClient, string> = {
  'opencode': path.join(xdgConfigHome, 'opencode', 'AGENTS.md'),
  'claude-code': path.join(expandPath('~/.claude'), 'CLAUDE.md'),
  'cursor': path.join(expandPath('~/.cursor'), 'rules', 'open-zk-kb.mdc'),
  'windsurf': path.join(expandPath('~/.windsurf'), 'rules', 'open-zk-kb.md'),
};

function loadCanonicalInstructions(): string {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const templatePath = path.join(projectRoot, 'agent-instructions.md');
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, 'utf-8').trim();
  }
  return [
    '## Knowledge Base (open-zk-kb)',
    '',
    'ALWAYS use the open-zk-kb MCP tools to maintain persistent memory across sessions.',
    '',
    '### Before Starting Work',
    '- Search for relevant context: `knowledge-search` with a query describing your task',
    '- Check for personalization notes (user preferences, coding style)',
    '- Check for decision notes (past architectural choices)',
    '',
    '### While Working',
    '- Store decisions, preferences, procedures, and insights via `knowledge-store`',
    '- One concept per note. Include `summary` and `guidance` fields.',
  ].join('\n');
}

function buildMarkedBlock(content: string): string {
  return `${INSTRUCTION_MARKER_START}\n${content}\n${INSTRUCTION_MARKER_END}`;
}

function findMarkerIndices(content: string): { startIdx: number; endIdx: number } {
  let startIdx = content.indexOf(INSTRUCTION_MARKER_START);
  if (startIdx === -1) {
    startIdx = content.indexOf(INSTRUCTION_MARKER_PREFIX);
    if (startIdx !== -1 && content.indexOf('\n', startIdx) === -1) {
      startIdx = -1;
    }
  }
  const endIdx = content.indexOf(INSTRUCTION_MARKER_END);
  return { startIdx, endIdx };
}

export function injectInstructions(filePath: string, dryRun: boolean = false): { updated: boolean; created: boolean } {
  const instructions = loadCanonicalInstructions();
  const markedBlock = buildMarkedBlock(instructions);

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    const { startIdx, endIdx } = findMarkerIndices(existing);

    if (startIdx !== -1 && endIdx !== -1) {
      const before = existing.substring(0, startIdx);
      const after = existing.substring(endIdx + INSTRUCTION_MARKER_END.length);
      const updated = before + markedBlock + after;
      if (updated !== existing && !dryRun) {
        fs.writeFileSync(filePath, updated);
      }
      return { updated: updated !== existing, created: false };
    }

    if (!dryRun) {
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      fs.writeFileSync(filePath, existing + separator + markedBlock + '\n');
    }
    return { updated: true, created: false };
  }

  if (!dryRun) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, markedBlock + '\n');
  }
  return { updated: false, created: true };
}

const CLIENT_PROMPT_OPTIONS: Array<{ value: McpClient; label: string; hint: string }> = [
  { value: 'opencode', label: 'OpenCode', hint: 'MCP server integration' },
  { value: 'claude-code', label: 'Claude Code', hint: 'MCP server integration' },
  { value: 'cursor', label: 'Cursor', hint: 'MCP server integration' },
  { value: 'windsurf', label: 'Windsurf', hint: 'MCP server integration' },
];

type McpEntry =
  | {
      type: 'local';
      command: string[];
      enabled: true;
    }
  | {
      command: string;
      args: string[];
    };

function isNpmInstall(): boolean {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, '..');
  return !fs.existsSync(path.join(projectRoot, '.git'));
}

function buildMcpEntry(clientConfig: ClientConfig, serverPath: string | null): McpEntry {
  // null serverPath = npm mode → use bunx
  if (serverPath === null) {
    if (clientConfig.mcpFormat === 'opencode') {
      return {
        type: 'local',
        command: ['bunx', 'open-zk-kb-server'],
        enabled: true,
      };
    }
    return {
      command: 'bunx',
      args: ['open-zk-kb-server'],
    };
  }

  // Explicit server path = local dev mode
  if (clientConfig.mcpFormat === 'opencode') {
    return {
      type: 'local',
      command: ['bun', 'run', serverPath],
      enabled: true,
    };
  }

  return {
    command: 'bun',
    args: ['run', serverPath],
  };
}

function detectServerPath(): string | null {
  if (isNpmInstall()) {
    return null; // npm mode — use bunx instead of absolute path
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const distPath = path.resolve(scriptDir, '..', 'dist', 'mcp-server.js');
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  throw new Error('Could not detect server path. Please provide --server-path');
}

function getNestedValue(obj: any, path: string[]): any {
  let current = obj;
  for (const key of path) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function setNestedValue(obj: any, path: string[], value: any): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!(path[i] in current)) {
      current[path[i]] = {};
    }
    current = current[path[i]];
  }
  current[path[path.length - 1]] = value;
}

function deleteNestedValue(obj: any, path: string[]): boolean {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!(path[i] in current)) {
      return false;
    }
    current = current[path[i]];
  }
  const lastKey = path[path.length - 1];
  if (lastKey in current) {
    delete current[lastKey];
    return true;
  }
  return false;
}

function getVaultPath(): string {
  return path.join(xdgDataHome, 'open-zk-kb');
}

function getVaultStats(vaultPath: string): { noteCount: number; projectCount: number; sizeMB: number } | null {
  const indexPath = path.join(vaultPath, '.index', 'knowledge.db');
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  
  let noteCount = 0;
  let projectCount = 0;
  let sizeMB = 0;
  
  try {
    const stats = fs.statSync(indexPath);
    sizeMB = Math.round(stats.size / (1024 * 1024) * 10) / 10;
    
    const mdFiles = fs.readdirSync(vaultPath).filter(f => f.endsWith('.md'));
    noteCount = mdFiles.length;
    
    const projects = new Set<string>();
    for (const file of mdFiles) {
      const projectMatch = file.match(/^(\d{16}|\d{12})-([^-]+)-/);
      if (projectMatch) {
        const slug = projectMatch[2];
        if (slug.startsWith('project-')) {
          projects.add(slug);
        }
      }
    }
    projectCount = projects.size;
  } catch {
    // Ignore errors
  }
  
  return { noteCount, projectCount, sizeMB };
}

export function install(args: InstallArgs): string {
  const clientConfig = CLIENT_CONFIGS[args.client];
  const serverPath = args.serverPath ?? detectServerPath();
  const vaultPath = getVaultPath();
  
  if (serverPath !== null && !fs.existsSync(serverPath)) {
    throw new Error(`Server not found at: ${serverPath}`);
  }
  
  let config: any = {};
  
  if (fs.existsSync(clientConfig.configPath)) {
    try {
      const content = fs.readFileSync(clientConfig.configPath, 'utf-8');
      config = JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to parse ${clientConfig.configPath}: ${e}`);
    }
  }
  
  const existing = getNestedValue(config, clientConfig.mcpPath);
  if (existing && !args.force) {
    return `Already installed for ${clientConfig.name}. Use --force to overwrite.`;
  }
  
  const mcpEntry = buildMcpEntry(clientConfig, serverPath);
  
  if (args.dryRun) {
    return `Dry run: Would add to ${clientConfig.configPath}:\n${JSON.stringify(mcpEntry, null, 2)}`;
  }
  
  setNestedValue(config, clientConfig.mcpPath, mcpEntry);
  
  const configDir = path.dirname(clientConfig.configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
  
  if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.mkdirSync(path.join(vaultPath, '.index'), { recursive: true });
  }
  
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const exampleConfigPath = path.join(projectRoot, 'config.example.yaml');
  const configYamlDir = path.join(xdgConfigHome, 'open-zk-kb');
  const configYamlPath = path.join(configYamlDir, 'config.yaml');
  let configCopied = false;
  if (!fs.existsSync(configYamlPath) && fs.existsSync(exampleConfigPath)) {
    if (!fs.existsSync(configYamlDir)) {
      fs.mkdirSync(configYamlDir, { recursive: true });
    }
    fs.copyFileSync(exampleConfigPath, configYamlPath);
    configCopied = true;
  }
  
  const instructionFilePath = INSTRUCTION_FILE_PATHS[args.client];
  const injectionResult = injectInstructions(instructionFilePath, args.dryRun);

  const serverDisplay = serverPath ?? 'bunx open-zk-kb-server';
  let output = `Installed open-zk-kb for ${clientConfig.name}\n\n`;
  output += `Config: ${clientConfig.configPath}\n`;
  output += `Vault: ${vaultPath}\n`;
  output += `Server: ${serverDisplay}\n`;
  output += `Instructions: ${instructionFilePath}\n\n`;

  if (injectionResult.created) {
    output += `Created ${instructionFilePath} with KB instructions.\n`;
  } else if (injectionResult.updated) {
    output += `Updated KB instructions in ${instructionFilePath}.\n`;
  } else {
    output += `KB instructions in ${instructionFilePath} already up to date.\n`;
  }

  output += `\nNext steps:\n`;
  const step = { n: 1 };
  if (configCopied) {
    output += `${step.n++}. (Optional) Edit ${configYamlPath} to configure API embeddings\n`;
  }
  output += `${step.n++}. Restart ${clientConfig.name} to load the MCP server\n`;
  
  return output;
}

export function removeInstructions(filePath: string, dryRun: boolean = false): { removed: boolean } {
  if (!fs.existsSync(filePath)) {
    return { removed: false };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const { startIdx, endIdx } = findMarkerIndices(content);

  if (startIdx === -1 || endIdx === -1) {
    return { removed: false };
  }

  const before = content.substring(0, startIdx);
  const after = content.substring(endIdx + INSTRUCTION_MARKER_END.length);
  const joined = before + after;
  const updated = joined.replace(/\n{3,}/g, '\n\n');

  if (!dryRun) {
    if (updated.trim().length === 0) {
      fs.unlinkSync(filePath);
    } else {
      fs.writeFileSync(filePath, updated);
    }
  }

  return { removed: true };
}

export function uninstall(args: UninstallArgs): string {
  const clientConfig = CLIENT_CONFIGS[args.client];
  const vaultPath = getVaultPath();
  
  if (!fs.existsSync(clientConfig.configPath)) {
    return `No config found for ${clientConfig.name} at ${clientConfig.configPath}`;
  }
  
  let config: any;
  try {
    const content = fs.readFileSync(clientConfig.configPath, 'utf-8');
    config = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse ${clientConfig.configPath}: ${e}`);
  }
  
  const existing = getNestedValue(config, clientConfig.mcpPath);
  if (!existing) {
    return `open-zk-kb not configured for ${clientConfig.name}`;
  }
  
  if (args.dryRun) {
    let output = `Dry run: Would remove from ${clientConfig.configPath}\n`;
    if (args.removeVault) {
      output += `\nWould also delete vault at ${vaultPath}`;
      const stats = getVaultStats(vaultPath);
      if (stats) {
        output += `\n  - ${stats.noteCount} notes`;
        output += `\n  - ${stats.sizeMB} MB`;
      }
    }
    return output;
  }
  
  if (args.removeVault) {
    const stats = getVaultStats(vaultPath);
    
    if (!args.confirm) {
      let output = `WARNING: This will permanently delete your knowledge base!\n\n`;
      output += `Vault: ${vaultPath}\n`;
      if (stats) {
        output += `Contains:\n`;
        output += `  - ${stats.noteCount} notes\n`;
        output += `  - ${stats.projectCount} projects\n`;
        output += `  - ${stats.sizeMB} MB\n`;
      }
      output += `\nTo confirm deletion, call again with confirm: true`;
      return output;
    }
    
    if (fs.existsSync(vaultPath)) {
      fs.rmSync(vaultPath, { recursive: true });
    }
  }
  
  deleteNestedValue(config, clientConfig.mcpPath);
  fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
  
  const instructionFilePath = INSTRUCTION_FILE_PATHS[args.client];
  const instructionResult = removeInstructions(instructionFilePath, args.dryRun);

  let output = `Uninstalled open-zk-kb from ${clientConfig.name}\n\n`;
  output += `Removed from: ${clientConfig.configPath}\n`;
  
  if (instructionResult.removed) {
    output += `Removed KB instructions from: ${instructionFilePath}\n`;
  }

  if (args.removeVault && args.confirm) {
    output += `Deleted vault: ${vaultPath}\n`;
  } else {
    output += `Vault preserved at: ${vaultPath}\n`;
    output += `Reinstall anytime with: bunx open-zk-kb install --client ${args.client}\n`;
  }
  
  return output;
}

function isMcpClient(value: string | undefined): value is McpClient {
  return value !== undefined && ALL_CLIENTS.includes(value as McpClient);
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function printHelp(): void {
  console.log(`Usage: open-zk-kb <install|uninstall> [options]

install:
  (no flags)           Interactive client selection
  --client <name>      Install for specific client (opencode, claude-code, cursor, windsurf)
  --server-path <path> Path to dist/mcp-server.js (auto-detected)
  --force              Overwrite existing config
  --dry-run            Preview changes without applying
  --yes                Non-interactive, accept defaults

uninstall:
  (no flags)           Interactive client selection
  --client <name>      Uninstall from specific client
  --remove-vault       Also delete the knowledge base data
  --confirm            Required with --remove-vault
  --dry-run            Preview changes without applying
  --yes                Non-interactive, accept defaults`);
}

// CLI entry point
if (import.meta.main) {
  const run = async (): Promise<void> => {
    const rawArgs = process.argv.slice(2);
    const firstArg = rawArgs[0];
    const hasSubcommand = firstArg === 'install' || firstArg === 'uninstall';
    const command: 'install' | 'uninstall' = hasSubcommand ? firstArg : 'install';
    const args = hasSubcommand ? rawArgs.slice(1) : rawArgs;

    if (firstArg === '--help' || firstArg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (firstArg && !hasSubcommand && !firstArg.startsWith('--')) {
      printHelp();
      process.exit(1);
    }

    if (command === 'install') {
      const force = args.includes('--force');
      const dryRun = args.includes('--dry-run');
      const yes = args.includes('--yes');
      const serverPath = parseFlagValue(args, '--server-path');
      const clientArg = parseFlagValue(args, '--client');
      let client: McpClient | undefined;

      if (clientArg !== undefined) {
        if (!isMcpClient(clientArg)) {
          throw new Error(`Invalid client: ${clientArg}`);
        }
        client = clientArg;
      }

      if (client) {
        const result = install({ client, serverPath, force, dryRun });
        console.log(result);
        return;
      }

      if (yes) {
        for (const client of ALL_CLIENTS) {
          const result = install({ client, serverPath, force, dryRun });
          console.log(result);
        }
        return;
      }

      p.intro(color.cyan('open-zk-kb — Knowledge Base Setup'));
      const selected = await p.multiselect<McpClient>({
        message: `Select clients to install:\n${color.dim('space to select, enter to confirm')}`,
        options: CLIENT_PROMPT_OPTIONS,
      });

      if (p.isCancel(selected)) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }

      if (selected.length === 0) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }

      for (const client of selected) {
        try {
          install({ client, serverPath, force, dryRun });
          p.log.success(`Installed for ${CLIENT_CONFIGS[client].name}`);
        } catch (e) {
          p.log.error(`${CLIENT_CONFIGS[client].name}: ${e instanceof Error ? e.message : e}`);
          process.exitCode = 1;
        }
      }

      p.outro('Done! Restart your editor to load the MCP server.');
      return;
    }

    const removeVault = args.includes('--remove-vault');
    const dryRun = args.includes('--dry-run');
    const yes = args.includes('--yes');
    const clientArg = parseFlagValue(args, '--client');
    let client: McpClient | undefined;

    if (clientArg !== undefined) {
      if (!isMcpClient(clientArg)) {
        throw new Error(`Invalid client: ${clientArg}`);
      }
      client = clientArg;
    }

    if (client) {
      const confirm = args.includes('--confirm') || (yes && removeVault);
      const result = uninstall({ client, removeVault, confirm, dryRun });
      console.log(result);
      return;
    }

    if (yes) {
      const confirm = removeVault;
      for (const client of ALL_CLIENTS) {
        const result = uninstall({ client, removeVault, confirm, dryRun });
        console.log(result);
      }
      return;
    }

    p.intro(color.yellow('open-zk-kb — Uninstall'));
    const selected = await p.multiselect<McpClient>({
      message: `Select clients to uninstall from:\n${color.dim('space to select, enter to confirm')}`,
      options: CLIENT_PROMPT_OPTIONS,
    });

    if (p.isCancel(selected)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    if (selected.length === 0) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    const removeVaultPrompt = await p.confirm({
      message: 'Also remove the knowledge vault? (irreversible)',
      initialValue: false,
    });

    if (p.isCancel(removeVaultPrompt)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    let confirm = false;
    if (removeVaultPrompt) {
      const secondConfirm = await p.confirm({
        message: color.red('This will permanently delete your vault. Continue?'),
        initialValue: false,
      });

      if (p.isCancel(secondConfirm)) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }

      if (!secondConfirm) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }

      confirm = true;
    }

    for (const client of selected) {
      try {
        uninstall({ client, removeVault: removeVaultPrompt, confirm, dryRun });
        p.log.success(`Uninstalled from ${CLIENT_CONFIGS[client].name}`);
      } catch (e) {
        p.log.error(`${CLIENT_CONFIGS[client].name}: ${e instanceof Error ? e.message : e}`);
        process.exitCode = 1;
      }
    }

    p.outro('Done!');
  };

  run().catch((e) => {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
