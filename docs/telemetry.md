# Telemetry

open-zk-kb can collect anonymous usage analytics to understand adoption and guide development. Runtime configuration defaults remain disabled, and both `telemetry.enabled` and `telemetry.share` must be `true` to send data. During an interactive installation, open-zk-kb asks for consent with **Yes** preselected and writes those settings only after affirmative confirmation and a successful installation. Choosing No, cancelling, using `--no-telemetry`, `--yes`, or installing non-interactively leaves sharing disabled. Direct package installs that bypass the installer also remain disabled unless configured separately.

## What we collect

When sharing is enabled, each completed session is reported as one `session` event on a later server startup. The top-level `distinct_id` comes from `telemetry.id`; the event `timestamp` is the session start time.

```json
{
  "event": "session",
  "properties": {
    "client": "claude-code",
    "client_version": "1.0.27",
    "version": "1.4.4",
    "os_platform": "darwin",
    "vault_size": 42,
    "duration_ms": 300000,
    "total_invocations": 10,
    "tool_store": 1,
    "tool_ingest": 1,
    "tool_search": 1,
    "tool_context": 1,
    "tool_open": 1,
    "tool_get": 1,
    "tool_health": 1,
    "tool_maintain": 1,
    "tool_mine": 1,
    "tool_template": 1,
    "models": ["claude"],
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "$lib": "open-zk-kb",
    "$lib_version": "1.4.4",
    "$lib_env": "production",
    "$geoip_disable": true
  }
}
```

| Property | Type | Purpose |
|---|---|---|
| `client` | enum | Canonical client: `pi`, `claude-code`, `opencode`, `cursor`, `windsurf`, `zed`, `omp`, or `other` |
| `client_version` | string \| null | MCP client version, when supplied |
| `version` | string | Deployed open-zk-kb version |
| `os_platform` | enum | `darwin`, `linux`, or `win32` |
| `vault_size` | number | Note count at session start |
| `duration_ms` | number | Completed session duration |
| `total_invocations` | number | Sum of all ten canonical tool counters |
| `tool_store` | number | `knowledge-store` calls |
| `tool_ingest` | number | `knowledge-ingest` calls |
| `tool_search` | number | `knowledge-search` calls |
| `tool_context` | number | `knowledge-context` calls |
| `tool_open` | number | `knowledge-open` calls |
| `tool_get` | number | `knowledge-get` calls |
| `tool_health` | number | `knowledge-health` calls |
| `tool_maintain` | number | `knowledge-maintain` calls |
| `tool_mine` | number | `knowledge-mine` calls |
| `tool_template` | number | `knowledge-template` calls |
| `models` | string[] | Distinct normalized model-family buckets observed during successful calls |
| `session_id` | string | Random session UUID for deduplication and debugging |
| `$lib` | string | Always `open-zk-kb` |
| `$lib_version` | string | Package version |
| `$lib_env` | enum | `dev` (source checkout), `test` (explicit synthetic validation), or `production` (installed package) |
| `$geoip_disable` | boolean | Always `true`; disables geographic enrichment |

Known runtime aliases are normalized to the canonical client vocabulary; unknown or malformed names become `other`, and raw client names are not shared. Models are reported only as family buckets, not model identifiers. Recognized model identifiers discard provider, deployment, and variant details (for example, Claude variants become `claude` and `chatgpt-*` becomes `gpt`); unrecognized or malformed identifiers are shared only as `other`; raw identifiers are never shared. For adoption analysis, filter to `$lib_env = "production"`; manual synthetic validation must use `$lib_env = "test"` even when run from a packaged install.

## Analysis boundaries

- `telemetry.id` is a random, deletable installation identifier. It can be reset or shared by multiple installations, so distinct IDs estimate **approximate installations**, not people or user accounts.
- The event timestamp represents session activity. PostHog may ingest it much later because delivery waits for a subsequent startup; a final session may never be delivered if open-zk-kb is never started again.
- A zero-invocation session can distinguish launch-only sessions from active tool use only for releases where all ten canonical tools are completely instrumented. Earlier zero counts must not be interpreted that way.

## What we don't collect

- Note content or metadata, including titles and slugs
- Search queries or tool arguments
- File paths or project names
- Machine hostnames or account identifiers such as names and email addresses
- Raw or custom client names
- IP addresses in event payloads or geographic fields. `$geoip_disable: true` disables enrichment, and the PostHog project discards client IP data; as with any HTTP endpoint, its infrastructure may transiently observe the source IP while processing a request

## How to opt out

Set both flags to `false` in `~/.config/open-zk-kb/config.yaml`:

```yaml
telemetry:
  enabled: false
  share: false
```

You can also pass `--no-telemetry` during installation or set `DO_NOT_TRACK=1`:

```bash
bunx open-zk-kb@latest --no-telemetry
export DO_NOT_TRACK=1
```

`DO_NOT_TRACK=1` is unconditional: no PostHog request occurs even when both config flags are `true`. Local SQLite counters are unaffected by this environment setting.

## How it works

- With local telemetry enabled, session boundaries and successful canonical tool calls are recorded in SQLite.
- Ending a session writes its end timestamp locally. Tool handling and shutdown make zero PostHog requests.
- A later startup atomically claims up to 50 completed, unreported prior sessions and sends one batch containing one `session` event for each. The current and incomplete sessions are excluded.
- A successful response marks the claimed sessions reported. A network failure, timeout after five seconds, or non-success response releases them for retry on another startup.
- At most one outbound PostHog request is attempted per startup.
- `telemetry.id` is generated in `config.yaml`; delete it to reset the approximate installation identifier.

## How to verify

Production payload construction and PostHog access are confined to [`src/analytics.ts`](../src/analytics.ts).

- Search source for the PostHog host and `fetch(` to audit call sites.
- Inspect local calls: `SELECT * FROM tool_telemetry ORDER BY id DESC LIMIT 20;`
- Inspect sessions: `SELECT * FROM sessions ORDER BY started_at DESC LIMIT 10;`
- Review analytics payload allowlist tests for the exact shared property boundary.

## Data handling

- **Provider**: [PostHog](https://posthog.com) (EU Cloud)
- **API key**: Write-only ingest key shipped in source; it cannot read project data
- **Access**: Only the project maintainer can view the dashboard
