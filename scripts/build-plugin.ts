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
const SOURCE_SKILLS = path.join(ROOT, 'skill-templates', 'open-zk-kb');
const ENTRYPOINT = path.join(ROOT, 'src', 'mcp-server.ts');
const TRANSFORMERS_PATCH = path.join(ROOT, 'patches', '@huggingface+transformers.patch');
const TRANSFORMERS_ONNX = path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'src', 'backends', 'onnx.js');
const TRANSFORMERS_IMAGE = path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'src', 'utils', 'image.js');
const TRANSFORMERS_MODEL_LOADER = path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'src', 'utils', 'model-loader.js');
const TRANSFORMERS_DIST = path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
const PATCHED_TRANSFORMERS_FILES = [TRANSFORMERS_ONNX, TRANSFORMERS_IMAGE, TRANSFORMERS_MODEL_LOADER, TRANSFORMERS_DIST];

function cleanupPatchArtifacts(): void {
  for (const file of PATCHED_TRANSFORMERS_FILES) {
    fs.rmSync(`${file}.orig`, { force: true });
    fs.rmSync(`${file}.rej`, { force: true });
  }
}

function isTransformersPatchApplied(): boolean {
  if (
    !fs.existsSync(TRANSFORMERS_ONNX)
    || !fs.existsSync(TRANSFORMERS_IMAGE)
    || !fs.existsSync(TRANSFORMERS_MODEL_LOADER)
    || !fs.existsSync(TRANSFORMERS_DIST)
  ) {
    return false;
  }

  const onnxSource = fs.readFileSync(TRANSFORMERS_ONNX, 'utf-8');
  const imageSource = fs.readFileSync(TRANSFORMERS_IMAGE, 'utf-8');
  const modelLoaderSource = fs.readFileSync(TRANSFORMERS_MODEL_LOADER, 'utf-8');
  const distSource = fs.readFileSync(TRANSFORMERS_DIST, 'utf-8');
  return onnxSource.includes('const ONNX_NODE = undefined;')
    && imageSource.includes('Image processing is unavailable in this build.')
    && modelLoaderSource.includes('getModelFile(pretrained_model_name_or_path, fullPath, true, options, false)')
    && modelLoaderSource.includes('const return_path = false;')
    && distSource.includes('const ONNX_NODE = undefined;')
    && distSource.includes('ONNX = ort_webgpu_bundle_min_exports;')
    && distSource.includes('Image processing is unavailable in this build.')
    && distSource.includes('getModelFile(pretrained_model_name_or_path, fullPath, true, options, false)')
    && distSource.includes('const return_path = false;');
}

function runPatch(reverse = false): void {
  const args = reverse
    ? ['-R', '-p1', '-i', TRANSFORMERS_PATCH]
    : ['-p1', '-i', TRANSFORMERS_PATCH];
  const result = Bun.spawnSync({
    cmd: ['patch', ...args],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Failed to ${reverse ? 'reverse' : 'apply'} Transformers patch: ${stderr || stdout}`);
  }

  cleanupPatchArtifacts();
}

function applyTransformersPatch(): boolean {
  if (isTransformersPatchApplied()) {
    console.log('  Transformers patch already applied');
    return false;
  }

  console.log('  Applying Transformers WASM patch...');
  try {
    runPatch();
    return true;
  } catch (error) {
    try {
      runPatch(true);
    } catch (restoreError) {
      console.error(`Failed to restore Transformers source after patch failure: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
    }
    throw error;
  }
}

async function main() {
  // Get version from package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const version = pkg.version;
  const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (typeof version !== 'string' || !semverRe.test(version)) {
    console.error(`Invalid or missing version in package.json: ${version}`);
    process.exit(1);
  }

  console.log(`Building open-zk-kb v${version} for Claude Code plugin...\n`);
  let shouldRestoreTransformers = false;

  let completedSuccessfully = false;
  try {
    shouldRestoreTransformers = applyTransformersPatch();

    // Ensure plugin/bin directory exists
    fs.mkdirSync(PLUGIN_BIN, { recursive: true });

    // Build for each target
    for (const { target, output } of TARGETS) {
      const outfile = path.join(PLUGIN_BIN, output);
      console.log(`  Building ${target}...`);

      try {
        const defineArg = `__PKG_VERSION__="${version}"`;
        await $`bun build --compile --target=${target} --define ${defineArg} --external onnxruntime-node --external sharp ${ENTRYPOINT} --outfile ${outfile}`.quiet();

        const stats = fs.statSync(outfile);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        console.log(`    ✓ ${output} (${sizeMB} MB)`);
      } catch (error) {
        throw new Error(`Failed to build ${target}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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
    completedSuccessfully = true;
  } finally {
    if (shouldRestoreTransformers) {
      try {
        console.log('\n  Restoring Transformers source...');
        runPatch(true);
      } catch (restoreError) {
        console.error('Failed to restore Transformers source:', restoreError);
        if (completedSuccessfully) {
          process.exitCode = 1;
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
