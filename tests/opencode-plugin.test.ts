import { describe, it, expect } from 'bun:test';
import {
  detectPatterns,
  scoreContent,
  hashPattern,
  extractSurroundingContext,
  sanitizeForCapture,
  isAtomicContent,
  QUALITY_GATE_SYSTEM_PROMPT,
  AGENT_RESPONSE_PATTERNS,
  USER_CAPTURE_PATTERNS,
  type CapturePattern,
  type DetectedPattern,
} from '../src/opencode-plugin.js';

describe('detectPatterns', () => {
  it('detects decision pattern from agent response', () => {
    const content = 'We decided to use PostgreSQL for the database.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'decision')).toBe(true);
  });

  it('detects decision pattern with "I recommend"', () => {
    const content = 'I recommend using TypeScript for this project to improve type safety.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'decision')).toBe(true);
  });

  it('detects preference_noted pattern from agent', () => {
    const content = "I'll remember that you prefer dark mode for all your interfaces.";
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'preference_noted')).toBe(true);
  });

  it('detects insight pattern', () => {
    const content = 'Turns out the cache was the bottleneck in the system.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'insight')).toBe(true);
  });

  it('detects solution pattern', () => {
    const content = 'The fix is to reset the connection pool every hour.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'solution')).toBe(true);
  });

  it('detects procedure pattern', () => {
    const content = 'To do this: first install the dependencies, then configure the environment.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'procedure')).toBe(true);
  });

  it('detects generalization pattern', () => {
    const content = 'In general, the pattern is to always use TypeScript for type safety.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'generalization')).toBe(true);
  });

  it('returns empty array for non-matching content', () => {
    const content = 'Hello world';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected).toEqual([]);
  });

  it('detects preference_statement from user patterns', () => {
    const content = 'I prefer tabs over spaces for indentation.';
    const patterns = USER_CAPTURE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'preference_statement')).toBe(true);
  });

  it('detects user_policy pattern', () => {
    const content = 'From now on, let\'s always use ESLint for all projects.';
    const patterns = USER_CAPTURE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'user_policy')).toBe(true);
  });

  it('detects explicit_remember pattern', () => {
    const content = 'Remember that the API key rotates weekly on Mondays.';
    const patterns = USER_CAPTURE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'explicit_remember')).toBe(true);
  });

  it('detects project_context pattern', () => {
    const content = 'We use Next.js for our frontend and Express for the backend.';
    const patterns = USER_CAPTURE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.name === 'project_context')).toBe(true);
  });
});

describe('scoreContent', () => {
  it('scores personal preference signals high', () => {
    const content = 'I prefer dark mode for all interfaces';
    const score = scoreContent(content);
    
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it('scores decision with causal reasoning high', () => {
    const content = 'We decided to use PostgreSQL because of its MVCC support and reliability.';
    const score = scoreContent(content);
    
    expect(score).toBeGreaterThanOrEqual(4);
  });

  it('scores insight with causal explanation high', () => {
    const content = 'Turns out the cache was the root cause of the performance issue.';
    const score = scoreContent(content);
    
    expect(score).toBeGreaterThanOrEqual(4);
  });

  it('scores non-matching content as zero', () => {
    const content = 'Hello world';
    const score = scoreContent(content);
    
    expect(score).toBe(0);
  });

  it('scores content matching all categories above 10 (no cap)', () => {
    const content = `
      I prefer to use TypeScript because it prevents bugs.
      The pattern is to always use ESLint.
      This approach is better than JavaScript.
      The workflow is: first install, then configure.
      The rule is: never skip tests.
      The definition is: a best practice is a proven method.
      From now on, we should always review code.
      I think this is important to note.
    `;
    const score = scoreContent(content);
    
    expect(score).toBeGreaterThan(10);
  });

  it('penalizes very long content with word-count penalty', () => {
    const longContent = 'I prefer ' + 'word '.repeat(350) + 'because it is better.';
    const score = scoreContent(longContent);

    expect(score).toBeLessThanOrEqual(5);
  });

  it('delegation prompt language scores low on pattern match', () => {
    const delegationFragment = 'Fix the type error in auth.ts on line 42';
    const score = scoreContent(delegationFragment);

    expect(score).toBeLessThanOrEqual(2);
  });

  it('scores multiple categories appropriately', () => {
    const content = 'The pattern is to always use TypeScript because it is better than JavaScript.';
    const score = scoreContent(content);
    
    expect(score).toBeGreaterThanOrEqual(5);
  });
});

describe('extractSurroundingContext', () => {
  it('returns context with ellipsis when match is in middle of text', () => {
    const fullText = 'x'.repeat(300) + 'important information' + 'y'.repeat(300);
    const matchStr = 'important information';
    const context = extractSurroundingContext(fullText, matchStr);
    
    expect(context).toContain('...');
    expect(context).toContain(matchStr);
  });

  it('returns context without prefix ellipsis when match is at start', () => {
    const fullText = 'Important information is at the start of this text.';
    const matchStr = 'Important information';
    const context = extractSurroundingContext(fullText, matchStr);
    
    expect(context).toStartWith('Important');
    expect(context).not.toMatch(/^\.\.\./);
  });

  it('returns context without suffix ellipsis when match is at end', () => {
    const fullText = 'This text ends with important information';
    const matchStr = 'important information';
    const context = extractSurroundingContext(fullText, matchStr);
    
    expect(context).toContain(matchStr);
    expect(context).not.toMatch(/\.\.\.$/);
  });

  it('returns match as-is when not found in full text', () => {
    const fullText = 'This is some text';
    const matchStr = 'not in text';
    const context = extractSurroundingContext(fullText, matchStr);
    
    expect(context).toBe(matchStr);
  });

  it('returns full text without ellipsis when match is the entire text', () => {
    const fullText = 'Short text';
    const matchStr = 'Short text';
    const context = extractSurroundingContext(fullText, matchStr);
    
    expect(context).toBe(fullText);
    expect(context).not.toContain('...');
  });
});

describe('sanitizeForCapture', () => {
  it('strips HTML comments including internal markers', () => {
    const input = '<!-- OMO_INTERNAL_INITIATOR -->Remember to use TypeScript';
    const result = sanitizeForCapture(input);
    expect(result).toBe('Remember to use TypeScript');
    expect(result).not.toContain('OMO_INTERNAL_INITIATOR');
  });

  it('strips delegation prompt blocks', () => {
    const input = `Some preamble text.

TASK: Fix the bug in auth.ts
MUST DO: Use the existing pattern
MUST NOT DO: Add new dependencies

Some trailing text.`;
    const result = sanitizeForCapture(input);
    expect(result).not.toContain('TASK:');
    expect(result).not.toContain('MUST DO:');
    expect(result).not.toContain('MUST NOT DO:');
    expect(result).toContain('Some preamble text');
  });

  it('strips markdown delegation headers', () => {
    const input = '## 1. TASK\nDo something\n## 2. MUST DO\nSomething else';
    const result = sanitizeForCapture(input);
    expect(result).not.toContain('## 1. TASK');
    expect(result).not.toContain('## 2. MUST DO');
  });

  it('preserves normal content', () => {
    const input = 'I prefer using TypeScript because it catches bugs at compile time.';
    const result = sanitizeForCapture(input);
    expect(result).toBe(input);
  });

  it('handles empty string after sanitization', () => {
    const input = '<!-- just a comment -->';
    const result = sanitizeForCapture(input);
    expect(result).toBe('');
  });
});

describe('isAtomicContent', () => {
  it('returns true for simple single-topic content', () => {
    expect(isAtomicContent('I prefer tabs over spaces for indentation')).toBe(true);
  });

  it('returns true for content with one causal connector', () => {
    expect(isAtomicContent('We chose PostgreSQL because of ACID support')).toBe(true);
  });

  it('returns true for content with two causal connectors', () => {
    expect(isAtomicContent('The cache fails because of TTL issues, thus we switched to Redis')).toBe(true);
  });

  it('returns false for content with many causal connectors', () => {
    const multiTopic = 'This fails because X. Therefore Y. Consequently Z needs to change because of W.';
    expect(isAtomicContent(multiTopic)).toBe(false);
  });

  it('returns false for content with multiple headings', () => {
    const multiSection = '## Overview\nSome text\n## Details\nMore text';
    expect(isAtomicContent(multiSection)).toBe(false);
  });

  it('returns true for content with one heading', () => {
    expect(isAtomicContent('## Decision\nWe chose to use FTS5')).toBe(true);
  });
});

describe('QUALITY_GATE_SYSTEM_PROMPT', () => {
  it('includes explicit delegation prompt rejection criteria', () => {
    expect(QUALITY_GATE_SYSTEM_PROMPT).toContain('TASK:');
    expect(QUALITY_GATE_SYSTEM_PROMPT).toContain('MUST DO:');
    expect(QUALITY_GATE_SYSTEM_PROMPT).toContain('MUST NOT DO:');
    expect(QUALITY_GATE_SYSTEM_PROMPT).toContain('EXPECTED OUTCOME:');
  });

  it('requires confidence field and not reason field in JSON schema', () => {
    expect(QUALITY_GATE_SYSTEM_PROMPT).toContain('"confidence": 0.0 to 1.0');
    expect(QUALITY_GATE_SYSTEM_PROMPT).not.toContain('"reason":');
  });

  it('contains explicit accept and reject guidance examples', () => {
    expect(QUALITY_GATE_SYSTEM_PROMPT).toContain('EXAMPLES OF CONTENT TO REJECT');
    expect(QUALITY_GATE_SYSTEM_PROMPT).toContain('EXAMPLES OF CONTENT TO ACCEPT');
  });
});

describe('hashPattern', () => {
  it('returns first 50 chars lowercased with spaces collapsed', () => {
    const content = 'This Is A Test Pattern With Multiple Spaces';
    const hash = hashPattern(content);
    
    expect(hash).toBe('thisisatestpatternwithmultiplespaces');
    expect(hash.length).toBeLessThanOrEqual(50);
  });

  it('produces identical hash for identical content', () => {
    const content = 'The same pattern text';
    const hash1 = hashPattern(content);
    const hash2 = hashPattern(content);
    
    expect(hash1).toBe(hash2);
  });

  it('produces same hash for content differing after char 50', () => {
    const content1 = 'This is a pattern that is exactly fifty characters long!!!!';
    const content2 = 'This is a pattern that is exactly fifty characters long????';
    const hash1 = hashPattern(content1);
    const hash2 = hashPattern(content2);
    
    expect(hash1).toBe(hash2);
  });

  it('returns empty string for empty input', () => {
    const hash = hashPattern('');
    
    expect(hash).toBe('');
  });
});

describe('DetectedPattern interface', () => {
  it('includes all required fields from pattern detection', () => {
    const content = 'We decided to use PostgreSQL for reliability.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    const pattern = detected[0];
    
    expect(pattern).toHaveProperty('name');
    expect(pattern).toHaveProperty('type');
    expect(pattern).toHaveProperty('match');
    expect(pattern).toHaveProperty('confidence');
    expect(pattern).toHaveProperty('suggestedKind');
    expect(pattern).toHaveProperty('context');
  });

  it('extracts match text correctly', () => {
    const content = 'I recommend using TypeScript for type safety.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    const match = detected[0].match;
    expect(match.length).toBeGreaterThan(0);
    expect(match).not.toContain('I recommend');
  });

  it('includes context in detected patterns', () => {
    const content = 'We decided to use PostgreSQL for the database because of MVCC.';
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
    const pattern = detected[0];
    expect(pattern.context).toBeDefined();
    expect(pattern.context!.length).toBeGreaterThan(0);
  });
});

describe('CapturePattern interface', () => {
  it('agent patterns have valid structure', () => {
    for (const pattern of AGENT_RESPONSE_PATTERNS) {
      expect(pattern).toHaveProperty('name');
      expect(pattern).toHaveProperty('regex');
      expect(pattern).toHaveProperty('type');
      expect(pattern).toHaveProperty('suggestedKind');
      expect(pattern).toHaveProperty('confidence');
      
      expect(typeof pattern.name).toBe('string');
      expect(pattern.regex instanceof RegExp).toBe(true);
      expect(typeof pattern.type).toBe('string');
      expect(typeof pattern.suggestedKind).toBe('string');
      expect(typeof pattern.confidence).toBe('number');
      expect(pattern.confidence).toBeGreaterThanOrEqual(0);
      expect(pattern.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('user patterns have valid structure', () => {
    for (const pattern of USER_CAPTURE_PATTERNS) {
      expect(pattern).toHaveProperty('name');
      expect(pattern).toHaveProperty('regex');
      expect(pattern).toHaveProperty('type');
      expect(pattern).toHaveProperty('suggestedKind');
      expect(pattern).toHaveProperty('confidence');
      
      expect(typeof pattern.name).toBe('string');
      expect(pattern.regex instanceof RegExp).toBe(true);
      expect(typeof pattern.type).toBe('string');
      expect(typeof pattern.suggestedKind).toBe('string');
      expect(typeof pattern.confidence).toBe('number');
      expect(pattern.confidence).toBeGreaterThanOrEqual(0);
      expect(pattern.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('Pattern confidence levels', () => {
  it('explicit_remember has highest confidence', () => {
    const pattern = USER_CAPTURE_PATTERNS.find(p => p.name === 'explicit_remember');
    expect(pattern?.confidence).toBe(0.9);
  });

  it('preference_noted has high confidence', () => {
    const pattern = AGENT_RESPONSE_PATTERNS.find(p => p.name === 'preference_noted');
    expect(pattern?.confidence).toBe(0.8);
  });

  it('warning confidence is tuned for stricter capture', () => {
    const pattern = AGENT_RESPONSE_PATTERNS.find(p => p.name === 'warning');
    expect(pattern?.confidence).toBe(0.7);
  });
});

describe('Pattern type coverage', () => {
  it('agent patterns cover all expected types', () => {
    const types = new Set(AGENT_RESPONSE_PATTERNS.map(p => p.type));
    expect(types.has('decision')).toBe(true);
    expect(types.has('preference')).toBe(true);
    expect(types.has('fact')).toBe(true);
    expect(types.has('procedure')).toBe(true);
    expect(types.has('solution')).toBe(true);
    expect(types.has('pattern')).toBe(true);
  });

  it('user patterns cover all expected types', () => {
    const types = new Set(USER_CAPTURE_PATTERNS.map(p => p.type));
    expect(types.has('preference')).toBe(true);
    expect(types.has('fact')).toBe(true);
    expect(types.has('pattern')).toBe(true);
  });
});

describe('Suggested kinds mapping', () => {
  it('decision patterns suggest decision kind', () => {
    const decisionPatterns = AGENT_RESPONSE_PATTERNS.filter(p => p.type === 'decision');
    for (const pattern of decisionPatterns) {
      expect(pattern.suggestedKind).toBe('decision');
    }
  });

  it('procedure patterns suggest procedure kind', () => {
    const procedurePatterns = AGENT_RESPONSE_PATTERNS.filter(p => p.type === 'procedure');
    for (const pattern of procedurePatterns) {
      expect(pattern.suggestedKind).toBe('procedure');
    }
  });

  it('preference patterns suggest personalization or observation kind', () => {
    const prefPatterns = USER_CAPTURE_PATTERNS.filter(p => p.type === 'preference');
    for (const pattern of prefPatterns) {
      expect(['personalization', 'observation']).toContain(pattern.suggestedKind);
    }
  });
});

describe('Edge cases', () => {
  it('handles case-insensitive pattern matching', () => {
    const content = 'I PREFER DARK MODE FOR ALL INTERFACES';
    const patterns = USER_CAPTURE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
  });

  it('handles patterns with special characters', () => {
    const content = "I'll remember that you prefer TypeScript's strict mode.";
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(content, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
  });

  it('handles very long content without crashing', () => {
    const longContent = 'We decided to use PostgreSQL. ' + 'x'.repeat(10000);
    const patterns = AGENT_RESPONSE_PATTERNS;
    const detected = detectPatterns(longContent, patterns);
    
    expect(detected.length).toBeGreaterThan(0);
  });

  it('handles empty pattern array', () => {
    const content = 'Some content here';
    const detected = detectPatterns(content, []);
    
    expect(detected).toEqual([]);
  });

  it('scoreContent handles very long text', () => {
    const longContent = 'I prefer dark mode. ' + 'x'.repeat(10000);
    const score = scoreContent(longContent);
    
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('extractSurroundingContext handles unicode characters', () => {
    const fullText = 'This is a test with émojis 🎉 and spëcial characters.';
    const matchStr = 'émojis 🎉';
    const context = extractSurroundingContext(fullText, matchStr);
    
    expect(context).toContain(matchStr);
  });
});
