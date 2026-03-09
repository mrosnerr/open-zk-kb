/**
 * Prompt rendering functions for knowledge tools.
 * Domain-agnostic: covers any type of knowledge worth remembering.
 */

import type { NoteMetadata } from './storage/NoteRepository.js';

// ---- Kind-specific fallback guidance ----

export const KIND_GUIDANCE: Record<string, string> = {
  personalization: 'User preference — apply when relevant choices arise.',
  reference: 'Reference fact — use when this topic comes up.',
  decision: 'Confirmed decision — follow unless explicitly overridden.',
  procedure: 'Follow these steps when performing this task.',
  resource: 'Recommended resource — reference when relevant.',
  observation: 'Unverified insight — consider but verify before relying on.',
};

// Kinds that benefit from a content preview in compact rendering
const CONTENT_PREVIEW_KINDS = new Set(['procedure', 'reference', 'observation', 'resource']);
const CONTENT_PREVIEW_MAX_CHARS = 150;

// ---- Shared note attributes ----

function buildNoteAttrs(note: NoteMetadata): string {
  const attrs: string[] = [
    `id="${note.id}"`,
    `kind="${note.kind || 'observation'}"`,
    `status="${note.status}"`,
  ];

  const tags = Array.isArray(note.tags) ? note.tags : [];
  if (tags.length > 0) {
    attrs.push(`tags="${tags.join(', ')}"`);
  }

  return attrs.join(' ');
}

// ---- Compact note rendering (summary + guidance) ----

export function renderNoteForAgent(note: NoteMetadata): string {
  const summary = note.summary || note.title || note.id;
  const guidance = note.guidance || KIND_GUIDANCE[note.kind || 'observation'] || '';

  let xml = `<note ${buildNoteAttrs(note)}>\n`;
  xml += `  <summary>${summary}</summary>\n`;
  xml += `  <guidance>${guidance}</guidance>\n`;

  // Add content preview for content-heavy kinds
  const content = note.content || '';
  if (CONTENT_PREVIEW_KINDS.has(note.kind) && content.length > 0) {
    const preview = content.length > CONTENT_PREVIEW_MAX_CHARS
      ? content.substring(0, CONTENT_PREVIEW_MAX_CHARS).trimEnd() + '...'
      : content;
    xml += `  <content_preview>${preview}</content_preview>\n`;
    if (content.length > CONTENT_PREVIEW_MAX_CHARS) {
      xml += `  <hint>Use knowledge-search to retrieve full content</hint>\n`;
    }
  }

  xml += `</note>`;

  return xml;
}

// ---- Note rendering for search results (full content) ----

export function renderNoteForSearch(note: NoteMetadata): string {
  const summary = note.summary || note.title || note.id;
  const guidance = note.guidance || KIND_GUIDANCE[note.kind || 'observation'] || '';

  let xml = `<note ${buildNoteAttrs(note)}>\n`;
  xml += `  <summary>${summary}</summary>\n`;
  xml += `  <guidance>${guidance}</guidance>\n`;

  const content = note.content || '';
  if (content.length > 0) {
    xml += `  <content>${content}</content>\n`;
  }

  xml += `</note>`;

  return xml;
}

export function emptyKbHint(directory: string): string {
  return `## Empty Knowledge Base — Onboarding Script

When the knowledge base has no notes, you follow a strict onboarding script. The exact wording matters because it sets user expectations about what the knowledge system can do.

Output the text inside <onboarding_script> tags verbatim, then stop.

<onboarding_script>
I don't have anything stored about you yet. Here's how we can fix that:

1. **I can scan \`${directory}\`** — I'll look through the files and structure, reflect back what I find, and suggest things worth remembering. You'll approve everything before I save it.
2. **You tell me** — Share anything you'd like me to remember across sessions: preferences, facts, links, whatever matters to you.
</onboarding_script>

<example>
<user_message>What do you know about me?</user_message>
<correct_response>
I don't have anything stored about you yet. Here's how we can fix that:

1. **I can scan \`${directory}\`** — I'll look through the files and structure, reflect back what I find, and suggest things worth remembering. You'll approve everything before I save it.
2. **You tell me** — Share anything you'd like me to remember across sessions: preferences, facts, links, whatever matters to you.
</correct_response>
</example>

FORBIDDEN:
- Adding a third option or any additional suggestions
- Suggesting specific topics (coding style, communication preferences, etc.)
- Rephrasing or rewording any part of the script
- Adding greetings, preamble, or commentary before or after`;
}
