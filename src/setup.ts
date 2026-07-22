#!/usr/bin/env bun
// setup.ts - Install/uninstall open-zk-kb MCP server to client configs
// Can be run as CLI or used as module by MCP tools

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as p from '@clack/prompts';
import color from 'picocolors';
import YAML from 'yaml';
import { expandPath } from './utils/path.js';
import { injectAgentDocs, inspectAgentDocs, removeAgentDocs, getAgentDocsVersion } from './agent-docs.js';
import type { InstructionSize } from './agent-docs.js';
import { PKG_VERSION } from './version.js';
import { getConfig, isTelemetryShareConfigured } from './config.js';
import { OMP_AGENT_DOCS_PREAMBLE } from './agent-docs-targets.js';

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

export type InstallStatus = 'installed' | 'already-installed' | 'dry-run';

export interface InstallResult {
  status: InstallStatus;
  clientName: string;
  output: string;
  /** Key files touched during install, for compact display. */
  details: string[];
  /** Stale symlinks that were skipped (user declined or non-interactive). */
  staleSkippedSymlinks: Array<{ stalePath: string; symlinkTarget: string }>;
  /** Agent docs symlink target if injection was skipped. */
  agentDocsSkippedSymlink: string | null;
}

export interface UninstallArgs {
  client: McpClient;
  removeVault?: boolean;
  confirm?: boolean;
  dryRun?: boolean;
  /** Remove agent docs even when the path is a symlink to a shared file. */
  removeSharedAgentDocs?: boolean;
}

export type UninstallStatus = 'uninstalled' | 'not-installed' | 'dry-run';

export interface UninstallResult {
  status: UninstallStatus;
  clientName: string;
  output: string;
  /** Key files touched during uninstall, for compact display. */
  details: string[];
  /** Agent docs symlink target if removal was skipped. */
  agentDocsSkippedSymlink: string | null;
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
  /** Field used by this client's HTTP MCP config for request headers. */
  httpAuthHeaderField?: 'headers';
  agentDocsPath?: string;
  /** Display label for the agent docs file (e.g. "Rule", "Instructions"). */
  agentDocsLabel?: string;
  instructionSize?: InstructionSize;
  /** Path where a Claude Code skill directory should be installed (e.g. ~/.claude/skills/open-zk-kb) */
  skillPath?: string;
  /** Paths where a previous install may have left a managed block that should be cleaned up. */
  staleAgentDocsPaths?: string[];
  /** Content prepended before the managed block when creating the file (e.g. YAML frontmatter for OMP rules) */
  preamble?: string;
  /**
   * Path to install a TTSR (Time-Traveling Stream Rules) enforcement rule.
   * TTSR is an OMP-specific mechanism that monitors the model's output stream

   * during generation and interrupts mid-stream when a regex pattern matches,
   * injecting corrective context. No other supported client has this capability.
   * Example: ~/.omp/agent/rules/open-zk-kb-enforce.md
   */
  ttsrRulePath?: string;
  /**
   * Server names to add to `disabledServers` during uninstall.
   * OMP uses this because it discovers MCP servers from other clients' configs too.
   */
  disabledServersOnUninstall?: string[];



  /** CLI binary name for "try it out" launch (e.g. "claude", "pi", "omp"). */
  cliBinary?: string;
}

const PI_PACKAGE_NAME = 'open-zk-kb';
export const TELEMETRY_PROMPT_INITIAL_VALUE = true;
export const CLIENT_CONFIGS: Record<McpClient, ClientConfig> = {
  'opencode': {
    name: 'OpenCode',
    configPath: path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    configFormat: 'json',
    mcpPath: ['mcp', 'open-zk-kb'],
    mcpFormat: 'opencode',
    httpAuthHeaderField: 'headers',
    agentDocsPath: path.join(xdgConfigHome, 'opencode', 'AGENTS.md'),
    agentDocsLabel: 'Instructions',
    instructionSize: 'full',
    cliBinary: 'opencode',
  },
  'claude-code': {
    name: 'Claude Code',
    configPath: path.join(expandPath('~/.claude'), 'settings.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
    httpAuthHeaderField: 'headers',
    skillPath: path.join(expandPath('~/.claude'), 'skills', 'open-zk-kb'),
    agentDocsPath: path.join(expandPath('~/.claude'), 'rules', 'open-zk-kb.md'),
    agentDocsLabel: 'Rule',
    instructionSize: 'rules',
    cliBinary: 'claude',
  },
  'cursor': {
    name: 'Cursor',
    configPath: path.join(expandPath('~/.cursor'), 'mcp.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
    httpAuthHeaderField: 'headers',
  },
  'windsurf': {
    name: 'Windsurf',
    configPath: path.join(expandPath('~/.codeium'), 'windsurf', 'mcp_config.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
    httpAuthHeaderField: 'headers',
    agentDocsPath: path.join(expandPath('~/.codeium'), 'windsurf', 'memories', 'global_rules.md'),
    instructionSize: 'compact',
    agentDocsLabel: 'Global rules',
  },
  'zed': {
    name: 'Zed',
    configPath: path.join(xdgConfigHome, 'zed', 'settings.json'),
    configFormat: 'json',
    mcpPath: ['context_servers', 'open-zk-kb'],
    mcpFormat: 'standard',
    httpAuthHeaderField: 'headers',
  },
  'pi': {
    name: 'Pi',
    configPath: path.join(expandPath('~/.pi'), 'agent', 'settings.json'),
    configFormat: 'json',
    integration: 'pi-package',
    agentDocsPath: path.join(expandPath('~/.pi'), 'agent', 'AGENTS.md'),
    agentDocsLabel: 'Instructions',
    instructionSize: 'full',
    cliBinary: 'pi',
  },
  'omp': {
    name: 'OMP',
    configPath: path.join(expandPath('~/.omp'), 'agent', 'mcp.json'),
    configFormat: 'json',
    mcpPath: ['mcpServers', 'open-zk-kb'],
    mcpFormat: 'standard',
    httpAuthHeaderField: 'headers',
    skillPath: path.join(expandPath('~/.omp'), 'agent', 'skills', 'open-zk-kb'),
    agentDocsPath: path.join(expandPath('~/.omp'), 'agent', 'rules', 'open-zk-kb.md'),
    agentDocsLabel: 'Rule',
    instructionSize: 'preflight',
    preamble: OMP_AGENT_DOCS_PREAMBLE,
    ttsrRulePath: path.join(expandPath('~/.omp'), 'agent', 'rules', 'open-zk-kb-enforce.md'),
    disabledServersOnUninstall: ['open-zk-kb'],

    staleAgentDocsPaths: [
      path.join(expandPath('~/.omp'), 'agent', 'AGENTS.md'),
      path.join(expandPath('~/.omp'), 'agent', 'RULES.md'),
    ],
    cliBinary: 'omp',
  },
};

const ALL_CLIENTS: McpClient[] = ['opencode', 'claude-code', 'cursor', 'windsurf', 'zed', 'pi', 'omp'];


/** Check if a client's editor/tool appears to be installed on this system. */
function isClientAvailable(client: McpClient): boolean {
  const configDir = path.dirname(CLIENT_CONFIGS[client].configPath);
  return fs.existsSync(configDir);
}
const CLIENT_PROMPT_OPTIONS: Array<{ value: McpClient; label: string; hint: string }> = [
  { value: 'claude-code', label: 'Claude Code', hint: 'MCP server + skill' },
  { value: 'cursor', label: 'Cursor', hint: 'MCP server integration' },
  { value: 'omp', label: 'OMP', hint: 'MCP server + skill' },
  { value: 'opencode', label: 'OpenCode', hint: 'MCP server + managed instructions' },
  { value: 'pi', label: 'Pi', hint: 'Pi package + managed instructions' },
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
    }
  | {
      type: 'http';
      url: string;
      headers?: {
        Authorization: string;
      };
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
    const headers = config.server.authToken && clientConfig.httpAuthHeaderField === 'headers'
      ? { Authorization: `Bearer ${config.server.authToken}` }
      : undefined;
    return {
      type: 'http',
      url: `http://${clientHost.includes(':') ? `[${clientHost}]` : clientHost}:${config.server.port}/mcp`,
      ...(headers ? { headers } : {}),
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

function getHttpAuthHeaderWarning(clientConfig: ClientConfig, transport?: McpTransport): string | undefined {
  if (
    transport !== 'http' ||
    !getConfig().server.authToken ||
    clientConfig.httpAuthHeaderField
  ) {
    return undefined;
  }

  return `Warning: ${clientConfig.name} does not support HTTP MCP authorization headers. Configure the Authorization header manually.`;
}

function formatMcpEntryForDisplay(entry: McpEntry | null): string {
  return JSON.stringify(entry, (key, value) =>
    key === 'Authorization' ? 'Bearer [REDACTED]' : value,
  2);
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

  // Handle both absolute and relative local paths
  const resolved = path.isAbsolute(source) ? source : path.resolve(source);
  return isOpenZkKbLocalPackagePath(resolved);
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

function hasOpenZkKbPiPackage(config: JsonObject): boolean {
  const existing = getPackageArray(config);
  if (!existing) {
    return false;
  }

  return existing.some((entry) => {
    const source = packageSourceValue(entry);
    return source !== undefined && isOpenZkKbPiPackageSource(source);
  });
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
      return hasOpenZkKbPiPackage(config);
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

function needsDisabledServersOnUninstall(client: McpClient): boolean {
  const clientConfig = CLIENT_CONFIGS[client];
  const serverNames = clientConfig.disabledServersOnUninstall ?? [];
  if (serverNames.length === 0) {
    return false;
  }

  if (!fs.existsSync(clientConfig.configPath)) {
    return true;
  }

  try {
    const content = fs.readFileSync(clientConfig.configPath, 'utf-8');
    const config = parseJsonObject(content);
    return getMissingDisabledServers(config, serverNames).length > 0;
  } catch {
    return false;
  }
}

function getUninstallCandidateClients(): McpClient[] {
  const candidates = new Set<McpClient>();

  for (const client of ALL_CLIENTS) {
    const clientConfig = CLIENT_CONFIGS[client];
    if (isClientInstalled(client) || hasAuxiliaryInstallArtifacts(clientConfig)) {
      candidates.add(client);
    }
  }

  if (candidates.size === 0) {
    return [];
  }

  for (const client of ALL_CLIENTS) {
    if (!candidates.has(client) && needsDisabledServersOnUninstall(client)) {
      candidates.add(client);
    }
  }

  return ALL_CLIENTS.filter((client) => candidates.has(client));
}


type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(content: string): JsonObject {
  const parsed: unknown = JSON.parse(content);
  if (!isJsonObject(parsed)) {
    throw new Error('JSON root must be an object');
  }

  return parsed;
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

function hasNonArrayDisabledServers(config: JsonObject): boolean {
  return config.disabledServers !== undefined && !Array.isArray(config.disabledServers);
}

function getMissingDisabledServers(config: JsonObject, serverNames: string[]): string[] {
  const disabled = config.disabledServers;
  const existing = new Set(
    Array.isArray(disabled)
      ? disabled.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  return serverNames.filter((name) => !existing.has(name));
}

function addDisabledServers(config: JsonObject, serverNames: string[]): string[] {
  if (hasNonArrayDisabledServers(config)) {
    return [];
  }

  const missing = getMissingDisabledServers(config, serverNames);
  if (missing.length === 0) {
    return [];
  }

  const disabled = Array.isArray(config.disabledServers)
    ? [...config.disabledServers]
    : [];
  config.disabledServers = [...disabled, ...missing];
  return missing;
}

function removeDisabledServers(config: JsonObject, serverNames: string[]): string[] {
  if (!Array.isArray(config.disabledServers)) {
    return [];
  }

  const targets = new Set(serverNames);
  const removed = new Set<string>();
  const remaining = config.disabledServers.filter((entry) => {
    if (typeof entry === 'string' && targets.has(entry)) {
      removed.add(entry);
      return false;
    }

    return true;
  });

  if (removed.size === 0) {
    return [];
  }

  if (remaining.length === 0) {
    delete config.disabledServers;
  } else {
    config.disabledServers = remaining;
  }

  return [...removed];
}


function getVaultPath(): string {
  return path.join(xdgDataHome, 'open-zk-kb');
}

/**
 * Destructive smoke tests must only delete vaults inside their private,
 * sentinel-marked sandbox. This is an independent backstop in case the shell
 * harness passes an unexpected XDG path.
 */
function assertSmokeTestVaultDeletionIsSandboxed(vaultPath: string): void {
  if (process.env.OPEN_ZK_KB_SMOKE_TEST !== '1') return;

  const sandboxRoot = process.env.OPEN_ZK_KB_SMOKE_SANDBOX_ROOT;
  if (!sandboxRoot) {
    throw new Error('Refusing vault deletion: smoke-test sandbox root is not set');
  }

  const sentinelPath = path.join(sandboxRoot, '.open-zk-kb-smoke-sandbox');
  const expectedSentinel = 'open-zk-kb destructive smoke-test sandbox';
  if (!fs.existsSync(sentinelPath)
    || !fs.statSync(sentinelPath).isFile()
    || fs.readFileSync(sentinelPath, 'utf8').trim() !== expectedSentinel) {
    throw new Error('Refusing vault deletion: smoke-test sandbox sentinel is missing or invalid');
  }

  const realSandboxRoot = fs.realpathSync(sandboxRoot);
  const realVaultPath = fs.existsSync(vaultPath)
    ? fs.realpathSync(vaultPath)
    : path.resolve(vaultPath);
  const relativeVaultPath = path.relative(realSandboxRoot, realVaultPath);
  const isInsideSandbox = relativeVaultPath !== ''
    && relativeVaultPath !== '..'
    && !relativeVaultPath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeVaultPath);

  if (!isInsideSandbox) {
    throw new Error(`Refusing vault deletion outside smoke-test sandbox: ${realVaultPath}`);
  }
}

function getConfigYamlPath(): string {
  return path.join(xdgConfigHome, 'open-zk-kb', 'config.yaml');
}

/** Write telemetry enabled/share settings to config.yaml.
 *  If the existing config has a non-mapping root (scalar/array), it is
 *  replaced with a fresh mapping — this corrects corrupted configs. */
function writeTelemetryConfig(enabled: boolean, share: boolean): void {
  const configPath = getConfigYamlPath();
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    } else if (parsed != null) {
      // Non-mapping root (scalar or array) — correct it during setup
      console.warn(`Warning: config.yaml has a non-mapping root (${typeof parsed}). Resetting to valid config.`);
    }
  }
  const existing = doc.telemetry;
  const telemetry = (existing && typeof existing === 'object' && !Array.isArray(existing))
    ? existing as Record<string, unknown>
    : {};
  telemetry.enabled = enabled;
  telemetry.share = share;
  doc.telemetry = telemetry;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(doc), 'utf-8');
}

/**
 * If the path is a symlink, return the resolved target. Otherwise return null.
 */
function resolveSymlinkTarget(filePath: string): string | null {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      try {
        return fs.realpathSync(filePath);
      } catch {
        // Dangling symlink — target doesn't exist but it's still a symlink.
        // Return the raw link target so callers correctly detect shared files.
        return fs.readlinkSync(filePath);
      }
    }
  } catch { /* path doesn't exist */ }
  return null;
}

/**
 * Path-existence check that also detects dangling symlinks. Unlike
 * `fs.existsSync` (which follows the link and returns false when the target
 * is missing), this uses `lstat` so a symlink entry counts as "present".
 */
function pathExistsOrSymlink(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns real (resolved) paths for all clients' agentDocsPath entries.
 * Used to avoid removing a managed block that belongs to a sibling client
 * when stale paths resolve to the same underlying file through symlinks.
 */
function getActiveAgentDocsRealPaths(): Set<string> {
  const paths = new Set<string>();
  for (const cfg of Object.values(CLIENT_CONFIGS)) {
    if (cfg.agentDocsPath) {
      try { paths.add(fs.realpathSync(cfg.agentDocsPath)); } catch { /* doesn't exist */ }
    }
  }
  return paths;
}

function hasManagedAgentDocsBlock(filePath: string): boolean {
  const inspection = inspectAgentDocs(filePath);
  return inspection.exists && inspection.status !== 'missing';
}

export function hasAuxiliaryInstallArtifacts(clientConfig: ClientConfig): boolean {
  if (clientConfig.skillPath && fs.existsSync(clientConfig.skillPath)) {
    return true;
  }

  if (clientConfig.agentDocsPath && hasManagedAgentDocsBlock(clientConfig.agentDocsPath)) {
    return true;
  }

  if (clientConfig.ttsrRulePath && pathExistsOrSymlink(clientConfig.ttsrRulePath)) {
    return true;
  }

  return (clientConfig.staleAgentDocsPaths ?? []).some((stalePath) => hasManagedAgentDocsBlock(stalePath));
}

/**
 * Like `fs.mkdirSync(p, { recursive: true })` but handles dangling symlinks
 * in the ancestor chain. A common case: `~/.claude/skills` is a symlink whose
 * target directory doesn't exist yet. Node's `mkdirSync` sees the symlink entry
 * and assumes the parent exists, then fails with ENOENT when it can't traverse.
 */
function ensureDirThroughSymlinks(dirPath: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;

    // Walk up to find the dangling symlink and create its target
    const segments = path.resolve(dirPath).split(path.sep);
    for (let i = 1; i <= segments.length; i++) {
      const partial = segments.slice(0, i).join(path.sep) || '/';
      try {
        const stat = fs.lstatSync(partial);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(partial);
          const resolved = path.isAbsolute(target)
            ? target
            : path.resolve(path.dirname(partial), target);
          if (!fs.existsSync(resolved)) {
            fs.mkdirSync(resolved, { recursive: true });
          }
        }
      } catch { /* segment doesn't exist yet — mkdirSync below will create it */ }
    }

    // Retry now that dangling targets are created
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// --- Skill installation helpers (Claude Code) ---

/**
 * Returns the path to the skill template directory in the package.
 * Works from both src/ (development) and dist/ (production) because skill-templates/
 * is at the project root, one level up from either location.
 */
function getSkillTemplateDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill-templates', 'open-zk-kb');
}

/** Returns the path to ~/.claude/CLAUDE.md for migration checks. */
function getLegacyClaudeMdPath(): string {
  return path.join(expandPath('~/.claude'), 'CLAUDE.md');
}
/**
 * Get the path to the TTSR (Time-Traveling Stream Rules) enforcement rule template.
 * TTSR is OMP-specific — see templates/install/omp-ttsr-enforce.md for details.

 */
function getTtsrRuleTemplatePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'install', 'omp-ttsr-enforce.md');
}


/**
 * Install a TTSR (Time-Traveling Stream Rules) enforcement rule by copying the
 * template to the target path. OMP-specific — no other client uses this.
 */
export function installTtsrRule(targetPath: string, dryRun?: boolean): { action: 'created' | 'updated' | 'skipped-symlink'; path: string } {
  const templatePath = getTtsrRuleTemplatePath();
  if (!fs.existsSync(templatePath)) {
    throw new Error(`TTSR rule template not found at: ${templatePath}`);
  }

  // Skip if target is a symlink — avoid mutating shared policy files
  if (resolveSymlinkTarget(targetPath)) {
    return { action: 'skipped-symlink', path: targetPath };
  }

  const existed = fs.existsSync(targetPath);

  if (!dryRun) {
    ensureDirThroughSymlinks(path.dirname(targetPath));
    fs.copyFileSync(templatePath, targetPath);
  }

  return { action: existed ? 'updated' : 'created', path: targetPath };
}

/**
 * Remove an installed TTSR enforcement rule.
 */
export function removeTtsrRule(targetPath: string, dryRun?: boolean): { action: 'removed' | 'not-found'; path: string } {
  if (!pathExistsOrSymlink(targetPath)) {
    return { action: 'not-found', path: targetPath };
  }

  if (!dryRun) {
    fs.unlinkSync(targetPath);
  }

  return { action: 'removed', path: targetPath };
}

/**
 * Report whether an installed TTSR rule matches the current template. Used by
 * `doctor` so a stale, truncated, or malformed rule isn't reported as healthy.
 * Symlinks are handled separately by the caller and must not reach this check.
 */
function isTtsrRuleCurrent(targetPath: string): boolean {
  try {
    if (!fs.lstatSync(targetPath).isFile()) {
      return false;
    }
    return fs.readFileSync(targetPath, 'utf-8').trimEnd() ===
      fs.readFileSync(getTtsrRuleTemplatePath(), 'utf-8').trimEnd();
  } catch {
    return false;
  }
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
    ensureDirThroughSymlinks(skillPath);

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
    if (typeof record.url !== 'string' || record.url.length === 0) {
      issues.push('missing url for http entry');
    } else {
      try {
        const url = new URL(record.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          issues.push('http entry url must use http or https');
        }
      } catch {
        issues.push('invalid url for http entry');
      }
    }
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
  // Don't repair valid HTTP entries — they are intentional transport overrides.
  // Invalid HTTP entries should still be repaired (e.g. malformed URL).
  if (
    existingEntry &&
    typeof existingEntry === 'object' &&
    (existingEntry as Record<string, unknown>).type === 'http' &&
    validateMcpEntry(clientConfig, existingEntry).length === 0
  ) {
    return;
  }
  // Preserve HTTP transport when repairing a broken HTTP entry —
  // without this, a malformed HTTP URL gets silently replaced with stdio.
  const transport: McpTransport | undefined =
    existingEntry &&
    typeof existingEntry === 'object' &&
    (existingEntry as Record<string, unknown>).type === 'http'
      ? 'http'
      : undefined;
  const inferredServerPath = inferServerPathFromEntry(clientConfig, existingEntry);
  const repairedEntry = buildMcpEntry(clientConfig, inferredServerPath, transport);
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
    if (clientConfig.ttsrRulePath && configured) {
      const ttsrSymlink = resolveSymlinkTarget(clientConfig.ttsrRulePath);
      if (ttsrSymlink) {
        pushCheck('INFO', `${clientConfig.name}: TTSR rule is a symlink (→ ${ttsrSymlink}) — skipping to avoid modifying a shared file`);
      } else if (!fs.existsSync(clientConfig.ttsrRulePath)) {
        if (args.fix) {
          installTtsrRule(clientConfig.ttsrRulePath, false);
          pushCheck('FIXED', `${clientConfig.name}: restored TTSR enforcement rule at ${clientConfig.ttsrRulePath}`);
        } else {
          pushCheck('WARN', `${clientConfig.name}: TTSR enforcement rule missing at ${clientConfig.ttsrRulePath}`);
        }
      } else if (!isTtsrRuleCurrent(clientConfig.ttsrRulePath)) {
        if (args.fix) {
          installTtsrRule(clientConfig.ttsrRulePath, false);
          pushCheck('FIXED', `${clientConfig.name}: repaired TTSR enforcement rule at ${clientConfig.ttsrRulePath}`);
        } else {
          pushCheck('WARN', `${clientConfig.name}: TTSR enforcement rule needs repair at ${clientConfig.ttsrRulePath}`);
        }
      } else {
        pushCheck('OK', `${clientConfig.name}: TTSR enforcement rule is healthy at ${clientConfig.ttsrRulePath}`);
      }
    }
    if (!clientConfig.skillPath && !clientConfig.agentDocsPath) {
      pushCheck('INFO', `${clientConfig.name}: managed instructions are not currently supported`);
    }
    // Check for stale managed blocks in old locations
    if (clientConfig.staleAgentDocsPaths) {
      for (const stalePath of clientConfig.staleAgentDocsPaths) {
        if (stalePath === clientConfig.agentDocsPath) continue;
        // Skip if real path is actively used by another client's agentDocsPath
        try {
          const realStale = fs.realpathSync(stalePath);
          if (getActiveAgentDocsRealPaths().has(realStale)) continue;
        } catch { /* doesn't exist */ }
        const symlinkTarget = resolveSymlinkTarget(stalePath);
        const staleInspection = inspectAgentDocs(stalePath);
        if (staleInspection.exists && staleInspection.status !== 'missing') {
          const locationDesc = symlinkTarget ? `${stalePath} → ${symlinkTarget}` : stalePath;
          if (args.fix) {
            removeAgentDocs(stalePath, false, clientConfig.preamble);
            pushCheck('FIXED', `${clientConfig.name}: removed stale managed block from ${locationDesc}`);
          } else {
            pushCheck('WARN', `${clientConfig.name}: stale managed block in ${locationDesc} — run with --fix to remove`);
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

export function install(args: InstallArgs): InstallResult {
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
  const removedDisabledServers = clientConfig.disabledServersOnUninstall
    ? removeDisabledServers(config, clientConfig.disabledServersOnUninstall)
    : [];

  const existing = usesPiPackage
    ? validatePiPackageConfig(config, piPackageSource ?? '').length === 0
    : clientConfig.mcpPath ? getNestedValue(config, clientConfig.mcpPath) !== undefined : false;

  if (existing && !args.force) {
    if ((removedStaleOpenCodePlugins || removedDisabledServers.length > 0) && !args.dryRun) {
      fs.mkdirSync(path.dirname(clientConfig.configPath), { recursive: true });
      fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
    }

    const details = removedDisabledServers.map((serverName) =>
      args.dryRun
        ? `Would re-enable MCP discovery for ${serverName} in ${clientConfig.configPath}`
        : `Discovery: re-enabled ${serverName} in ${clientConfig.configPath}`,
    );

    let output = `Already installed for ${clientConfig.name}. Use --force to overwrite.`;
    if (details.length > 0) {
      output += `\n${details.join('\n')}`;
    }

    return { status: 'already-installed', clientName: clientConfig.name, output, details, staleSkippedSymlinks: [], agentDocsSkippedSymlink: null };
  }

  
  const mcpEntry = usesPiPackage ? null : buildMcpEntry(clientConfig, serverPath, args.transport);
  const httpAuthHeaderWarning = usesPiPackage
    ? undefined
    : getHttpAuthHeaderWarning(clientConfig, args.transport);
  
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const templatesDir = path.join(projectRoot, 'templates');
  const vaultTemplatesDir = path.join(vaultPath, 'templates');
  const templateFileCount = fs.existsSync(templatesDir) ? fs.readdirSync(templatesDir).filter(f => f.endsWith('.md')).length : 0;

  const activeRealPaths = getActiveAgentDocsRealPaths();

  if (args.dryRun) {
    let output = usesPiPackage
      ? `Dry run: Would add Pi package source to ${clientConfig.configPath}:\n${piPackageSource}\nNote: Also run \`pi install ${piPackageSource}\` — Pi does not support MCP natively`
      : `Dry run: Would add to ${clientConfig.configPath}:\n${formatMcpEntryForDisplay(mcpEntry)}`;
    if (removedDisabledServers.length > 0) {
      output += `\nWould re-enable MCP discovery for ${removedDisabledServers.join(', ')} in ${clientConfig.configPath}`;
    }
    if (httpAuthHeaderWarning) {
      output += `\n${httpAuthHeaderWarning}`;
    }

    if (clientConfig.skillPath) {
      output += `\nWould install skill to ${clientConfig.skillPath}`;
    }
    if (clientConfig.agentDocsPath) {
      const symlinkTarget = resolveSymlinkTarget(clientConfig.agentDocsPath);
      if (!symlinkTarget || args.injectSharedAgentDocs) {
        const size = args.instructionSize || clientConfig.instructionSize || 'full';
        const dryResult = injectAgentDocs(clientConfig.agentDocsPath, size, true, args.client, PKG_VERSION, clientConfig.preamble);
        if (dryResult.action !== 'unchanged') {
          output += `\nWould inject agent docs into ${clientConfig.agentDocsPath}`;
        } else {
          output += `\nAgent docs already up to date: ${clientConfig.agentDocsPath}`;
        }
      } else {
        const existingVersion = getAgentDocsVersion(clientConfig.agentDocsPath);
        if (existingVersion !== PKG_VERSION) {
          output += `\nWould skip agent docs — symlinked to shared file`;
          output += `\n  ${clientConfig.agentDocsPath} → ${symlinkTarget}`;
        } else {
          output += `\nAgent docs already up to date: ${clientConfig.agentDocsPath}`;
        }
      }
    }
    if (clientConfig.ttsrRulePath) {
      const ttsrSymlink = resolveSymlinkTarget(clientConfig.ttsrRulePath);
      if (ttsrSymlink) {
        output += `\nTTSR rule: skipped — symlinked to shared file (${clientConfig.ttsrRulePath} → ${ttsrSymlink})`;
      } else if (pathExistsOrSymlink(clientConfig.ttsrRulePath)) {
        output += `\nWould update TTSR enforcement rule at ${clientConfig.ttsrRulePath}`;
      } else {
        output += `\nWould install TTSR enforcement rule to ${clientConfig.ttsrRulePath}`;
      }
    }
    if (templateFileCount > 0) {
      output += `\nWould copy ${templateFileCount} template files to ${vaultTemplatesDir}`;
    }
    if (clientConfig.staleAgentDocsPaths) {
      for (const stalePath of clientConfig.staleAgentDocsPaths) {
        if (stalePath === clientConfig.agentDocsPath) continue;
        // Check real path — another client may own the block through a symlink
        try {
          const realStale = fs.realpathSync(stalePath);
          if (activeRealPaths.has(realStale)) continue;
        } catch { /* doesn't exist */ }
        const symlinkTarget = resolveSymlinkTarget(stalePath);
        const staleInspection = inspectAgentDocs(stalePath);
        if (staleInspection.exists && staleInspection.status !== 'missing') {
          if (symlinkTarget && !args.injectSharedAgentDocs) {
            output += `\nWould skip stale cleanup — symlinked to shared file`;
            output += `\n  ${stalePath}`;
            output += `\n  → ${symlinkTarget}`;
          } else {
            output += `\nWould remove stale managed block from\n  ${stalePath}`;
          }
        }
      }
    }
    return { status: 'dry-run', clientName: clientConfig.name, output, details: [], staleSkippedSymlinks: [], agentDocsSkippedSymlink: null };
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
  let ttsrResult: { action: string; path: string } | null = null;
  if (clientConfig.ttsrRulePath) {
    ttsrResult = installTtsrRule(clientConfig.ttsrRulePath, args.dryRun);
  }
  const staleCleaned: string[] = [];
  const staleSkippedSymlinks: Array<{ stalePath: string; symlinkTarget: string }> = [];
  if (clientConfig.staleAgentDocsPaths && !args.dryRun) {
    for (const stalePath of clientConfig.staleAgentDocsPaths) {
      if (stalePath === clientConfig.agentDocsPath) continue; // don't clean the current target
      // Check real path — another client may own the block through a symlink
      try {
        const realStale = fs.realpathSync(stalePath);
        if (activeRealPaths.has(realStale)) continue;
      } catch { /* doesn't exist — fall through to cleanup attempt */ }
      const symlinkTarget = resolveSymlinkTarget(stalePath);
      if (symlinkTarget && !args.injectSharedAgentDocs) {
        // Symlink target may have a stale block — warn but don't modify without opt-in
        const staleInspection = inspectAgentDocs(stalePath);
        if (staleInspection.exists && staleInspection.status !== 'missing') {
          staleSkippedSymlinks.push({ stalePath, symlinkTarget });
        }
        continue;
      }
      const staleResult = removeAgentDocs(stalePath, args.dryRun, clientConfig.preamble);
      if (staleResult.action === 'removed' || staleResult.action === 'file-deleted') {
        staleCleaned.push(stalePath);
      }
    }
  }

  let output = `Installed open-zk-kb for ${clientConfig.name}\n\n`;
  const docsLabel = clientConfig.agentDocsLabel || 'Agent docs';
  output += `MCP config: ${clientConfig.configPath}\n`;
  output += `Vault: ${vaultPath}\n`;
  if (usesPiPackage) {
    output += `Package: ${piPackageSource}\n`;
  } else {
    output += `MCP server: ${formatServerCommand(serverPath)}\n`;
  }
  if (httpAuthHeaderWarning) {
    output += `${httpAuthHeaderWarning}\n`;
  }
  if (removedDisabledServers.length > 0) {
    output += `Discovery: re-enabled ${removedDisabledServers.join(', ')} in ${clientConfig.configPath}\n`;
  }

  if (skillResult) {
    output += `Skill: ${skillResult.skillPath} (${skillResult.action})\n`;
  }
  if (agentDocsResult) {
    output += `${docsLabel}: ${agentDocsResult.filePath} (${agentDocsResult.action})\n`;
  }
  if (ttsrResult) {
    output += `TTSR rule: ${ttsrResult.path} (${ttsrResult.action})\n`;
  }

  if (agentDocsSkippedSymlink) {
    output += `${docsLabel}: skipped — symlinked to shared file\n`;
    output += `  ${clientConfig.agentDocsPath}\n`;
    output += `  → ${agentDocsSkippedSymlink}\n`;
  }
  if (migrationResult?.migrated) {
    output += `Migration: removed old CLAUDE.md managed block`;
    if (migrationResult.fileDeleted) output += ' (file deleted — was empty)';
    output += '\n';
  }
  for (const cleaned of staleCleaned) {
    output += `Cleanup: removed stale managed block\n`;
    output += `  ${cleaned}\n`;
  }
  for (const { stalePath, symlinkTarget } of staleSkippedSymlinks) {
    output += `Cleanup: stale managed block in symlinked file (skipped)\n`;
    output += `  ${stalePath}\n`;
    output += `  → ${symlinkTarget}\n`;
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

  const details: string[] = [];
  details.push(`MCP config: ${clientConfig.configPath}`);
  details.push(`Vault: ${vaultPath}`);
  if (removedDisabledServers.length > 0) {
    details.push(`Discovery: re-enabled ${removedDisabledServers.join(', ')} in ${clientConfig.configPath}`);
  }

  if (skillResult) {
    details.push(`Skill: ${skillResult.skillPath} (${skillResult.action})`);
  }
  if (agentDocsResult) {
    details.push(`${docsLabel}: ${agentDocsResult.filePath} (${agentDocsResult.action})`);
  }
  if (templatesCopied > 0) {
    details.push(`Templates: ${templatesCopied} files → ${vaultTemplatesDir}`);
  }
  if (ttsrResult) {
    details.push(`TTSR rule: ${ttsrResult.path} (${ttsrResult.action})`);
  }
  if (httpAuthHeaderWarning) {
    details.push(httpAuthHeaderWarning);
  }

  return { status: 'installed', clientName: clientConfig.name, output, details, staleSkippedSymlinks, agentDocsSkippedSymlink };
}

export function uninstall(args: UninstallArgs): UninstallResult {
  const clientConfig = CLIENT_CONFIGS[args.client];
  const usesPiPackage = isPiPackageClient(clientConfig);
  const vaultPath = getVaultPath();
  const docsLabel = clientConfig.agentDocsLabel || 'Agent docs';

  // Smoke mode must reject an unexpected vault before dry-run summaries,
  // confirmation statistics, or any other read touches that path.
  if (args.removeVault) {
    assertSmokeTestVaultDeletionIsSandboxed(vaultPath);
  }

  const disabledServersOnUninstall = clientConfig.disabledServersOnUninstall ?? [];
  const configExists = fs.existsSync(clientConfig.configPath);
  const hasAuxiliaryArtifacts = hasAuxiliaryInstallArtifacts(clientConfig);
  if (!configExists && disabledServersOnUninstall.length === 0 && !hasAuxiliaryArtifacts) {
    return {
      status: 'not-installed',
      clientName: clientConfig.name,
      output: `No config found for ${clientConfig.name} at ${clientConfig.configPath}`,
      details: [],
      agentDocsSkippedSymlink: null,
    };
  }

  let config: JsonObject = {};
  if (configExists) {
    try {
      const content = fs.readFileSync(clientConfig.configPath, 'utf-8');
      config = parseJsonObject(content);
    } catch (e) {
      throw new Error(`Failed to parse ${clientConfig.configPath}: ${e}`, { cause: e });
    }
  }


  const existing = usesPiPackage
    ? hasOpenZkKbPiPackage(config)
    : clientConfig.mcpPath ? getNestedValue(config, clientConfig.mcpPath) !== undefined : false;
  const missingDisabledServers = getMissingDisabledServers(config, disabledServersOnUninstall);
  const invalidDisabledServers = disabledServersOnUninstall.length > 0 && hasNonArrayDisabledServers(config);

  if (invalidDisabledServers && missingDisabledServers.length > 0 && !args.dryRun) {
    throw new Error(`Cannot update ${clientConfig.configPath}: disabledServers must be an array to disable OMP rediscovery.`);
  }
  if (!existing && !hasAuxiliaryArtifacts && missingDisabledServers.length === 0 && !invalidDisabledServers) {
    return {
      status: 'not-installed',
      clientName: clientConfig.name,
      output: `open-zk-kb not configured for ${clientConfig.name}`,
      details: [],
      agentDocsSkippedSymlink: null,
    };
  }


  // --- Dry-run path ---
  if (args.dryRun) {
    let output = existing
      ? `Dry run: Would remove from ${clientConfig.configPath}\n`
      : `Dry run: Would remove leftover open-zk-kb artifacts for ${clientConfig.name}\n`;
    const details: string[] = [];
    if (clientConfig.skillPath && fs.existsSync(clientConfig.skillPath)) {
      details.push(`Would remove skill from ${clientConfig.skillPath}`);
    }
    let agentDocsSkippedSymlink: string | null = null;
    if (clientConfig.agentDocsPath) {
      const symlinkTarget = resolveSymlinkTarget(clientConfig.agentDocsPath);
      if (symlinkTarget) {
        if (args.removeSharedAgentDocs) {
          details.push(`Would remove ${docsLabel.toLowerCase()} from symlinked file: ${clientConfig.agentDocsPath} → ${symlinkTarget}`);
        } else {
          const inspection = inspectAgentDocs(clientConfig.agentDocsPath);
          if (inspection.exists && inspection.status !== 'missing') {
            agentDocsSkippedSymlink = symlinkTarget;
            details.push(`${docsLabel}: skipped — symlinked to shared file (${clientConfig.agentDocsPath} → ${symlinkTarget})`);
          }
        }
      } else {
        const inspection = inspectAgentDocs(clientConfig.agentDocsPath);
        if (inspection.exists && inspection.status !== 'missing') {
          details.push(`Would remove ${docsLabel.toLowerCase()} from ${clientConfig.agentDocsPath}`);
        }
      }
    }
    if (clientConfig.ttsrRulePath && pathExistsOrSymlink(clientConfig.ttsrRulePath)) {
      details.push(`Would remove TTSR rule from ${clientConfig.ttsrRulePath}`);
    }
    if (invalidDisabledServers) {
      details.push(`MCP discovery disable skipped: disabledServers is not an array in ${clientConfig.configPath}`);
    } else if (missingDisabledServers.length > 0) {
      details.push(`Would disable MCP discovery for ${missingDisabledServers.join(', ')} in ${clientConfig.configPath}`);
    }


    // Stale paths
    if (clientConfig.staleAgentDocsPaths) {
      const activeRealPaths = getActiveAgentDocsRealPaths();
      for (const stalePath of clientConfig.staleAgentDocsPaths) {
        if (stalePath === clientConfig.agentDocsPath) continue;
        let sharedWithActiveClient = false;
        try {
          const realStale = fs.realpathSync(stalePath);
          sharedWithActiveClient = activeRealPaths.has(realStale);
        } catch { /* doesn't exist */ }
        if (sharedWithActiveClient && !args.removeSharedAgentDocs) {
          const staleInspection = inspectAgentDocs(stalePath);
          if (staleInspection.exists && staleInspection.status !== 'missing') {
            details.push(`Stale managed block: skipped — shared with another active client (${stalePath})`);
          }
          continue;
        }

        const staleInspection = inspectAgentDocs(stalePath);
        if (staleInspection.exists && staleInspection.status !== 'missing') {
          const symlinkTarget = resolveSymlinkTarget(stalePath);
          if (symlinkTarget && !args.removeSharedAgentDocs) {
            const reason = sharedWithActiveClient ? 'shared with another active client' : 'symlinked to shared file';
            details.push(`Stale managed block: skipped — ${reason} (${stalePath} → ${symlinkTarget})`);
            agentDocsSkippedSymlink ??= symlinkTarget;
          } else {
            const desc = symlinkTarget ? `${stalePath} → ${symlinkTarget}` : stalePath;
            details.push(`Would remove stale managed block from ${desc}`);
          }
        }
      }
    }
    if (args.removeVault) {
      const stats = getVaultStats(vaultPath);
      let vaultDesc = `Would delete vault at ${vaultPath}`;
      if (stats) {
        vaultDesc += ` (${stats.noteCount} notes, ${stats.sizeMB} MB)`;
      }
      details.push(vaultDesc);
    }
    for (const d of details) {
      output += `${d}\n`;
    }
    return { status: 'dry-run', clientName: clientConfig.name, output, details, agentDocsSkippedSymlink };
  }

  // --- Vault deletion (must precede config removal for confirm gate) ---
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
      return { status: 'not-installed', clientName: clientConfig.name, output, details: [], agentDocsSkippedSymlink: null };
    }

    if (fs.existsSync(vaultPath)) {
      fs.rmSync(vaultPath, { recursive: true });
    }
  }

  // --- Remove MCP config entry and block rediscovery where supported ---
  if (existing) {
    if (usesPiPackage) {
      removePiPackage(config);
    } else if (clientConfig.mcpPath) {
      deleteNestedValue(config, clientConfig.mcpPath);
    }
    if (clientConfig.mcpFormat === 'opencode') {
      removeStaleOpenCodePluginEntries(config);
    }
  }

  const disabledServersAdded = invalidDisabledServers ? [] : addDisabledServers(config, disabledServersOnUninstall);

  if (existing || disabledServersAdded.length > 0) {
    fs.mkdirSync(path.dirname(clientConfig.configPath), { recursive: true });
    fs.writeFileSync(clientConfig.configPath, JSON.stringify(config, null, 2));
  }


  // --- Remove skill, agent docs, and stale paths ---
  const details: string[] = [];
  details.push(existing ? `MCP config: ${clientConfig.configPath}` : `Config checked: ${clientConfig.configPath} (no active entry)`);
  if (disabledServersAdded.length > 0) {
    details.push(`Discovery disabled: ${disabledServersAdded.join(', ')} in ${clientConfig.configPath}`);
  }
  if (invalidDisabledServers) {
    details.push(`Discovery disable skipped: disabledServers is not an array in ${clientConfig.configPath}`);
  }

  if (clientConfig.skillPath) {
    const skillResult = removeSkill(clientConfig.skillPath);
    if (skillResult.action !== 'not-found') {
      details.push(`Skill: ${skillResult.skillPath} (${skillResult.action})`);
    }
  }

  let agentDocsSkippedSymlink: string | null = null;
  if (clientConfig.agentDocsPath) {
    const symlinkTarget = resolveSymlinkTarget(clientConfig.agentDocsPath);
    if (symlinkTarget && !args.removeSharedAgentDocs) {
      // Check if the managed block exists before reporting a skip
      const inspection = inspectAgentDocs(clientConfig.agentDocsPath);
      if (inspection.exists && inspection.status !== 'missing') {
        agentDocsSkippedSymlink = symlinkTarget;
      }
    } else {
      const agentDocsResult = removeAgentDocs(clientConfig.agentDocsPath, false, clientConfig.preamble);
      if (agentDocsResult.action !== 'not-found') {
        details.push(`${docsLabel}: ${agentDocsResult.filePath} (${agentDocsResult.action})`);
      }
    }
  }
  if (clientConfig.ttsrRulePath) {
    const ttsrResult = removeTtsrRule(clientConfig.ttsrRulePath);
    if (ttsrResult.action !== 'not-found') {
      details.push(`TTSR rule: ${ttsrResult.path} (${ttsrResult.action})`);
    }
  }

  // Clean stale managed blocks (same logic as install)
  if (clientConfig.staleAgentDocsPaths) {
    const activeRealPaths = getActiveAgentDocsRealPaths();
    for (const stalePath of clientConfig.staleAgentDocsPaths) {
      if (stalePath === clientConfig.agentDocsPath) continue;
      let sharedWithActiveClient = false;
      try {
        const realStale = fs.realpathSync(stalePath);
        sharedWithActiveClient = activeRealPaths.has(realStale);
      } catch { /* doesn't exist */ }
      if (sharedWithActiveClient && !args.removeSharedAgentDocs) {
        const staleInspection = inspectAgentDocs(stalePath);
        if (staleInspection.exists && staleInspection.status !== 'missing') {
          details.push(`Stale block skipped: ${stalePath} (shared with another active client)`);
        }
        continue;
      }
      const symlinkTarget = resolveSymlinkTarget(stalePath);
      if (symlinkTarget && !args.removeSharedAgentDocs) {
        const staleInspection = inspectAgentDocs(stalePath);
        if (staleInspection.exists && staleInspection.status !== 'missing') {
          agentDocsSkippedSymlink ??= symlinkTarget;
          const reason = sharedWithActiveClient ? 'shared with another active client' : 'symlinked shared file';
          details.push(`Stale block skipped: ${stalePath} → ${symlinkTarget} (${reason})`);
        }
      } else {
        const staleResult = removeAgentDocs(stalePath, args.dryRun, clientConfig.preamble);
        if (staleResult.action === 'removed' || staleResult.action === 'file-deleted') {
          details.push(`Stale block removed: ${stalePath}`);
        }
      }
    }
  }

  if (args.removeVault && args.confirm) {
    details.push(`Vault deleted: ${vaultPath}`);
  }

  let output = `Uninstalled open-zk-kb from ${clientConfig.name}\n\n`;
  for (const d of details) {
    output += `${d}\n`;
  }
  if (!args.removeVault || !args.confirm) {
    output += `\nVault preserved at: ${vaultPath}\n`;
    output += `Reinstall anytime with: bunx open-zk-kb@${detectNpmTag()} install --client ${args.client}\n`;
  }

  return { status: 'uninstalled', clientName: clientConfig.name, output, details, agentDocsSkippedSymlink };
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
  --instructions <size> Agent instruction size: compact (~140 tokens), full (~420 tokens), rules, or preflight
  --transport <type>   Transport type: stdio (default) or http
  --force              Overwrite existing config
  --dry-run            Preview changes without applying
  --yes                Non-interactive, accept defaults

uninstall:
  (no flags)           Interactive client selection
  --client <name>      Uninstall from specific client (opencode, claude-code, cursor, windsurf, zed, pi, omp)
  --remove-vault       Also delete the knowledge base data
  --confirm            Required with --remove-vault
  --remove-shared-agent-docs
                       Remove managed instructions from symlinked shared files
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
    const noTelemetry = args.includes('--no-telemetry');
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
      instructionsArg === 'compact' || instructionsArg === 'full' || instructionsArg === 'rules' || instructionsArg === 'preflight' ? instructionsArg : undefined;
    if (instructionsArg && !instructionSize) {
      throw new Error(`Invalid --instructions value: ${instructionsArg}. Use 'compact', 'full', 'rules', or 'preflight'.`);
    }
    let client: McpClient | undefined;

    if (clientArg !== undefined) {
      if (!isMcpClient(clientArg)) {
        throw new Error(`Invalid client: ${clientArg}`);
      }
      client = clientArg;
    }

    /** Detect symlinked agent docs / stale paths and prompt user if interactive. */
    async function resolveSymlinkChoice(
      client: McpClient,
      opts: { yes?: boolean },
    ): Promise<boolean | undefined> {
      const clientConfig = CLIENT_CONFIGS[client];

      // Check if agent docs through symlink actually need updating.
      // Compare by version, not full content — the shared file may have been
      // stamped by a sibling client (e.g. Pi's block says client:"pi" but the
      // instructions are identical to what OpenCode would inject).
      let agentDocsSymlinkTarget: string | null = null;
      if (clientConfig.agentDocsPath) {
        const target = resolveSymlinkTarget(clientConfig.agentDocsPath);
        if (target) {
          const existingVersion = getAgentDocsVersion(clientConfig.agentDocsPath);
          if (existingVersion !== PKG_VERSION) {
            agentDocsSymlinkTarget = target;
          }
        }
      }
      const activeRealPaths = getActiveAgentDocsRealPaths();
      const staleSymlinks: Array<{ stalePath: string; target: string }> = [];
      if (clientConfig.staleAgentDocsPaths) {
        for (const sp of clientConfig.staleAgentDocsPaths) {
          if (sp === clientConfig.agentDocsPath) continue;
          // Skip if real path is actively used by another client
          try {
            const realStale = fs.realpathSync(sp);
            if (activeRealPaths.has(realStale)) continue;
          } catch { /* doesn't exist */ }
          const target = resolveSymlinkTarget(sp);
          if (!target) continue;
          const inspection = inspectAgentDocs(sp);
          if (inspection.exists && inspection.status !== 'missing') {
            staleSymlinks.push({ stalePath: sp, target });
          }
        }
      }

      if (!agentDocsSymlinkTarget && staleSymlinks.length === 0) return undefined;

      if (opts.yes) return true; // Non-interactive: default to optimal setup

      const parts: string[] = [];
      if (agentDocsSymlinkTarget && clientConfig.agentDocsPath) {
        const agentDocsPath = clientConfig.agentDocsPath;
        parts.push(`  ${color.dim(agentDocsPath)}\n  ${color.dim(`→ ${agentDocsSymlinkTarget}`)}`);
      }
      for (const { stalePath, target } of staleSymlinks) {
        parts.push(`  ${color.dim(stalePath)}\n  ${color.dim(`→ ${target}`)}\n\n  ⚠  has stale KB block`);
      }
      const actionDesc = staleSymlinks.length > 0 && !agentDocsSymlinkTarget
        ? 'file to remove the stale block'
        : agentDocsSymlinkTarget && staleSymlinks.length === 0
          ? 'file with managed instructions'
          : 'files';
      const answer = await p.confirm({
        message: `${clientConfig.name}: found symlinked agent docs:\n\n${parts.join('\n\n')}\n\n  Update the shared ${actionDesc}?`,
        initialValue: true,
      });
      if (p.isCancel(answer)) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }
      return answer;
    }

    /** Run install for a single client, prompting for symlinks if interactive. */
    async function installClient(
      client: McpClient,
      opts: { serverPath?: string; transport?: McpTransport; force?: boolean; dryRun?: boolean; instructionSize?: InstructionSize; yes?: boolean },
    ): Promise<InstallResult> {
      const injectSharedAgentDocs = opts.force
        ? await resolveSymlinkChoice(client, opts)
        : undefined; // no prompt when not forcing — install() handles the "already installed" early return

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

    /** Log an InstallResult using clack formatting. */
    function logInstallResult(result: InstallResult): void {
      switch (result.status) {
        case 'already-installed':
          p.log.warn(result.output);
          break;
        case 'installed': {
          const clientDetails = result.details.filter(d => !d.startsWith('Vault:'));
          if (clientDetails.length > 0) {
            const detailLines = clientDetails.map(d => `  ${color.dim(d)}`).join('\n');
            p.log.success(`Installed for ${result.clientName}\n${detailLines}`);
          } else {
            p.log.success(`Installed for ${result.clientName}`);
          }
          for (const { stalePath, symlinkTarget } of result.staleSkippedSymlinks) {
            p.log.warn(
              `Stale KB block in symlinked file (skipped)\n` +
              `  ${stalePath}\n` +
              `  → ${symlinkTarget}`,
            );
          }
          break;
        }
        case 'dry-run':
          p.log.info(result.output);
          break;
      }
    }

    // --- Telemetry prompt helper ---
    // Captures the user's choice but does NOT write config.
    // Returns { enabled, share } to write after install succeeds,
    // or null if no change is needed.
    async function promptTelemetry(): Promise<{ enabled: boolean; share: boolean } | null> {
      if (dryRun) return null;
      if (noTelemetry) {
        // Defaults are already disabled (enabled: false, share: false).
        // Only need to write if config already exists and might have telemetry enabled.
        const configPath = getConfigYamlPath();
        if (fs.existsSync(configPath)) {
          return { enabled: false, share: false };
        }
        return null;
      }
      if (yes || !process.stdin.isTTY) {
        // Non-interactive: use config defaults
        return null;
      }
      // Only prompt if the user hasn't explicitly configured share
      if (isTelemetryShareConfigured()) return null;

      const answer = await p.confirm({
        message: 'Help improve open-zk-kb with anonymous usage analytics?\n' +
          color.dim('    Sends session metadata and a random installation ID to PostHog EU Cloud.\n') +
          color.dim('    Never note contents, search queries, names, email addresses, or file paths.\n') +
          color.dim('    Open source and auditable: https://github.com/mrosnerr/open-zk-kb/blob/main/docs/telemetry.md'),
        initialValue: TELEMETRY_PROMPT_INITIAL_VALUE,
      });
      if (p.isCancel(answer)) return null; // Don't block install on cancel
      // Only write config when opting in — the defaults are already disabled,
      // so declining doesn't need a config write (and avoids creating a
      // comment-stripped config.yaml before installClient seeds the example).
      if (answer) {
        return { enabled: true, share: true };
      }
      return null;
    }

    // Persist telemetry choice after successful install
    function applyTelemetryChoice(choice: { enabled: boolean; share: boolean } | null): void {
      if (!choice) return;
      try {
        writeTelemetryConfig(choice.enabled, choice.share);
      } catch (err) {
        if (!choice.enabled) {
          // Opt-out write failed — warn user about fallback
          console.error(
            `Failed to write telemetry opt-out to config.\n` +
            `  Set DO_NOT_TRACK=1 in your environment as a fallback.\n` +
            `  ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // Opt-in write failure is non-fatal — config stays at safe defaults
      }
    }

    // Capture telemetry choice before install (prompt runs early)
    const telemetryChoice = await promptTelemetry();

    // --- Single-client mode ---
    if (client) {
      const result = await installClient(client, { serverPath, transport, force, dryRun, instructionSize, yes });
      applyTelemetryChoice(telemetryChoice);
      console.log(result.output);
      return;
    }

    // --- All-clients non-interactive mode ---
    if (yes) {
      for (const c of ALL_CLIENTS) {
        const result = await installClient(c, { serverPath, transport, force, dryRun, instructionSize, yes: true });
        console.log(result.output);
      }
      applyTelemetryChoice(telemetryChoice);
      return;
    }

    // --- Interactive multi-select mode ---
    p.intro(color.cyan('open-zk-kb — Knowledge Base Setup'));

    const alreadyInstalled = new Set(getInstalledClients());

    // Build grouped options: Update (pre-selected) → Available (detected) → Other (not detected)
    type PromptOption = { value: McpClient; label: string; hint: string };
    const updateOptions: PromptOption[] = [];
    const availableOptions: PromptOption[] = [];
    const otherOptions: PromptOption[] = [];
    for (const opt of CLIENT_PROMPT_OPTIONS) {
      if (alreadyInstalled.has(opt.value)) {
        updateOptions.push(opt);
      } else if (isClientAvailable(opt.value)) {
        availableOptions.push(opt);
      } else {
        otherOptions.push(opt);
      }
    }

    const groups: Record<string, PromptOption[]> = {};
    if (updateOptions.length > 0) groups['Update'] = updateOptions;
    if (availableOptions.length > 0) groups['Available'] = availableOptions;
    if (otherOptions.length > 0) groups['Other'] = otherOptions;

    // Fallback: if nothing detected at all, show everything flat
    if (Object.keys(groups).length === 0) {
      groups['Install'] = [...CLIENT_PROMPT_OPTIONS];
    }

    const answer = await p.groupMultiselect<McpClient>({
      message: `Select clients to install or update:\n${color.dim('space to select, enter to confirm')}`,
      options: groups,
      initialValues: [...alreadyInstalled],
      selectableGroups: false,
    });
    if (p.isCancel(answer)) { p.cancel('Setup cancelled.'); process.exit(0); }
    const selected = answer;

    if (selected.length === 0) {
      p.cancel('No clients selected.');
      process.exit(0);
    }

    // Show shared info once before per-client results
    p.log.info(color.dim(`Vault: ${getVaultPath()}`));

    for (const c of selected) {
      try {
        // Selecting an already-installed client = implicit force (user chose to update it)
        const implicitForce = alreadyInstalled.has(c) || force;
        const result = await installClient(c, { serverPath, transport, force: implicitForce, dryRun, instructionSize });
        logInstallResult(result);
      } catch (e) {
        p.log.error(`${CLIENT_CONFIGS[c].name}: ${e instanceof Error ? e.message : e}`);
        process.exitCode = 1;
      }
    }

    // Persist telemetry choice only after all installs succeed
    applyTelemetryChoice(telemetryChoice);

    // Offer to launch a CLI client to try out the knowledge base
    if (!dryRun) {
      const cliClients = selected.flatMap((c) => {
        const cliBinary = CLIENT_CONFIGS[c].cliBinary;
        if (!cliBinary) return [];
        try {
          execFileSync('which', [cliBinary], { stdio: 'ignore' });
          return [c];
        } catch { return []; }
      });

      if (cliClients.length > 0) {
        const tryIt = await p.select<McpClient | 'skip'>({
          message: 'Try it out?',
          options: [
            ...cliClients.map(c => ({
              value: c as McpClient | 'skip',
              label: `Open ${CLIENT_CONFIGS[c].name}`,
              hint: CLIENT_CONFIGS[c].cliBinary,
            })),
            { value: 'skip' as const, label: 'Skip' },
          ],
          initialValue: 'skip' as McpClient | 'skip',
        });

        if (!p.isCancel(tryIt) && tryIt !== 'skip') {
          const tryItConfig = CLIENT_CONFIGS[tryIt];
          const bin = tryItConfig.cliBinary;
          if (bin) {
              p.outro(`Launching ${tryItConfig.name}...`);
            execFileSync(bin, ['Search the knowledge base for any existing notes'], {
              stdio: 'inherit',
            });
          }
          return;
        }
      }
    }

    p.outro('Done! Restart your editor to load the MCP server.');
  } else if (command === 'uninstall') {
  const removeVault = args.includes('--remove-vault');
  const removeSharedAgentDocs = args.includes('--remove-shared-agent-docs');
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

  /** Log an UninstallResult using clack formatting. */
  function logUninstallResult(result: UninstallResult): void {
    switch (result.status) {
      case 'not-installed':
        // Silently skip in multi-client mode — only noisy when explicitly targeted
        break;
      case 'uninstalled': {
        const clientDetails = result.details.filter(d => !d.startsWith('Vault'));
        if (clientDetails.length > 0) {
          const detailLines = clientDetails.map(d => `  ${color.dim(d)}`).join('\n');
          p.log.success(`Uninstalled from ${result.clientName}\n${detailLines}`);
        } else {
          p.log.success(`Uninstalled from ${result.clientName}`);
        }
        if (result.agentDocsSkippedSymlink) {
          const docsLabel = CLIENT_CONFIGS[
            ALL_CLIENTS.find(c => CLIENT_CONFIGS[c].name === result.clientName) || 'opencode'
          ].agentDocsLabel || 'Agent docs';
          p.log.warn(
            `${docsLabel} in symlinked file (skipped)\n` +
            `  → ${result.agentDocsSkippedSymlink}`,
          );
        }
        break;
      }
      case 'dry-run':
        p.log.info(result.output);
        break;
    }
  }

  // --- Single-client mode ---
  if (client) {
    const confirm = args.includes('--confirm') || (yes && removeVault);
    const result = uninstall({ client, removeVault, confirm, dryRun, removeSharedAgentDocs });
    console.log(result.output);
    return;
  }

  // --- All-clients non-interactive mode ---
  if (yes) {
    const installed = getUninstallCandidateClients();

    if (installed.length === 0) {
      console.log('No clients are currently installed.');
      return;
    }
    const confirm = removeVault;
    // Delete vault once if requested, not per-client
    let vaultDeleted = false;
    for (const c of installed) {
      const shouldRemoveVault = removeVault && !vaultDeleted;
      const result = uninstall({ client: c, removeVault: shouldRemoveVault, confirm: shouldRemoveVault ? confirm : false, dryRun, removeSharedAgentDocs });
      console.log(result.output);
      if (shouldRemoveVault && result.status === 'uninstalled') vaultDeleted = true;
    }
    return;
  }

  // --- Interactive mode ---
  p.intro(color.yellow('open-zk-kb — Uninstall'));

  const alreadyInstalled = getUninstallCandidateClients();

  if (alreadyInstalled.length === 0) {
    p.log.warn('No clients are currently installed.');
    p.outro('Nothing to uninstall.');
    return;
  }

  // Build grouped picker: only show installed clients, no pre-selection (destructive op)
  const installedOptions = CLIENT_PROMPT_OPTIONS.filter(opt =>
    alreadyInstalled.includes(opt.value),
  );

  const selected = await p.multiselect<McpClient>({
    message: `Select clients to uninstall:\n${color.dim('space to select, enter to confirm')}`,
    options: installedOptions,
    required: true,
  });

  if (p.isCancel(selected)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  if (selected.length === 0) {
    p.cancel('No clients selected.');
    process.exit(0);
  }

  let removeVaultChoice = await p.confirm({
    message: 'Also remove the knowledge vault? (irreversible)',
    initialValue: false,
  });

  if (p.isCancel(removeVaultChoice)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  let confirm = false;
  if (removeVaultChoice) {
    const vaultPath = getVaultPath();
    const stats = getVaultStats(vaultPath);
    let confirmMsg = 'This will permanently delete your vault';
    if (stats) {
      confirmMsg += ` (${stats.noteCount} notes, ${stats.sizeMB} MB)`;
    }
    confirmMsg += `. Type "delete" to confirm:`;

    const typed = await p.text({
      message: color.red(confirmMsg),
      placeholder: 'delete',
    });

    if (p.isCancel(typed) || typed?.toLowerCase() !== 'delete') {
      p.cancel('Vault deletion cancelled. Proceeding without removing vault.');
      removeVaultChoice = false; // Reset so uninstall() doesn't get removeVault: true
    } else {
      confirm = true;
    }
  }

  // Delete vault once before per-client loop, not per-client
  let vaultDeleted = false;
  for (const c of selected) {
    try {
      const shouldRemoveVault = removeVaultChoice && !vaultDeleted;
      const result = uninstall({
        client: c,
        removeVault: shouldRemoveVault,
        confirm: shouldRemoveVault ? confirm : false,
        dryRun,
        removeSharedAgentDocs,
      });
      logUninstallResult(result);
      if (shouldRemoveVault && result.status === 'uninstalled') vaultDeleted = true;
    } catch (e) {
      p.log.error(`${CLIENT_CONFIGS[c].name}: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  }

  if (vaultDeleted) {
    p.log.info(color.dim(`Vault deleted: ${getVaultPath()}`));
  } else {
    p.log.info(color.dim(`Vault preserved: ${getVaultPath()}`));
  }

  p.outro('Done!');
  }
}

if (import.meta.main) {
  runSetupCli().catch((e) => {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
