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
}

export interface ThemeRegistryEntry {
  name: string;
  repo: string;
  tag: string;
  files: string[];
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
}

const DEFAULT_OBSIDIAN_CONFIG: ObsidianConfig = {
  scaffold: true,
  autoUpgrade: true,
  readOnly: true,
};

export const CURRENT_SCAFFOLD_VERSION = 1;
const SNIPPET_VERSION = 1;

export const PLUGIN_REGISTRY: PluginRegistryEntry[] = [
  { id: 'homepage', repo: 'mirnovov/obsidian-homepage', tag: '4.4.0', files: ['main.js', 'manifest.json', 'styles.css'] },
  { id: 'quickadd', repo: 'chhoumann/quickadd', tag: '2.12.0', files: ['main.js', 'manifest.json', 'styles.css'] },
  { id: 'cmdr', repo: 'jsmorabito/obsidian-commander', tag: '0.5.5', files: ['main.js', 'manifest.json', 'styles.css'] },
  { id: 'templater-obsidian', repo: 'SilentVoid13/Templater', tag: '2.20.0', files: ['main.js', 'manifest.json', 'styles.css'] },
  { id: 'obsidian-minimal-settings', repo: 'kepano/obsidian-minimal-settings', tag: '8.2.2', files: ['main.js', 'manifest.json', 'styles.css'] },
  { id: 'oz-calendar', repo: 'ozntel/oz-calendar', tag: '0.3.4', files: ['main.js', 'manifest.json', 'styles.css'] },
  { id: 'read-only-view', repo: 'mrKazzila/Read-Only-View', tag: '1.0.2', files: ['main.js', 'manifest.json', 'styles.css'] },
];

export const THEME_REGISTRY: ThemeRegistryEntry = {
  name: 'Minimal',
  repo: 'kepano/obsidian-minimal',
  tag: '8.1.7',
  files: ['manifest.json', 'theme.css'],
};

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

function buildQuickAddChoices(): Array<Record<string, unknown>> {
  const kinds = [
    { kind: 'decision', folder: 'decisions', template: 'decision.md', label: 'Decision' },
    { kind: 'procedure', folder: 'procedures', template: 'procedure.md', label: 'Procedure' },
    { kind: 'observation', folder: 'observations', template: 'observation.md', label: 'Observation' },
    { kind: 'reference', folder: 'references', template: 'reference.md', label: 'Reference' },
    { kind: 'resource', folder: 'resources', template: 'resource.md', label: 'Resource' },
    { kind: 'personalization', folder: 'preferences', template: 'personalization.md', label: 'Personalization' },
    { kind: 'domain', folder: 'projects', template: 'domain.md', label: 'Domain' },
  ];

  return kinds.map(({ kind, folder, template, label }) => ({
    name: `New ${label} Note`,
    id: deterministicId(`quickadd-${kind}`),
    type: 'Template',
    command: true,
    templatePath: `templates/${template}`,
    fileNameFormat: {
      enabled: true,
      format: '{{DATE:YYYYMMDDHHmmss}}-{{VALUE}}',
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
          { folder: 'decisions', template: 'templates/decision.md' },
          { folder: 'procedures', template: 'templates/procedure.md' },
          { folder: 'observations', template: 'templates/observation.md' },
          { folder: 'references', template: 'templates/reference.md' },
          { folder: 'resources', template: 'templates/resource.md' },
          { folder: 'preferences', template: 'templates/personalization.md' },
          { folder: 'projects', template: 'templates/domain.md' },
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

async function downloadAsset(repo: string, tag: string, fileName: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const url = `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function installPluginAssets(
  vaultPath: string,
  plugin: PluginRegistryEntry,
  fetchImpl: typeof fetch,
  forceRefresh: boolean,
): Promise<boolean> {
  const pluginDir = path.join(getObsidianDir(vaultPath), 'plugins', plugin.id);
  ensureDir(pluginDir);

  const requiredFiles = plugin.files.filter(file => file === 'main.js' || file === 'manifest.json');
  const hadRequiredFiles = requiredFiles.every(file => fs.existsSync(path.join(pluginDir, file)));
  if (hadRequiredFiles && !forceRefresh) return true;

  if (forceRefresh) {
    for (const fileName of plugin.files) {
      const assetPath = path.join(pluginDir, fileName);
      if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
    }
  }

  try {
    for (const fileName of plugin.files) {
      const contents = await downloadAsset(plugin.repo, plugin.tag, fileName, fetchImpl);
      fs.writeFileSync(path.join(pluginDir, fileName), contents);
    }
    return true;
  } catch {
    return requiredFiles.every(file => fs.existsSync(path.join(pluginDir, file)));
  }
}

async function installThemeAssets(
  vaultPath: string,
  theme: ThemeRegistryEntry,
  fetchImpl: typeof fetch,
  forceRefresh: boolean,
): Promise<boolean> {
  const themeDir = path.join(getObsidianDir(vaultPath), 'themes', theme.name);
  ensureDir(themeDir);

  const requiredFiles = ['manifest.json', 'theme.css'];
  const alreadyInstalled = requiredFiles.every(file => fs.existsSync(path.join(themeDir, file)));
  if (alreadyInstalled && !forceRefresh) return true;

  if (forceRefresh) {
    for (const fileName of theme.files) {
      const assetPath = path.join(themeDir, fileName);
      if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
    }
  }

  try {
    for (const fileName of theme.files) {
      const contents = await downloadAsset(theme.repo, theme.tag, fileName, fetchImpl);
      fs.writeFileSync(path.join(themeDir, fileName), contents);
    }
    return true;
  } catch {
    return requiredFiles.every(file => fs.existsSync(path.join(themeDir, file)));
  }
}

function writeOwnedSnippets(vaultPath: string, config: ObsidianConfig): void {
  const snippetsDir = path.join(getObsidianDir(vaultPath), 'snippets');
  ensureDir(snippetsDir);

  for (const [fileName, content] of Object.entries(SNIPPETS)) {
    if (fileName === 'readonly-kb.css' && !config.readOnly) continue;
    fs.writeFileSync(path.join(snippetsDir, fileName), content, 'utf-8');
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

function applyPluginConfigs(vaultPath: string, config: ObsidianConfig, pluginIds: string[]): Record<string, { version: string; configVersion: number }> {
  const installed: Record<string, { version: string; configVersion: number }> = {};

  for (const plugin of PLUGIN_REGISTRY) {
    if (!pluginIds.includes(plugin.id)) continue;
    installed[plugin.id] = { version: plugin.tag, configVersion: 1 };
    const data = buildPluginData(plugin.id, config);
    if (data == null) continue;

    const dataPath = path.join(getObsidianDir(vaultPath), 'plugins', plugin.id, 'data.json');
    const existing = readJsonFile<unknown>(dataPath);
    writeJsonFile(dataPath, existing == null ? data : mergeAddOnly(existing, data));
  }

  return installed;
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
  const enabledPlugins: string[] = [];
  for (const plugin of pluginEntriesForConfig(config)) {
    const ok = await installPluginAssets(vaultPath, plugin, fetchImpl, manifest.plugins[plugin.id]?.version !== plugin.tag);
    if (ok) {
      enabledPlugins.push(plugin.id);
    } else {
      logToFile('WARN', 'Skipped Obsidian plugin scaffold asset after download failure', { plugin: plugin.id, repo: plugin.repo, tag: plugin.tag });
    }
  }

  const themeInstalled = await installThemeAssets(vaultPath, THEME_REGISTRY, fetchImpl, manifest.theme?.version !== THEME_REGISTRY.tag);
  if (!themeInstalled) {
    logToFile('WARN', 'Skipped Obsidian theme scaffold asset after download failure', { theme: THEME_REGISTRY.name, repo: THEME_REGISTRY.repo, tag: THEME_REGISTRY.tag });
  }

  mergeJsonFile(path.join(getObsidianDir(vaultPath), 'app.json'), defaultAppConfig(config));
  mergeJsonFile(path.join(getObsidianDir(vaultPath), 'appearance.json'), defaultAppearanceConfig(config));
  mergeJsonFile(path.join(getObsidianDir(vaultPath), 'core-plugins.json'), CORE_PLUGINS, 'union');
  mergeJsonFile(path.join(getObsidianDir(vaultPath), 'community-plugins.json'), enabledPlugins, 'union');

  const updatedManifest: ScaffoldManifest = {
    ...manifest,
    scaffoldVersion: CURRENT_SCAFFOLD_VERSION,
    lastUpgrade: (deps.now ?? (() => new Date()))().toISOString(),
    plugins: applyPluginConfigs(vaultPath, config, enabledPlugins),
    theme: themeInstalled ? { name: THEME_REGISTRY.name, version: THEME_REGISTRY.tag } : null,
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
