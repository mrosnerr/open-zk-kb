const GENERATED_RELATED_SECTION = /(?:^|\n{1,2})## Related[ \t]*\n(?:[ \t]*\n)?(?:- .*?(?:\n|$))+[ \t]*$/u;

/** Remove the generated trailing Related section while preserving authored content. */
export function stripGeneratedRelatedSection(content: string): string {
  return content.replace(GENERATED_RELATED_SECTION, '').trimEnd();
}
