#!/usr/bin/env bun
// setup.ts - Install/uninstall open-zk-kb MCP server to client configs
// Can be run as CLI or used as module by MCP tools

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as p from '@clack/prompts';
import color from 'picocolors';
import { expandPath } from './utils/path.js';
import { injectAgentDocs, inspectAgentDocs, removeAgentDocs } from './agent-docs.js';
import type { InstructionSize } from './agent-docs.js';
import { PKG_VERSION } from './version.js';
import { getConfig } from './config.js';

function detectNpmTag(): 'dev' | 'latest' {
  return PKG_VERSION.includes('-dev.') ? 'dev' : 'latest';
}

const xdgConfigHome = process.env.XDG_CONFIG_HOME || expandPath('~/.config');
const xdgDataHome = process.env.XDG_DATA_HOME || expandPath('~/.local/share');

export type McpClient = 'opencode' | 'claude-code' | 'cursor' | 'windsurf' | 'zed' | 'pi' | 'omp';

export type McpTransport = 'stdio' | 'http';

export interface InstallArgs {
  client: McpClient;
  serverPath?: string;
  transport?: McpTransport;
  force?: boolean;
  dryRun?: boolean;
  instructionSize?: InstructionSize;
  /** Inject agent docs even when the path is a symlink to a shared file. */
  injectSharedAgentDocs?: boolean;
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
  integration?: 'mcp' | 'pi-package';
  mcpPath?: string[];
  mcpFormat?: 'opencode' | 'standard';
  agentDocsPath?: string;
  instructionSize?: InstructionSize;
  /** Path where a Claude Code skill directory should be installed (e.g. ~/.claude/skills/open-zk-kb) */
  skillPath?: string;
  /** Paths where a previous install may have left a managed block that should be cleaned up. */
  staleAgentDocsPaths?: string[];
  /** Content prepended before the managed block when creating the file (e.g. YAML frontmatter for OMP rules) */
  preamble?: string;
}

const PI_PACKAGE_NAME = 'open-zk-kb';
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
  'pi': {
    name: 'Pi',
    configPath: path.join(expandPath('~/.pi'), 'agent', 'settings.json'),
    configFormat: 'json',
    integration: 'pi-package',
    agentDocsPath: path.join(expandPath('~/.pi'), 'agent', 'AGENTS.md'),
    instructionSize: 'full',
  },
  'omp': {
    name: 'OMP',
    configPath: path.join(expandPath('~/.omp'), 'agent', 'mcp.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
    skillPath: path.join(expandPath('~/.omp'), 'agent', 'skills', 'open-zk-kb'),
    agentDocsPath: path.join(expandPath('~/.omp'), 'agent', 'rules', 'open-zk-kb.md'),
    instructionSize: 'compact',
    preamble: '---\nalwaysApply: true\ndescription: Knowledge base (open-zk-kb) persistent memory instructions\n---\n',
    staleAgentDocsPaths: [
      path.join(expandPath('~/.omp'), 'agent', 'AGENTS.md'),
      path.join(expandPath('~/.omp'), 'agent', 'RULES.md'),
    ],
  },
};

const ALL_CLIENTS: McpClient[] = ['opencode', 'claude-code', 'cursor', 'windsurf', 'zed', 'pi', 'omp'];

const CLIENT_PROMPT_OPTIONS: Array<{ value: McpClient; label: string; hint: string }> = [
  { value: 'opencode', label: 'OpenCode', hint: 'MCP server + managed instructions' },
  { value: 'claude-code', label: 'Claude Code', hint: 'MCP server + skill' },
  { value: 'cursor', label: 'Cursor', hint: 'MCP server integration' },
  { value: 'windsurf', label: 'Windsurf', hint: 'MCP server integration' },
  { value: 'zed', label: 'Zed', hint: 'MCP server integration' },
  { value: 'pi', label: 'Pi', hint: 'Pi package + managed instructions' },
  { value: 'omp', label: 'OMP', hint: 'MCP server + skill' },
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
    }
  | {
      type: 'http';
      url: string;
    };

function buildMcpEntry(clientConfig: ClientConfig, serverPath?: string, transport?: McpTransport): McpEntry {
  if (!clientConfig.mcpFormat) {
    throw new Error(`${clientConfig.name} does not use MCP config entries`);
  }

  if (transport === 'http') {
    const config = getConfig();
    const clientHost = config.server.host === '0.0.0.0' || config.server.host === '::'
      ? '127.0.0.1'
      : config.server.host;
    return {
      type: 'http',
      url: `http://${clientHost.includes(':') ? `[${clientHost}]` : clientHost}:${config.server.port}/mcp`,
    };
  }

  if (!serverPath) {
    const tag = detectNpmTag();
    if (clientConfig.mcpFormat === 'opencode') {
      return {
        type: 'local',
        command: ['bunx', `open-zk-kb@${tag}`, 'server'],
        enabled: true,
      };
    }

    return {
      command: 'bunx',
      args: [`open-zk-kb@${tag}`, 'server'],
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

function detectProjectRoot(): string | undefined {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, '..');
  return fs.existsSync(path.join(projectRoot, '.git')) ? projectRoot : undefined;
}

function detectServerPath(): string | undefined {
  const projectRoot = detectProjectRoot();
  if (!projectRoot) {
    return undefined;
  }
  const distPath = path.join(projectRoot, 'dist', 'mcp-server.js');
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  throw new Error('Could not detect server path. Please provide --server-path');
}

function isStaleOpenCodePluginEntry(value: string): boolean {
  if (value === 'open-zk-kb' || value === 'open-zk-kb/plugin') {
    return true;
  }

  if (value.startsWith('open-zk-kb@')) {
    return true;
  }

  if (!value.startsWith('file://')) {
    return false;
  }

  try {
    const filePath = fileURLToPath(value);
    const normalized = path.normalize(filePath);
    return path.basename(normalized) === 'open-zk-kb'
      || normalized.endsWith(`${path.sep}open-zk-kb${path.sep}dist${path.sep}opencode-plugin${path.sep}index.js`);
  } catch {
    return false;
  }
}

function removeStaleOpenCodePluginEntries(config: JsonObject): boolean {
  if (!Array.isArray(config.plugin)) {
    return false;
  }

  const preserved = config.plugin.filter((entry) => typeof entry !== 'string' || !isStaleOpenCodePluginEntry(entry));
  if (preserved.length === config.plugin.length) {
    return false;
  }

  if (preserved.length === 0) {
    delete config.plugin;
  } else {
    config.plugin = preserved;
  }

  return true;
}

function formatServerCommand(serverPath?: string): string {
  return serverPath ? `bun run ${serverPath}` : `bunx open-zk-kb@${detectNpmTag()} server`;
}

function buildPiPackageSource(): string {
  const projectRoot = detectProjectRoot();
  if (projectRoot) {
    return projectRoot;
  }

  const tag = detectNpmTag();
  return tag === 'dev' ? `npm:${PI_PACKAGE_NAME}@dev` : `npm:${PI_PACKAGE_NAME}`;
}

function getPackageArray(config: JsonObject): unknown[] | undefined {
  return Array.isArray(config.packages) ? config.packages : undefined;
}

function packageSourceValue(entry: unknown): string | undefined {
  if (typeof entry === 'string') {
    return entry;
  }

  if (isJsonObject(entry) && typeof entry.source === 'string') {
    return entry.source;
  }

  return undefined;
}

function isOpenZkKbPiPackageSource(source: string): boolean {
  if (source === PI_PACKAGE_NAME || source === `npm:${PI_PACKAGE_NAME}` || source.startsWith(`npm:${PI_PACKAGE_NAME}@`)) {
    return true;
  }

  if (source.startsWith('file://')) {
    try {
      return isOpenZkKbLocalPackagePath(fileURLToPath(source));
    } catch {
      return false;
    }
  }

  return path.isAbsolute(source) && isOpenZkKbLocalPackagePath(source);
}

function isOpenZkKbLocalPackagePath(source: string): boolean {
  const normalized = path.normalize(source);
  return path.basename(normalized) === PI_PACKAGE_NAME;
}

function normalizePiPackages(config: JsonObject, desiredSource: string): void {
  const existing = getPackageArray(config) ?? [];
  const preserved = existing.filter((entry) => {
    const source = packageSourceValue(entry);
    return source === undefined || !isOpenZkKbPiPackageSource(source);
  });
  config.packages = [...preserved, desiredSource];
}

function removePiPackage(config: JsonObject): void {
  const existing = getPackageArray(config);
  if (!existing) {
    return;
  }

  const preserved = existing.filter((entry) => {
    const source = packageSourceValue(entry);
    return source === undefined || !isOpenZkKbPiPackageSource(source);
  });

  if (preserved.length === 0) {
    delete config.packages;
    return;
  }

  config.packages = preserved;
}

function validatePiPackageConfig(config: JsonObject, expectedSource: string): string[] {
  if (!("packages" in config)) {
    return ['missing packages array'];
  }

  if (!Array.isArray(config.packages)) {
    return ['packages is not an array'];
  }

  const matches = config.packages
    .map(packageSourceValue)
    .filter((source): source is string => source !== undefined && isOpenZkKbPiPackageSource(source));

  if (matches.length === 0) {
    return ['missing open-zk-kb package source'];
  }

  if (matches.length > 1) {
    return ['duplicate open-zk-kb package sources'];
  }

  if (matches[0] !== expectedSource) {
    return [`expected package source "${expectedSource}"`];
  }

  return [];
}

function isPiPackageClient(clientConfig: ClientConfig): boolean {
  return clientConfig.integration === 'pi-package';
}

/**
 * Check if open-zk-kb is already installed for a given client.
 */
function isClientInstalled(client: McpClient): boolean {
  const clientConfig = CLIENT_CONFIGS[client];
  
  if (!fs.existsSync(clientConfig.configPath)) {
    return false;
  }
  
  try {
    const content = fs.readFileSync(clientConfig.configPath, 'utf-8');
    const config = parseJsonObject(content);
    if (isPiPackageClient(clientConfig)) {
      return validatePiPackageConfig(config, buildPiPackageSource()).length === 0;
    }
    if (!clientConfig.mcpPath) {
      return false;
    }
    const entry = getNestedValue(config, clientConfig.mcpPath);
    return entry !== undefined;
  } catch {
    return false;
  }
}

/**
 * Get list of clients that are already installed.
 */
function getInstalledClients(): McpClient[] {
  return ALL_CLIENTS.filter(isClientInstalled);
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(content: string): JsonObject {
  const parsed: unknown = JSON.parse(content);
  return isJsonObject(parsed) ? parsed : {};
}

function getNestedValue(obj: JsonObject, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (isJsonObject(current) && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function setNestedValue(obj: JsonObject, path: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = current[key];
    if (!isJsonObject(next)) {
      current[key] = {};
    }
    const updated = current[key];
    if (isJsonObject(updated)) current = updated;
  }
  current[path[path.length - 1]] = value;
}

function deleteNestedValue(obj: JsonObject, path: string[]): boolean {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = current[path[i]];
    if (!isJsonObject(next)) {
      return false;
    }
    current = next;
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

/**
 * If the path is a symlink, return the resolved target. Otherwise return null.
 */
function resolveSymlinkTarget(filePath: string): string | null {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      return fs.realpathSync(filePath);
    }
  } catch { /* path doesn't exist */ }
  return null;
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
  const exampleConfigPath = path.join(projectRoot, 'templates', 'install', 'config.example.yaml');
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

  // HTTP transport entries are valid if they have a url
  if (record.type === 'http') {
    if (typeof record.url !== 'string' || record.url.length === 0) issues.push('missing url for http entry');
    return issues;
  }
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
  if (!clientConfig.mcpPath) {
    throw new Error(`${clientConfig.name} does not use MCP config entries`);
  }
  // Don't repair HTTP entries — they are intentional transport overrides
  if (existingEntry && typeof existingEntry === 'object' && (existingEntry as Record<string, unknown>).type === 'http') {
    return;
  }
  const inferredServerPath = inferServerPathFromEntry(clientConfig, existingEntry);
  const repairedEntry = buildMcpEntry(clientConfig, inferredServerPath);
  setNestedValue(config, clientConfig.mcpPath, repairedEntry);
  if (clientConfig.mcpFormat === 'opencode') {
    removeStaleOpenCodePluginEntries(config);
  }
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
        const config = parseJsonObject(content);

        if (isPiPackageClient(clientConfig)) {
          const packageIssues = validatePiPackageConfig(config, buildPiPackageSource());
          if (packageIssues.length === 0) {
            configured = true;
            pushCheck('OK', `${clientConfig.name}: package source looks healthy in ${clientConfig.configPath}`);
          } else if (args.fix && getPackageArray(config)?.some((entry) => {
            const source = packageSourceValue(entry);
            return source !== undefined && isOpenZkKbPiPackageSource(source);
          })) {
            normalizePiPackages(config, buildPiPackageSource());
            fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
            configured = true;
            pushCheck('FIXED', `${clientConfig.name}: repaired package source in ${clientConfig.configPath}`);
          } else {
            pushCheck('INFO', `${clientConfig.name}: open-zk-kb package is not configured in ${clientConfig.configPath}`);
          }
        } else if (clientConfig.mcpPath) {
          const entry = getNestedValue(config, clientConfig.mcpPath);

          if (!entry) {
            pushCheck('INFO', `${clientConfig.name}: open-zk-kb is not configured in ${clientConfig.configPath}`);
          } else {
            const issues = validateMcpEntry(clientConfig, entry);
            if (issues.length === 0) {
              configured = true;
              pushCheck('OK', `${clientConfig.name}: MCP config looks healthy in ${clientConfig.configPath}`);
              if (clientConfig.mcpFormat === 'opencode' && removeStaleOpenCodePluginEntries(config)) {
                if (args.fix) {
                  fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
                  pushCheck('FIXED', `${clientConfig.name}: removed stale open-zk-kb plugin entries from ${clientConfig.configPath}`);
                } else {
                  pushCheck('WARN', `${clientConfig.name}: stale open-zk-kb plugin entries remain in ${clientConfig.configPath} — run with --fix to remove`);
                }
              }
            } else if (args.fix) {
              repairClientConfig(clientConfig, config, entry);
              configured = true;
              pushCheck('FIXED', `${clientConfig.name}: repaired MCP config in ${clientConfig.configPath}`);
            } else {
              pushCheck('ERROR', `${clientConfig.name}: MCP config is invalid (${issues.join(', ')})`);
            }
          }
        }
      } catch (error) {
        pushCheck('ERROR', `${clientConfig.name}: failed to parse ${clientConfig.configPath} (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    if (clientConfig.skillPath) {
      // Skill-based client (e.g. Claude Code, OMP)
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
        if (client === 'claude-code') {
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
      }
    }
    if (clientConfig.agentDocsPath) {
      const symlinkTarget = resolveSymlinkTarget(clientConfig.agentDocsPath);
      if (symlinkTarget) {
        pushCheck('INFO', `${clientConfig.name}: agent docs path is a symlink (→ ${symlinkTarget}) — skipping to avoid modifying a shared file`);
      } else if (!configured) {
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
            injectAgentDocs(clientConfig.agentDocsPath, size, false, client, PKG_VERSION, clientConfig.preamble);
            pushCheck('FIXED', `${clientConfig.name}: restored managed instructions in ${clientConfig.agentDocsPath}`);
          } else {
            pushCheck('WARN', `${clientConfig.name}: managed instructions missing at ${clientConfig.agentDocsPath}`);
          }
        } else if (inspection.status === 'healthy') {
          pushCheck('OK', `${clientConfig.name}: managed instructions are healthy in ${clientConfig.agentDocsPath}`);
        } else if (args.fix) {
          const size = clientConfig.instructionSize || 'full';
          injectAgentDocs(clientConfig.agentDocsPath, size, false, client, PKG_VERSION, clientConfig.preamble);
          pushCheck('FIXED', `${clientConfig.name}: repaired managed instructions in ${clientConfig.agentDocsPath}`);
        } else if (inspection.status === 'missing') {
          pushCheck('WARN', `${clientConfig.name}: instruction file exists but has no managed block at ${clientConfig.agentDocsPath}`);
        } else {
          pushCheck('WARN', `${clientConfig.name}: managed instructions need repair (${inspection.status}) in ${clientConfig.agentDocsPath}`);
        }
      }
    }
    if (!clientConfig.skillPath && !clientConfig.agentDocsPath) {
      pushCheck('INFO', `${clientConfig.name}: managed instructions are not currently supported`);
    }
    // Check for stale managed blocks in old locations
    if (clientConfig.staleAgentDocsPaths) {
      for (const stalePath of clientConfig.staleAgentDocsPaths) {
        if (stalePath === clientConfig.agentDocsPath) continue;
        if (resolveSymlinkTarget(stalePath)) continue; // don't modify shared files via symlink
        const staleInspection = inspectAgentDocs(stalePath);
        if (staleInspection.exists && staleInspection.status !== 'missing') {
          if (args.fix) {
            removeAgentDocs(stalePath);
            pushCheck('FIXED', `${clientConfig.name}: removed stale managed block from ${stalePath}`);
          } else {
            pushCheck('WARN', `${clientConfig.name}: stale managed block in ${stalePath} — run with --fix to remove`);
          }
        }
      }
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
  const usesPiPackage = isPiPackageClient(clientConfig);
  const serverPath = usesPiPackage ? args.serverPath :
    args.transport === 'http' ? args.serverPath :
    args.serverPath || detectServerPath();
  const piPackageSource = usesPiPackage ? buildPiPackageSource() : null;
  const vaultPath = getVaultPath();
  
  if (!usesPiPackage && args.transport !== 'http' && serverPath && !fs.existsSync(serverPath)) {
    throw new Error(`Server not found at: ${serverPath}`);
  }
  
  let config: JsonObject = {};
  
  if (fs.existsSync(clientConfig.configPath)) {
    try {
      const content = fs.readFileSync(clientConfig.configPath, 'utf-8');
      config = parseJsonObject(content);
    } catch (e) {
      throw new Error(`Failed to parse ${clientConfig.configPath}: ${e}`, { cause: e });
    }
  }

  const removedStaleOpenCodePlugins = !usesPiPackage && clientConfig.mcpFormat === 'opencode'
    ? removeStaleOpenCodePluginEntries(config)
    : false;

  const existing = usesPiPackage
    ? validatePiPackageConfig(config, piPackageSource ?? '').length === 0
    : clientConfig.mcpPath ? getNestedValue(config, clientConfig.mcpPath) !== undefined : false;

  if (existing && !args.force) {
    if (removedStaleOpenCodePlugins && !args.dryRun) {
      fs.mkdirSync(path.dirname(clientConfig.configPath), { recursive: true });
      fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
    }
    return `Already installed for ${clientConfig.name}. Use --force to overwrite.`;
  }
  
  const mcpEntry = usesPiPackage ? null : buildMcpEntry(clientConfig, serverPath, args.transport);
  
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const templatesDir = path.join(projectRoot, 'templates');
  const vaultTemplatesDir = path.join(vaultPath, 'templates');
  const templateFileCount = fs.existsSync(templatesDir) ? fs.readdirSync(templatesDir).filter(f => f.endsWith('.md')).length : 0;

  if (args.dryRun) {
    let output = usesPiPackage
      ? `Dry run: Would add Pi package source to ${clientConfig.configPath}:\n${piPackageSource}\nNote: Also run \`pi install ${piPackageSource}\` — Pi does not support MCP natively`
      : `Dry run: Would add to ${clientConfig.configPath}:\n${JSON.stringify(mcpEntry, null, 2)}`;
    if (clientConfig.skillPath) {
      output += `\nWould install skill to ${clientConfig.skillPath}`;
    }
    if (clientConfig.agentDocsPath) {
      const symlinkTarget = resolveSymlinkTarget(clientConfig.agentDocsPath);
      if (!symlinkTarget || args.injectSharedAgentDocs) {
        output += `\nWould inject agent docs into ${clientConfig.agentDocsPath}`;
      } else {
        output += `\nWould skip agent docs (${clientConfig.agentDocsPath} → ${symlinkTarget})`;
      }
    }
    if (templateFileCount > 0) {
      output += `\nWould copy ${templateFileCount} template files to ${vaultTemplatesDir}`;
    }
    return output;
  }
  
  if (usesPiPackage) {
    normalizePiPackages(config, piPackageSource ?? buildPiPackageSource());
  } else if (clientConfig.mcpPath) {
    setNestedValue(config, clientConfig.mcpPath, mcpEntry);
  }
  
  const configDir = path.dirname(clientConfig.configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
  
  if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.mkdirSync(path.join(vaultPath, '.index'), { recursive: true });
  }
  
  const exampleConfigPath = path.join(projectRoot, 'templates', 'install', 'config.example.yaml');
  const configYamlPath = getConfigYamlPath();
  let configCopied = false;
  if (!fs.existsSync(configYamlPath) && fs.existsSync(exampleConfigPath)) {
    fs.mkdirSync(path.dirname(configYamlPath), { recursive: true });
    fs.copyFileSync(exampleConfigPath, configYamlPath);
    configCopied = true;
  }
  
  let templatesCopied = 0;
  if (fs.existsSync(templatesDir)) {
    fs.mkdirSync(vaultTemplatesDir, { recursive: true });
    for (const file of fs.readdirSync(templatesDir).filter(f => f.endsWith('.md'))) {
      const dest = path.join(vaultTemplatesDir, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(templatesDir, file), dest);
        templatesCopied++;
      }
    }
  }

  let skillResult: { action: string; skillPath: string } | null = null;
  let agentDocsResult: { action: string; filePath: string } | null = null;
  let migrationResult: { migrated: boolean; fileDeleted: boolean } | null = null;

  if (clientConfig.skillPath) {
    skillResult = installSkill(clientConfig.skillPath, args.dryRun);

    // Migrate away from old CLAUDE.md managed block if present (Claude Code only)
    if (args.client === 'claude-code') {
      migrationResult = migrateFromAgentDocs(getLegacyClaudeMdPath(), args.dryRun);
    }
  }
  let agentDocsSkippedSymlink: string | null = null;
  if (clientConfig.agentDocsPath) {
    const symlinkTarget = resolveSymlinkTarget(clientConfig.agentDocsPath);
    if (symlinkTarget && !args.injectSharedAgentDocs) {
      agentDocsSkippedSymlink = symlinkTarget;
    } else {
      const size = args.instructionSize || clientConfig.instructionSize || 'full';
      agentDocsResult = injectAgentDocs(clientConfig.agentDocsPath, size, args.dryRun, args.client, PKG_VERSION, clientConfig.preamble);
    }
  }
  // Clean up managed blocks from stale locations (e.g. OMP: AGENTS.md → RULES.md migration)
  const staleCleaned: string[] = [];
  if (clientConfig.staleAgentDocsPaths && !args.dryRun) {
    for (const stalePath of clientConfig.staleAgentDocsPaths) {
      if (stalePath === clientConfig.agentDocsPath) continue; // don't clean the current target
      if (resolveSymlinkTarget(stalePath)) continue; // don't modify shared files via symlink
      const staleResult = removeAgentDocs(stalePath);
      if (staleResult.action === 'removed' || staleResult.action === 'file-deleted') {
        staleCleaned.push(stalePath);
      }
    }
  }

  let output = `Installed open-zk-kb for ${clientConfig.name}\n\n`;
  output += `Config: ${clientConfig.configPath}\n`;
  output += `Vault: ${vaultPath}\n`;
  if (usesPiPackage) {
    output += `Package: ${piPackageSource}\n`;
  } else {
    output += `Server: ${formatServerCommand(serverPath)}\n`;
  }
  if (skillResult) {
    output += `Skill: ${skillResult.skillPath} (${skillResult.action})\n`;
  }
  if (agentDocsResult) {
    output += `Agent docs: ${agentDocsResult.filePath} (${agentDocsResult.action})\n`;
  }
  if (agentDocsSkippedSymlink) {
    output += `Agent docs: skipped (${clientConfig.agentDocsPath} → ${agentDocsSkippedSymlink})\n`;
  }
  if (migrationResult?.migrated) {
    output += `Migration: removed old CLAUDE.md managed block${migrationResult.fileDeleted ? ' (file deleted — was empty)' : ''}\n`;
  }
  for (const cleaned of staleCleaned) {
    output += `Cleanup: removed stale managed block from ${cleaned}\n`;
  }
  if (templatesCopied > 0) {
    output += `Templates: ${templatesCopied} files → ${vaultTemplatesDir}\n`;
  }
  output += `\nNext steps:\n`;
  let step = 1;
  if (configCopied) {
    output += `${step++}. Review ${configYamlPath} if you want to customize settings or use API embeddings\n`;
  }
  if (usesPiPackage) {
    output += `${step++}. Run \`pi install ${piPackageSource}\` if you haven't already (Pi does not support MCP natively — this installs the package extension)\n`;
    output += `${step}. Restart Pi to load the package extension\n`;
  } else {
    output += `${step}. Restart ${clientConfig.name} to load the MCP server\n`;
  }
  
  return output;
}

export function uninstall(args: UninstallArgs): string {
  const clientConfig = CLIENT_CONFIGS[args.client];
  const usesPiPackage = isPiPackageClient(clientConfig);
  const vaultPath = getVaultPath();
  
  if (!fs.existsSync(clientConfig.configPath)) {
    return `No config found for ${clientConfig.name} at ${clientConfig.configPath}`;
  }
  
  let config: JsonObject;
  try {
    const content = fs.readFileSync(clientConfig.configPath, 'utf-8');
    config = parseJsonObject(content);
  } catch (e) {
    throw new Error(`Failed to parse ${clientConfig.configPath}: ${e}`, { cause: e });
  }

  const existing = usesPiPackage
    ? validatePiPackageConfig(config, buildPiPackageSource()).length === 0
    : clientConfig.mcpPath ? getNestedValue(config, clientConfig.mcpPath) !== undefined : false;
  if (!existing) {
    return `open-zk-kb not configured for ${clientConfig.name}`;
  }
  
  if (args.dryRun) {
    let output = `Dry run: Would remove from ${clientConfig.configPath}\n`;
    if (clientConfig.skillPath) {
      output += `Would remove skill from ${clientConfig.skillPath}\n`;
    }
    if (clientConfig.agentDocsPath && !resolveSymlinkTarget(clientConfig.agentDocsPath)) {
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
  
  if (usesPiPackage) {
    removePiPackage(config);
  } else if (clientConfig.mcpPath) {
    deleteNestedValue(config, clientConfig.mcpPath);
  }
  if (clientConfig.mcpFormat === 'opencode') {
    removeStaleOpenCodePluginEntries(config);
  }

  fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));

  // Remove skill and/or agent docs depending on client
  let skillResult: { action: string; skillPath: string } | null = null;
  let agentDocsResult: { action: string; filePath: string } | null = null;

  if (clientConfig.skillPath) {
    skillResult = removeSkill(clientConfig.skillPath, args.dryRun);
  }
  if (clientConfig.agentDocsPath && !resolveSymlinkTarget(clientConfig.agentDocsPath)) {
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
    output += `Reinstall anytime with: bunx open-zk-kb@${detectNpmTag()} install --client ${args.client}\n`;
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
  --client <name>      Check a specific client (opencode, claude-code, cursor, windsurf, zed, pi, omp)
  --fix                Repair safe doctor findings when possible

install:
  (no flags)           Interactive client selection
  --client <name>      Install for specific client (opencode, claude-code, cursor, windsurf, zed, pi, omp)
  --server-path <path> Path to dist/mcp-server.js (auto-detected; MCP clients only)
  --instructions <size> Agent instruction size: compact (~140 tokens) or full (~420 tokens)
  --transport <type>   Transport type: stdio (default) or http
  --force              Overwrite existing config
  --dry-run            Preview changes without applying
  --yes                Non-interactive, accept defaults

uninstall:
  (no flags)           Interactive client selection
  --client <name>      Uninstall from specific client (opencode, claude-code, cursor, windsurf, zed, pi, omp)
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
    const transportArg = parseFlagValue(args, '--transport');
    const transport: McpTransport | undefined =
      transportArg === 'stdio' || transportArg === 'http' ? transportArg : undefined;
    if (transportArg && !transport) {
      throw new Error(`Invalid --transport value: ${transportArg}. Use 'stdio' or 'http'.`);
    }
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

    /** Prompt for symlinked agent docs and install a single client. */
    async function installWithSymlinkPrompt(
      client: McpClient,
      opts: { serverPath?: string; transport?: McpTransport; force?: boolean; dryRun?: boolean; instructionSize?: InstructionSize; yes?: boolean },
    ): Promise<string> {
      const clientConfig = CLIENT_CONFIGS[client];
      let injectSharedAgentDocs: boolean | undefined;

      if (clientConfig.agentDocsPath) {
        const symlinkTarget = resolveSymlinkTarget(clientConfig.agentDocsPath);
        if (symlinkTarget) {
          if (opts.yes) {
            // Non-interactive: skip by default
            injectSharedAgentDocs = false;
          } else {
            const answer = await p.confirm({
              message: `${clientConfig.name}: agent docs path is a symlink:\n  ${color.dim(`${clientConfig.agentDocsPath} → ${symlinkTarget}`)}\n  Inject managed instructions into the shared file?`,
              initialValue: false,
            });
            if (p.isCancel(answer)) {
              p.cancel('Setup cancelled.');
              process.exit(0);
            }
            injectSharedAgentDocs = answer;
          }
        }
      }

      return install({
        client,
        serverPath: opts.serverPath,
        transport: opts.transport,
        force: opts.force,
        dryRun: opts.dryRun,
        instructionSize: opts.instructionSize,
        injectSharedAgentDocs,
      });
    }

    if (client) {
      const result = await installWithSymlinkPrompt(client, { serverPath, transport, force, dryRun, instructionSize, yes });
      console.log(result);
      return;
    }

    if (yes) {
      for (const client of ALL_CLIENTS) {
        const result = await installWithSymlinkPrompt(client, { serverPath, transport, force, dryRun, instructionSize, yes: true });
        console.log(result);
      }
      return;
    }

    p.intro(color.cyan('open-zk-kb — Knowledge Base Setup'));
    
    // Pre-select clients that are already installed
    const alreadyInstalled = getInstalledClients();
    const hasInstalled = alreadyInstalled.length > 0;
    
    const selected = await p.multiselect<McpClient>({
      message: hasInstalled
        ? `Select clients to install:\n${color.dim('Already installed clients are pre-selected. Use --force to update.')}`
        : `Select clients to install:\n${color.dim('space to select, enter to confirm')}`,
      options: CLIENT_PROMPT_OPTIONS,
      initialValues: alreadyInstalled,
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
        await installWithSymlinkPrompt(client, { serverPath, transport, force, dryRun, instructionSize });
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
  
  // Pre-select clients that are currently installed
  const alreadyInstalled = getInstalledClients();
  
  if (alreadyInstalled.length === 0) {
    p.log.warn('No clients are currently installed.');
    p.outro('Nothing to uninstall.');
    return;
  }
  
  const selected = await p.multiselect<McpClient>({
    message: `Select clients to uninstall from:\n${color.dim('Installed clients are pre-selected.')}`,
    options: CLIENT_PROMPT_OPTIONS,
    initialValues: alreadyInstalled,
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
