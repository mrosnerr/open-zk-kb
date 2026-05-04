import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';
import { ensureObsidianScaffold } from '../src/obsidian-scaffold.js';

function mockFetchFactory() {
  return async (url: string | URL | Request): Promise<Response> => {
    const urlString = String(url);
    const fileName = urlString.split('/').pop() || 'asset.txt';

    if (fileName === 'manifest.json') {
      return new Response(JSON.stringify({ name: 'Mock', id: 'mock', version: '1.0.0' }), { status: 200 });
    }
    if (fileName === 'theme.css' || fileName === 'styles.css') {
      return new Response('body { color: var(--text-normal); }', { status: 200 });
    }
    if (fileName === 'main.js') {
      return new Response('module.exports = {};', { status: 200 });
    }

    return new Response('ok', { status: 200 });
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
      fetchImpl: mockFetchFactory(),
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

    const readOnlyData = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'plugins', 'read-only-view', 'data.json'), 'utf-8'));
    expect(readOnlyData.useGlobPatterns).toBe(true);
    expect(readOnlyData.includeRules).toEqual(['**/*.md']);
  });

  it('respects readOnly=false by omitting read-only plugin defaults', async () => {
    await ensureObsidianScaffold(ctx.tempDir, { ...ctx.config.obsidian, readOnly: false }, {
      fetchImpl: mockFetchFactory(),
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

    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, { fetchImpl: mockFetchFactory() });
    await ensureObsidianScaffold(ctx.tempDir, ctx.config.obsidian, { fetchImpl: mockFetchFactory() });

    const appConfig = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'app.json'), 'utf-8'));
    expect(appConfig.defaultViewMode).toBe('source');
    expect(appConfig.propertiesInDocument).toBe('hidden');
    expect(appConfig.custom).toBe(true);

    const plugins = JSON.parse(fs.readFileSync(path.join(obsidianDir, 'community-plugins.json'), 'utf-8'));
    expect(plugins).toContain('custom-plugin');
    expect(plugins.filter((plugin: string) => plugin === 'homepage')).toHaveLength(1);
  });
});
