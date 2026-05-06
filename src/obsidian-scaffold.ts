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
  source?: 'release' | 'raw';
  branch?: string;
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
const SNIPPET_VERSION = 4;

export const PLUGIN_REGISTRY: PluginRegistryEntry[] = [
  { id: 'breadcrumbs', repo: 'SkepticMystic/breadcrumbs', tag: '4.8.2', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '3c291ade567955ac067ed80bdaddfef98fded3f6a32bc3d2b0e96b00bd2a9afd', 'manifest.json': '31d430dba4ee9b697d10caedc6943976e4c7308c9558b8aa8ae5fe4f456aed6d', 'styles.css': '14c1648afa8bb2d69d5d97500f52433cd8bff827de3c04facff8ab4abdf5fdd9' } },
  { id: 'dataview', repo: 'blacksmithgu/obsidian-dataview', tag: '0.5.68', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '794e9eaede73920bb8d54b0eda4f5de2182d698cc638774500f24f14bcd4da0b', 'manifest.json': '9235db47112da81b85591c79ecb9ae2574e5e72207056e976472f90616286185', 'styles.css': '3306dd9032e00f989ba7233a37fd255bc4d3f4340cee661762e952f3f6aa1de9' } },
  { id: 'homepage', repo: 'mirnovov/obsidian-homepage', tag: '4.4.0', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '4239eaaffced27ff2e743fffceefa75e19ccf784da5fc18dbec6b0f63f144b93', 'manifest.json': 'c76ac910648258eb763b4796efb62d56c7012bd8353cc1a6d59dd34f702466b1', 'styles.css': '3e0db75be5be6495188eb429f678606c27ba39d1ba97434f85c2dc387c127508' } },
  { id: 'quickadd', repo: 'chhoumann/quickadd', tag: '2.12.0', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': 'e09403bd9e20fe97affd1d53225ba09fbeada7f5e024dde8b64c5890529bffbe', 'manifest.json': '8eab8e5f9c1632dff06875c79bb55832a0a82f6fece246e05728cabdbe824889', 'styles.css': 'e820f28cbb62f604727a07a7dee614386e765ef3d98bc541ac863ce5961bcba2' } },
  { id: 'cmdr', repo: 'jsmorabito/obsidian-commander', tag: '0.5.5', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': 'ebfce0b5dbaac7dd46c8b51cd397a811020d079ab0bf931a64e20049d7510637', 'manifest.json': 'c6df5e0aa6d389695a87850eeeaf836775e2cd01579f4e277d82bc7a99fbe5e8', 'styles.css': '91765c55d9cddfbd3a62dc06bf18dc3ea6ecb879c89f939a1e50cebd3c31c28c' } },
  { id: 'templater-obsidian', repo: 'SilentVoid13/Templater', tag: '2.20.0', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '81eccff81962daf8ec722ed2deff7957b3fabee244afc9fb15c39e7b8d2943e3', 'manifest.json': '47f59f1683eca98be9a9fb58ebce3cf37557af2f5947b47bcba9e8f54c567eae', 'styles.css': 'f7d4ee5bd4ec1d032eda1f4e1da481e713c57af964ec1e55d31494f086068d1e' } },
  { id: 'obsidian-style-settings', repo: 'mgmeyers/obsidian-style-settings', tag: '1.0.9', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '1828abaacdab4c5578b705a625c585b30512f8efad4c7cfc5a18e70cc3557468', 'manifest.json': '9cffdc20cf2aa1354820e0050b694b0f9b576446e3d5d44a36ae8b0187e5bfb8', 'styles.css': 'ee7937d2be50653a89ccb30ae5f0572b23507d5b7f1328d005271a363075bfd8' } },
  { id: 'iconic', repo: 'gfxholo/iconic', tag: '1.1.9', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '83f6bd3eef277fd96c08c5a6ab7b3a8df2dca885da1348c449e122719988ce4f', 'manifest.json': '8236f5909d6864e2ccc1afeae2ac869e7c0f40ab9f537dfeee74df580e597835', 'styles.css': '78ee3acb0f70fb5dac55aabc89773efd5ef724d22bd432799116e3aedb374a20' } },
  { id: 'oz-calendar', repo: 'ozntel/oz-calendar', tag: '0.3.4', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '366853a93f4e0b2dfcbba25e5f74129b91ec93787ef3c4a97097cb00a8eef458', 'manifest.json': '632f4bc99a28e1d2d54ece32f9c754ebd0cc032e77dab8a962b316a7dbe22080', 'styles.css': '5e66038c352bbe773c8e614247a937499478fedca53697e48188b27a6acc3e41' } },
  { id: 'read-only-view', repo: 'mrKazzila/Read-Only-View', tag: '1.0.2', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '3df01d1010b8a47dfcd34f9099ab85fd0d94ff3f50794b0521febcb1408728e5', 'manifest.json': 'dbb136801ffe760c277be5707b2d9c7aee9d2a18da504acaf4a9c083f99c2fe4', 'styles.css': 'ed8507c596c292b2f4cf83f8f5645971ce14e0edf060611f258c1f3eddf997eb' } },
  { id: 'file-name-styler', repo: 'marc-f/obsidian-file-name-styler', tag: '1.2.3', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': 'dee37d54829f7ac2a03d4a9555d512fc704e03453858cfc0ef1be708a4d56d3b', 'manifest.json': '6e6ff5cb7a6e4eae529797ead9a6503ba8f12da4fe83a29c17450c02e6b13757', 'styles.css': 'f36e63c86032181c0a769f7832e7b81dd0c77ffcf1c0f9c5c134b4ce7e9219c7' } },
  { id: 'inline-callouts', repo: 'gapmiss/inline-callouts', tag: '0.1.4', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '6a8883c3d0c1d83c8d6868151e63fc4495d89f1547e8ced472b43330d7614d73', 'manifest.json': '34d7d4ae0eff4397e221972407c67a1d0380242ba47c89f2fb2fd36b2027cc5a', 'styles.css': '72145b1e1d0abf55b8f637ed835b55c5239ce5ccf56adeb984513527d5ff9191' } },
  { id: 'obsidian-meta-bind-plugin', repo: 'mProjectsCode/obsidian-meta-bind-plugin', tag: '1.4.9', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '99f60f4db8295fedc4b7014f2d341027500f43294b810b1a9cd00cecbb79821f', 'manifest.json': 'd6a43929b67dcf62e6daa94560c527680646afa69aa96c21b8b03e44e0854a1e', 'styles.css': '02bdee47f0e9173e52df663f92730d2cd26892ab510b572ce6d65503f6427f17' } },
  { id: 'folder-notes', repo: 'LostPaul/obsidian-folder-notes', tag: '1.8.19', files: ['main.js', 'manifest.json', 'styles.css'], fileDigests: { 'main.js': '761f16cc811c91fe286909aa7df9e9dd8104bb31b699ef855c2397562454ac37', 'manifest.json': '9a5984322e3af70a43ffecbd7a5c76fdabbc8e1feee7bbc61831f7341474ebe1', 'styles.css': '0be981f1240faf811a11127bb06cb4df31806c1f3c45e2adca77f5f4f38ed9d9' } },
];

export const THEME_REGISTRY: ThemeRegistryEntry = {
  name: 'Border',
  repo: 'Akifyss/obsidian-border',
  tag: '1.13.6',
  files: ['manifest.json', 'theme.css'],
  fileDigests: {
    'manifest.json': '88ee77db69989694e3a4cd7f839f7b65e94b7a9d7ba5c5230b029306d786825e',
    'theme.css': '396b9ee12ff71cc2acd08350e2e4f8dc3273e5de028c2071ad972826f87ad201',
  },
  source: 'raw',
  branch: 'main',
};

const ASSET_DOWNLOAD_TIMEOUT_MS = 30_000;
const MANAGED_SNIPPETS = ['zk-tables', 'zk-metadata', 'zk-properties', 'zk-nav', 'zk-dashboard', 'zk-icons', 'readonly-kb'];
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

.dashboard.markdown-reading-view table,
.dashboard.markdown-source-view.mod-cm6 .cm-table-widget table {
  width: 100% !important;
  table-layout: fixed !important;
}

.dashboard.markdown-reading-view table th:nth-child(1),
.dashboard.markdown-reading-view table td:nth-child(1),
.dashboard.markdown-source-view.mod-cm6 .cm-table-widget table th:nth-child(1),
.dashboard.markdown-source-view.mod-cm6 .cm-table-widget table td:nth-child(1) {
  width: 30% !important;
}

.dashboard.markdown-reading-view table th:nth-child(2),
.dashboard.markdown-reading-view table td:nth-child(2),
.dashboard.markdown-source-view.mod-cm6 .cm-table-widget table th:nth-child(2),
.dashboard.markdown-source-view.mod-cm6 .cm-table-widget table td:nth-child(2) {
  width: 12% !important;
  text-align: center;
}

.dashboard.markdown-reading-view table th:nth-child(3),
.dashboard.markdown-reading-view table td:nth-child(3),
.dashboard.markdown-source-view.mod-cm6 .cm-table-widget table th:nth-child(3),
.dashboard.markdown-source-view.mod-cm6 .cm-table-widget table td:nth-child(3) {
  width: 58% !important;
}

.dashboard .callout[data-callout="abstract"] {
  border-color: var(--interactive-accent);
  background-color: color-mix(in srgb, var(--interactive-accent) 8%, transparent);
}

.dashboard h2 {
  margin-top: 2.25rem;
}

.dashboard .inline-title {
  display: none;
}
`.trimStart(),
  'zk-tables.css': `
.markdown-reading-view table,
.markdown-source-view.mod-cm6 .cm-table-widget table,
.markdown-rendered table,
.table-view-table {
  width: 100% !important;
  table-layout: fixed !important;
  border-collapse: collapse;
}

.markdown-reading-view table th,
.markdown-reading-view table td,
.markdown-source-view.mod-cm6 .cm-table-widget table th,
.markdown-source-view.mod-cm6 .cm-table-widget table td,
.markdown-rendered table th,
.markdown-rendered table td,
.table-view-table th,
.table-view-table td {
  padding: 6px 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-word;
}

.table-view-table th:nth-child(1),
.table-view-table td:nth-child(1) {
  width: 20% !important;
  max-width: 200px;
}

.table-view-table th:nth-child(3),
.table-view-table td:nth-child(3) {
  width: 140px !important;
  min-width: 130px;
  max-width: 160px;
  white-space: nowrap;
}

.table-view-table th:nth-child(4),
.table-view-table td:nth-child(4) {
  width: 85px !important;
  min-width: 80px;
  max-width: 95px;
  text-align: center;
  white-space: nowrap;
  overflow: visible !important;
}

.dv-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: none !important;
  color: var(--text-muted) !important;
  text-decoration: none !important;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.dv-action-btn:hover {
  color: var(--text-accent) !important;
  background: var(--background-modifier-hover) !important;
}

.dv-action-btn-destructive:hover {
  color: var(--text-error) !important;
  background: color-mix(in srgb, var(--text-error) 8%, transparent);
}

.dv-action-btn .svg-icon {
  width: 20px;
  height: 20px;
}

.dataview-actions {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

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

.markdown-rendered .cm-table-widget {
  overflow-x: auto;
}
`.trimStart(),
  'zk-icons.css': `
.nav-file-title:has(.iconic-icon)::before {
  display: none !important;
}

/* Inline callout descriptions: breathing room under headings */
.inline-callout {
  margin-top: 4px;
  margin-bottom: 8px;
}

.markdown-rendered h1 .inline-callout,
.markdown-rendered h2 .inline-callout {
  margin: 0;
}
`.trimStart(),
  'zk-metadata.css': 'body { --metadata-display-reading: none; }\n',
  'zk-properties.css': `
/* Compact properties: collapsed by default, expand on hover */
.cm-editor .metadata-container {
  padding-top: 0;
  padding-bottom: 6px;
}

.cm-editor .metadata-properties-heading {
  display: none;
}

body:not(.is-mobile) .cm-editor .metadata-container {
  height: 0.5em;
  margin-bottom: 0;
}

body:not(.is-mobile) .cm-editor .metadata-container .metadata-content {
  display: none;
}

body:not(.is-mobile) .cm-editor .metadata-container::before {
  content: '⋯';
  display: block;
  position: absolute;
  height: 100%;
  width: 100%;
  line-height: 1em;
  text-indent: 3px;
  top: -4px;
  pointer-events: none;
  color: var(--text-faint);
}

body:not(.is-mobile) .cm-editor .metadata-container:is(:hover, :focus-within) {
  height: auto;
  background: inherit;
}

body:not(.is-mobile) .cm-editor .metadata-container:is(:hover, :focus-within)::before {
  display: none;
}

body:not(.is-mobile) .cm-editor .metadata-container:is(:hover, :focus-within) .metadata-content {
  display: inherit;
}

/* Hide metadata in hover popovers */
.hover-popover .metadata-container {
  display: none !important;
}
`.trimStart(),
  'zk-nav.css': `
.BC-page-views {
  margin: 0 0 1rem 0;
  padding: 0;
  border: none !important;
  background: none !important;
  box-shadow: none !important;
  font-size: 0.82em;
  color: var(--text-faint);
  min-height: 1.875em;
}

.BC-trail-view {
  padding: 0 !important;
  background: transparent !important;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

.BC-trail-view-path {
  gap: 0.35em !important;
  padding: 0 !important;
  background: none !important;
  border: none !important;
  box-shadow: none !important;
}

.BC-trail-view-item {
  background: none !important;
  border: none !important;
  box-shadow: none !important;
}

.BC-trail-view-item-separator {
  margin: 0 0.1em;
}

.BC-trail-view-item-separator::before {
  color: var(--text-faint);
  font-size: 0.85em;
}

.BC-page-views .internal-link {
  color: var(--text-muted);
  text-decoration: none;
}

.BC-page-views .internal-link:hover {
  color: var(--text-accent);
}

.BC-page-views .BC-edge,
.BC-page-views .BC-edge.internal-link,
.BC-page-views span[role="link"].internal-link {
  background: none !important;
  border: none !important;
  box-shadow: none !important;
  border-radius: 0 !important;
  padding: 0 !important;
  outline: none !important;
}

.markdown-rendered a[href^="obsidian://quickadd?"] {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  color: var(--text-accent);
  text-decoration: none;
  font-size: 0.9em;
  font-weight: 500;
  vertical-align: middle;
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
}

.markdown-rendered a[href^="obsidian://quickadd?"]:hover {
  background: color-mix(in srgb, var(--interactive-accent) 20%, transparent);
  color: var(--text-normal);
  transform: translateY(-1px);
}

.markdown-rendered h1 a[href^="obsidian://quickadd?"],
.markdown-rendered h2 a[href^="obsidian://quickadd?"] {
  background: none;
  padding: 0;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-left: 0.35rem;
  color: var(--text-muted);
  font-size: 0.75em;
  font-weight: 400;
  vertical-align: baseline;
  position: relative;
  top: 0.1em;
  transition: color 0.15s ease, background 0.15s ease;
}

.markdown-rendered h1 a[href^="obsidian://quickadd?"]:hover,
.markdown-rendered h2 a[href^="obsidian://quickadd?"]:hover {
  color: var(--text-accent);
  background: var(--background-modifier-hover);
  transform: none;
}

.markdown-rendered h1 a[href^="obsidian://quickadd?"]::after,
.markdown-rendered h2 a[href^="obsidian://quickadd?"]::after {
  display: none !important;
}

.workspace-leaf-content:has(.folder-note-shell) .view-action.cmdr-page-header {
  display: none !important;
}

.view-header-breadcrumb-container,
.view-header-title-container {
  display: none !important;
}

.markdown-rendered a.external-link::after {
  content: '';
  display: inline-block;
  width: 0.7em;
  height: 0.7em;
  margin-left: 0.15em;
  background-color: currentColor;
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'%3E%3Cpath d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'/%3E%3Cpolyline points='15 3 21 3 21 9'/%3E%3Cline x1='10' y1='14' x2='21' y2='3'/%3E%3C/svg%3E");
  mask-size: contain;
  mask-repeat: no-repeat;
  vertical-align: middle;
  opacity: 0.6;
}
`.trimStart(),
  'readonly-kb.css': `
.clickable-icon.view-action[aria-label^="Current view"] {
  display: none !important;
}

.markdown-source-view.mod-cm6 .edit-block-button {
  display: none;
}
`.trimStart(),
};

const QUICKADD_SCRIPTS: Record<string, string> = {
  'edit-note.js': `
module.exports = async (params) => {
  const { app } = params;
  const filePath = params.variables?.path;
  if (!filePath) return;
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!file) return;
  const leaf = app.workspace.getLeaf('tab');
  await leaf.openFile(file, { state: { mode: 'source' } });
};
`.trimStart(),
  'delete-note.js': `
module.exports = async (params) => {
  const { app, quickAddApi } = params;
  const filePath = params.variables?.path;
  if (!filePath) { new Notice('No file path provided'); return; }
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!file) { new Notice('File not found: ' + filePath); return; }
  const confirm = await quickAddApi.yesNoPrompt('Delete this note?', 'Are you sure you want to delete "' + file.name + '"?');
  if (confirm) {
    await app.vault.trash(file, true);
    new Notice('Deleted: ' + file.name);
  }
};
`.trimStart(),
  'promote-note.js': `
module.exports = async (params) => {
  const { app } = params;
  const filePath = params.variables?.path;
  if (!filePath) { new Notice('No file path provided'); return; }
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!file) { new Notice('File not found: ' + filePath); return; }
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (fm.status === 'fleeting') {
      fm.status = 'permanent';
      new Notice('Promoted to permanent: ' + (fm.title || file.name));
    } else {
      new Notice('Already ' + (fm.status || 'unknown') + ': ' + file.name);
    }
  });
};
`.trimStart(),
};

function getPackageTemplatesDir(): string {
  const obsidianDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'obsidian');
  if (fs.existsSync(obsidianDir)) return obsidianDir;
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
    readableLineLength: false,
    showFrontmatter: false,
    alwaysUpdateLinks: true,
    useMarkdownLinks: false,
    newLinkFormat: 'shortest',
    showInlineTitle: false,
    foldHeading: true,
    trashOption: 'local',
    userIgnoreFilters: ['.scripts', '.templates'],
  };
}

function defaultAppearanceConfig(config: ObsidianConfig): Record<string, unknown> {
  const enabledCssSnippets = ['zk-tables', 'zk-metadata', 'zk-properties', 'zk-nav', 'zk-dashboard', 'zk-icons'];
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
    { id: 'decision', kind: 'decision', template: 'decision.md', label: 'Decision — choices & tradeoffs' },
    { id: 'observation', kind: 'observation', template: 'observation.md', label: 'Observation — things you noticed' },
    { id: 'procedure', kind: 'procedure', template: 'procedure.md', label: 'Procedure — step-by-step workflows' },
    { id: 'reference', kind: 'reference', template: 'reference.md', label: 'Reference — sources & excerpts' },
    { id: 'resource', kind: 'resource', template: 'resource.md', label: 'Resource — tools & URLs' },
    { id: 'preference', kind: 'personalization', template: 'personalization.md', label: 'Preference — personal habits' },
    { id: 'domain', kind: 'domain', template: 'domain.md', label: 'Domain — project manual for AI' },
  ];

  const kindDirMap: Record<string, string> = {
    decision: 'decisions', observation: 'observations', procedure: 'procedures',
    reference: 'references', resource: 'resources', personalization: 'preferences',
    domain: '',
  };

  return kinds.map(({ id, kind, template, label }) => ({
    name: label,
    id: deterministicId(`quickadd-${id}`),
    type: 'Template',
    command: true,
    templatePath: `.templates/${template}`,
    fileNameFormat: {
      enabled: true,
      format: kind === 'domain'
        ? 'domain'
        : '{{DATE:YYYYMMDDHHmmss}}00-new-note',
    },
    folder: {
      enabled: true,
      folders: [kind === 'domain' ? 'general' : `general/${kindDirMap[kind] || `${kind}s`}`],
      chooseWhenCreatingNote: false,
    },
    openFile: true,
    fileOpening: {
      location: 'tab',
      direction: 'vertical',
      mode: 'source',
      focus: true,
    },
  }));
}

function buildProjectQuickAddChoices(): Array<Record<string, unknown>> {
  const kinds = [
    { id: 'project-decision', template: 'decision-project.md', label: 'Project Decision' },
    { id: 'project-observation', template: 'observation-project.md', label: 'Project Observation' },
    { id: 'project-procedure', template: 'procedure-project.md', label: 'Project Procedure' },
    { id: 'project-reference', template: 'reference-project.md', label: 'Project Reference' },
    { id: 'project-resource', template: 'resource-project.md', label: 'Project Resource' },
    { id: 'project-preference', template: 'personalization-project.md', label: 'Project Preference' },
  ];

  const kindDirMap: Record<string, string> = {
    decision: 'decisions', observation: 'observations', procedure: 'procedures',
    reference: 'references', resource: 'resources', personalization: 'preferences',
  };

  return kinds.map(({ id, template, label }) => {
    const kind = id.replace('project-', '');
    return {
      name: label,
      id: deterministicId(`quickadd-${id}`),
      type: 'Template',
      command: false,
      templatePath: `.templates/${template}`,
      fileNameFormat: {
        enabled: true,
        format: '{{DATE:YYYYMMDDHHmmss}}00-new-note',
      },
      folder: {
        enabled: true,
        folders: [`projects/{{VALUE:project}}/${kindDirMap[kind] || `${kind}s`}`],
        chooseWhenCreatingNote: false,
      },
      openFile: true,
      fileOpening: {
        location: 'tab',
        direction: 'vertical',
        mode: 'source',
        focus: true,
      },
    };
  });
}

function buildQuickAddMacros(): Array<Record<string, unknown>> {
  return [
    {
      name: 'Edit Note',
      id: deterministicId('macro-edit-note'),
      commands: [
        {
          name: 'edit-note',
          type: 'UserScript',
          id: deterministicId('macro-command-edit-note'),
          path: '.scripts/edit-note.js',
          settings: {},
        },
      ],
    },
    {
      name: 'Delete Note',
      id: deterministicId('macro-delete-note'),
      commands: [
        {
          name: 'delete-note',
          type: 'UserScript',
          id: deterministicId('macro-command-delete-note'),
          path: '.scripts/delete-note.js',
          settings: {},
        },
      ],
    },
    {
      name: 'Promote Note',
      id: deterministicId('macro-promote-note'),
      commands: [
        {
          name: 'promote-note',
          type: 'UserScript',
          id: deterministicId('macro-command-promote-note'),
          path: '.scripts/promote-note.js',
          settings: {},
        },
      ],
    },
  ];
}

function buildQuickAddActionChoices(): Array<Record<string, unknown>> {
  return [
    {
      name: 'Edit Note',
      id: deterministicId('choice-edit-note'),
      type: 'Macro',
      command: true,
      macroId: deterministicId('macro-edit-note'),
    },
    {
      name: 'Delete Note',
      id: deterministicId('choice-delete-note'),
      type: 'Macro',
      command: true,
      macroId: deterministicId('macro-delete-note'),
    },
    {
      name: 'Promote Note',
      id: deterministicId('choice-promote-note'),
      type: 'Macro',
      command: true,
      macroId: deterministicId('macro-promote-note'),
    },
  ];
}

function buildPluginData(pluginId: string, config: ObsidianConfig): Record<string, unknown> | null {
  switch (pluginId) {
    case 'folder-notes':
      return {
        hideFolderNote: true,
        storageLocation: 'insideFolder',
        folderNoteName: '{{folder_name}}',
        syncFolderName: true,
        underlineFolder: true,
        underlineFolderInPath: true,
        openFolderNoteOnClickInPath: true,
      };
    case 'dataview':
      return {
        enableDataviewJs: true,
        enableInlineDataviewJs: true,
      };
    case 'homepage':
      return {
        version: 4,
        separateMobile: false,
        homepages: {
          'Main Homepage': {
            value: 'Home',
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
    case 'breadcrumbs':
      return {
        edge_fields: [
          { label: 'up' },
          { label: 'down' },
          { label: 'same' },
          { label: 'next' },
          { label: 'prev' },
        ],
        edge_field_groups: [
          { label: 'ups', fields: ['up'] },
          { label: 'downs', fields: ['down'] },
        ],
        views: {
          page: {
            all: { sticky: false, readable_line_width: true },
            trail: {
              enabled: true,
              format: 'path',
              selection: 'longest',
              default_depth: 999,
              no_path_message: '',
              show_controls: false,
              merge_fields: false,
              field_group_labels: ['ups'],
              show_node_options: { ext: false, folder: false, alias: true },
            },
          },
        },
        commands: {
          rebuild_graph: {
            notify: true,
            trigger: {
              note_save: true,
              layout_change: true,
            },
          },
        },
      };
    case 'quickadd': {
      const multiChoiceId = deterministicId('quickadd-new-note');
      return {
        user_scripts_folder: '.scripts',
        macros: buildQuickAddMacros(),
        choices: [
          {
            name: 'New Note',
            id: multiChoiceId,
            type: 'Multi',
            command: true,
            choices: buildQuickAddChoices(),
          },
          ...buildProjectQuickAddChoices(),
          ...buildQuickAddActionChoices(),
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
        pageHeader: [
          {
            id: 'markdown:toggle-preview',
            icon: 'lucide-pencil',
            name: 'Edit',
            mode: 'any',
          },
          {
            id: 'app:delete-file',
            icon: 'lucide-trash-2',
            name: 'Delete',
            mode: 'any',
          },
        ],
      };
    case 'templater-obsidian':
      return {
        templates_folder: 'templates',
        trigger_on_file_creation: false,
        auto_jump_to_cursor: true,
        enable_system_commands: false,
        shell_path: '',
        user_scripts_folder: '',
        enable_folder_templates: true,
        folder_templates: [
          { folder: 'general/decisions', template: '.templates/decision.md' },
          { folder: 'general/procedures', template: '.templates/procedure.md' },
          { folder: 'general/observations', template: '.templates/observation.md' },
          { folder: 'general/references', template: '.templates/reference.md' },
          { folder: 'general/resources', template: '.templates/resource.md' },
          { folder: 'preferences', template: '.templates/personalization.md' },
        ],
        enable_file_templates: false,
        syntax_highlighting: true,
      };
    case 'oz-calendar':
      return {
        openViewOnStart: false,
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
    case 'file-name-styler':
      return {
        profiles: [
          {
            name: 'Hide Zettelkasten ID',
            enabled: true,
            idFormat: 'custom',
            customIdRegex: '^\\d{16}-',
            displayMode: 'hide',
            folders: [],
            restrictToFolders: false,
          },
        ],
        activeProfile: 'Hide Zettelkasten ID',
      };
    case 'inline-callouts':
      return {};
    case 'obsidian-meta-bind-plugin':
      return {
        jsEngineEnabled: true,
      };
    case 'obsidian-style-settings':
      return {
        'Appearance-dark@@card-layout-open-dark': true,
        'Appearance-light@@card-layout-open-light': true,
        'file-icon-remove': true,
      };
    case 'iconic':
      return {
        biggerIcons: 'off',
        clickableIcons: 'on',
        showAllFileIcons: false,
        showAllFolderIcons: true,
        minimalFolderIcons: false,
        showMarkdownTabIcons: true,
        appIcons: {},
        tabIcons: {},
        fileIcons: {},
        bookmarkIcons: {},
        tagIcons: {},
        propertyIcons: {},
        ribbonIcons: {},
        folderIcons: {},
        fileRules: [
          { id: 'zkdec', name: 'Decisions', icon: 'lucide-scale', color: 'orange', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'decision' }], enabled: true },
          { id: 'zkpro', name: 'Procedures', icon: 'lucide-list-checks', color: 'green', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'procedure' }], enabled: true },
          { id: 'zkref', name: 'References', icon: 'lucide-book-open', color: 'blue', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'reference' }], enabled: true },
          { id: 'zkobs', name: 'Observations', icon: 'lucide-lightbulb', color: 'yellow', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'observation' }], enabled: true },
          { id: 'zkres', name: 'Resources', icon: 'lucide-external-link', color: 'cyan', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'resource' }], enabled: true },
          { id: 'zkper', name: 'Preferences', icon: 'lucide-user-cog', color: 'pink', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'personalization' }], enabled: true },
          { id: 'zkdom', name: 'Domain', icon: 'lucide-compass', color: 'purple', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'domain' }], enabled: true },
          { id: 'zkrhom', name: 'Home', icon: 'lucide-brain', color: 'purple', match: 'all', conditions: [{ source: 'name', operator: 'is', value: 'Home' }], enabled: true },
          { id: 'zkidx', name: 'Index', icon: 'lucide-layout-grid', color: 'blue', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'index' }], enabled: true },
          { id: 'zklog', name: 'Log', icon: 'lucide-scroll-text', color: 'red', match: 'all', conditions: [{ source: 'property:kind', operator: 'is', value: 'log' }], enabled: true },
          { id: 'zkrlog', name: 'Global Log', icon: 'lucide-scroll-text', color: 'red', match: 'all', conditions: [{ source: 'name', operator: 'is', value: 'log' }], enabled: true },
          { id: 'zkrrev', name: 'Review', icon: 'lucide-clipboard-check', color: 'green', match: 'all', conditions: [{ source: 'name', operator: 'is', value: 'review' }], enabled: true },
        ],
        folderRules: [
          { id: 'zkfprj', name: 'Projects', icon: 'lucide-folder-open', color: 'blue', match: 'all', conditions: [{ source: 'path', operator: 'is', value: 'projects' }], enabled: true },
          { id: 'zkfdec', name: 'Decisions', icon: 'lucide-scale', color: 'orange', match: 'all', conditions: [{ source: 'name', operator: 'is', value: 'decisions' }], enabled: true },
          { id: 'zkfpro', name: 'Procedures', icon: 'lucide-list-checks', color: 'green', match: 'all', conditions: [{ source: 'name', operator: 'is', value: 'procedures' }], enabled: true },
          { id: 'zkfref', name: 'References', icon: 'lucide-book-open', color: 'blue', match: 'all', conditions: [{ source: 'name', operator: 'is', value: 'references' }], enabled: true },
          { id: 'zkfobs', name: 'Observations', icon: 'lucide-lightbulb', color: 'yellow', match: 'all', conditions: [{ source: 'name', operator: 'is', value: 'observations' }], enabled: true },
          { id: 'zkfres', name: 'Resources', icon: 'lucide-external-link', color: 'cyan', match: 'all', conditions: [{ source: 'name', operator: 'is', value: 'resources' }], enabled: true },
          { id: 'zkfprf', name: 'Preferences', icon: 'lucide-user-cog', color: 'pink', match: 'all', conditions: [{ source: 'path', operator: 'is', value: 'preferences' }], enabled: true },
          { id: 'zkfgen', name: 'General', icon: 'lucide-library', color: 'cyan', match: 'all', conditions: [{ source: 'path', operator: 'is', value: 'general' }], enabled: true },
        ],
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

async function downloadAsset(
  repo: string,
  tag: string,
  fileName: string,
  fetchImpl: typeof fetch,
  verifyDigest: string | null,
  source?: 'release' | 'raw',
  branch?: string,
): Promise<Buffer> {
  const url = source === 'raw'
    ? `https://raw.githubusercontent.com/${repo}/${branch || 'main'}/${fileName}`
    : `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
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
        theme.source,
        theme.branch,
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

function writeQuickAddScripts(vaultPath: string): void {
  const scriptsDir = path.join(vaultPath, '.scripts');
  ensureDir(scriptsDir);

  for (const [fileName, content] of Object.entries(QUICKADD_SCRIPTS)) {
    fs.writeFileSync(path.join(scriptsDir, fileName), content, 'utf-8');
  }
}

function copyPackageTemplates(vaultPath: string, templatesDir?: string): void {
  const sourceDir = templatesDir ?? getPackageTemplatesDir();
  const targetDir = path.join(vaultPath, '.templates');
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
  merged.readableLineLength = false;
  merged.showInlineTitle = false;
  merged.userIgnoreFilters = ['.scripts', '.templates'];
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

  merged.cssTheme = THEME_REGISTRY.name;

  writeJsonFile(filePath, merged);
}

function scaffoldWorkspaceDefaults(vaultPath: string): void {
  const filePath = path.join(getObsidianDir(vaultPath), 'workspace.json');
  const existing = readJsonFile<Record<string, unknown>>(filePath);

  if (!existing) {
    writeJsonFile(filePath, {
      main: { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), type: 'split', children: [], direction: 'vertical' },
      left: { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), type: 'split', children: [], direction: 'horizontal', width: 200, collapsed: true },
      right: { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), type: 'split', children: [], direction: 'horizontal', width: 300, collapsed: true },
    });
    return;
  }

  if (isPlainObject(existing.left) && !('collapsed' in existing.left)) {
    (existing.left as Record<string, unknown>).collapsed = true;
  }
  if (isPlainObject(existing.right) && !('collapsed' in existing.right)) {
    (existing.right as Record<string, unknown>).collapsed = true;
  }

  const ribbon = (existing['left-ribbon'] ?? {}) as Record<string, unknown>;
  ribbon.hiddenItems = {
    'switcher:Open quick switcher': true,
    'graph:Open graph view': true,
    'canvas:Create new canvas': true,
    'command-palette:Open command palette': true,
    'bases:Create new base': true,
    'homepage:Open homepage': false,
    'cmdr:New Note': false,
    'templater-obsidian:Templater': true,
    'iconic:Open rulebook': true,
  };
  existing['left-ribbon'] = ribbon;

  writeJsonFile(filePath, existing);
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

const FORCE_REPLACE_PLUGINS = new Set(['quickadd', 'cmdr', 'templater-obsidian', 'breadcrumbs', 'iconic']);

function writePluginConfigs(vaultPath: string, config: ObsidianConfig, pluginIds: string[]): void {
  for (const plugin of PLUGIN_REGISTRY) {
    if (!pluginIds.includes(plugin.id)) continue;
    const data = buildPluginData(plugin.id, config);
    if (data == null) continue;

    const dataPath = path.join(getObsidianDir(vaultPath), 'plugins', plugin.id, 'data.json');
    if (FORCE_REPLACE_PLUGINS.has(plugin.id)) {
      writeJsonFile(dataPath, data);
    } else {
      const existing = readJsonFile<unknown>(dataPath);
      writeJsonFile(dataPath, existing == null ? data : mergeAddOnly(existing, data));
    }
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
  writeQuickAddScripts(vaultPath);

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
  scaffoldWorkspaceDefaults(vaultPath);
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
