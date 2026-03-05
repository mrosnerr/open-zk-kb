#!/usr/bin/env bun
// setup.ts - Install/uninstall open-zk-kb MCP server to client configs
// Can be run as CLI or used as module by MCP tools

import * as fs from 'fs';
import * as path from 'path';
import { expandPath } from './utils/path.js';

const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');
const xdgDataHome = process.env.XDG_DATA_HOME || expandPath('~/.local/share');

export type McpClient = 'opencode' | 'claude-code' | 'cursor' | 'windsurf' | 'zed';

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
}

const CLIENT_CONFIGS: Record<McpClient, ClientConfig> = {
  'opencode': {
    name: 'OpenCode',
    configPath: path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    configFormat: 'json',
    mcpPath: ['mcp', 'open-zk-kb'],
  },
  'claude-code': {
    name: 'Claude Code',
    configPath: path.join(expandPath('~/.claude'), 'settings.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
  },
  'cursor': {
    name: 'Cursor',
    configPath: path.join(xdgConfigHome, 'cursor', 'mcp.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
  },
  'windsurf': {
    name: 'Windsurf',
    configPath: path.join(xdgConfigHome, 'windsurf', 'mcp.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
  },
  'zed': {
    name: 'Zed',
    configPath: path.join(xdgConfigHome, 'zed', 'settings.json'),
    configFormat: 'json',
    mcpPath: ['mcp_servers', 'open-zk-kb'],
  },
};

function detectServerPath(): string {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
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
  
  if (!fs.existsSync(serverPath)) {
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
  
  const mcpEntry: any = {
    type: 'local',
    command: ['bun', 'run', serverPath],
    enabled: true,
  };
  
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
  
  // Copy config.example.yaml → ~/.config/open-zk-kb/config.yaml if no config exists yet
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
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
  
  let output = `Installed open-zk-kb for ${clientConfig.name}\n\n`;
  output += `Config: ${clientConfig.configPath}\n`;
  output += `Vault: ${vaultPath}\n`;
  output += `Server: ${serverPath}\n\n`;
  output += `Next steps:\n`;
  if (configCopied) {
    output += `1. Edit ${configYamlPath} with your API key and preferences\n`;
    output += `2. Restart ${clientConfig.name} to load the MCP server\n`;
    output += `3. Add to your AGENTS.md:\n\n`;
  } else {
    output += `1. Restart ${clientConfig.name} to load the MCP server\n`;
    output += `2. Add to your AGENTS.md:\n\n`;
  }
  output += `   # Knowledge Management\n`;
  output += `   - Use knowledge-search to find context before responding\n`;
  output += `   - Use knowledge-store to save decisions and patterns\n`;
  output += `   - Use knowledge-maintain for KB management\n`;
  
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
  
  let output = `Uninstalled open-zk-kb from ${clientConfig.name}\n\n`;
  output += `Removed from: ${clientConfig.configPath}\n`;
  
  if (args.removeVault && args.confirm) {
    output += `Deleted vault: ${vaultPath}\n`;
  } else {
    output += `Vault preserved at: ${vaultPath}\n`;
    output += `Reinstall anytime with: bun run setup install --client ${args.client}\n`;
  }
  
  return output;
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (command === 'install') {
    const clientIdx = args.indexOf('--client');
    const client = clientIdx >= 0 ? args[clientIdx + 1] as McpClient : 'opencode';
    const force = args.includes('--force');
    const dryRun = args.includes('--dry-run');
    const serverPathIdx = args.indexOf('--server-path');
    const serverPath = serverPathIdx >= 0 ? args[serverPathIdx + 1] : undefined;
    
    try {
      const result = install({ client, serverPath, force, dryRun });
      console.log(result);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  } else if (command === 'uninstall') {
    const clientIdx = args.indexOf('--client');
    const client = clientIdx >= 0 ? args[clientIdx + 1] as McpClient : 'opencode';
    const removeVault = args.includes('--remove-vault');
    const confirm = args.includes('--confirm');
    const dryRun = args.includes('--dry-run');
    
    try {
      const result = uninstall({ client, removeVault, confirm, dryRun });
      console.log(result);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  } else {
    console.log(`Usage: bun run setup.ts <install|uninstall> [options]
    
install:
  --client <name>      Client to configure (opencode, claude-code, cursor, windsurf, zed)
  --server-path <path> Path to dist/mcp-server.js (auto-detected if not provided)
  --force              Overwrite existing config
  --dry-run            Preview changes without applying

uninstall:
  --client <name>      Client to remove from
  --remove-vault       Also delete the knowledge base data
  --confirm            Required if --remove-vault to confirm deletion
  --dry-run            Preview changes without applying`);
    process.exit(1);
  }
}
