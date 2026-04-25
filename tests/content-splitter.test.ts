import { describe, it, expect } from 'bun:test';
import { splitSections, extractLinks, canonicalizeUrl, countWords } from '../src/content-splitter.js';

describe('splitSections', () => {
  it('splits on h2 boundaries', () => {
    const md = '## First\n\nContent one.\n\n## Second\n\nContent two.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('First');
    expect(sections[0].depth).toBe(2);
    expect(sections[0].content).toContain('Content one');
    expect(sections[1].heading).toBe('Second');
  });

  it('splits on h3 boundaries', () => {
    const md = '### Alpha\n\nA content.\n\n### Beta\n\nB content.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('Alpha');
    expect(sections[0].depth).toBe(3);
  });

  it('captures preamble before first heading', () => {
    const md = 'Intro text here.\n\n## Section\n\nSection content.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('');
    expect(sections[0].depth).toBe(0);
    expect(sections[0].content).toContain('Intro text');
    expect(sections[1].heading).toBe('Section');
  });

  it('returns single section for content with no headings', () => {
    const md = 'Just a paragraph of text.\n\nAnother paragraph.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('');
    expect(sections[0].content).toContain('Just a paragraph');
  });

  it('does not split on # inside fenced code blocks', () => {
    const md = '## Real Heading\n\nBefore code.\n\n```\n## Not a heading\nconst x = 1;\n```\n\nAfter code.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Real Heading');
    expect(sections[0].content).toContain('## Not a heading');
    expect(sections[0].content).toContain('After code');
  });

  it('does not split on # inside tilde fenced code blocks', () => {
    const md = '## Heading\n\n~~~\n## Fake\n~~~\n\nReal content.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain('## Fake');
  });

  it('does not split on h1 (only h2 and h3)', () => {
    const md = '# Title\n\nIntro.\n\n## Section\n\nContent.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('');
    expect(sections[0].content).toContain('# Title');
    expect(sections[1].heading).toBe('Section');
  });

  it('does not split on h4+ (only h2 and h3)', () => {
    const md = '## Main\n\nContent.\n\n#### Deep\n\nNested content.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain('#### Deep');
    expect(sections[0].content).toContain('Nested content');
  });

  it('computes word counts per section', () => {
    const md = '## Short\n\nOne two three.\n\n## Long\n\n' + 'word '.repeat(50);
    const sections = splitSections(md);
    expect(sections[0].wordCount).toBe(3);
    expect(sections[1].wordCount).toBe(50);
  });

  it('returns empty array for empty input', () => {
    expect(splitSections('')).toHaveLength(0);
    expect(splitSections('   ')).toHaveLength(0);
  });

  it('handles multiple consecutive headings', () => {
    const md = '## A\n\n## B\n\nContent B.\n\n## C\n\nContent C.';
    const sections = splitSections(md);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    const headings = sections.map(s => s.heading);
    expect(headings).toContain('B');
    expect(headings).toContain('C');
  });

  it('handles mixed h2 and h3 sections', () => {
    const md = '## Parent\n\nParent content.\n\n### Child\n\nChild content.\n\n## Sibling\n\nSibling content.';
    const sections = splitSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe('Parent');
    expect(sections[1].heading).toBe('Child');
    expect(sections[1].depth).toBe(3);
    expect(sections[2].heading).toBe('Sibling');
  });
});

describe('extractLinks', () => {
  it('extracts markdown links', () => {
    const md = 'See [example](https://example.com) for details.';
    const links = extractLinks(md);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/');
    expect(links[0].anchor).toBe('example');
  });

  it('extracts multiple links from one line', () => {
    const md = 'Use [foo](https://foo.com) or [bar](https://bar.com).';
    const links = extractLinks(md);
    expect(links).toHaveLength(2);
  });

  it('deduplicates by canonical URL', () => {
    const md = '[a](https://example.com/page) and [b](https://example.com/page).';
    const links = extractLinks(md);
    expect(links).toHaveLength(1);
  });

  it('strips tracking parameters', () => {
    const md = '[link](https://example.com/page?utm_source=twitter&utm_medium=social&real=1)';
    const links = extractLinks(md);
    expect(links[0].url).toContain('real=1');
    expect(links[0].url).not.toContain('utm_source');
    expect(links[0].url).not.toContain('utm_medium');
  });

  it('strips fbclid and gclid', () => {
    const md = '[link](https://example.com/?fbclid=abc123&gclid=xyz)';
    const links = extractLinks(md);
    expect(links[0].url).not.toContain('fbclid');
    expect(links[0].url).not.toContain('gclid');
  });

  it('strips fragment identifiers', () => {
    const md = '[link](https://example.com/page#section-2)';
    const links = extractLinks(md);
    expect(links[0].url).toBe('https://example.com/page');
  });

  it('skips non-http links', () => {
    const md = '[mail](mailto:test@example.com) and [tel](tel:+1234) and [js](javascript:void(0))';
    const links = extractLinks(md);
    expect(links).toHaveLength(0);
  });

  it('associates links with their section heading', () => {
    const md = '## Intro\n\n[link1](https://a.com)\n\n## Details\n\n[link2](https://b.com)';
    const links = extractLinks(md);
    expect(links).toHaveLength(2);
    expect(links[0].section).toBe('Intro');
    expect(links[1].section).toBe('Details');
  });

  it('resolves relative URLs when sourceUrl is provided', () => {
    const md = '[guide](/docs/guide)';
    const links = extractLinks(md, 'https://example.com/blog/post');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/docs/guide');
  });

  it('skips links inside fenced code blocks', () => {
    const md = '```\n[not a link](https://skip.com)\n```\n\n[real](https://keep.com)';
    const links = extractLinks(md);
    expect(links).toHaveLength(1);
    expect(links[0].url).toContain('keep.com');
  });

  it('returns empty array for no links', () => {
    expect(extractLinks('No links here.')).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(extractLinks('')).toHaveLength(0);
  });

  it('handles links with empty anchor text', () => {
    const md = '[](https://example.com/empty)';
    const links = extractLinks(md);
    expect(links).toHaveLength(1);
    expect(links[0].anchor).toBe('');
  });

  it('filters out links targeting private IPs', () => {
    const md = `
[public](https://example.com)
[private](http://192.168.1.1/admin)
[metadata](http://169.254.169.254/latest)
[localhost](http://localhost:3000/api)
[also public](https://other.com)
`;
    const links = extractLinks(md);
    expect(links).toHaveLength(2);
    expect(links[0].url).toContain('example.com');
    expect(links[1].url).toContain('other.com');
  });

  it('filters out IPv6 private links', () => {
    const md = '[loopback](http://[::1]:8080/secret)';
    const links = extractLinks(md);
    expect(links).toHaveLength(0);
  });

  it('strips URL credentials from extracted links', () => {
    const md = '[creds](https://user:pass@example.com/page)';
    const links = extractLinks(md);
    expect(links).toHaveLength(1);
    expect(links[0].url).not.toContain('user');
    expect(links[0].url).not.toContain('pass');
    expect(links[0].url).toContain('example.com/page');
  });

  it('uses strict http:// or https:// prefix for absolute detection', () => {
    const md = '[x](httpfoo://example.com/bad)';
    const links = extractLinks(md);
    expect(links).toHaveLength(0);
  });

  it('resolves relative links only when sourceUrl provided', () => {
    const md = '[relative](/docs/api)';
    const links = extractLinks(md, 'https://example.com/page');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/docs/api');
  });
});

describe('canonicalizeUrl', () => {
  it('strips credentials from URLs', () => {
    const result = canonicalizeUrl('https://admin:secret@example.com/path');
    expect(result).not.toBeNull();
    expect(result).not.toContain('admin');
    expect(result).not.toContain('secret');
    expect(result).toContain('example.com/path');
  });

  it('returns null for private IP URLs', () => {
    expect(canonicalizeUrl('http://127.0.0.1/secret')).toBeNull();
    expect(canonicalizeUrl('http://192.168.1.1/admin')).toBeNull();
    expect(canonicalizeUrl('http://10.0.0.1/internal')).toBeNull();
    expect(canonicalizeUrl('http://169.254.169.254/metadata')).toBeNull();
    expect(canonicalizeUrl('http://localhost:3000/')).toBeNull();
  });

  it('allows public URLs', () => {
    expect(canonicalizeUrl('https://example.com/page')).not.toBeNull();
  });

  it('returns null for non-http schemes', () => {
    expect(canonicalizeUrl('ftp://example.com')).toBeNull();
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('countWords', () => {
  it('counts space-separated words', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('handles multiple whitespace types', () => {
    expect(countWords('one\ttwo\nthree  four')).toBe(4);
  });

  it('returns 0 for empty/whitespace input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});
