import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { extractWikiLinks } from '../src/utils/wikilink';
import { cleanupTestHarness, createTestHarness, type TestContext } from './harness';

function markdownWithContextLinks(ids: readonly string[]): string {
  const [frontmatter, prose, code] = ids;
  return [
    '---',
    `up: "[[${frontmatter}|Navigation]]"`,
    '---',
    '',
    `Authored [[${prose}|Prose]].`,
    '',
    `\`\`[[${code}|Example]]\`\``,
  ].join('\n');
}

describe('contextual Markdown compatibility baseline', () => {
  let context: TestContext;

  beforeEach(() => { context = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(context); });

  it('characterizes the existing context-free wikilink utility', () => {
    const ids = ['2026072500000001', '2026072500000002', '2026072500000003'] as const;

    expect(extractWikiLinks(markdownWithContextLinks(ids)).map(link => link.id)).toEqual(ids);
  });

  it('characterizes existing syncLinks rows before contextual facts are consumed', () => {
    const targets = [
      context.engine.store('Navigation target', { title: 'Navigation Target', kind: 'reference' }),
      context.engine.store('Prose target', { title: 'Prose Target', kind: 'reference' }),
      context.engine.store('Code target', { title: 'Code Target', kind: 'reference' }),
    ];
    const source = context.engine.store('Source note', { title: 'Source', kind: 'reference' });

    context.engine.syncLinks(source.id, markdownWithContextLinks(targets.map(note => note.id)));

    expect(context.engine.getOutgoingLinks(source.id).map(link => link.note.id).sort()).toEqual(
      targets.map(note => note.id).sort(),
    );
  });
});
