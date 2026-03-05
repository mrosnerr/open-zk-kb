#!/usr/bin/env bun

import { NoteRepository } from '../src/storage/NoteRepository.js';
import * as fs from 'fs';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: bun scripts/rebuild-db.ts <vault-path>');
  console.error('Example: bun scripts/rebuild-db.ts ~/.local/share/open-zk-kb');
  process.exit(1);
}

const vaultPath = args[0].replace(/^~/, process.env.HOME || '~');

if (!fs.existsSync(vaultPath)) {
  console.error(`❌ Vault not found: ${vaultPath}`);
  process.exit(1);
}

const mdFiles = fs.readdirSync(vaultPath).filter(f => f.endsWith('.md'));
console.log(`\n🔧 Rebuilding database for vault: ${vaultPath}`);
console.log(`   Found ${mdFiles.length} markdown files\n`);

try {
  const repo = new NoteRepository(vaultPath);
  const result = repo.rebuildFromFiles();

  const embStats = repo.getEmbeddingStats();
  console.log(`✅ Rebuild complete: ${result.indexed} notes indexed, ${result.errors} errors`);
  console.log(`📊 Embeddings: ${embStats.withEmbedding}/${embStats.total} notes have embeddings`);
  if (embStats.withoutEmbedding > 0) {
    console.log(`💡 Run 'knowledge-maintain embed' to generate embeddings for ${embStats.withoutEmbedding} notes`);
  }
  repo.close();
  console.log('\n✨ Done!\n');
} catch (error) {
  console.error('❌ Rebuild failed:', error);
  process.exit(1);
}
