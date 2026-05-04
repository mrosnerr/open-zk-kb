import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';
import { ensureObsidianScaffold } from '../src/obsidian-scaffold.js';

const MOCK_MANIFEST_CONTENT = JSON.stringify({ name: 'Mock', id: 'mock', version: '1.0.0' });
const MOCK_STYLE_CONTENT = 'body { color: var(--text-normal); }';
const MOCK_MAIN_CONTENT = 'module.exports = {};';

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function mockScaffoldDeps() {
  return {
    fetchImpl: mockFetchFactory(),
    verifyAssetIntegrity: false,
  };
}

function mockIntegrityDeps() {
  return {
    fetchImpl: mockFetchFactory(),
    verifyAssetIntegrity: true,
    pluginRegistry: [
      {
        id: 'homepage',
        repo: 'mock/homepage',
        tag: '1.0.0',
        files: ['main.js', 'manifest.json', 'styles.css'],
        fileDigests: {
          'main.js': sha256(MOCK_MAIN_CONTENT),
          'manifest.json': sha256(MOCK_MANIFEST_CONTENT),
          'styles.css': sha256(MOCK_STYLE_CONTENT),
        },
      },
    ],
    themeRegistry: {
      name: 'Minimal',
      repo: 'mock/minimal',
      tag: '1.0.0',
      files: ['manifest.json', 'theme.css'],
      fileDigests: {
        'manifest.json': sha256(MOCK_MANIFEST_CONTENT),
        'theme.css': sha256(MOCK_STYLE_CONTENT),
      },
    },
  };
}

function mockFetchFactory() {
  return async (url: string | URL | Request): Promise<Response> => {
    const urlString = String(url);
    const fileName = urlString.split('/').pop() || 'asset.txt';

    if (fileName === 'manifest.json') {
      return new Response(MOCK_MANIFEST_CONTENT, { status: 200 });
    }
    if (fileName === 'theme.css' || fileName === 'styles.css') {
      return new Response(MOCK_STYLE_CONTENT, { status: 200 });
    }
    if (fileName === 'main.js') {
      return new Response(MOCK_MAIN_CONTENT, { status: 200 });
    }

    return new Response('ok', { status: 200 });
  };
}

function selectiveFailureFetchFactory(failFiles: string[]) {
  return async (url: string | URL | Request): Promise<Response> => {
    const urlString = String(url);
    const fileName = urlString.split('/').pop() || 'asset.txt';

    if (failFiles.includes(fileName)) {
      throw new Error(`forced failure for ${fileName}`);
    }

    return mockFetchFactory()(url);
  };
}

describe('Obsidian scaffold', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('writes scaffold config, snippets, templates, manifest, and downloaded assets', async () => {
    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, {
      ...mockScaffoldDeps(),
      now: () => new Date('2026-05-03T12:00:00Z'),
    });

    const obsidianDir = path.join(ctx.tempDir, '.obsidian');
    expect(fs.existsSync(path.join(obsidianDir, 'app.json'))).toBe(true);
    expect(fs.existsSync(path.join(obsidianDir, 'appearance.json'))).toBe(true);
    expect(fs.existsSync(path.join(obsidianDir, 'open-zk-kb.json'))).toBe(true);
    expect(fs.existsSync(path.join(obsidianDir, 'snippets', 'zk-dashboard.css'))).toBe(true);
    expect(fs.existsSync(path.join(obsidianDir, 'themes', 'Minimal', 'theme.css'))).toBe(true);
    expect(fs.existsSync(path.join(obsidianDir, 'plugins', 'homepage', 'main.js'))).toBe(true);
    expect(fs.existsSync(path.join(ctx.tempDir, 'templates', 'decision.md'))).toBe(true);

    const appConfig = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'app.json'), 'utf-8'));
    expect(appConfig.defaultViewMode).toBe('preview');

    const appearance = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'appearance.json'), 'utf-8'));
    expect(appearance.cssTheme).toBe('Minimal');
    expect(appearance.enabledCssSnippets).toContain('readonly-kb');

    const plugins = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'community-plugins.json'), 'utf-8'));
    expect(plugins).toContain('homepage');
    expect(plugins).toContain('read-only-view');

    const manifest = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'open-zk-kb.json'), 'utf-8'));
    expect(manifest.scaffoldVersion).toBe(1);
    expect(manifest.plugins.homepage.version).toBe('4.4.0');

    const homepageData = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'plugins', 'homepage', 'data.json'), 'utf-8'));
    expect(homepageData.homepages['Main Homepage'].value).toBe('index');

    const quickAddData = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'plugins', 'quickadd', 'data.json'), 'utf-8'));
    const nestedChoices = quickAddData.choices[0].choices;
    expect(nestedChoices.some((choice: { folder: { folders: string[] } }) => choice.folder.folders[0] === 'general/decisions')).toBe(true);
    expect(nestedChoices.some((choice: { folder: { folders: string[] } }) => choice.folder.folders[0] === 'projects/{{VALUE:project|label:Project name|case:slug}}/decisions')).toBe(true);
    expect(nestedChoices.some((choice: { fileNameFormat: { format: string } }) => choice.fileNameFormat.format === '{{DATE:YYYYMMDDHHmmss}}00-{{VALUE:title|label:Note title|case:slug}}')).toBe(true);
    expect(nestedChoices.some((choice: { fileNameFormat: { format: string } }) => choice.fileNameFormat.format === 'domain')).toBe(true);

    const readOnlyData = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'plugins', 'read-only-view', 'data.json'), 'utf-8'));
    expect(readOnlyData.useGlobPatterns).toBe(true);
    expect(readOnlyData.includeRules).toEqual(['**/*.md']);
  });

  it('respects readOnly=false by omitting read-only plugin defaults', async () => {
    await ensureObsidianScaffold(ctx.tempDir, { ...ctx.config.obsidian, readOnly: false }, {
      ...mockScaffoldDeps(),
    });

    const obsidianDir = path.join(ctx.tempDir, '.obsidian');
    const appConfig = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'app.json'), 'utf-8'));
    expect(appConfig.defaultViewMode).toBe('source');

    const appearance = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'appearance.json'), 'utf-8'));
    expect(appearance.enabledCssSnippets).not.toContain('readonly-kb');

    const plugins = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'community-plugins.json'), 'utf-8'));
    expect(plugins).not.toContain('read-only-view');
  });

  it('merges existing config and remains idempotent on rerun', async () => {
    const obsidianDir = path.join(ctx.tempDir, '.obsidian');
    fs.mkdirSync(obsidianDir, { recursive: true });
    fs.writeFileSync(path.join(obsidianDir, 'app.json'), JSON.stringify({ defaultViewMode: 'source', custom: true }, null, 2));
    fs.writeFileSync(path.join(obsidianDir, 'community-plugins.json'), JSON.stringify(['custom-plugin'], null, 2));

    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, mockScaffoldDeps());
    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, mockScaffoldDeps());

    const appConfig = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'app.json'), 'utf-8'));
    expect(appConfig.defaultViewMode).toBe('preview');
    expect(appConfig.propertiesInDocument).toBe('hidden');
    expect(appConfig.custom).toBe(true);

    const plugins = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'community-plugins.json'), 'utf-8'));
    expect(plugins).toContain('custom-plugin');
    expect(plugins.filter((plugin: string) => plugin === 'homepage')).toHaveLength(1);
  });

  it('applies readOnly=false on rerun after an initial read-only scaffold', async () => {
    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, mockScaffoldDeps());
    await ensureObsidianScaffold(ctx.tempDir, { ...ctx.config.obsidian, readOnly: false }, mockScaffoldDeps());

    const obsidianDir = path.join(ctx.tempDir, '.obsidian');
    const appConfig = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'app.json'), 'utf-8'));
    expect(appConfig.defaultViewMode).toBe('source');

    const appearance = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'appearance.json'), 'utf-8'));
    expect(appearance.enabledCssSnippets).not.toContain('readonly-kb');

    const plugins = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'community-plugins.json'), 'utf-8'));
    expect(plugins).not.toContain('read-only-view');
    expect(fs.existsSync(path.join(obsidianDir, 'snippets', 'readonly-kb.css'))).toBe(false);
  });

  it('preserves existing manifest versions when forced plugin and theme refresh fail', async () => {
    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, mockScaffoldDeps());

    const obsidianDir = path.join(ctx.tempDir, '.obsidian');
    const manifestPath = path.join(obsidianDir, 'open-zk-kb.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.plugins.homepage.version = '0.0.1';
    manifest.theme.version = '0.0.1';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, {
      fetchImpl: selectiveFailureFetchFactory(['main.js', 'theme.css']),
      verifyAssetIntegrity: false,
    });

    const nextManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(nextManifest.plugins.homepage.version).toBe('0.0.1');
    expect(nextManifest.theme.version).toBe('0.0.1');
    expect(fs.existsSync(path.join(obsidianDir, 'plugins', 'homepage', 'main.js'))).toBe(true);
    expect(fs.existsSync(path.join(obsidianDir, 'themes', 'Minimal', 'theme.css'))).toBe(true);
  });

  it('reinstalls managed assets when local files drift from expected digests', async () => {
    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, mockIntegrityDeps());

    const obsidianDir = path.join(ctx.tempDir, '.obsidian');
    const pluginMainPath = path.join(obsidianDir, 'plugins', 'homepage', 'main.js');
    fs.writeFileSync(pluginMainPath, 'tampered', 'utf-8');

    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, mockIntegrityDeps());

    expect(fs.readFileSync(pluginMainPath, 'utf-8')).toBe(MOCK_MAIN_CONTENT);
  });

  it('skips digest-currentness checks when integrity verification is disabled', async () => {
    const deps = mockIntegrityDeps();
    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, deps);

    const obsidianDir = path.join(ctx.tempDir, '.obsidian');
    const pluginMainPath = path.join(obsidianDir, 'plugins', 'homepage', 'main.js');
    fs.writeFileSync(pluginMainPath, 'locally modified but allowed', 'utf-8');

    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, {
      ...deps,
      verifyAssetIntegrity: false,
    });

    expect(fs.readFileSync(pluginMainPath, 'utf-8')).toBe('locally modified but allowed');
  });
});
