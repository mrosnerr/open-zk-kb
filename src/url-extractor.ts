// url-extractor.ts - Deterministic URL content extraction
//
// Fetches a URL, extracts article content using Readability, converts to markdown.
// No LLM dependency — pure server-side extraction.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { logToFile } from './logger.js';

export interface ExtractionResult {
  title: string;
  content: string;
  textContent: string;
  url: string;
  extractedAt: string;
  wordCount: number;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
}

export interface FetchResult {
  html: string;
  finalUrl: string;
}

export interface ExtractOptions {
  timeoutMs?: number;
  maxContentLength?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5MB HTML limit
const MAX_REDIRECTS = 5;
const MIN_READABLE_CHARS = 50;
const USER_AGENT = 'open-zk-kb/1.0 (knowledge-ingest)';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

turndown.remove(['img', 'iframe', 'video', 'audio', 'picture', 'figure', 'svg']);

/** Checks whether a URL string has a valid http/https scheme. */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Returns true if an IP address is private, loopback, link-local,
 * or otherwise reserved.
 */
export function isPrivateOrReservedIp(address: string, family: number = isIP(address)): boolean {
  const host = address.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');

  if (family === 4) {
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipv4Match) return false;
    const [, aStr = '', bStr = '', cStr = '', dStr = ''] = ipv4Match;
    const parts = [aStr, bStr, cStr, dStr].map(Number);
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a = 0, b = 0] = parts;
    if (a === 127) return true;                       // 127.0.0.0/8  loopback
    if (a === 10) return true;                        // 10.0.0.0/8   private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
    if (a === 0) return true;                         // 0.0.0.0/8
    return false;
  }

  if (family !== 6) return false;

  if (host === '::1') return true;                                  // loopback
  if (host.startsWith('fc') || host.startsWith('fd')) return true;  // fc00::/7 unique local
  const fe = parseInt(host.slice(0, 4), 16);
  if ((fe & 0xffc0) === 0xfe80) return true;                       // fe80::/10 link-local (fe80-febf)

  const dottedMappedMatch = host.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedMappedMatch) {
    return isPrivateOrReservedIp(dottedMappedMatch[1] ?? '', 4);
  }

  const mappedMatch = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedMatch) {
    const high = parseInt(mappedMatch[1] ?? '', 16);
    const low = parseInt(mappedMatch[2] ?? '', 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isPrivateOrReservedIp(ipv4, 4);
  }

  return false;
}

/**
 * Returns true if the hostname matches a private, loopback, link-local,
 * or otherwise reserved IP pattern. Does not perform DNS resolution.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  // Loopback hostnames
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipFamily = isIP(host);
  if (ipFamily !== 0) return isPrivateOrReservedIp(host, ipFamily);

  // IPv6 bracket notation (as it appears in URL hostnames)
  if (host.startsWith('[') && host.endsWith(']')) {
    const ipv6 = host.slice(1, -1);
    const bracketedFamily = isIP(ipv6);
    if (bracketedFamily !== 0) return isPrivateOrReservedIp(ipv6, bracketedFamily);
  }

  return false;
}

/**
 * Resolves a fetch target hostname and blocks hostnames resolving to any
 * private/reserved address. Literal IP targets are already checked by
 * validateFetchTarget and are not resolved.
 */
async function validateResolvedFetchTarget(url: string): Promise<void> {
  const parsed = new URL(url);
  if (isIP(parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')) !== 0) return;

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch (error) {
    throw new Error(`Blocked URL: failed to resolve hostname ${parsed.hostname}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  for (const address of addresses) {
    if (isPrivateOrReservedIp(address.address, address.family)) {
      throw new Error(`Blocked URL: hostname ${parsed.hostname} resolves to private/reserved address ${address.address}`);
    }
  }
}

/**
 * Validates a URL for safe fetching: scheme must be http/https and
 * hostname must not be a private/reserved literal or hostname pattern.
 */
function validateFetchTarget(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL: unsupported protocol ${parsed.protocol}`);
  }
  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new Error(`Blocked URL: hostname ${parsed.hostname} matches a private/reserved range`);
  }
}

/**
 * Reads a response body as text using streaming byte-counting.
 * Aborts as soon as accumulated bytes exceed maxLength — never buffers the
 * full body before enforcing the limit.
 */
async function readBodyWithLimit(response: Response, maxLength: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for environments where body is not a ReadableStream
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxLength) {
      throw new Error(`Content too large: exceeded ${maxLength} bytes`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxLength) {
        throw new Error(`Content too large: exceeded ${maxLength} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function fetchHtml(url: string, options: ExtractOptions = {}): Promise<FetchResult> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let currentUrl = url;
    let redirectCount = 0;

    while (true) {
      validateFetchTarget(currentUrl);
      await validateResolvedFetchTarget(currentUrl);

      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
        }
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect ${response.status} without Location header`);
        }
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
        throw new Error(`Unsupported content type: ${contentType}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxLength) {
        throw new Error(`Content too large: ${contentLength} bytes (max ${maxLength})`);
      }

      const html = await readBodyWithLimit(response, maxLength);
      return { html, finalUrl: currentUrl };
    }
  } finally {
    clearTimeout(timer);
  }
}

export function extractArticle(html: string, url: string): ExtractionResult | null {
  if (!html || html.trim().length === 0) return null;

  const { document } = parseHTML(html);

  try {
    Object.defineProperty(document, 'documentURI', { value: url, configurable: true, writable: false });
  } catch {
    // linkedom may define documentURI as non-configurable; fall through
  }

  const reader = new Readability(document);
  const article = reader.parse();

  if (!article || !article.textContent || article.textContent.trim().length < MIN_READABLE_CHARS) {
    return null;
  }

  const markdown = turndown.turndown(article.content);
  const textContent = article.textContent;
  const wordCount = textContent.split(/\s+/).filter(Boolean).length;

  let title = article.title;
  if (!title) {
    try { title = new URL(url).hostname || 'Untitled'; } catch { title = 'Untitled'; }
  }

  return {
    title,
    content: markdown,
    textContent,
    url,
    extractedAt: new Date().toISOString(),
    wordCount,
    byline: article.byline || null,
    excerpt: article.excerpt || null,
    siteName: article.siteName || null,
  };
}

export async function extractFromUrl(url: string, options: ExtractOptions = {}): Promise<ExtractionResult> {
  if (!isValidUrl(url)) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const { html, finalUrl } = await fetchHtml(url, options);
  const safeFinalUrl = new URL(finalUrl);
  safeFinalUrl.username = '';
  safeFinalUrl.password = '';
  const result = extractArticle(html, safeFinalUrl.href);

  if (!result) {
    throw new Error(`Could not extract article content from ${url}. The page may not contain enough readable content.`);
  }

  logToFile('DEBUG', 'URL extraction complete', {
    url: safeFinalUrl.href,
    title: result.title,
    wordCount: result.wordCount,
  });

  return result;
}
