# Performance and Resilience

Benchmarks from a MacBook Pro M3 Max with 36GB RAM, 439-note knowledge base, MiniLM-L6-v2 embeddings enabled. Numbers are wall-clock latency measured at the MCP client boundary (including JSON-RPC serialization and HTTP transport).

## Tool Latency

Measured against the shared HTTP server (`open-zk-kb serve`) at steady state.

| Tool | Typical | What it does |
|---|---|---|
| `knowledge-get` | 9ms | Single note by ID. File read + frontmatter parse. |
| `knowledge-search` | 14ms | FTS5 query + embedding cosine similarity + re-rank. |
| `knowledge-store` | 20ms | Write markdown file + SQLite insert + FTS5 update + embedding generation. |
| `knowledge-context` | 10ms | Read project index + recent log entries. |
| `knowledge-template` | 10ms | Return template for a note kind. |
| `tools/list` | 11ms | MCP tool registration (no DB). Useful as a health baseline. |

Embedding generation adds ~5ms to store (MiniLM-L6-v2, quantized q8, WASM backend). Search embedding is generated on the query side and adds ~5ms. Both are fast enough to be invisible in the tool response.

These latencies scale with note count for FTS5 and embedding search. At 439 notes the index fits comfortably in SQLite's page cache. For larger vaults (10k+ notes), FTS5 remains fast (it's an inverted index), but embedding search is a linear scan over cosine similarity. Consider an approximate nearest-neighbor index if search latency becomes a concern at that scale.

## Memory

The shared HTTP server architecture (`open-zk-kb serve` + stdio bridges) trades a small amount of complexity for significant memory savings when multiple AI sessions are active simultaneously.

### Per-process footprint

| Process type | Physical footprint | Dirty (private) | What it loads |
|---|---|---|---|
| **HTTP server** | 154 MB | 154 MB | NoteRepository + SQLite + FTS5 + ONNX Runtime + MiniLM-L6-v2 model + MCP SDK |
| **Stdio bridge** | 21 MB | 4-10 MB | Bun runtime + JSON-RPC forwarding. No SQLite, no ONNX. |

### Breakdown of the HTTP server (154 MB)

| Component | Dirty memory | Notes |
|---|---|---|
| ONNX Runtime + model weights | ~52 MB | MiniLM-L6-v2 is 23 MB on disk, expands in ONNX inference buffers. |
| App heap (SQLite, FTS5, MCP SDK) | ~49 MB | Includes SQLite page cache, FTS5 inverted index, tool handler state. |
| Bun runtime (__TEXT, shared COW) | ~22 MB | Shared via copy-on-write with bridge processes. |
| Stacks + other | ~31 MB | 22 threads (MCP handlers, ONNX inference pool). |

### Scaling with sessions

| Active sessions | In-process (no sharing) | Shared HTTP server |
|---|---|---|
| 1 | 154 MB | 154 MB (no bridges yet) |
| 3 | 462 MB | 196 MB (1 server + 2 bridges) |
| 5 | 770 MB | 238 MB (1 server + 4 bridges) |
| 8 | 1,232 MB | 295 MB (1 server + 7 bridges) |

Bridge processes share the Bun runtime's __TEXT pages via COW. The kernel stores one copy regardless of bridge count. The "true unique" memory for 8 processes is ~210 MB (vs. the naive 302 MB sum of per-process footprints).

## Startup and Cold Paths

| Event | Latency | What happens |
|---|---|---|
| **Bridge startup (hot server)** | <100ms | Read state file, probe `/health`, enter forwarding loop. No heavy imports. |
| **HTTP server startup** | ~500ms | `Bun.serve()` + SQLite open + schema check + state file write. |
| **ONNX model first load** | 2-3s | Downloads model to `~/.cache/open-zk-kb/models/` on first run. Async, doesn't block requests. |
| **ONNX model warm (cached)** | ~200ms | Loads from disk cache into ONNX Runtime. Background, non-blocking. |
| **Bridge recovery (server dead)** | ~116ms | Dynamic import of MCP server stack + first in-process request. One-time cost. |

The ONNX model warm-up is fire-and-forget. Until it completes, search falls back to FTS5-only (still returns results, just without semantic re-ranking).

## Resilience Model

The server uses a single-machine, multi-process architecture. One shared HTTP server handles all MCP traffic; lightweight stdio bridges forward requests from individual client sessions.

### Recovery chain

When the shared HTTP server becomes unreachable, each bridge independently executes a recovery chain. Every step is attempted before returning an error to the calling agent.

```text
Forward request to shared HTTP server
  |
  +--> Success? Done (normal path, ~17ms)
  |
  +--> Fail? Immediate retry (handles transient glitches, ~1ms)
         |
         +--> Success? Done
         |
         +--> Fail? Re-read state file + probe (handles server restart, ~10ms)
                |
                +--> Found healthy server? Reconnect + retry. Done.
                |
                +--> No server? Process locally (~116ms first time, ~17ms after)
                       |
                       +--> Also start HTTP server in background for other bridges
```

### Failure modes and mitigations

| Failure | What happens | User-visible impact |
|---|---|---|
| Shared server crashes | Bridges detect on next request, process locally, start background HTTP server. | ~116ms one-time latency on the triggering request. No errors. |
| Shared server restart (rebuild) | Bridges detect new state file on next request, reconnect. | ~10ms extra latency on the triggering request. No errors. |
| Transient network glitch | Immediate retry succeeds. | ~1ms extra latency. No errors. |
| Multiple bridges lose server simultaneously | Each independently processes locally via SQLite WAL. One starts background HTTP, others reconnect to it. | ~116ms one-time per bridge. No errors. |
| Unhandled exception in tool handler | HTTP server catches at request level, returns JSON-RPC error. Server stays alive. | Tool-level error returned (expected behavior). Server survives. |
| Uncaught exception / unhandled rejection | HTTP server logs and continues (registered handlers). | No impact on other requests. |

### Graceful shutdown

On SIGINT/SIGTERM, the HTTP server:

1. Removes the state file (prevents new bridges from connecting)
2. Stops accepting new connections
3. Waits up to 5 seconds for in-flight requests to complete
4. Force-closes any remaining transports
5. Cleans up SQLite and exits

### Design principles

- **Server computes, agent judges.** The server owns storage, indexing, and recovery. The agent owns intent and relevance. Recovery is transparent to the agent.
- **No external supervision required.** The system self-organizes: the first process becomes the master, bridges discover it, and any bridge can promote itself if the master dies. No launchd, systemd, or process managers needed.
- **Availability over memory.** When the shared server is unavailable, bridges independently load the full MCP server stack (~154 MB each). Multiple bridges serving simultaneously is preferred over any bridge returning errors.
- **SQLite WAL enables concurrency.** Multiple processes can safely read and write the same database. WAL mode allows concurrent readers with a single writer. `SQLITE_BUSY` retries (3 attempts, 50ms backoff) handle contention.

## Embedding Performance

Local embeddings use MiniLM-L6-v2 via `@huggingface/transformers` (ONNX Runtime, WASM backend).

| Operation | Latency | Notes |
|---|---|---|
| Generate embedding (single note) | ~5ms | 384-dimensional vector. Included in store latency. |
| Cosine similarity (439 notes) | ~1ms | Linear scan. Dominates at large vault sizes. |
| Search total (FTS5 + embedding re-rank) | ~14ms | FTS5 finds candidates, embeddings re-rank top results. |
| Model cold load (first ever) | 2-3s | Downloads ~23 MB model. One-time. |
| Model warm load (from cache) | ~200ms | Loads ONNX session from disk. Background on startup. |

The embedding model runs in the same process as the MCP server. No external API calls, no network latency, no API keys required. Override with an OpenAI-compatible API via `config.yaml` if preferred.
