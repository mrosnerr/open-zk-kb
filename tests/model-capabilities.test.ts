import { describe, it, expect } from 'bun:test';
import { classifyModel, MODEL_HINT } from '../src/model-capabilities.js';

describe('classifyModel', () => {
  describe('high tier', () => {
    const highModels = [
      'claude-opus-4',
      'claude-opus-4-6',
      'anthropic/claude-opus-4-6',
      'gpt-5',
      'gpt-5.4',
      'openai/gpt-5',
      'o3-pro',
      'o4-preview',
      'gemini-2.5-pro',
      'gemini-25-pro',
      'gemini-ultra',
      'deepseek-r1',
      'kimi-k2',
      'kimi-k2.5',
      'glm-5',
    ];

    for (const model of highModels) {
      it(`classifies "${model}" as high`, () => {
        expect(classifyModel(model)).toBe('high');
      });
    }
  });

  describe('low tier', () => {
    const lowModels = [
      'claude-haiku',
      'claude-3-haiku',
      'gpt-4o-mini',
      'gpt-3.5-turbo',
      'gpt-35-turbo',
      'gpt-5-mini',
      'o3-mini',
      'o4-mini',
      'gemini-flash',
      'gemini-nano',
      'gemma-2b',
      'phi-3',
      'phi-4-mini',
      'qwen-2b',
      'llama-3-8b',
      'llama-8b',
    ];

    for (const model of lowModels) {
      it(`classifies "${model}" as low`, () => {
        expect(classifyModel(model)).toBe('low');
      });
    }
  });

  describe('medium tier (default)', () => {
    const mediumModels = [
      'claude-sonnet-4',
      'claude-3.5-sonnet',
      'gpt-4o',
      'gpt-4-turbo',
      'gemini-pro',
      'gemini-2.0-pro',
      'mistral-large',
      'command-r-plus',
      'unknown-model-xyz',
    ];

    for (const model of mediumModels) {
      it(`classifies "${model}" as medium`, () => {
        expect(classifyModel(model)).toBe('medium');
      });
    }
  });

  describe('undefined/empty input', () => {
    it('returns medium for undefined', () => {
      expect(classifyModel(undefined)).toBe('medium');
    });

    it('returns medium for empty string', () => {
      expect(classifyModel('')).toBe('medium');
    });

    it('returns medium for whitespace-only', () => {
      expect(classifyModel('   ')).toBe('medium');
    });
  });

  describe('provider-prefixed models', () => {
    it('handles anthropic/ prefix', () => {
      expect(classifyModel('anthropic/claude-opus-4')).toBe('high');
    });

    it('handles openai/ prefix', () => {
      expect(classifyModel('openai/gpt-5.4')).toBe('high');
    });

    it('handles github-copilot/ prefix', () => {
      expect(classifyModel('github-copilot/claude-haiku')).toBe('low');
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase', () => {
      expect(classifyModel('Claude-OPUS-4')).toBe('high');
    });

    it('handles mixed case', () => {
      expect(classifyModel('GPT-4o-Mini')).toBe('low');
    });
  });

  describe('whitespace handling', () => {
    it('trims leading/trailing whitespace', () => {
      expect(classifyModel('  claude-opus-4  ')).toBe('high');
    });
  });

  describe('tier collision: low suffix overrides high base', () => {
    const collisionModels: Array<[string, 'low']> = [
      ['gpt-5-mini', 'low'],
      ['gpt-5-nano', 'low'],
      ['o3-mini', 'low'],
      ['o4-mini', 'low'],
    ];

    for (const [model, expected] of collisionModels) {
      it(`classifies "${model}" as ${expected} (low suffix wins)`, () => {
        expect(classifyModel(model)).toBe(expected);
      });
    }
  });
});

describe('MODEL_HINT', () => {
  it('is a non-empty string', () => {
    expect(MODEL_HINT.length).toBeGreaterThan(0);
  });

  it('mentions the model parameter', () => {
    expect(MODEL_HINT).toContain('model');
  });
});
