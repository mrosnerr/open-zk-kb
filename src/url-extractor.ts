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
  url: string;
  extractedAt: string;
  wordCount: number;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
}

export interface ExtractOptions {
  timeoutMs?: number;
  maxContentLength?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5MB HTML limit
const USER_AGENT = 'open-zk-kb/1.0 (knowledge-ingest)';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

turndown.remove(['img', 'iframe', 'video', 'audio', 'picture', 'figure', 'svg']);

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function fetchHtml(url: string, options: ExtractOptions = {}): Promise<string> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });

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

    const html = await response.text();
    if (html.length > maxLength) {
      throw new Error(`Content too large: ${html.length} bytes (max ${maxLength})`);
    }

    return html;
  } finally {
    clearTimeout(timer);
  }
}

export function extractArticle(html: string, url: string): ExtractionResult | null {
  if (!html || html.trim().length === 0) return null;

  const { document } = parseHTML(html);

  // Set documentURI for Readability's relative URL resolution
  Object.defineProperty(document, 'documentURI', { value: url, writable: false });

  const reader = new Readability(document);
  const article = reader.parse();

  if (!article || !article.textContent || article.textContent.trim().length < 50) {
    return null;
  }

  const markdown = turndown.turndown(article.content);
  const wordCount = markdown.split(/\s+/).filter(Boolean).length;

  return {
    title: article.title || new URL(url).hostname,
    content: markdown,
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

  const html = await fetchHtml(url, options);
  const result = extractArticle(html, url);

  if (!result) {
    throw new Error(`Could not extract article content from ${url}. The page may not contain enough readable content.`);
  }

  logToFile('DEBUG', 'URL extraction complete', {
    url,
    title: result.title,
    wordCount: result.wordCount,
  });

  return result;
}
