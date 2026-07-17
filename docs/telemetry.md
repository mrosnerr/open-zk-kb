# Telemetry

open-zk-kb collects anonymous usage analytics to understand adoption and guide development. This page documents what is collected, why, and how to opt out.

## What we collect

One event per session, reported on the next server startup:

### `session` — reported on next server startup

```json
{
  "event": "session",
  "properties": {
    "client": "claude-code",
    "client_version": "1.0.27",
    "version": "1.3.0",
    "os_platform": "darwin",
    "vault_size": 42,
    "duration_ms": 300000,
    "total_invocations": 8,
    "tool_search": 5,
    "tool_store": 2,
    "tool_maintain": 1,
    "tool_mine": 0,
    "tool_template": 0,
    "models": ["claude-sonnet-4"],
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "$lib": "open-zk-kb",
    "$lib_version": "1.3.0",
    "$lib_env": "production",
    "$geoip_disable": true
  }
}
```

| Property | Type | Purpose |
|---|---|---|
| `client` | string | Which MCP harness launched the server (e.g. claude-code, cursor) |
| `client_version` | string \| null | Version of the MCP client |
| `version` | string | Which open-zk-kb version is deployed |
| `os_platform` | string | Platform (darwin, linux, win32) |
| `vault_size` | number | Total notes in the vault at session start |
| `duration_ms` | number \| null | Session length in milliseconds (null if not cleanly ended) |
| `total_invocations` | number | Total tool calls in the session |
| `tool_search` | number | Number of search calls |
| `tool_store` | number | Number of store calls |
| `tool_maintain` | number | Number of maintain calls |
| `tool_mine` | number | Number of mine calls |
| `tool_template` | number | Number of template calls |
| `models` | string[] | Distinct model IDs seen during the session |
| `session_id` | string | Random UUID for dedup/debugging (not linkable to user identity) |

### Metadata on all events

| Property | Purpose |
|---|---|
| `$lib` | Always `"open-zk-kb"` |
| `$lib_version` | Package version |
| `$lib_env` | `"dev"` (git checkout) or `"production"` (npm install) |
| `$geoip_disable` | Prevents PostHog from enriching events with geographic data |

## What we don't collect

- Note content, titles, or slugs
- Search queries
- File paths or project names
- Machine hostnames or IP addresses
- User names or email addresses
- Geographic location (GeoIP enrichment is explicitly disabled)
- Model names or AI provider information
- Session IDs are random UUIDs — not linkable to any user identity beyond the anonymous `telemetry.id`

## How to opt out

**Config file** — set `share: false` in `~/.config/open-zk-kb/config.yaml`:

```yaml
telemetry:
  enabled: true   # local SQLite counters (never leaves your machine)
  share: false     # disable anonymous analytics
```

**Install flag** — pass `--no-telemetry` during installation:

```bash
bunx open-zk-kb@latest --no-telemetry
```

**Environment variable** — set `DO_NOT_TRACK=1` ([consoledonottrack.com](https://consoledonottrack.com)):

```bash
export DO_NOT_TRACK=1
```

Note: an explicit `share: true` in config takes precedence over `DO_NOT_TRACK=1`. The config file is a deliberate per-app choice; the env var is a blanket default. To stop sharing, set `share: false`.

## How it works

- Session metadata (client, start time, vault size) and tool usage are recorded locally to SQLite during each session.
- On the next server startup, unreported sessions are sent to PostHog as one `session` event per session in a single batch POST (fire-and-forget, non-blocking).
- At most 1 outbound connection per startup. At most 50 unreported sessions per batch.
- If the network is unavailable or PostHog doesn't respond within 5 seconds, the event is silently dropped and retried on the next startup.
- Shutdown only writes the session end timestamp to SQLite locally — no network calls at shutdown.
- A random UUID is generated and stored in `config.yaml` as `telemetry.id`. Delete it to reset your identity.

## How to verify

All sharing logic lives in [`src/analytics.ts`](../src/analytics.ts).

- `grep -rn 'reportPreviousSessions' src/` to find the reporting call site
- Local telemetry (unrelated to sharing) is in SQLite: `SELECT * FROM tool_telemetry ORDER BY id DESC LIMIT 20;`
- Session tracking: `SELECT * FROM sessions ORDER BY started_at DESC LIMIT 10;`

## Data handling

- **Provider**: [PostHog](https://posthog.com) (EU Cloud)
- **API key**: Write-only ingest key shipped in source. Cannot read data.
- **Access**: Only the project maintainer can view the dashboard.
