#!/usr/bin/env bun
// scripts/build-plugin.ts - Build cross-platform binaries for Claude Code plugin
// Usage: bun run scripts/build-plugin.ts

import { $ } from 'bun';
import * as fs from 'fs';
import * as path from 'path';

const TARGETS = [
  { target: 'bun-darwin-arm64', output: 'open-zk-kb-darwin-arm64' },
  { target: 'bun-darwin-x64', output: 'open-zk-kb-darwin-x64' },
  { target: 'bun-linux-x64', output: 'open-zk-kb-linux-x64' },
  { target: 'bun-linux-arm64', output: 'open-zk-kb-linux-arm64' },
  { target: 'bun-windows-x64', output: 'open-zk-kb-windows-x64.exe' },
];

const ROOT = path.resolve(import.meta.dir, '..');
const PLUGIN_DIR = path.join(ROOT, 'plugin');
const PLUGIN_BIN = path.join(PLUGIN_DIR, 'bin');
const PLUGIN_SKILLS = path.join(PLUGIN_DIR, 'skills', 'open-zk-kb');
const SOURCE_SKILLS = path.join(ROOT, 'skills', 'open-zk-kb');
const ENTRYPOINT = path.join(ROOT, 'src', 'mcp-server.ts');

async function main() {
  // Get version from package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const version = pkg.version;
  
  console.log(`Building open-zk-kb v${version} for Claude Code plugin...\n`);

  // Ensure plugin/bin directory exists
  fs.mkdirSync(PLUGIN_BIN, { recursive: true });

  // Build for each target
  for (const { target, output } of TARGETS) {
    const outfile = path.join(PLUGIN_BIN, output);
    console.log(`  Building ${target}...`);
    
    try {
      const defineArg = `__PKG_VERSION__="${version}"`;
      await $`bun build --compile --target=${target} --define ${defineArg} ${ENTRYPOINT} --outfile ${outfile}`.quiet();
      
      const stats = fs.statSync(outfile);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      console.log(`    ✓ ${output} (${sizeMB} MB)`);
    } catch (error) {
      console.error(`    ✗ Failed to build ${target}:`, error);
      process.exit(1);
    }
  }

  // Update plugin.json version
  const pluginJsonPath = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
  pluginJson.version = version;
  fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n');
  console.log(`\n  Updated plugin.json version to ${version}`);

  // Copy skills from source to plugin (clean first to remove stale files)
  console.log('\n  Copying skills...');
  fs.rmSync(PLUGIN_SKILLS, { recursive: true, force: true });
  fs.cpSync(SOURCE_SKILLS, PLUGIN_SKILLS, { recursive: true });
  for (const file of fs.readdirSync(PLUGIN_SKILLS)) {
    console.log(`    ✓ ${file}`);
  }

  console.log('\n✓ Plugin build complete!');
  console.log(`  Binaries: ${PLUGIN_BIN}`);
  console.log(`  Skills: ${PLUGIN_SKILLS}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
