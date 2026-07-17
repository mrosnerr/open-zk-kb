/**
 * Anonymous usage analytics via PostHog.
 *
 * ALL sharing logic lives in this single file for auditability.
 * Events contain no PII — only aggregate counts, enumerated types, and anonymous IDs.
 *
 * Network calls happen at exactly one point:
 *   On server startup, reporting previous sessions' telemetry from SQLite.
 *
 * One event per session: a single `session` event with flattened properties.
 * No in-memory buffering. No shutdown flushes. All data is persisted locally
 * in SQLite first, then reported on the next startup (fire-and-forget).
 *
 * See docs/telemetry.md for full details.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { getConfig, getConfigPath, isTelemetryShareConfigured } from './config.js';
import type { UnreportedSession } from './storage/NoteRepository.js';

// ── PostHog Constants ──

const POSTHOG_HOST = 'https://eu.i.posthog.com';
const POSTHOG_API_KEY = 'phc_BjczNc5sPmdexNVK4xnKPrfrukpYsuJXWzYkhbHh6Hs9';

// Read version from package.json at module load time
const LIB_VERSION = (() => {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version as string;
  } catch {
    return 'unknown';
  }
})();

/** 'dev' when running from a git checkout, 'production' for npm installs. */
const LIB_ENV = (() => {
  try {
    const gitDir = new URL('../.git', import.meta.url);
    return fs.existsSync(gitDir) ? 'dev' : 'production';
  } catch {
    return 'production';
  }
})();

// ── Event Types ──

export interface SessionProperties {
  // Dimensions
  client: string;
  client_version: string | null;
  version: string;
  os_platform: string;
  // Metrics
  vault_size: number;
  duration_ms: number | null;
  total_invocations: number;
  tool_search: number;
  tool_store: number;
  tool_maintain: number;
  tool_mine: number;
  tool_template: number;
  // Correlation
  session_id: string;
}

export interface AnalyticsEvent {
  event: 'session';
  properties: SessionProperties;
}

// ── Sharing Guards ──

export function isSharingEnabled(): boolean {
  const config = getConfig();
  if (!config.telemetry.enabled || !config.telemetry.share) return false;

  // If the user explicitly set share: true in config, honor that choice
  // even when DO_NOT_TRACK=1 is set globally in their shell.
  // If share was never explicitly configured (defaulted), respect DO_NOT_TRACK.
  if (process.env.DO_NOT_TRACK === '1' && !isTelemetryShareConfigured()) return false;

  return true;
}

// ── Analytics ID ──

export function getOrCreateAnalyticsId(): string {
  const config = getConfig();
  if (config.telemetry.id) return config.telemetry.id;

  const id = crypto.randomUUID();

  // Persist to config.yaml
  try {
    let doc: Record<string, unknown> = {};
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = YAML.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    }
    // Ensure telemetry is an object (could be a scalar like `telemetry: false`)
    const existing = doc.telemetry;
    const telemetry = (existing && typeof existing === 'object' && !Array.isArray(existing))
      ? existing as Record<string, unknown>
      : {};
    telemetry.id = id;
    doc.telemetry = telemetry;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, YAML.stringify(doc), 'utf-8');
  } catch {
    // Silent failure — ID is still usable for this session
  }

  return id;
}

// ── PostHog Payload Helpers ──

function makePayload(event: AnalyticsEvent, distinctId: string, timestamp?: string): Record<string, unknown> {
  return {
    api_key: POSTHOG_API_KEY,
    event: event.event,
    distinct_id: distinctId,
    ...(timestamp ? { timestamp } : {}),
    properties: {
      ...event.properties,
      $lib: 'open-zk-kb',
      $lib_version: LIB_VERSION,
      $lib_env: LIB_ENV,
      $geoip_disable: true,
    },
  };
}

// ── Public API ──

/**
 * Report previous sessions' telemetry to PostHog.
 * Called on server startup (fire-and-forget). Queries unreported sessions
 * from SQLite, sends a single batch POST, marks them reported on success.
 *
 * One `session` event per unreported session with flattened tool counts.
 *
 * @param repo - Object providing session query/mark methods
 */
export async function reportPreviousSessions(repo: {
  getUnreportedSessions: (limit?: number) => UnreportedSession[];
  markSessionsReported: (ids: string[]) => void;
}): Promise<void> {
  try {
    if (!isSharingEnabled()) return;

    const sessions = repo.getUnreportedSessions(50);
    if (sessions.length === 0) return;

    const distinctId = getOrCreateAnalyticsId();
    const batch: Record<string, unknown>[] = [];

    for (const s of sessions) {
      const sessionTimestamp = new Date(s.started_at).toISOString();

      batch.push(makePayload({
        event: 'session',
        properties: {
          // Dimensions
          client: s.client,
          client_version: s.client_version,
          version: s.version,
          os_platform: s.os_platform,
          // Metrics
          vault_size: s.vault_size,
          duration_ms: s.ended_at ? s.ended_at - s.started_at : null,
          total_invocations: s.total_invocations,
          tool_search: s.tool_counts.search ?? 0,
          tool_store: s.tool_counts.store ?? 0,
          tool_maintain: s.tool_counts.maintain ?? 0,
          tool_mine: s.tool_counts.mine ?? 0,
          tool_template: s.tool_counts.template ?? 0,
          // Correlation
          session_id: s.session_id,
        },
      }, distinctId, sessionTimestamp));
    }

    await fetch(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_API_KEY, batch }),
      signal: AbortSignal.timeout(5000),
    });

    // Only mark reported after successful POST
    repo.markSessionsReported(sessions.map(s => s.session_id));
  } catch {
    // Silent failure — sessions remain unreported for next startup
  }
}
