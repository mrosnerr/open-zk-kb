// Fetch latest version from npm registry with a short timeout.
// Returns null on any failure — never blocks or throws.
export async function getLatestVersion(packageName: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${packageName}/latest`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

  // Same core version: stable (no pre) is newer than pre-release
  if (c.pre && !l.pre) return true;
  if (!c.pre && l.pre) return false;

  // Both have pre-release: compare lexicographically
  if (c.pre && l.pre) return l.pre > c.pre;

  return false;
}
