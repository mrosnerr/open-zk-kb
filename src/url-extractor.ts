// url-extractor.ts - Deterministic URL content extraction
//
// Fetches a URL, extracts article content using Readability, converts to markdown.
// No LLM dependency — pure server-side extraction.

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
 * Returns true if the hostname matches a private, loopback, link-local,
 * or otherwise reserved IP pattern. Does not perform DNS resolution.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  // Loopback hostnames
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv4 ranges
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, aStr, bStr] = ipv4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 127) return true;                        // 127.0.0.0/8  loopback
    if (a === 10) return true;                         // 10.0.0.0/8   private
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local / cloud metadata
    if (a === 0) return true;                          // 0.0.0.0/8
  }

  // IPv6 bracket notation (as it appears in URL hostnames)
  if (host.startsWith('[') && host.endsWith(']')) {
    const ipv6 = host.slice(1, -1).toLowerCase();
    if (ipv6 === '::1') return true;                                    // loopback
    if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true;    // fc00::/7 unique local
    const fe = parseInt(ipv6.slice(0, 4), 16);
    if ((fe & 0xffc0) === 0xfe80) return true;                            // fe80::/10 link-local (fe80-febf)

    // IPv4-mapped (::ffff:H:H) and IPv4-compatible (::H:H) — extract embedded IPv4 and re-check
    const mappedMatch = ipv6.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedMatch) {
      const high = parseInt(mappedMatch[1], 16);
      const low = parseInt(mappedMatch[2], 16);
      const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isPrivateOrReservedHost(ipv4);
    }
  }

  return false;
}

/**
 * Validates a URL for safe fetching: scheme must be http/https and
 * hostname must not resolve to a private/reserved range.
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
