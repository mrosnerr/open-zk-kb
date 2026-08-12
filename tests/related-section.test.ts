// tests/related-section.test.ts - Provenance marking for generated Related sections.
import { describe, expect, it } from 'bun:test';
import {
  GENERATED_RELATED_MARKER,
  extractGeneratedRelatedIds,
  isGeneratedRelatedBody,
  renderGeneratedRelatedSection,
  stripGeneratedRelatedSection,
} from '../src/related-section.js';

describe('generated Related sections', () => {
  const generated = renderGeneratedRelatedSection(['[[2026081217215033-linked|Linked]]', '[[2026081217215034]]']);

  it('marks rendered sections and round-trips their relation IDs', () => {
    expect(generated.startsWith(`## Related\n\n${GENERATED_RELATED_MARKER}`)).toBe(true);
    const content = `body text\n\n${generated}\n`;
    expect(extractGeneratedRelatedIds(content)).toEqual(['2026081217215033', '2026081217215034']);
    expect(stripGeneratedRelatedSection(content)).toBe('body text');
  });

  it('preserves unmarked authored Related sections verbatim', () => {
    const authored = 'body text\n\n## Related\n\n- [[2026081217215033-linked|Linked]]\n';
    expect(stripGeneratedRelatedSection(authored)).toBe(authored.trimEnd());
    expect(extractGeneratedRelatedIds(authored)).toEqual([]);
    expect(isGeneratedRelatedBody('- [[2026081217215033]]')).toBe(false);
    expect(isGeneratedRelatedBody(`${GENERATED_RELATED_MARKER} forged`)).toBe(false);
    expect(isGeneratedRelatedBody(`${GENERATED_RELATED_MARKER} \t\n- [[2026081217215033]]`)).toBe(true);
    expect(isGeneratedRelatedBody(`${GENERATED_RELATED_MARKER}\u00a0\n- [[2026081217215033]]`)).toBe(false);
  });

  it('strips only the trailing marked section and leaves earlier authored ones', () => {
    const mixed = `body\n\n## Related\n\n- [[2026081217215031-authored|Authored]]\n\n## Notes\n\ntext\n\n${generated}\n`;
    const stripped = stripGeneratedRelatedSection(mixed);
    expect(stripped).toContain('- [[2026081217215031-authored|Authored]]');
    expect(stripped).not.toContain(GENERATED_RELATED_MARKER);
  });
});
