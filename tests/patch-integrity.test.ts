/**
 * Validates that the @huggingface/transformers patch was applied correctly.
 *
 * The patch removes onnxruntime-node, sharp, and Node-specific filesystem
 * paths so the plugin can bundle a portable WASM-only binary.
 *
 * If these tests fail, the patch file needs regenerating for the current
 * @huggingface/transformers version. Pin the exact version in package.json
 * and rebuild the patch against the new dist bundle.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const TRANSFORMERS_DIR = join(import.meta.dir, '..', 'node_modules', '@huggingface', 'transformers');

function readTransformersFile(relativePath: string): string {
  return readFileSync(join(TRANSFORMERS_DIR, relativePath), 'utf-8');
}

describe('Transformers patch integrity', () => {
  describe('source files', () => {
    it('onnx.js: removes onnxruntime-node import', () => {
      const content = readTransformersFile('src/backends/onnx.js');
      expect(content).toContain('const ONNX_NODE = undefined;');
      expect(content).not.toContain("import * as ONNX_NODE from 'onnxruntime-node'");
    });

    it('image.js: replaces sharp with stub', () => {
      const content = readTransformersFile('src/utils/image.js');
      expect(content).toContain('const sharp = undefined;');
      expect(content).toContain('Image processing is unavailable in this build.');
    });

    it('model-loader.js: disables Node filesystem paths', () => {
      const content = readTransformersFile('src/utils/model-loader.js');
      expect(content).toContain('getModelFile(pretrained_model_name_or_path, fullPath, true, options, false)');
      expect(content).toContain('const return_path = false;');
    });
  });

  describe('dist bundle', () => {
    it('removes onnxruntime-node import', () => {
      const content = readTransformersFile('dist/transformers.node.mjs');
      expect(content).toContain('const ONNX_NODE = undefined;');
      expect(content).not.toContain('import * as ONNX_NODE from "onnxruntime-node"');
    });

    it('uses WASM runtime instead of native ONNX', () => {
      const content = readTransformersFile('dist/transformers.node.mjs');
      expect(content).toContain('ONNX = ort_webgpu_bundle_min_exports;');
    });

    it('replaces sharp with stub', () => {
      const content = readTransformersFile('dist/transformers.node.mjs');
      expect(content).toContain('const sharp = undefined;');
      expect(content).toContain('Image processing is unavailable in this build.');
    });

    it('disables Node filesystem paths', () => {
      const content = readTransformersFile('dist/transformers.node.mjs');
      expect(content).toContain('getModelFile(pretrained_model_name_or_path, fullPath, true, options, false)');
      expect(content).toContain('const return_path = false;');
    });
  });

  it('installed version matches pinned version', () => {
    const pkg = JSON.parse(readFileSync(join(TRANSFORMERS_DIR, 'package.json'), 'utf-8'));
    const rootPkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'));
    const pinned = rootPkg.dependencies['@huggingface/transformers'];
    // Pinned version should be exact (no ^ or ~)
    expect(pinned).not.toStartWith('^');
    expect(pinned).not.toStartWith('~');
    expect(pkg.version).toBe(pinned);
  });
});
