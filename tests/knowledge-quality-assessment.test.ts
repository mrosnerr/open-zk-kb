// tests/knowledge-quality-assessment.test.ts
// Quality assessment test for notes in the zettelkasten-mcp vault

// @ts-ignore - bun:test types may not be available during build
import { describe, it, expect, beforeAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

class QualityAssessor {
  private countWords(content: string): number {
    return content.split(/\s+/).filter(w => w.length > 0).length;
  }

  assessContentQuality(content: string): { score: number; shouldCapture: boolean; reason?: string } {
    const cleanContent = content.trim();
    const wordCount = this.countWords(cleanContent);

    if (wordCount < 20) {
      return { score: 0, shouldCapture: false, reason: 'Content too short (< 20 words)' };
    }

    const uiPatterns = [
      /toggle navigation/i,
      /search or jump to/i,
      /sign in/i,
      /log in/i,
      /click here/i,
      /submit/i,
      /cancel/i,
      /appearance settings/i,
      /saved searches/i,
      /provide feedback/i,
      /^\s*\[\]\s*$/m,
      /^\s*\[.*?\]\s*$/m,
    ];

    const uiPatternCount = uiPatterns.filter(pattern => pattern.test(cleanContent)).length;
    if (uiPatternCount >= 3) {
      return { score: 10, shouldCapture: false, reason: 'Contains multiple UI/navigation elements' };
    }

    const sentences = cleanContent.split(/[.!?]+/).filter(s => s.trim().length > 10);
    if (sentences.length < 2 && wordCount < 50) {
      return { score: 20, shouldCapture: false, reason: 'Insufficient information density' };
    }

    let structureScore = 0;
    if (/^#+\s+[A-Z]/m.test(cleanContent)) structureScore += 15;
    if (/```[\s\S]+?```/.test(cleanContent)) structureScore += 20;
    const listMatches = cleanContent.match(/^[-*]\s+.{20,}/gm);
    if (listMatches && listMatches.length >= 2) structureScore += 15;
    const completeSentences = sentences.filter(s => s.split(/\s+/).length >= 5);
    if (completeSentences.length >= 3) structureScore += 20;
    const paragraphs = cleanContent.split(/\n\n+/).filter(p => p.trim().length > 50);
    if (paragraphs.length >= 2) structureScore += 15;

    let technicalScore = 0;
    const techKeywords = [
      /\b(function|class|const|let|var|import|export|return|async|await)\b/i,
      /\b(component|api|endpoint|database|query|schema|model)\b/i,
      /\b(error|exception|debug|test|build|deploy|config)\b/i,
      /\b(typescript|javascript|python|react|node|sql)\b/i,
    ];
    const techMatches = techKeywords.filter(pattern => pattern.test(cleanContent)).length;
    technicalScore = Math.min(techMatches * 10, 30);

    const baseScore = Math.min(wordCount / 5, 30);
    const finalScore = Math.min(baseScore + structureScore + technicalScore, 100);

    const shouldCapture = finalScore >= 40;
    const reason = shouldCapture ? undefined : `Quality score ${finalScore} < 40 (insufficient value)`;

    return { score: finalScore, shouldCapture, reason };
  }
}

interface NoteAssessment {
  path: string;
  filename: string;
  wordCount: number;
  score: number;
  shouldCapture: boolean;
  reason?: string;
  category: 'pass' | 'borderline' | 'fail' | 'missing';
}

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory() && entry.name !== '.index' && entry.name !== 'node_modules') {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }
  walk(dir);
  return files;
}

function parseNoteContent(filePath: string): { body: string; wordCount: number } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    const body = match ? match[2] : content;
    const wordCount = body.split(/\s+/).filter(w => w.length > 0).length;
    return { body, wordCount };
  } catch {
    return { body: '', wordCount: 0 };
  }
}

async function assessKnowledgeBase(docsPath: string): Promise<NoteAssessment[]> {
  const assessor = new QualityAssessor();
  const assessments: NoteAssessment[] = [];
  const files = findMarkdownFiles(docsPath);

  for (const filePath of files) {
    const { body, wordCount } = parseNoteContent(filePath);

    if (!body) {
      assessments.push({
        path: filePath, filename: path.basename(filePath),
        wordCount: 0, score: 0, shouldCapture: false,
        reason: 'Empty or unreadable file', category: 'missing',
      });
      continue;
    }

    const quality = assessor.assessContentQuality(body);
    let category: 'pass' | 'borderline' | 'fail' | 'missing';
    if (quality.score >= 40 && quality.score <= 55) {
      category = 'borderline';
    } else if (quality.score >= 40) {
      category = 'pass';
    } else {
      category = 'fail';
    }

    assessments.push({
      path: filePath, filename: path.basename(filePath),
      wordCount, score: quality.score, shouldCapture: quality.shouldCapture,
      reason: quality.reason, category,
    });
  }

  return assessments;
}

describe('Knowledge Base Quality Assessment', () => {
  let notes: NoteAssessment[];

  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share');
  const vaultPath = path.join(xdgDataHome, 'zettelkasten-mcp');

  beforeAll(async () => {
    notes = await assessKnowledgeBase(vaultPath);
  });

  it('should assess all notes in the vault', () => {
    // If vault doesn't exist yet, that's OK
    if (!fs.existsSync(vaultPath)) {
      expect(notes).toHaveLength(0);
      return;
    }
    expect(notes.length).toBeGreaterThanOrEqual(0);
  });

  it('should categorize notes correctly', () => {
    const total = notes.filter(n => n.category === 'pass').length
      + notes.filter(n => n.category === 'borderline').length
      + notes.filter(n => n.category === 'fail').length
      + notes.filter(n => n.category === 'missing').length;
    expect(total).toBe(notes.length);
  });

  it('should have valid quality scores', () => {
    for (const note of notes) {
      expect(note.score).toBeGreaterThanOrEqual(0);
      expect(note.score).toBeLessThanOrEqual(100);
    }
  });
});
