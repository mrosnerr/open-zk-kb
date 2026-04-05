// version.ts - Centralized package version resolution
// Supports compile-time injection (__PKG_VERSION__) with runtime fallback

import { createRequire } from 'module';

declare const __PKG_VERSION__: string | undefined;

/**
 * Get the package version.
 * Uses compile-time injected __PKG_VERSION__ if available (for compiled binaries),
 * otherwise falls back to reading package.json at runtime.
 */
export const PKG_VERSION: string = (() => {
  if (typeof __PKG_VERSION__ !== 'undefined') {
    return __PKG_VERSION__;
  }
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error('Invalid or missing version in package.json');
  }
  return pkg.version;
})();
