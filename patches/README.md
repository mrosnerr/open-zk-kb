# Patches

Runtime patches applied via `patch-package` to dependencies that assume a Node.js environment with native addon support.

## `@huggingface+transformers.patch`

`@huggingface/transformers` ships with hard dependencies on native Node.js C++ addons that don't work under Bun. This patch swaps them for portable alternatives:

| What | Problem | Fix |
|------|---------|-----|
| `onnxruntime-node` | Native C++ addon; Bun can't load it | Stubbed out, forced to WASM backend via `onnxruntime-web` |
| `sharp` | Native C++ image processing library | Stubbed out — only text embeddings (MiniLM-L6-v2) are needed, not image processing |
| `apis.IS_NODE_ENV` file paths | Model loader uses Node-specific filesystem paths | Forced to `false` so fetch/buffer paths are used instead |

Without this patch, the server crashes on import when running under Bun.
