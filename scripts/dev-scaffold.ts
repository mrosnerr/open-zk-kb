#!/usr/bin/env bun

import { execSync } from 'child_process';
import { existsSync } from 'fs';

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const skipBuild = args.has('--no-build');

if (process.env.CI) {
  console.log('⏭️  Dev scaffold skipped (CI environment)');
  process.exit(0);
}

if (!skipBuild) {
  console.log('⚙️  Building...');
  try {
    execSync('bun run build', { cwd: import.meta.dirname + '/..', stdio: 'inherit' });
  } catch {
    console.error('❌ Build failed');
    process.exit(1);
  }
  console.log('✅ Build complete\n');
}

const { getConfig } = await import('../dist/config.js');
const { ensureObsidianScaffold, getObsidianScaffoldStatus } = await import('../dist/obsidian-scaffold.js');
const { handleMaintain } = await import('../dist/tool-handlers.js');
const { createNoteRepository } = await import('../dist/storage/NoteRepository.js');

const config = getConfig();
const vaultPath = config.vault;

if (!vaultPath || !existsSync(vaultPath)) {
  console.log('⏭️  Dev scaffold skipped (no vault configured or vault not found)');
  process.exit(0);
}

console.log(`📂 Vault: ${vaultPath}\n`);

if (statusOnly) {
  const status = getObsidianScaffoldStatus(vaultPath, config.obsidian);
  console.log('📊 Scaffold Status:');
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

console.log('🔨 Running scaffold...');
const manifest = await ensureObsidianScaffold(vaultPath, config.obsidian);

if (!manifest) {
  console.log('⏭️  Scaffold skipped (disabled in config)');
} else {
  console.log('✅ Scaffold complete');
  console.log(`   Version: ${manifest.scaffoldVersion}`);
  console.log(`   Plugins: ${Object.keys(manifest.plugins).length}`);
  console.log(`   Theme: ${manifest.theme?.name ?? 'none'} ${manifest.theme?.version ?? ''}`);
  console.log(`   Last upgrade: ${manifest.lastUpgrade}`);
}

console.log('\n📄 Rebuilding indexes...');
const repo = createNoteRepository(vaultPath);
try {
  const result = await handleMaintain({ action: 'rebuild' }, repo, config);
  console.log(`✅ ${result}`);
} finally {
  repo.close();
}
