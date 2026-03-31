#!/usr/bin/env bun
// setup.ts - Install/uninstall open-zk-kb MCP server to client configs
// Can be run as CLI or used as module by MCP tools

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as p from '@clack/prompts';
import color from 'picocolors';
import { expandPath } from './utils/path.js';
import { injectAgentDocs, inspectAgentDocs, removeAgentDocs, getAgentDocsVersion } from './agent-docs.js';
import type { InstructionSize } from './agent-docs.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json') as { version: string };

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

export interface DoctorArgs {
  client?: McpClient;
  fix?: boolean;
}

export interface ClientConfig {
  name: string;
  configPath: string;
  configFormat: 'json' | 'jsonc';
  mcpPath: string[];
  mcpFormat: 'opencode' | 'standard';
  agentDocsPath?: string;
  instructionSize?: InstructionSize;
  /** Path where a Claude Code skill directory should be installed (e.g. ~/.claude/skills/open-zk-kb) */
  skillPath?: string;
}

export const CLIENT_CONFIGS: Record<McpClient, ClientConfig> = {
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
    skillPath: path.join(expandPath('~/.claude'), 'skills', 'open-zk-kb'),
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
  { value: 'opencode', label: 'OpenCode', hint: 'MCP server + managed instructions' },
  { value: 'claude-code', label: 'Claude Code', hint: 'MCP server + skill' },
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

function getConfigYamlPath(): string {
  return path.join(xdgConfigHome, 'open-zk-kb', 'config.yaml');
}

// --- Skill installation helpers (Claude Code) ---

/**
 * Returns the path to the skill template directory in the package.
 * Works from both src/ (development) and dist/ (production) because skills/
 * is at the project root, one level up from either location.
 */
function getSkillTemplateDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'open-zk-kb');
}

/** Returns the path to ~/.claude/CLAUDE.md for migration checks. */
function getLegacyClaudeMdPath(): string {
  return path.join(expandPath('~/.claude'), 'CLAUDE.md');
}

/**
 * Install a Claude Code skill by copying template files to the target directory.
 */
function installSkill(skillPath: string, dryRun?: boolean): { action: 'created' | 'updated'; skillPath: string } {
  const templateDir = getSkillTemplateDir();
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Skill template not found at: ${templateDir}`);
  }

  const existed = fs.existsSync(skillPath);

  if (!dryRun) {
    fs.mkdirSync(skillPath, { recursive: true });

    // Copy all files from the template directory
    for (const file of fs.readdirSync(templateDir)) {
      fs.copyFileSync(path.join(templateDir, file), path.join(skillPath, file));
    }
  }

  return { action: existed ? 'updated' : 'created', skillPath };
}

/**
 * Remove an installed Claude Code skill directory.
 */
function removeSkill(skillPath: string, dryRun?: boolean): { action: 'removed' | 'not-found'; skillPath: string } {
  if (!fs.existsSync(skillPath)) {
    return { action: 'not-found', skillPath };
  }

  if (!dryRun) {
    fs.rmSync(skillPath, { recursive: true, force: true });
  }

  return { action: 'removed', skillPath };
}

/**
 * Inspect a Claude Code skill installation for health.
 */
function inspectSkill(skillPath: string): { exists: boolean; hasSkillMd: boolean; hasFrontmatter: boolean } {
  if (!fs.existsSync(skillPath)) {
    return { exists: false, hasSkillMd: false, hasFrontmatter: false };
  }

  const skillMdPath = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return { exists: true, hasSkillMd: false, hasFrontmatter: false };
  }

  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const hasFrontmatter = content.startsWith('---') && content.includes('name:') && content.includes('description:');

  return { exists: true, hasSkillMd: true, hasFrontmatter };
}

/**
 * Get the version from an installed Claude Code skill's SKILL.md frontmatter.
 * Returns null if skill doesn't exist or has no version.
 */
export function getSkillVersion(skillPath: string): string | null {
  const skillMdPath = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return null;

  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const match = content.match(/^---[\s\S]*?version:\s*["']?([\d.]+)["']?[\s\S]*?---/m);
  return match ? match[1] : null;
}

/**
 * Remove the old CLAUDE.md managed block if present (migration from pre-skill install).
 */
function migrateFromAgentDocs(agentDocsPath: string, dryRun?: boolean): { migrated: boolean; fileDeleted: boolean } {
  if (!fs.existsSync(agentDocsPath)) {
    return { migrated: false, fileDeleted: false };
  }

  const result = removeAgentDocs(agentDocsPath, dryRun);
  return {
    migrated: result.action === 'removed' || result.action === 'file-deleted',
    fileDeleted: result.action === 'file-deleted',
  };
}

function ensureDefaultConfigYaml(): boolean {
  const configYamlPath = getConfigYamlPath();
  if (fs.existsSync(configYamlPath)) {
    return false;
  }

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const exampleConfigPath = path.join(projectRoot, 'config.example.yaml');
  if (!fs.existsSync(exampleConfigPath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(configYamlPath), { recursive: true });
  fs.copyFileSync(exampleConfigPath, configYamlPath);
  return true;
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

function validateMcpEntry(clientConfig: ClientConfig, entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') {
    return ['entry is not an object'];
  }

  const record = entry as Record<string, unknown>;
  const issues: string[] = [];

  if (clientConfig.mcpFormat === 'opencode') {
    if (record.type !== 'local') issues.push('expected type "local"');
    if (!Array.isArray(record.command) || record.command.length === 0) issues.push('missing command array');
    if (record.enabled !== true) issues.push('expected enabled: true');
    return issues;
  }

  if (typeof record.command !== 'string' || record.command.length === 0) issues.push('missing command');
  if (!Array.isArray(record.args) || record.args.length === 0) issues.push('missing args array');
  return issues;
}

function inferServerPathFromEntry(clientConfig: ClientConfig, entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  const record = entry as Record<string, unknown>;

  if (clientConfig.mcpFormat === 'opencode') {
    if (!Array.isArray(record.command)) return undefined;
    const [runtime, action, serverPath] = record.command;
    return runtime === 'bun' && action === 'run' && typeof serverPath === 'string'
      ? serverPath
      : undefined;
  }

  if (record.command !== 'bun' || !Array.isArray(record.args)) {
    return undefined;
  }

  const [action, serverPath] = record.args;
  return action === 'run' && typeof serverPath === 'string'
    ? serverPath
    : undefined;
}

function repairClientConfig(clientConfig: ClientConfig, config: Record<string, unknown>, existingEntry: unknown): void {
  const inferredServerPath = inferServerPathFromEntry(clientConfig, existingEntry);
  const repairedEntry = buildMcpEntry(clientConfig, inferredServerPath);
  setNestedValue(config, clientConfig.mcpPath, repairedEntry);
  fs.mkdirSync(path.dirname(clientConfig.configPath), { recursive: true });
  fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
}

export function doctor(args: DoctorArgs = {}): string {
  const clients = args.client ? [args.client] : ALL_CLIENTS;
  const vaultPath = getVaultPath();
  const configYamlPath = getConfigYamlPath();
  const checks: string[] = [];
  let okCount = 0;
  let fixedCount = 0;
  let infoCount = 0;
  let warnCount = 0;
  let errorCount = 0;

  const pushCheck = (level: 'OK' | 'FIXED' | 'INFO' | 'WARN' | 'ERROR', message: string) => {
    checks.push(`- ${level} ${message}`);
    if (level === 'OK') okCount++;
    else if (level === 'FIXED') fixedCount++;
    else if (level === 'INFO') infoCount++;
    else if (level === 'WARN') warnCount++;
    else errorCount++;
  };

  const vaultStats = getVaultStats(vaultPath);
  if (fs.existsSync(vaultPath)) {
    const noteCount = vaultStats?.noteCount ?? fs.readdirSync(vaultPath).filter((name) => name.endsWith('.md')).length;
    pushCheck('OK', `Vault exists at ${vaultPath} (${noteCount} notes)`);
  } else {
    pushCheck('INFO', `Vault not created yet at ${vaultPath}`);
  }

  const indexPath = path.join(vaultPath, '.index');
  if (fs.existsSync(indexPath)) {
    pushCheck('OK', `Index directory exists at ${indexPath}`);
  } else {
    if (args.fix && fs.existsSync(vaultPath)) {
      fs.mkdirSync(indexPath, { recursive: true });
      pushCheck('FIXED', `Created missing index directory at ${indexPath}`);
    } else {
      pushCheck('INFO', `Index directory not created yet at ${indexPath}`);
    }
  }

  if (fs.existsSync(configYamlPath)) {
    pushCheck('OK', `Config file exists at ${configYamlPath}`);
  } else {
    if (args.fix && ensureDefaultConfigYaml()) {
      pushCheck('FIXED', `Copied default config file to ${configYamlPath}`);
    } else {
      pushCheck('INFO', `Config file not created yet at ${configYamlPath}`);
    }
  }

  for (const client of clients) {
    const clientConfig = CLIENT_CONFIGS[client];
    let configured = false;

    if (!fs.existsSync(clientConfig.configPath)) {
      pushCheck('INFO', `${clientConfig.name}: config file not found at ${clientConfig.configPath}`);
    } else {
      try {
        const content = fs.readFileSync(clientConfig.configPath, 'utf-8');
        const config = JSON.parse(content) as Record<string, unknown>;
        const entry = getNestedValue(config, clientConfig.mcpPath);

        if (!entry) {
          pushCheck('INFO', `${clientConfig.name}: open-zk-kb is not configured in ${clientConfig.configPath}`);
        } else {
          const issues = validateMcpEntry(clientConfig, entry);
          if (issues.length === 0) {
            configured = true;
            pushCheck('OK', `${clientConfig.name}: MCP config looks healthy in ${clientConfig.configPath}`);
          } else if (args.fix) {
            repairClientConfig(clientConfig, config, entry);
            configured = true;
            pushCheck('FIXED', `${clientConfig.name}: repaired MCP config in ${clientConfig.configPath}`);
          } else {
            pushCheck('ERROR', `${clientConfig.name}: MCP config is invalid (${issues.join(', ')})`);
          }
        }
      } catch (error) {
        pushCheck('ERROR', `${clientConfig.name}: failed to parse ${clientConfig.configPath} (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    if (clientConfig.skillPath) {
      // Skill-based client (Claude Code)
      if (!configured) {
        if (fs.existsSync(clientConfig.skillPath)) {
          pushCheck('INFO', `${clientConfig.name}: skill exists at ${clientConfig.skillPath}, but open-zk-kb is not installed for this client`);
        } else {
          pushCheck('INFO', `${clientConfig.name}: skill is not installed`);
        }
      } else {
        const inspection = inspectSkill(clientConfig.skillPath);
        if (!inspection.exists) {
          if (args.fix) {
            installSkill(clientConfig.skillPath, false);
            pushCheck('FIXED', `${clientConfig.name}: restored skill in ${clientConfig.skillPath}`);
          } else {
            pushCheck('WARN', `${clientConfig.name}: skill missing at ${clientConfig.skillPath}`);
          }
        } else if (!inspection.hasSkillMd) {
          if (args.fix) {
            installSkill(clientConfig.skillPath, false);
            pushCheck('FIXED', `${clientConfig.name}: restored SKILL.md in ${clientConfig.skillPath}`);
          } else {
            pushCheck('WARN', `${clientConfig.name}: SKILL.md missing in ${clientConfig.skillPath}`);
          }
        } else if (!inspection.hasFrontmatter) {
          if (args.fix) {
            installSkill(clientConfig.skillPath, false);
            pushCheck('FIXED', `${clientConfig.name}: repaired SKILL.md frontmatter in ${clientConfig.skillPath}`);
          } else {
            pushCheck('WARN', `${clientConfig.name}: SKILL.md has invalid frontmatter in ${clientConfig.skillPath}`);
          }
        } else {
          pushCheck('OK', `${clientConfig.name}: skill is healthy in ${clientConfig.skillPath}`);
        }

        // Check for stale CLAUDE.md managed block (pre-skill migration)
        const oldAgentDocsPath = getLegacyClaudeMdPath();
        const oldInspection = inspectAgentDocs(oldAgentDocsPath);
        if (oldInspection.exists && oldInspection.status !== 'missing') {
          if (args.fix) {
            migrateFromAgentDocs(oldAgentDocsPath, false);
            pushCheck('FIXED', `${clientConfig.name}: removed stale CLAUDE.md managed block`);
          } else {
            pushCheck('WARN', `${clientConfig.name}: stale CLAUDE.md managed block found — run with --fix to remove`);
          }
        }
      }
    } else if (clientConfig.agentDocsPath) {
      if (!configured) {
        if (fs.existsSync(clientConfig.agentDocsPath)) {
          pushCheck('INFO', `${clientConfig.name}: instruction file exists at ${clientConfig.agentDocsPath}, but open-zk-kb is not installed for this client`);
        } else {
          pushCheck('INFO', `${clientConfig.name}: managed instructions are not installed`);
        }
      } else {
        const inspection = inspectAgentDocs(clientConfig.agentDocsPath);
        if (!inspection.exists) {
          if (args.fix) {
            const size = clientConfig.instructionSize || 'full';
            injectAgentDocs(clientConfig.agentDocsPath, size, false, client, PKG_VERSION);
            pushCheck('FIXED', `${clientConfig.name}: restored managed instructions in ${clientConfig.agentDocsPath}`);
          } else {
            pushCheck('WARN', `${clientConfig.name}: managed instructions missing at ${clientConfig.agentDocsPath}`);
          }
        } else if (inspection.status === 'healthy') {
          pushCheck('OK', `${clientConfig.name}: managed instructions are healthy in ${clientConfig.agentDocsPath}`);
        } else if (args.fix) {
          const size = clientConfig.instructionSize || 'full';
          injectAgentDocs(clientConfig.agentDocsPath, size, false, client, PKG_VERSION);
          pushCheck('FIXED', `${clientConfig.name}: repaired managed instructions in ${clientConfig.agentDocsPath}`);
        } else if (inspection.status === 'missing') {
          pushCheck('WARN', `${clientConfig.name}: instruction file exists but has no managed block at ${clientConfig.agentDocsPath}`);
        } else {
          pushCheck('WARN', `${clientConfig.name}: managed instructions need repair (${inspection.status}) in ${clientConfig.agentDocsPath}`);
        }
      }
    } else {
      pushCheck('INFO', `${clientConfig.name}: managed instructions are not currently supported`);
    }
  }

  return [
    'open-zk-kb doctor',
    '',
    ...checks,
    '',
    'Summary',
    `- OK: ${okCount}`,
    `- FIXED: ${fixedCount}`,
    `- INFO: ${infoCount}`,
    `- WARN: ${warnCount}`,
    `- ERROR: ${errorCount}`,
  ].join('\n');
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
      throw new Error(`Failed to parse ${clientConfig.configPath}: ${e}`, { cause: e });
    }
  }

  const existing = getNestedValue(config, clientConfig.mcpPath);
  if (existing && !args.force) {
    return `Already installed for ${clientConfig.name}. Use --force to overwrite.`;
  }
  
  const mcpEntry = buildMcpEntry(clientConfig, serverPath);
  
  if (args.dryRun) {
    let output = `Dry run: Would add to ${clientConfig.configPath}:\n${JSON.stringify(mcpEntry, null, 2)}`;
    if (clientConfig.skillPath) {
      output += `\nWould install skill to ${clientConfig.skillPath}`;
    } else if (clientConfig.agentDocsPath) {
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
  const configYamlPath = getConfigYamlPath();
  let configCopied = false;
  if (!fs.existsSync(configYamlPath) && fs.existsSync(exampleConfigPath)) {
    fs.mkdirSync(path.dirname(configYamlPath), { recursive: true });
    fs.copyFileSync(exampleConfigPath, configYamlPath);
    configCopied = true;
  }
  
  // Install skill or inject agent docs depending on client
  let skillResult: { action: string; skillPath: string } | null = null;
  let agentDocsResult: { action: string; filePath: string } | null = null;
  let migrationResult: { migrated: boolean; fileDeleted: boolean } | null = null;

  if (clientConfig.skillPath) {
    skillResult = installSkill(clientConfig.skillPath, args.dryRun);

    // Migrate away from old CLAUDE.md managed block if present
    migrationResult = migrateFromAgentDocs(getLegacyClaudeMdPath(), args.dryRun);
  } else if (clientConfig.agentDocsPath) {
    const size = args.instructionSize || clientConfig.instructionSize || 'full';
    agentDocsResult = injectAgentDocs(clientConfig.agentDocsPath, size, args.dryRun, args.client, PKG_VERSION);
  }

  let output = `Installed open-zk-kb for ${clientConfig.name}\n\n`;
  output += `Config: ${clientConfig.configPath}\n`;
  output += `Vault: ${vaultPath}\n`;
  output += `Server: ${formatServerCommand(serverPath)}\n`;
  if (skillResult) {
    output += `Skill: ${skillResult.skillPath} (${skillResult.action})\n`;
  }
  if (agentDocsResult) {
    output += `Agent docs: ${agentDocsResult.filePath} (${agentDocsResult.action})\n`;
  }
  if (migrationResult?.migrated) {
    output += `Migration: removed old CLAUDE.md managed block${migrationResult.fileDeleted ? ' (file deleted — was empty)' : ''}\n`;
  }
  output += `\nNext steps:\n`;
  if (configCopied) {
    output += `1. Review ${configYamlPath} if you want to customize settings or use API embeddings\n`;
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
    throw new Error(`Failed to parse ${clientConfig.configPath}: ${e}`, { cause: e });
  }

  const existing = getNestedValue(config, clientConfig.mcpPath);
  if (!existing) {
    return `open-zk-kb not configured for ${clientConfig.name}`;
  }
  
  if (args.dryRun) {
    let output = `Dry run: Would remove from ${clientConfig.configPath}\n`;
    if (clientConfig.skillPath) {
      output += `Would remove skill from ${clientConfig.skillPath}\n`;
    } else if (clientConfig.agentDocsPath) {
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

  // Remove skill or agent docs depending on client
  let skillResult: { action: string; skillPath: string } | null = null;
  let agentDocsResult: { action: string; filePath: string } | null = null;

  if (clientConfig.skillPath) {
    skillResult = removeSkill(clientConfig.skillPath, args.dryRun);
  } else if (clientConfig.agentDocsPath) {
    agentDocsResult = removeAgentDocs(clientConfig.agentDocsPath, args.dryRun);
  }

  let output = `Uninstalled open-zk-kb from ${clientConfig.name}\n\n`;
  output += `Removed from: ${clientConfig.configPath}\n`;
  if (skillResult && skillResult.action !== 'not-found') {
    output += `Skill: ${skillResult.skillPath} (${skillResult.action})\n`;
  }
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
  console.log(`Usage: open-zk-kb <install|uninstall|doctor|server> [options]

server:
  Start the MCP stdio server directly

doctor:
  Check install health for one client or all clients
  --client <name>      Check a specific client (opencode, claude-code, cursor, windsurf, zed)
  --fix                Repair safe doctor findings when possible

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
  const hasSubcommand = firstArg === 'install' || firstArg === 'uninstall' || firstArg === 'doctor';
  const command: 'install' | 'uninstall' | 'doctor' = hasSubcommand ? firstArg : 'install';
  const args = hasSubcommand ? rawArgs.slice(1) : rawArgs;

  if (firstArg === '--help' || firstArg === '-h') {
    printHelp();
    process.exit(0);
  }

  if (firstArg && !hasSubcommand && !firstArg.startsWith('--')) {
    printHelp();
    process.exit(1);
  }

  if (command === 'doctor') {
    const clientArg = parseFlagValue(args, '--client');
    const fix = args.includes('--fix');
    let client: McpClient | undefined;

    if (clientArg !== undefined) {
      if (!isMcpClient(clientArg)) {
        throw new Error(`Invalid client: ${clientArg}`);
      }
      client = clientArg;
    }

    console.log(doctor({ client, fix }));
    return;
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
