import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { ObsidianConfig } from './types.js';
import { logToFile } from './logger.js';

export interface PluginRegistryEntry {
  id: string;
  repo: string;
  tag: string;
  files: string[];
  fileDigests: Record<string, string>;
}

export interface ThemeRegistryEntry {
  name: string;
  repo: string;
  tag: string;
  files: string[];
  fileDigests: Record<string, string>;
}

export interface ScaffoldManifest {
  scaffoldVersion: number;
  installedAt: string;
  lastUpgrade: string;
  plugins: Record<string, { version: string; configVersion: number }>;
  theme: { name: string; version: string } | null;
  snippets: { version: number };
}

export interface ObsidianScaffoldStatus {
  scaffolded: boolean;
  scaffoldVersion: number | null;
  latestVersion: number;
  theme: { name: string; version: string } | null;
  pluginsInstalled: number;
  pluginsExpected: number;
  pluginsNeedingUpdate: number;
  readOnly: boolean;
  autoUpgrade: boolean;
}

interface ObsidianScaffoldDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  templatesDir?: string;
  verifyAssetIntegrity?: boolean;
  pluginRegistry?: PluginRegistryEntry[];
  themeRegistry?: ThemeRegistryEntry;
}

interface AssetInstallResult {
  available: boolean;
  refreshed: boolean;
}

const DEFAULT_OBSIDIAN_CONFIG: ObsidianConfig = {
  scaffold: true,
  autoUpgrade: true,
  readOnly: true,
};

export const CURRENT_SCAFFOLD_VERSION = 1;
const SNIPPET_VERSION = 1;

export const PLUGIN_REGISTRY: PluginRegistryEntry[] = [
  { id: 'homepage', repo: 'mirnovov/obsidian-homepage', tag: '4.4.0', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '4239eaaffced27ff2e743fffceefa75e19ccf784da5fc18dbec6b0f63f144b93', 'manifest.json': 'c76ac910648258eb763b4796efb62d56c7012bd8353cc1a6d59dd34f702466b1', 'styles.css': '3e0db75be5be6495188eb429f678606c27ba39d1ba97434f85c2dc387c127508' } },
  { id: 'quickadd', repo: 'chhoumann/quickadd', tag: '2.12.0', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': 'e09403bd9e20fe97affd1d53225ba09fbeada7f5e024dde8b64c5890529bffbe', 'manifest.json': '8eab8e5f9c1632dff06875c79bb55832a0a82f6fece246e05728cabdbe824889', 'styles.css': 'e820f28cbb62f604727a07a7dee614386e765ef3d98bc541ac863ce5961bcba2' } },
  { id: 'cmdr', repo: 'jsmorabito/obsidian-commander', tag: '0.5.5', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': 'ebfce0b5dbaac7dd46c8b51cd397a811020d079ab0bf931a64e20049d7510637', 'manifest.json': 'c6df5e0aa6d389695a87850eeeaf836775e2cd01579f4e277d82bc7a99fbe5e8', 'styles.css': '91765c55d9cddfbd3a62dc06bf18dc3ea6ecb879c89f939a1e50cebd3c31c28c' } },
  { id: 'templater-obsidian', repo: 'SilentVoid13/Templater', tag: '2.20.0', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '81eccff81962daf8ec722ed2deff7957b3fabee244afc9fb15c39e7b8d2943e3', 'manifest.json': '47f59f1683eca98be9a9fb58ebce3cf37557af2f5947b47bcba9e8f54c567eae', 'styles.css': 'f7d4ee5bd4ec1d032eda1f4e1da481e713c57af964ec1e55d31494f086068d1e' } },
  { id: 'obsidian-minimal-settings', repo: 'kepano/obsidian-minimal-settings', tag: '8.2.2', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '8aa9350977fca098f56cea444eb672942e10fcaeb9b07aceb05a3d5368aa742b', 'manifest.json': 'cc07b2a08a2128acab9f678f2fdc1a0492b370be928d6ddfb1df1ae4b376667a', 'styles.css': '50084760da927a5bf5ac1b9d3b960dc52e1d0a3bf690e54df8f4d76f8212628c' } },
  { id: 'oz-calendar', repo: 'ozntel/oz-calendar', tag: '0.3.4', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '366853a93f4e0b2dfcbba25e5f74129b91ec93787ef3c4a97097cb00a8eef458', 'manifest.json': '632f4bc99a28e1d2d54ece32f9c754ebd0cc032e77dab8a962b316a7dbe22080', 'styles.css': '5e66038c352bbe773c8e614247a937499478fedca53697e48188b27a6acc3e41' } },
  { id: 'read-only-view', repo: 'mrKazzila/Read-Only-View', tag: '1.0.2', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '3df01d1010b8a47dfcd34f9099ab85fd0d94ff3f50794b0521febcb1408728e5', 'manifest.json': 'dbb136801ffe760c277be5707b2d9c7aee9d2a18da504acaf4a9c083f99c2fe4', 'styles.css': 'ed8507c596c292b2f4cf83f8f5645971ce14e0edf060611f258c1f3eddf997eb' } },
];

export const THEME_REGISTRY: ThemeRegistryEntry = {
  name: 'Minimal',
  repo: 'kepano/obsidian-minimal',
  tag: '8.1.7',
  files: ['manifest.json', 'theme.css'],
  fileDigests: { 'manifest.json': '7e71c6d34fa20ceafe51aff1220ee62e9a7fc9548592e01da60d366945227e07', 'theme.css': 'ee4610bc2aec92a491e3b66fc3c6e854ddcdd3be91abb9f9aa0870f6adbdfaf8' },
};

const ASSET_DOWNLOAD_TIMEOUT_MS = 30_000;
const MANAGED_SNIPPETS = ['zk-tables', 'zk-metadata', 'zk-dashboard', 'readonly-kb'];
const MANAGED_PLUGIN_IDS = PLUGIN_REGISTRY.map(plugin => plugin.id);

const CORE_PLUGINS = [
  'file-explorer',
  'global-search',
  'switcher',
  'graph',
  'backlink',
  'outgoing-link',
  'tag-pane',
  'outline',
  'properties',
  'bookmarks',
  'note-composer',
  'command-palette',
  'word-count',
];

const SNIPPETS: Record<string, string> = {
  'zk-dashboard.css': `
.dashboard.markdown-reading-view .markdown-preview-sizer,
.dashboard.markdown-source-view.mod-cm6 .cm-sizer {
  max-width: 1100px;
}

.dashboard .callout[data-callout="abstract"] {
  border-color: var(--interactive-accent);
  background-color: color-mix(in srgb, var(--interactive-accent) 8%, transparent);
}

.dashboard h2 {
  margin-top: 2.25rem;
}

.dashboard table {
  width: 100%;
}
`.trimStart(),
  'zk-tables.css': `
.markdown-rendered table tr:nth-child(even) td {
  background-color: var(--table-row-alt-background, var(--background-secondary-alt, rgba(0,0,0,0.02)));
}

.markdown-rendered table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.markdown-rendered table th {
  background-color: var(--background-secondary);
  font-weight: var(--bold-weight, 600);
  border-bottom: 2px solid var(--interactive-accent);
}

.markdown-rendered table tr:hover td {
  background-color: var(--background-modifier-hover, rgba(0,0,0,0.04));
}

.markdown-rendered table {
  table-layout: auto;
  border-collapse: collapse;
}

.markdown-rendered table th,
.markdown-rendered table td {
  padding: 6px 14px;
}

.markdown-rendered .cm-table-widget {
  overflow-x: auto;
}
`.trimStart(),
  'zk-metadata.css': 'body { --metadata-display-reading: none; }\n',
  'readonly-kb.css': `
.clickable-icon.view-action[aria-label^="Current view"] {
  display: none !important;
}

.markdown-source-view.mod-cm6 .edit-block-button {
  display: none;
}
`.trimStart(),
};

function getPackageTemplatesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

function getObsidianDir(vaultPath: string): string {
  return path.join(vaultPath, '.obsidian');
}

function getManifestPath(vaultPath: string): string {
  return path.join(getObsidianDir(vaultPath), 'open-zk-kb.json');
}

function effectiveConfig(config?: Partial<ObsidianConfig>): ObsidianConfig {
  return {
    scaffold: config?.scaffold ?? DEFAULT_OBSIDIAN_CONFIG.scaffold,
    autoUpgrade: config?.autoUpgrade ?? DEFAULT_OBSIDIAN_CONFIG.autoUpgrade,
    readOnly: config?.readOnly ?? DEFAULT_OBSIDIAN_CONFIG.readOnly,
  };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function mergeAddOnly(existing: unknown, defaults: unknown): unknown {
  if (Array.isArray(existing) && Array.isArray(defaults)) {
    const merged = [...existing];
    for (const item of defaults) {
      if (!merged.some(existingItem => JSON.stringify(existingItem) === JSON.stringify(item))) {
        merged.push(item);
      }
    }
    return merged;
  }

  if (isPlainObject(existing) && isPlainObject(defaults)) {
    const result: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in result)) {
        result[key] = value;
      } else {
        result[key] = mergeAddOnly(result[key], value);
      }
    }
    return result;
  }

  return existing ?? defaults;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeStringArray(existing: unknown, additions: string[]): string[] {
  const current = Array.isArray(existing) ? existing.filter((item): item is string => typeof item === 'string') : [];
  const merged = [...current];
  for (const item of additions) {
    if (!merged.includes(item)) merged.push(item);
  }
  return merged;
}

function defaultAppConfig(config: ObsidianConfig): Record<string, unknown> {
  return {
    propertiesInDocument: 'hidden',
    defaultViewMode: config.readOnly ? 'preview' : 'source',
    alwaysUpdateLinks: true,
    useMarkdownLinks: false,
    newLinkFormat: 'shortest',
    showInlineTitle: true,
    foldHeading: true,
    trashOption: 'local',
  };
}

function defaultAppearanceConfig(config: ObsidianConfig): Record<string, unknown> {
  const enabledCssSnippets = ['zk-tables', 'zk-metadata', 'zk-dashboard'];
  if (config.readOnly) enabledCssSnippets.push('readonly-kb');

  return {
    theme: 'system',
    cssTheme: THEME_REGISTRY.name,
    enabledCssSnippets,
  };
}

function deterministicId(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5');
}

function sha256Hex(contents: Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function expectedDigest(fileDigests: Record<string, string>, fileName: string): string {
  const digest = fileDigests[fileName];
  if (!digest) {
    throw new Error(`Missing expected digest for ${fileName}`);
  }
  return digest;
}

function buildQuickAddChoices(): Array<Record<string, unknown>> {
  const kinds = [
    { id: 'general-decision', kind: 'decision', folder: 'general/decisions', template: 'decision.md', label: 'General Decision' },
    { id: 'general-procedure', kind: 'procedure', folder: 'general/procedures', template: 'procedure.md', label: 'General Procedure' },
    { id: 'general-observation', kind: 'observation', folder: 'general/observations', template: 'observation.md', label: 'General Observation' },
    { id: 'general-reference', kind: 'reference', folder: 'general/references', template: 'reference.md', label: 'General Reference' },
    { id: 'general-resource', kind: 'resource', folder: 'general/resources', template: 'resource.md', label: 'General Resource' },
    { id: 'preference', kind: 'personalization', folder: 'preferences', template: 'personalization.md', label: 'Preference' },
    { id: 'project-decision', kind: 'decision', folder: 'projects/{{VALUE:project|label:Project name|case:slug}}/decisions', template: 'decision.md', label: 'Project Decision' },
    { id: 'project-procedure', kind: 'procedure', folder: 'projects/{{VALUE:project|label:Project name|case:slug}}/procedures', template: 'procedure.md', label: 'Project Procedure' },
    { id: 'project-observation', kind: 'observation', folder: 'projects/{{VALUE:project|label:Project name|case:slug}}/observations', template: 'observation.md', label: 'Project Observation' },
    { id: 'project-reference', kind: 'reference', folder: 'projects/{{VALUE:project|label:Project name|case:slug}}/references', template: 'reference.md', label: 'Project Reference' },
    { id: 'project-resource', kind: 'resource', folder: 'projects/{{VALUE:project|label:Project name|case:slug}}/resources', template: 'resource.md', label: 'Project Resource' },
    { id: 'project-domain', kind: 'domain', folder: 'projects/{{VALUE:project|label:Project name|case:slug}}', template: 'domain.md', label: 'Project Domain' },
  ];

  return kinds.map(({ id, kind, folder, template, label }) => ({
    name: `New ${label} Note`,
    id: deterministicId(`quickadd-${id}`),
    type: 'Template',
    command: true,
    templatePath: `templates/${template}`,
    fileNameFormat: {
      enabled: true,
      format: kind === 'domain'
        ? 'domain'
        : '{{DATE:YYYYMMDDHHmmss}}00-{{VALUE:title|label:Note title|case:slug}}',
    },
    folder: {
      enabled: true,
      folders: [folder],
      chooseWhenCreatingNote: false,
    },
  }));
}

function buildPluginData(pluginId: string, config: ObsidianConfig): Record<string, unknown> | null {
  switch (pluginId) {
    case 'homepage':
      return {
        version: 4,
        separateMobile: false,
        homepages: {
          'Main Homepage': {
            value: 'index',
            kind: 'File',
            openOnStartup: true,
            openMode: 'Replace all open notes',
            manualOpenMode: 'Keep open notes',
            view: 'Reading view',
            revertView: true,
            openWhenEmpty: false,
            refreshDataview: false,
            autoCreate: false,
            autoScroll: false,
            pin: false,
            commands: [],
            alwaysApply: false,
            hideReleaseNotes: false,
          },
        },
      };
    case 'quickadd': {
      const multiChoiceId = deterministicId('quickadd-new-note');
      return {
        choices: [
          {
            name: 'New Note',
            id: multiChoiceId,
            type: 'Multi',
            command: true,
            choices: buildQuickAddChoices(),
          },
        ],
      };
    }
    case 'cmdr':
      return {
        leftRibbon: [
          {
            id: `quickadd:choice:${deterministicId('quickadd-new-note')}`,
            icon: 'lucide-plus-circle',
            name: 'New Note',
            mode: 'any',
          },
        ],
      };
    case 'templater-obsidian':
      return {
        templates_folder: 'templates',
        trigger_on_file_creation: false,
        auto_jump_to_cursor: false,
        enable_system_commands: false,
        shell_path: '',
        user_scripts_folder: '',
        enable_folder_templates: true,
        folder_templates: [
          { folder: 'general/decisions', template: 'templates/decision.md' },
          { folder: 'general/procedures', template: 'templates/procedure.md' },
          { folder: 'general/observations', template: 'templates/observation.md' },
          { folder: 'general/references', template: 'templates/reference.md' },
          { folder: 'general/resources', template: 'templates/resource.md' },
          { folder: 'preferences', template: 'templates/personalization.md' },
        ],
        enable_file_templates: false,
        syntax_highlighting: true,
      };
    case 'oz-calendar':
      return {
        openViewOnStart: true,
        calendarType: 'ISO 8601',
        dateSource: 'yaml',
        yamlKey: 'created',
        dateFormat: 'YYYY-MM-DD',
        defaultFolder: '/',
        defaultFileNamePrefix: 'YYYY-MM-DD',
        fixedCalendar: true,
      };
    case 'read-only-view':
      if (!config.readOnly) return null;
      return {
        includeRules: ['**/*.md'],
        excludeRules: [],
        enabled: true,
        useGlobPatterns: true,
        caseSensitive: false,
      };
    default:
      return null;
  }
}

function readManifest(vaultPath: string): ScaffoldManifest | null {
  return readJsonFile<ScaffoldManifest>(getManifestPath(vaultPath));
}

function newManifest(now: Date): ScaffoldManifest {
  const iso = now.toISOString();
  return {
    scaffoldVersion: 0,
    installedAt: iso,
    lastUpgrade: iso,
    plugins: {},
    theme: null,
    snippets: { version: 0 },
  };
}

function writeManifest(vaultPath: string, manifest: ScaffoldManifest): void {
  writeJsonFile(getManifestPath(vaultPath), manifest);
}

function pluginEntriesForConfig(config: ObsidianConfig): PluginRegistryEntry[] {
  return config.readOnly
    ? PLUGIN_REGISTRY
    : PLUGIN_REGISTRY.filter(entry => entry.id !== 'read-only-view');
}

function pluginEntriesForConfigWithRegistry(config: ObsidianConfig, registry: PluginRegistryEntry[]): PluginRegistryEntry[] {
  return config.readOnly
    ? registry
    : registry.filter(entry => entry.id !== 'read-only-view');
}

async function downloadAsset(repo: string, tag: string, fileName: string, fetchImpl: typeof fetch, verifyDigest: string | null): Promise<Buffer> {
  const url = `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ASSET_DOWNLOAD_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logToFile('WARN', 'Timed out Obsidian scaffold asset download', {
        repo,
        tag,
        fileName,
        timeoutMs: ASSET_DOWNLOAD_TIMEOUT_MS,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const contents = Buffer.from(arrayBuffer);
  if (verifyDigest && sha256Hex(contents) !== verifyDigest) {
    throw new Error(`Digest mismatch for ${url}`);
  }
  return contents;
}

function installedAssetMatchesDigest(dirPath: string, fileName: string, digest: string): boolean {
  const assetPath = path.join(dirPath, fileName);
  if (!fs.existsSync(assetPath)) return false;
  return sha256Hex(fs.readFileSync(assetPath)) === digest;
}

async function installPluginAssets(
  vaultPath: string,
  plugin: PluginRegistryEntry,
  fetchImpl: typeof fetch,
  forceRefresh: boolean,
  verifyAssetIntegrity: boolean,
): Promise<AssetInstallResult> {
  const pluginDir = path.join(getObsidianDir(vaultPath), 'plugins', plugin.id);
  const tempDir = pluginDir + '.tmp';
  ensureDir(pluginDir);

  const allFilesCurrent = verifyAssetIntegrity
    ? plugin.files.every(file => installedAssetMatchesDigest(pluginDir, file, expectedDigest(plugin.fileDigests, file)))
    : plugin.files.every(file => fs.existsSync(path.join(pluginDir, file)));
  if (allFilesCurrent && !forceRefresh) {
    return { available: true, refreshed: false };
  }

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    ensureDir(tempDir);
    for (const fileName of plugin.files) {
      const contents = await downloadAsset(
        plugin.repo,
        plugin.tag,
        fileName,
        fetchImpl,
        verifyAssetIntegrity ? expectedDigest(plugin.fileDigests, fileName) : null,
      );
      fs.writeFileSync(path.join(tempDir, fileName), contents);
    }
    for (const fileName of plugin.files) {
      fs.renameSync(path.join(tempDir, fileName), path.join(pluginDir, fileName));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { available: true, refreshed: true };
  } catch {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return {
      available: plugin.files.every(file => fs.existsSync(path.join(pluginDir, file))),
      refreshed: false,
    };
  }
}

async function installThemeAssets(
  vaultPath: string,
  theme: ThemeRegistryEntry,
  fetchImpl: typeof fetch,
  forceRefresh: boolean,
  verifyAssetIntegrity: boolean,
): Promise<AssetInstallResult> {
  const themeDir = path.join(getObsidianDir(vaultPath), 'themes', theme.name);
  const tempDir = themeDir + '.tmp';
  ensureDir(themeDir);

  const allFilesCurrent = verifyAssetIntegrity
    ? theme.files.every(file => installedAssetMatchesDigest(themeDir, file, expectedDigest(theme.fileDigests, file)))
    : theme.files.every(file => fs.existsSync(path.join(themeDir, file)));
  if (allFilesCurrent && !forceRefresh) {
    return { available: true, refreshed: false };
  }

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    ensureDir(tempDir);
    for (const fileName of theme.files) {
      const contents = await downloadAsset(
        theme.repo,
        theme.tag,
        fileName,
        fetchImpl,
        verifyAssetIntegrity ? expectedDigest(theme.fileDigests, fileName) : null,
      );
      fs.writeFileSync(path.join(tempDir, fileName), contents);
    }
    for (const fileName of theme.files) {
      fs.renameSync(path.join(tempDir, fileName), path.join(themeDir, fileName));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { available: true, refreshed: true };
  } catch {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return {
      available: theme.files.every(file => fs.existsSync(path.join(themeDir, file))),
      refreshed: false,
    };
  }
}

function writeOwnedSnippets(vaultPath: string, config: ObsidianConfig): void {
  const snippetsDir = path.join(getObsidianDir(vaultPath), 'snippets');
  ensureDir(snippetsDir);

  for (const [fileName, content] of Object.entries(SNIPPETS)) {
    if (fileName === 'readonly-kb.css' && !config.readOnly) continue;
    fs.writeFileSync(path.join(snippetsDir, fileName), content, 'utf-8');
  }

  if (!config.readOnly) {
    const readonlySnippetPath = path.join(snippetsDir, 'readonly-kb.css');
    if (fs.existsSync(readonlySnippetPath)) {
      fs.rmSync(readonlySnippetPath, { force: true });
    }
  }
}

function copyPackageTemplates(vaultPath: string, templatesDir?: string): void {
  const sourceDir = templatesDir ?? getPackageTemplatesDir();
  const targetDir = path.join(vaultPath, 'templates');
  ensureDir(targetDir);

  for (const fileName of fs.readdirSync(sourceDir)) {
    if (!fileName.endsWith('.md')) continue;
    const targetPath = path.join(targetDir, fileName);
    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(path.join(sourceDir, fileName), targetPath);
    }
  }
}

function mergeJsonFile(filePath: string, defaults: unknown, arrayMode: 'replace' | 'union' = 'replace'): void {
  const existing = readJsonFile<unknown>(filePath);
  if (arrayMode === 'union') {
    writeJsonFile(filePath, mergeStringArray(existing, defaults as string[]));
    return;
  }

  if (existing == null) {
    writeJsonFile(filePath, defaults);
    return;
  }

  writeJsonFile(filePath, mergeAddOnly(existing, defaults));
}

function syncManagedAppConfig(vaultPath: string, config: ObsidianConfig): void {
  const filePath = path.join(getObsidianDir(vaultPath), 'app.json');
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const merged = mergeAddOnly(existing, defaultAppConfig(config)) as Record<string, unknown>;
  merged.defaultViewMode = config.readOnly ? 'preview' : 'source';
  writeJsonFile(filePath, merged);
}

function syncManagedAppearanceConfig(vaultPath: string, config: ObsidianConfig): void {
  const filePath = path.join(getObsidianDir(vaultPath), 'appearance.json');
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const merged = mergeAddOnly(existing, defaultAppearanceConfig(config)) as Record<string, unknown>;
  const currentSnippets = Array.isArray(existing.enabledCssSnippets)
    ? existing.enabledCssSnippets.filter((item): item is string => typeof item === 'string')
    : [];
  const desiredSnippets = (defaultAppearanceConfig(config).enabledCssSnippets as string[]);

  merged.enabledCssSnippets = [...currentSnippets.filter(item => !MANAGED_SNIPPETS.includes(item))];
  for (const snippet of desiredSnippets) {
    if (!(merged.enabledCssSnippets as string[]).includes(snippet)) {
      (merged.enabledCssSnippets as string[]).push(snippet);
    }
  }

  writeJsonFile(filePath, merged);
}

function syncManagedCommunityPlugins(vaultPath: string, enabledPlugins: string[]): void {
  const filePath = path.join(getObsidianDir(vaultPath), 'community-plugins.json');
  const existing = readJsonFile<unknown>(filePath);
  const currentPlugins = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === 'string')
    : [];
  const merged = currentPlugins.filter(plugin => !MANAGED_PLUGIN_IDS.includes(plugin));
  for (const plugin of enabledPlugins) {
    if (!merged.includes(plugin)) merged.push(plugin);
  }
  writeJsonFile(filePath, merged);
}

function writePluginConfigs(vaultPath: string, config: ObsidianConfig, pluginIds: string[]): void {
  for (const plugin of PLUGIN_REGISTRY) {
    if (!pluginIds.includes(plugin.id)) continue;
    const data = buildPluginData(plugin.id, config);
    if (data == null) continue;

    const dataPath = path.join(getObsidianDir(vaultPath), 'plugins', plugin.id, 'data.json');
    const existing = readJsonFile<unknown>(dataPath);
    writeJsonFile(dataPath, existing == null ? data : mergeAddOnly(existing, data));
  }
}

function buildPluginManifestState(
  manifest: ScaffoldManifest,
  config: ObsidianConfig,
  pluginResults: Map<string, AssetInstallResult>,
  registry: PluginRegistryEntry[],
): Record<string, { version: string; configVersion: number }> {
  const nextPlugins: Record<string, { version: string; configVersion: number }> = {};

  for (const plugin of pluginEntriesForConfigWithRegistry(config, registry)) {
    const result = pluginResults.get(plugin.id);
    if (!result?.available) continue;

    if (result.refreshed || !manifest.plugins[plugin.id]) {
      nextPlugins[plugin.id] = { version: plugin.tag, configVersion: 1 };
    } else {
      nextPlugins[plugin.id] = manifest.plugins[plugin.id];
    }
  }

  return nextPlugins;
}

async function applyScaffoldV1(
  vaultPath: string,
  config: ObsidianConfig,
  manifest: ScaffoldManifest,
  deps: ObsidianScaffoldDeps,
): Promise<ScaffoldManifest> {
  ensureDir(getObsidianDir(vaultPath));
  copyPackageTemplates(vaultPath, deps.templatesDir);
  writeOwnedSnippets(vaultPath, config);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const verifyAssetIntegrity = deps.verifyAssetIntegrity ?? true;
  const pluginRegistry = deps.pluginRegistry ?? PLUGIN_REGISTRY;
  const themeRegistry = deps.themeRegistry ?? THEME_REGISTRY;
  const pluginResults = new Map<string, AssetInstallResult>();
  const enabledPlugins: string[] = [];
  for (const plugin of pluginEntriesForConfigWithRegistry(config, pluginRegistry)) {
    const result = await installPluginAssets(vaultPath, plugin, fetchImpl, manifest.plugins[plugin.id]?.version !== plugin.tag, verifyAssetIntegrity);
    pluginResults.set(plugin.id, result);
    if (result.available) {
      enabledPlugins.push(plugin.id);
    } else {
      logToFile('WARN', 'Skipped Obsidian plugin scaffold asset after download failure', { plugin: plugin.id, repo: plugin.repo, tag: plugin.tag });
    }
  }

  const themeResult = await installThemeAssets(vaultPath, themeRegistry, fetchImpl, manifest.theme?.version !== themeRegistry.tag, verifyAssetIntegrity);
  if (!themeResult.available) {
    logToFile('WARN', 'Skipped Obsidian theme scaffold asset after download failure', { theme: themeRegistry.name, repo: themeRegistry.repo, tag: themeRegistry.tag });
  }

  syncManagedAppConfig(vaultPath, config);
  syncManagedAppearanceConfig(vaultPath, config);
  mergeJsonFile(path.join(getObsidianDir(vaultPath), 'core-plugins.json'), CORE_PLUGINS, 'union');
  syncManagedCommunityPlugins(vaultPath, enabledPlugins);
  writePluginConfigs(vaultPath, config, enabledPlugins);

  const updatedManifest: ScaffoldManifest = {
    ...manifest,
    scaffoldVersion: CURRENT_SCAFFOLD_VERSION,
    lastUpgrade: (deps.now ?? (() => new Date()))().toISOString(),
    plugins: buildPluginManifestState(manifest, config, pluginResults, pluginRegistry),
    theme: themeResult.available
      ? (themeResult.refreshed || !manifest.theme
        ? { name: themeRegistry.name, version: themeRegistry.tag }
        : manifest.theme)
      : null,
    snippets: { version: SNIPPET_VERSION },
  };

  writeManifest(vaultPath, updatedManifest);
  return updatedManifest;
}

export async function ensureObsidianScaffold(
  vaultPath: string,
  config?: Partial<ObsidianConfig>,
  deps: ObsidianScaffoldDeps = {},
): Promise<ScaffoldManifest | null> {
  const resolvedConfig = effectiveConfig(config);
  if (!resolvedConfig.scaffold) return null;

  const now = (deps.now ?? (() => new Date()))();
  let manifest = readManifest(vaultPath) ?? newManifest(now);

  if (manifest.scaffoldVersion < 1) {
    manifest = await applyScaffoldV1(vaultPath, resolvedConfig, manifest, deps);
  } else if (resolvedConfig.autoUpgrade) {
    manifest = await applyScaffoldV1(vaultPath, resolvedConfig, manifest, deps);
  }

  return manifest;
}

export function getObsidianScaffoldStatus(vaultPath: string, config?: Partial<ObsidianConfig>): ObsidianScaffoldStatus {
  const resolvedConfig = effectiveConfig(config);
  const manifest = readManifest(vaultPath);
  const pluginsExpected = pluginEntriesForConfig(resolvedConfig).length;
  const pluginsInstalled = manifest ? Object.keys(manifest.plugins).length : 0;
  const pluginsNeedingUpdate = manifest
    ? pluginEntriesForConfig(resolvedConfig)
      .filter(plugin => manifest.plugins[plugin.id] && manifest.plugins[plugin.id].version !== plugin.tag)
      .length
    : 0;

  return {
    scaffolded: manifest != null,
    scaffoldVersion: manifest?.scaffoldVersion ?? null,
    latestVersion: CURRENT_SCAFFOLD_VERSION,
    theme: manifest?.theme ?? null,
    pluginsInstalled,
    pluginsExpected,
    pluginsNeedingUpdate,
    readOnly: resolvedConfig.readOnly,
    autoUpgrade: resolvedConfig.autoUpgrade,
  };
}
