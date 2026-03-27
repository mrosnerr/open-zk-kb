// tests/integration.test.ts - Integration tests for knowledge base
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  createTestHarness,
  cleanupTestHarness,
  createNoteFile,
  readNoteFile,
  noteFileExists,
} from './harness.js';
import type { TestContext } from './harness.js';
import type { NoteKind } from '../src/types.js';

describe('Knowledge Capture Integration Tests', () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(context);
  });

  describe('Storage with Kind', () => {
    it('should store a note with kind and retrieve it', () => {
      const result = context.engine.store('This is a user preference about dark mode', {
        title: 'Dark Mode Preference',
        kind: 'personalization',
        status: 'permanent',
        tags: ['ui', 'preference'],
      });

      expect(result.action).toBe('created');
      expect(result.id).toBeTruthy();

      const note = context.engine.getById(result.id);
      expect(note).not.toBeNull();
      expect(note!.kind).toBe('personalization');
      expect(note!.status).toBe('permanent');
      expect(note!.title).toBe('Dark Mode Preference');
      expect(note!.tags).toContain('ui');
    });

    it('should default kind to observation if not specified', () => {
      const result = context.engine.store('Some random observation', {
        title: 'Random Observation',
      });

      const note = context.engine.getById(result.id);
      expect(note!.kind).toBe('observation');
    });

    it('should write kind to frontmatter in markdown file', () => {
      const result = context.engine.store('We decided to use PostgreSQL', {
        title: 'Database Decision',
        kind: 'decision',
        status: 'permanent',
      });

      const filename = result.path.split('/').pop()!;
      const content = readNoteFile(context, filename);
      expect(content).toContain('kind: decision');
      expect(content).toContain('status: permanent');
    });
  });

  describe('Search with Kind Filter', () => {
    beforeEach(() => {
      context.engine.store('I prefer TypeScript over JavaScript', {
        title: 'TypeScript Preference',
        kind: 'personalization',
        status: 'permanent',
      });
      context.engine.store('The API endpoint is /api/v2/users', {
        title: 'API Endpoint Reference',
        kind: 'reference',
        status: 'fleeting',
      });
      context.engine.store('We decided to use PostgreSQL', {
        title: 'Database Decision',
        kind: 'decision',
        status: 'permanent',
      });
    });

    it('should search all notes by text', () => {
      const results = context.engine.search('TypeScript');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.title === 'TypeScript Preference')).toBe(true);
    });

    it('should filter by kind', () => {
      const results = context.engine.search('prefer TypeScript API PostgreSQL', { kind: 'personalization' });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.kind).toBe('personalization');
      }
    });

    it('should filter by status', () => {
      const results = context.engine.search('TypeScript API PostgreSQL', { status: 'fleeting' });
      for (const r of results) {
        expect(r.status).toBe('fleeting');
      }
    });
  });

  describe('Get by Kind', () => {
    beforeEach(() => {
      context.engine.store('I love hiking in the mountains', {
        title: 'Hiking Preference',
        kind: 'personalization',
      });
      context.engine.store('I prefer dark roast coffee', {
        title: 'Coffee Preference',
        kind: 'personalization',
      });
      context.engine.store('Turns out the cache was the bottleneck', {
        title: 'Cache Observation',
        kind: 'observation',
      });
    });

    it('should get notes by kind', () => {
      const personalizations = context.engine.getByKind('personalization');
      expect(personalizations.length).toBe(2);
      for (const note of personalizations) {
        expect(note.kind).toBe('personalization');
      }
    });

    it('should return empty for kind with no notes', () => {
      const procedures = context.engine.getByKind('procedure');
      expect(procedures).toHaveLength(0);
    });
  });

  describe('Lifecycle (Review Queue)', () => {
    it('should find stale fleeting notes', () => {
      context.engine.store('Old observation that nobody read', {
        title: 'Old Observation',
        kind: 'observation',
        status: 'fleeting',
      });

      const stale = context.engine.getStaleNotes(1, 2, ['personalization', 'decision']);
      expect(Array.isArray(stale)).toBe(true);
    });

    it('should exclude exempt kinds from stale query', () => {
      context.engine.store('This is my preference', {
        title: 'A Preference',
        kind: 'personalization',
        status: 'fleeting',
      });

      const stale = context.engine.getStaleNotes(0, 0, ['personalization', 'decision']);
      const hasPersonalization = stale.some(n => n.kind === 'personalization');
      expect(hasPersonalization).toBe(false);
    });

    it('should not exclude non-exempt kinds', () => {
      context.engine.store('Old procedure nobody uses', {
        title: 'Old Procedure',
        kind: 'procedure',
        status: 'fleeting',
      });

      const stale = context.engine.getStaleNotes(0, 1, ['personalization', 'decision']);
      expect(Array.isArray(stale)).toBe(true);
    });
  });

  describe('Review Queue Selection Logic', () => {
    const daysAgo = (days: number): number => Date.now() - (days * 24 * 60 * 60 * 1000);

    const setCreatedAt = (noteId: string, timestamp: number): void => {
      (context.engine as any).db.prepare('UPDATE notes SET created_at = ? WHERE id = ?').run(timestamp, noteId);
    };

    it('includes fleeting notes older than daysThreshold in review queue', () => {
      const result = context.engine.store('Old fleeting note', {
        title: 'Old Fleeting',
        kind: 'observation',
        status: 'fleeting',
      });

      const note = context.engine.getById(result.id)!;
      setCreatedAt(note.id, daysAgo(20));

      const queue = context.engine.getReviewQueue(
        undefined,
        14,
        10,
        context.config.lifecycle.promotionThreshold,
        context.config.lifecycle.exemptKinds,
      );

      expect(queue.fleeting.total).toBe(1);
      expect(queue.fleeting.notes.some(n => n.id === note.id)).toBe(true);
    });

    it('does not include fleeting notes newer than daysThreshold', () => {
      context.engine.store('Fresh fleeting note', {
        title: 'Fresh Fleeting',
        kind: 'observation',
        status: 'fleeting',
      });

      const queue = context.engine.getReviewQueue(
        undefined,
        14,
        10,
        context.config.lifecycle.promotionThreshold,
        context.config.lifecycle.exemptKinds,
      );

      expect(queue.fleeting.total).toBe(0);
      expect(queue.fleeting.notes).toHaveLength(0);
    });

    it('excludes fleeting notes with access_count >= promotionThreshold', () => {
      const result = context.engine.store('Well-used fleeting note', {
        title: 'Well-used Fleeting',
        kind: 'observation',
        status: 'fleeting',
      });

      const note = context.engine.getById(result.id)!;
      setCreatedAt(note.id, daysAgo(20));

      for (let i = 0; i < context.config.lifecycle.promotionThreshold; i++) {
        context.engine.recordAccess(note.id);
      }

      const queue = context.engine.getReviewQueue(
        undefined,
        14,
        10,
        context.config.lifecycle.promotionThreshold,
        context.config.lifecycle.exemptKinds,
      );

      expect(queue.fleeting.total).toBe(0);
      expect(queue.fleeting.notes.some(n => n.id === note.id)).toBe(false);
    });

    it('excludes exemptKinds from both fleeting and permanent review', () => {
      const fleetingExempt = context.engine.store('Exempt fleeting preference', {
        title: 'Exempt Fleeting Preference',
        kind: 'personalization',
        status: 'fleeting',
      });
      const permanentExempt = context.engine.store('Exempt permanent decision', {
        title: 'Exempt Permanent Decision',
        kind: 'decision',
        status: 'permanent',
      });

      setCreatedAt(fleetingExempt.id, daysAgo(20));
      setCreatedAt(permanentExempt.id, daysAgo(20));

      const queue = context.engine.getReviewQueue(
        undefined,
        14,
        10,
        context.config.lifecycle.promotionThreshold,
        context.config.lifecycle.exemptKinds,
      );

      expect(queue.fleeting.total).toBe(0);
      expect(queue.permanent.total).toBe(0);
    });

    it('includes permanent notes with zero accesses older than threshold', () => {
      const result = context.engine.store('Old permanent note', {
        title: 'Old Permanent',
        kind: 'reference',
        status: 'permanent',
      });

      const note = context.engine.getById(result.id)!;
      setCreatedAt(note.id, daysAgo(20));

      const queue = context.engine.getReviewQueue(
        undefined,
        14,
        10,
        context.config.lifecycle.promotionThreshold,
        context.config.lifecycle.exemptKinds,
      );

      expect(queue.permanent.total).toBe(1);
      expect(queue.permanent.notes.some(n => n.id === note.id)).toBe(true);
    });

    it('respects filter=fleeting and filter=permanent', () => {
      const fleeting = context.engine.store('Old fleeting note', {
        title: 'Filtered Fleeting',
        kind: 'observation',
        status: 'fleeting',
      });
      const permanent = context.engine.store('Old permanent note', {
        title: 'Filtered Permanent',
        kind: 'reference',
        status: 'permanent',
      });

      setCreatedAt(fleeting.id, daysAgo(20));
      setCreatedAt(permanent.id, daysAgo(20));

      const fleetingOnly = context.engine.getReviewQueue(
        'fleeting',
        14,
        10,
        context.config.lifecycle.promotionThreshold,
        context.config.lifecycle.exemptKinds,
      );
      expect(fleetingOnly.fleeting.total).toBe(1);
      expect(fleetingOnly.permanent.total).toBe(0);

      const permanentOnly = context.engine.getReviewQueue(
        'permanent',
        14,
        10,
        context.config.lifecycle.promotionThreshold,
        context.config.lifecycle.exemptKinds,
      );
      expect(permanentOnly.fleeting.total).toBe(0);
      expect(permanentOnly.permanent.total).toBe(1);
    });
  });

  describe('Stats by Kind', () => {
    beforeEach(() => {
      context.engine.store('Pref 1', { title: 'P1', kind: 'personalization', status: 'permanent' });
      context.engine.store('Pref 2', { title: 'P2', kind: 'personalization', status: 'permanent' });
      context.engine.store('Ref 1', { title: 'R1', kind: 'reference', status: 'fleeting' });
      context.engine.store('Dec 1', { title: 'D1', kind: 'decision', status: 'permanent' });
    });

    it('should return stats broken down by kind', () => {
      const stats = context.engine.getStatsByKind();
      expect(stats.personalization.total).toBe(2);
      expect(stats.personalization.permanent).toBe(2);
      expect(stats.reference.total).toBe(1);
      expect(stats.reference.fleeting).toBe(1);
      expect(stats.decision.total).toBe(1);
    });
  });

  describe('Promote and Archive', () => {
    it('should promote a fleeting note to permanent', () => {
      const result = context.engine.store('Some insight', {
        title: 'Insight',
        kind: 'observation',
        status: 'fleeting',
      });

      let note = context.engine.getById(result.id);
      expect(note!.status).toBe('fleeting');

      context.engine.promoteToPermanent(result.id);

      note = context.engine.getById(result.id);
      expect(note!.status).toBe('permanent');
    });

    it('should archive a note', () => {
      const result = context.engine.store('Old decision', {
        title: 'Old Decision',
        kind: 'decision',
        status: 'permanent',
      });

      context.engine.archive(result.id);

      const note = context.engine.getById(result.id);
      expect(note!.status).toBe('archived');
    });

    it('should update frontmatter on promote', () => {
      const result = context.engine.store('Insight content', {
        title: 'Insight',
        kind: 'observation',
        status: 'fleeting',
      });

      context.engine.promoteToPermanent(result.id);

      const filename = result.path.split('/').pop()!;
      const content = readNoteFile(context, filename);
      expect(content).toContain('status: permanent');
    });
  });

  describe('Rebuild from Files', () => {
    it('should rebuild index from markdown files', () => {
      // Store some notes
      context.engine.store('First note content', { title: 'First', kind: 'observation' });
      context.engine.store('Second note content', { title: 'Second', kind: 'personalization', status: 'permanent' });

      const statsBefore = context.engine.getStats();
      expect(statsBefore.total).toBe(2);

      // Rebuild from files
      const result = context.engine.rebuildFromFiles();
      expect(result.indexed).toBe(2);
      expect(result.errors).toBe(0);

      // Verify notes are still accessible
      const statsAfter = context.engine.getStats();
      expect(statsAfter.total).toBe(2);
    });
  });

  describe('File System Operations', () => {
    it('should create note files on disk', () => {
      const result = context.engine.store('Test content for file creation', {
        title: 'Test Note',
        kind: 'reference',
      });

      expect(result.action).toBe('created');
      expect(noteFileExists(context, result.path.split('/').pop()!)).toBe(true);
    });

    it('should update existing note files', () => {
      const initialResult = context.engine.store('Initial content', {
        title: 'Test Note',
        kind: 'observation',
      });

      const updateResult = context.engine.store('Updated content with more words', {
        title: 'Test Note Updated',
        kind: 'observation',
        existingId: initialResult.id,
      });

      expect(updateResult.action).toBe('updated');
      expect(updateResult.id).toBe(initialResult.id);

      const content = readNoteFile(context, updateResult.path.split('/').pop()!);
      expect(content).toContain('Updated content');
    });
  });

  describe('Wikilinks', () => {
    it('should extract and store wiki links between notes', () => {
      const note1 = context.engine.store('First note about patterns', {
        title: 'Patterns',
        kind: 'reference',
        existingId: '202602081000',
      });

      const note2 = context.engine.store('This references [[202602081000]] for patterns', {
        title: 'Architecture',
        kind: 'reference',
        existingId: '202602081001',
      });

      const backlinks = context.engine.getBacklinks('202602081000');
      expect(backlinks.length).toBeGreaterThan(0);
      expect(backlinks.some(l => l.note.id === '202602081001')).toBe(true);
    });
  });

  describe('Client Tag Round-Trip', () => {
    it('should store a note with client tag and retrieve it', () => {
      const result = context.engine.store('Configure .opencode/config.json for settings', {
        title: 'OpenCode Config',
        kind: 'reference',
        tags: ['client:opencode'],
      });

      const note = context.engine.getById(result.id);
      expect(note).not.toBeNull();
      expect(note!.tags).toContain('client:opencode');
    });

    it('should persist client tag in frontmatter', () => {
      const result = context.engine.store('Claude-specific content', {
        title: 'Claude Note',
        kind: 'reference',
        tags: ['client:claude-code'],
      });

      const filename = result.path.split('/').pop()!;
      const content = readNoteFile(context, filename);
      expect(content).toContain('client:claude-code');
    });

    it('should preserve client tags through updateTags', () => {
      const result = context.engine.store('Some content', {
        title: 'Tag Update Test',
        kind: 'reference',
        tags: ['client:opencode', 'existing-tag'],
      });

      context.engine.updateTags(result.id, ['client:opencode', 'existing-tag', 'new-tag']);

      const note = context.engine.getById(result.id);
      expect(note!.tags).toContain('client:opencode');
      expect(note!.tags).toContain('new-tag');
      expect(note!.tags).toContain('existing-tag');

      // Verify frontmatter updated too
      const filename = result.path.split('/').pop()!;
      const content = readNoteFile(context, filename);
      expect(content).toContain('client:opencode');
      expect(content).toContain('new-tag');
    });

    it('should find client-tagged notes in search', () => {
      context.engine.store('OpenCode specific knowledge', {
        title: 'OpenCode Note',
        kind: 'reference',
        tags: ['client:opencode'],
      });

      const results = context.engine.search('OpenCode specific knowledge');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tags).toContain('client:opencode');
    });

    it('should include client-tagged notes in tag search', () => {
      context.engine.store('Tagged content', {
        title: 'Tagged Note',
        kind: 'reference',
        tags: ['client:opencode', 'config'],
      });

      const results = context.engine.search('Tagged content', { tags: ['config'] });
      expect(results.length).toBeGreaterThan(0);
    });

    it('should rebuild client-tagged notes from files correctly', () => {
      context.engine.store('Rebuild test content', {
        title: 'Rebuild Client Note',
        kind: 'reference',
        tags: ['client:cursor', 'test'],
      });

      const result = context.engine.rebuildFromFiles();
      expect(result.errors).toBe(0);

      const notes = context.engine.getByTag('client:cursor');
      expect(notes.length).toBe(1);
      expect(notes[0].title).toBe('Rebuild Client Note');
    });
  });

  describe('Access Tracking', () => {
    it('should track access count', () => {
      const result = context.engine.store('Trackable content', {
        title: 'Trackable',
        kind: 'reference',
      });

      context.engine.recordAccess(result.id);
      context.engine.recordAccess(result.id);

      const note = context.engine.getById(result.id);
      expect(note!.access_count).toBe(2);
    });
  });
});
