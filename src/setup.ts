#!/usr/bin/env bun
// setup.ts - Install/uninstall open-zk-kb MCP server to client configs
// Can be run as CLI or used as module by MCP tools

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as p from '@clack/prompts';
import color from 'picocolors';
import { expandPath } from './utils/path.js';
import { injectAgentDocs, removeAgentDocs } from './agent-docs.js';
import type { InstructionSize } from './agent-docs.js';

const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');
const xdgDataHome = process.env.XDG_DATA_HOME || expandPath('~/.local/share');

export type McpClient = 'opencode' | 'claude-code' | 'cursor' | 'windsurf' | 'zed';

export interface InstallArgs {
  client: McpClient;
  serverPath?: string;
  force?: boolean;
  dryRun?: boolean;
  instructionSize?: InstructionSize;
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
  agentDocsPath?: string;
  instructionSize?: InstructionSize;
}

const CLIENT_CONFIGS: Record<McpClient, ClientConfig> = {
  'opencode': {
    name: 'OpenCode',
    configPath: path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    configFormat: 'json',
    mcpPath: ['mcp', 'open-zk-kb'],
    mcpFormat: 'opencode',
    agentDocsPath: path.join(xdgConfigHome, 'opencode', 'AGENTS.md'),
    instructionSize: 'full',
  },
  'claude-code': {
    name: 'Claude Code',
    configPath: path.join(expandPath('~/.claude'), 'settings.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
    agentDocsPath: path.join(expandPath('~/.claude'), 'CLAUDE.md'),
    instructionSize: 'full',
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
    agentDocsPath: path.join(expandPath('~/.codeium'), 'windsurf', 'memories', 'global_rules.md'),
    instructionSize: 'compact',
  },
  'zed': {
    name: 'Zed',
    configPath: path.join(xdgConfigHome, 'zed', 'settings.json'),
    configFormat: 'json',
    mcpPath: ['context_servers', 'open-zk-kb'],
    mcpFormat: 'standard',
  },
};

const ALL_CLIENTS: McpClient[] = ['opencode', 'claude-code', 'cursor', 'windsurf', 'zed'];

const CLIENT_PROMPT_OPTIONS: Array<{ value: McpClient; label: string; hint: string }> = [
  { value: 'opencode', label: 'OpenCode', hint: 'Enhanced plugin with auto-capture' },
  { value: 'claude-code', label: 'Claude Code', hint: 'MCP server integration' },
  { value: 'cursor', label: 'Cursor', hint: 'MCP server integration' },
  { value: 'windsurf', label: 'Windsurf', hint: 'MCP server integration' },
  { value: 'zed', label: 'Zed', hint: 'MCP server integration' },
];

type McpEntry =
  | {
      type: 'local';
      command: [string, ...string[]];
      enabled: true;
    }
  | {
      command: 'bun' | 'bunx';
      args: [string, ...string[]];
    };

function buildMcpEntry(clientConfig: ClientConfig, serverPath?: string): McpEntry {
  if (!serverPath) {
    if (clientConfig.mcpFormat === 'opencode') {
      return {
        type: 'local',
        command: ['bunx', 'open-zk-kb@latest', 'server'],
        enabled: true,
      };
    }

    return {
      command: 'bunx',
      args: ['open-zk-kb@latest', 'server'],
    };
  }

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

function detectServerPath(): string | undefined {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, '..');
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return undefined;
  }
  const distPath = path.resolve(scriptDir, '..', 'dist', 'mcp-server.js');
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  throw new Error('Could not detect server path. Please provide --server-path');
}

function formatServerCommand(serverPath?: string): string {
  return serverPath ? `bun run ${serverPath}` : 'bunx open-zk-kb@latest server';
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
      const projectMatch = file.match(/^(\d{12})-([^-]+)-/);
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
  const serverPath = args.serverPath || detectServerPath();
  const vaultPath = getVaultPath();
  
  if (serverPath && !fs.existsSync(serverPath)) {
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
    let output = `Dry run: Would add to ${clientConfig.configPath}:\n${JSON.stringify(mcpEntry, null, 2)}`;
    if (clientConfig.agentDocsPath) {
      output += `\nWould inject agent docs into ${clientConfig.agentDocsPath}`;
    }
    return output;
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
  
  // Copy config.example.yaml → ~/.config/open-zk-kb/config.yaml if no config exists yet
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
  
  // Inject agent docs (instructions for the AI agent) into the client's docs file
  let agentDocsResult: { action: string; filePath: string } | null = null;
  if (clientConfig.agentDocsPath) {
    const size = args.instructionSize || clientConfig.instructionSize || 'full';
    agentDocsResult = injectAgentDocs(clientConfig.agentDocsPath, size, args.dryRun);
  }

  let output = `Installed open-zk-kb for ${clientConfig.name}\n\n`;
  output += `Config: ${clientConfig.configPath}\n`;
  output += `Vault: ${vaultPath}\n`;
  output += `Server: ${formatServerCommand(serverPath)}\n`;
  if (agentDocsResult) {
    output += `Agent docs: ${agentDocsResult.filePath} (${agentDocsResult.action})\n`;
  }
  output += `\nNext steps:\n`;
  if (configCopied) {
    output += `1. Edit ${configYamlPath} with your API key and preferences\n`;
    output += `2. Restart ${clientConfig.name} to load the MCP server\n`;
  } else {
    output += `1. Restart ${clientConfig.name} to load the MCP server\n`;
  }
  
  return output;
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
    if (clientConfig.agentDocsPath) {
      output += `Would remove agent docs from ${clientConfig.agentDocsPath}\n`;
    }
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

  // Remove agent docs (managed instruction block) from the client's docs file
  let agentDocsResult: { action: string; filePath: string } | null = null;
  if (clientConfig.agentDocsPath) {
    agentDocsResult = removeAgentDocs(clientConfig.agentDocsPath, args.dryRun);
  }

  let output = `Uninstalled open-zk-kb from ${clientConfig.name}\n\n`;
  output += `Removed from: ${clientConfig.configPath}\n`;
  if (agentDocsResult && agentDocsResult.action !== 'not-found') {
    output += `Agent docs: ${agentDocsResult.filePath} (${agentDocsResult.action})\n`;
  }

  if (args.removeVault && args.confirm) {
    output += `Deleted vault: ${vaultPath}\n`;
  } else {
    output += `Vault preserved at: ${vaultPath}\n`;
    output += `Reinstall anytime with: bunx open-zk-kb@latest install --client ${args.client}\n`;
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
  --client <name>      Install for specific client (opencode, claude-code, cursor, windsurf, zed)
  --server-path <path> Path to dist/mcp-server.js (auto-detected)
  --instructions <size> Agent instruction size: compact (~140 tokens) or full (~420 tokens)
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

export async function runSetupCli(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
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
    const instructionsArg = parseFlagValue(args, '--instructions');
    const instructionSize: InstructionSize | undefined =
      instructionsArg === 'compact' || instructionsArg === 'full' ? instructionsArg : undefined;
    if (instructionsArg && !instructionSize) {
      throw new Error(`Invalid --instructions value: ${instructionsArg}. Use 'compact' or 'full'.`);
    }
    let client: McpClient | undefined;

    if (clientArg !== undefined) {
      if (!isMcpClient(clientArg)) {
        throw new Error(`Invalid client: ${clientArg}`);
      }
      client = clientArg;
    }

    if (client) {
      const result = install({ client, serverPath, force, dryRun, instructionSize });
      console.log(result);
      return;
    }

    if (yes) {
      for (const client of ALL_CLIENTS) {
        const result = install({ client, serverPath, force, dryRun, instructionSize });
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
        install({ client, serverPath, force, dryRun, instructionSize });
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
}

if (import.meta.main) {
  runSetupCli().catch((e) => {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
