// Fetch latest version from npm registry with a short timeout.
// Returns null on any failure — never blocks or throws.
const CACHE_TTL_MS = 60 * 60 * 1000;

const versionCache = new Map<string, { value: string | null; expiresAt: number }>();
const inFlightRequests = new Map<string, Promise<string | null>>();

export function clearVersionCheckCache(): void {
  versionCache.clear();
  inFlightRequests.clear();
}

export async function getLatestVersion(packageName: string): Promise<string | null> {
  const cached = versionCache.get(packageName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const inFlight = inFlightRequests.get(packageName);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const encodedName = encodeURIComponent(packageName);
      const res = await fetch(
        `https://registry.npmjs.org/${encodedName}/latest`,
        { signal: controller.signal }
      );
      if (!res.ok) {
        versionCache.set(packageName, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
        return null;
      }
      const data = (await res.json()) as { version?: string };
      const version = data.version ?? null;
      versionCache.set(packageName, { value: version, expiresAt: Date.now() + CACHE_TTL_MS });
      return version;
    } catch {
      versionCache.set(packageName, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      inFlightRequests.delete(packageName);
    }
  })();

  inFlightRequests.set(packageName, request);
  return request;
}

function comparePrerelease(current?: string, latest?: string): number {
  if (!current && !latest) return 0;
  if (!current) return 1;
  if (!latest) return -1;

  const currentParts = current.split('.');
  const latestParts = latest.split('.');

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const currentPart = currentParts[i];
    const latestPart = latestParts[i];

    if (currentPart === undefined) return -1;
    if (latestPart === undefined) return 1;

    const currentIsNumeric = /^\d+$/.test(currentPart);
    const latestIsNumeric = /^\d+$/.test(latestPart);

    if (currentIsNumeric && latestIsNumeric) {
      const diff = Number(currentPart) - Number(latestPart);
      if (diff !== 0) return diff;
      continue;
    }

    if (currentIsNumeric !== latestIsNumeric) {
      return currentIsNumeric ? -1 : 1;
    }

    if (currentPart < latestPart) return -1;
    if (currentPart > latestPart) return 1;
  }

  return 0;
}

/**
 * Compare two semver strings. Returns true if `latest` is newer than `current`.
 * Handles pre-release tags (e.g. 0.1.0-beta.6 < 0.1.0).
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2);
    const parts = core.split('.').map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, pre };
  };

  const c = parse(current);
  const l = parse(latest);

  // Compare major.minor.patch
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  if (l.patch !== c.patch) return l.patch > c.patch;

  return comparePrerelease(c.pre, l.pre) < 0;
}
