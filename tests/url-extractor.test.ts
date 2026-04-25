import { describe, it, expect, afterEach } from 'bun:test';
import { isValidUrl, isPrivateOrReservedHost, extractArticle, extractFromUrl, fetchHtml } from '../src/url-extractor.js';
import { handleIngest } from '../src/tool-handlers.js';

// ---- Unit: isValidUrl ----

describe('isValidUrl', () => {
  it('accepts https URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
  });

  it('accepts http URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
  });

  it('accepts URLs with paths', () => {
    expect(isValidUrl('https://example.com/blog/article-1')).toBe(true);
  });

  it('accepts URLs with query params', () => {
    expect(isValidUrl('https://example.com/search?q=test&page=2')).toBe(true);
  });

  it('rejects ftp URLs', () => {
    expect(isValidUrl('ftp://example.com/file')).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    expect(isValidUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidUrl('')).toBe(false);
  });

  it('rejects plain text', () => {
    expect(isValidUrl('not a url')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isValidUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isValidUrl('data:text/html,<h1>hi</h1>')).toBe(false);
  });
});

// ---- Unit: extractArticle ----

describe('extractArticle', () => {
  const makeArticleHtml = (title: string, body: string) => `
    <html><head><title>${title}</title></head>
    <body>
      <nav>Navigation links here</nav>
      <article>
        <h1>${title}</h1>
        ${body}
      </article>
      <footer>Footer content</footer>
    </body></html>
  `;

  const longParagraph = '<p>' + 'This is a meaningful sentence about a topic. '.repeat(10) + '</p>';

  it('extracts title from HTML', () => {
    const html = makeArticleHtml('My Great Article', longParagraph);
    const result = extractArticle(html, 'https://example.com/article');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('My Great Article');
  });

  it('extracts content as markdown', () => {
    const html = makeArticleHtml('Test', longParagraph);
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.content).toContain('meaningful sentence');
    expect(result!.content).not.toContain('<p>');
  });

  it('strips navigation and footer', () => {
    const html = makeArticleHtml('Test', longParagraph);
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.content).not.toContain('Navigation links');
    expect(result!.content).not.toContain('Footer content');
  });

  it('converts headings to markdown ATX style', () => {
    const html = makeArticleHtml('Test', '<h2>Subheading</h2>' + longParagraph);
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.content).toContain('## Subheading');
  });

  it('converts lists to markdown', () => {
    const html = makeArticleHtml('Test', '<ul><li>Item A</li><li>Item B</li></ul>' + longParagraph);
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.content).toContain('Item A');
    expect(result!.content).toContain('Item B');
  });

  it('converts links to markdown', () => {
    const html = makeArticleHtml('Test', '<p>See <a href="https://example.com">this link</a> for details.</p>' + longParagraph);
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.content).toContain('[this link](https://example.com)');
  });

  it('counts words correctly', () => {
    const html = makeArticleHtml('Test', '<p>one two three four five</p>' + longParagraph);
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.wordCount).toBeGreaterThan(5);
  });

  it('sets url in result', () => {
    const html = makeArticleHtml('Test', longParagraph);
    const result = extractArticle(html, 'https://example.com/page');

    expect(result!.url).toBe('https://example.com/page');
  });

  it('sets extractedAt as ISO string', () => {
    const html = makeArticleHtml('Test', longParagraph);
    const result = extractArticle(html, 'https://example.com');

    expect(result!.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns null for non-article HTML', () => {
    const html = '<html><body><p>Too short</p></body></html>';
    const result = extractArticle(html, 'https://example.com');

    expect(result).toBeNull();
  });

  it('returns null for empty HTML', () => {
    const result = extractArticle('', 'https://example.com');
    expect(result).toBeNull();
  });

  it('returns null for nav-only HTML', () => {
    const html = '<html><body><nav><ul><li>Link 1</li><li>Link 2</li></ul></nav></body></html>';
    const result = extractArticle(html, 'https://example.com');

    expect(result).toBeNull();
  });

  it('extracts byline when present', () => {
    const html = `<html><head><title>Test</title></head><body>
      <article>
        <h1>Test</h1>
        <span class="author" rel="author">John Smith</span>
        ${longParagraph}
      </article>
    </body></html>`;
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.byline).toContain('John Smith');
  });

  it('extracts excerpt', () => {
    const html = makeArticleHtml('Test', longParagraph);
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.excerpt).toBeTruthy();
    expect(result!.excerpt!.length).toBeGreaterThan(0);
  });

  it('handles HTML with multiple articles (extracts main content)', () => {
    const html = `<html><head><title>Multi</title></head><body>
      <article><h1>Main Article</h1>${longParagraph}</article>
      <aside><p>Sidebar content</p></aside>
    </body></html>`;
    const result = extractArticle(html, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.content).toContain('meaningful sentence');
  });

  it('uses hostname as title fallback when title is missing', () => {
    const html = `<html><head></head><body><article><h1></h1>${longParagraph}</article></body></html>`;
    const result = extractArticle(html, 'https://myblog.example.com/post');

    expect(result).not.toBeNull();
    expect(result!.title).toBeTruthy();
  });
});

// ---- Unit: extractFromUrl error handling ----

describe('extractFromUrl', () => {
  it('rejects invalid URLs', async () => {
    await expect(extractFromUrl('not-a-url')).rejects.toThrow('Invalid URL');
  });

  it('rejects ftp URLs', async () => {
    await expect(extractFromUrl('ftp://example.com')).rejects.toThrow('Invalid URL');
  });

  it('rejects javascript: URLs', async () => {
    await expect(extractFromUrl('javascript:void(0)')).rejects.toThrow('Invalid URL');
  });
});

// ---- Integration: handleIngest ----

describe('handleIngest', () => {
  it('rejects invalid URLs with error message', async () => {
    await expect(handleIngest({ url: 'not-a-url' })).rejects.toThrow('Invalid URL');
  });

  it('rejects empty URL', async () => {
    await expect(handleIngest({ url: '' })).rejects.toThrow('Invalid URL');
  });
});

// ---- Unit: isPrivateOrReservedHost ----

describe('isPrivateOrReservedHost', () => {
  it('blocks localhost', () => {
    expect(isPrivateOrReservedHost('localhost')).toBe(true);
  });

  it('blocks *.localhost', () => {
    expect(isPrivateOrReservedHost('app.localhost')).toBe(true);
  });

  it('blocks 127.x.x.x loopback', () => {
    expect(isPrivateOrReservedHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('127.255.255.255')).toBe(true);
  });

  it('blocks 10.x.x.x private range', () => {
    expect(isPrivateOrReservedHost('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('10.255.255.255')).toBe(true);
  });

  it('blocks 172.16-31.x.x private range', () => {
    expect(isPrivateOrReservedHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('172.31.255.255')).toBe(true);
    expect(isPrivateOrReservedHost('172.15.0.1')).toBe(false);
    expect(isPrivateOrReservedHost('172.32.0.1')).toBe(false);
  });

  it('blocks 192.168.x.x private range', () => {
    expect(isPrivateOrReservedHost('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedHost('192.168.0.1')).toBe(true);
  });

  it('blocks 169.254.x.x link-local / cloud metadata', () => {
    expect(isPrivateOrReservedHost('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedHost('169.254.0.1')).toBe(true);
  });

  it('blocks 0.0.0.0', () => {
    expect(isPrivateOrReservedHost('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 loopback', () => {
    expect(isPrivateOrReservedHost('[::1]')).toBe(true);
  });

  it('blocks IPv6 unique local (fc/fd)', () => {
    expect(isPrivateOrReservedHost('[fc00::1]')).toBe(true);
    expect(isPrivateOrReservedHost('[fd12::1]')).toBe(true);
  });

  it('blocks IPv6 link-local (fe80)', () => {
    expect(isPrivateOrReservedHost('[fe80::1]')).toBe(true);
  });

  it('allows public hostnames', () => {
    expect(isPrivateOrReservedHost('example.com')).toBe(false);
    expect(isPrivateOrReservedHost('google.com')).toBe(false);
    expect(isPrivateOrReservedHost('8.8.8.8')).toBe(false);
  });
});

// ---- Unit: fetchHtml ----

describe('fetchHtml', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('rejects on non-HTML content type', async () => {
    globalThis.fetch = (async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await expect(fetchHtml('https://example.com/api')).rejects.toThrow('Unsupported content type');
  });

  it('rejects on HTTP error status', async () => {
    globalThis.fetch = (async () => new Response('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
    await expect(fetchHtml('https://example.com/missing')).rejects.toThrow('HTTP 404');
  });

  it('rejects when content-length exceeds limit', async () => {
    globalThis.fetch = (async () => new Response('x', {
      status: 200,
      headers: { 'content-type': 'text/html', 'content-length': '999999999' },
    })) as typeof fetch;
    await expect(fetchHtml('https://example.com/huge')).rejects.toThrow('Content too large');
  });

  it('accepts text/html content type', async () => {
    globalThis.fetch = (async () => new Response('<html><body>ok</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch;
    const html = await fetchHtml('https://example.com');
    expect(html).toContain('<body>ok</body>');
  });

  it('accepts text/plain content type', async () => {
    globalThis.fetch = (async () => new Response('plain text content', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as typeof fetch;
    const html = await fetchHtml('https://example.com/text');
    expect(html).toBe('plain text content');
  });

  it('rejects when streamed body exceeds limit', async () => {
    const largeBody = 'x'.repeat(1024);
    globalThis.fetch = (async () => new Response(largeBody, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
    await expect(fetchHtml('https://example.com', { maxContentLength: 100 })).rejects.toThrow('Content too large');
  });

  it('aborts on timeout', async () => {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_, reject) => {
        const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (init?.signal?.aborted) { onAbort(); return; }
        init?.signal?.addEventListener('abort', onAbort);
      });
    }) as typeof fetch;
    await expect(fetchHtml('https://example.com', { timeoutMs: 50 })).rejects.toThrow();
  });

  it('blocks URLs targeting localhost', async () => {
    await expect(fetchHtml('http://localhost/secret')).rejects.toThrow('private/reserved');
  });

  it('blocks URLs targeting private IPs', async () => {
    await expect(fetchHtml('http://192.168.1.1/admin')).rejects.toThrow('private/reserved');
  });

  it('blocks URLs targeting cloud metadata endpoint', async () => {
    await expect(fetchHtml('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('private/reserved');
  });

  it('blocks redirects to private IPs', async () => {
    globalThis.fetch = (async () => new Response('', {
      status: 302,
      headers: { 'location': 'http://127.0.0.1/secret' },
    })) as typeof fetch;
    await expect(fetchHtml('https://example.com/redirect')).rejects.toThrow('private/reserved');
  });

  it('follows valid redirects', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('', { status: 301, headers: { 'location': 'https://example.com/final' } });
      }
      return new Response('<html><body>redirected</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;
    const html = await fetchHtml('https://example.com/start');
    expect(html).toContain('redirected');
    expect(callCount).toBe(2);
  });

  it('rejects on too many redirects', async () => {
    globalThis.fetch = (async () => new Response('', {
      status: 302,
      headers: { 'location': 'https://example.com/loop' },
    })) as typeof fetch;
    await expect(fetchHtml('https://example.com/start')).rejects.toThrow('Too many redirects');
  });
});
