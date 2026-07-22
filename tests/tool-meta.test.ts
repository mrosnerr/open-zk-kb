import { describe, it, expect } from 'bun:test';
import { TOOL_DEFINITIONS, STORABLE_KINDS, ALL_KINDS, STATUSES, LIFECYCLES, MAINTAIN_ACTIONS } from '../src/tool-meta.js';
import type { ParamDef } from '../src/tool-meta.js';
import { toZodSchema } from '../src/tool-schemas.js';
import { toTypeBoxSchema } from '../src/pi/tool-schemas.js';
import { z } from 'zod';

const EXPECTED_TOOL_NAMES = [
  'knowledge-store',
  'knowledge-search',
  'knowledge-get',
  'knowledge-context',
  'knowledge-open',
  'knowledge-ingest',
  'knowledge-health',
  'knowledge-maintain',
  'knowledge-mine',
  'knowledge-template',
];

describe('tool-meta', () => {
  it('exports all 10 tool definitions', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(10);
    const names = TOOL_DEFINITIONS.map(t => t.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('every tool has required metadata fields', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^knowledge-/);
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.promptSnippet.length).toBeGreaterThan(0);
      expect(['sequential', 'parallel']).toContain(tool.executionMode);
      expect(Object.keys(tool.params).length).toBeGreaterThan(0);
    }
  });

  it('every param has type and required fields', () => {
    const validTypes = ['string', 'number', 'boolean', 'array', 'object'];
    function checkParam(param: ParamDef, path: string) {
      expect(validTypes).toContain(param.type);
      expect(typeof param.required).toBe('boolean');
      if (param.type === 'array' && param.items) {
        checkParam(param.items, `${path}.items`);
      }
      if (param.type === 'object' && param.properties) {
        for (const [key, child] of Object.entries(param.properties)) {
          checkParam(child, `${path}.${key}`);
        }
      }
    }
    for (const tool of TOOL_DEFINITIONS) {
      for (const [key, param] of Object.entries(tool.params)) {
        checkParam(param, `${tool.name}.${key}`);
      }
    }
  });

  it('publishing excludes domain while mining exposes an optional client', () => {
    const maintain = TOOL_DEFINITIONS.find(t => t.name === 'knowledge-maintain')!;
    const candidate = maintain.params.candidate;
    expect(candidate.properties?.kind.enum).toContain('reference');
    expect(candidate.properties?.kind.enum).not.toContain('domain');

    const mine = TOOL_DEFINITIONS.find(t => t.name === 'knowledge-mine')!;
    expect(mine.params.client.required).toBe(false);
  });

  it('knowledge-context documents required project visibility with automatic globals', () => {
    const context = TOOL_DEFINITIONS.find(t => t.name === 'knowledge-context')!;
    expect(context.params.project.required).toBe(true);
    expect(context.description).toContain('automatically visible explicit global knowledge');
    expect(context.description).not.toContain('Without project');
  });

  it('knowledge-store description includes structure hints', () => {
    const store = TOOL_DEFINITIONS.find(t => t.name === 'knowledge-store')!;
    expect(store.description).toContain('Content structure by kind');
    expect(store.description).toContain('decision:');
    expect(store.description).toContain('procedure:');
    expect(store.description).toContain('observation:');
    expect(store.description).toContain('knowledge-template');
  });

  it('shared constants have expected values', () => {
    expect(STORABLE_KINDS).toContain('decision');
    expect(STORABLE_KINDS).toContain('observation');
    expect(STORABLE_KINDS).not.toContain('index');
    expect(STORABLE_KINDS).not.toContain('log');
    expect(ALL_KINDS).toContain('index');
    expect(ALL_KINDS).toContain('log');
    expect(STATUSES).toContain('fleeting');
    expect(STATUSES).toContain('permanent');
    expect(STATUSES).toContain('archived');
    expect(LIFECYCLES).toContain('living');
    expect(LIFECYCLES).toContain('snapshot');
    expect(MAINTAIN_ACTIONS).toContain('rebuild');
    expect(MAINTAIN_ACTIONS).toContain('full');
  });
});

describe('toZodSchema', () => {
  it('generates valid Zod schemas for all tools', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const schema = toZodSchema(tool.params);
      expect(schema).toBeDefined();
      expect(schema instanceof z.ZodObject).toBe(true);
    }
  });

  it('handles required and optional fields', () => {
    const schema = toZodSchema({
      required: { type: 'string', required: true, description: 'required field' },
      optional: { type: 'string', required: false, description: 'optional field' },
    });
    // Required field should reject undefined
    expect(() => schema.parse({ optional: 'x' })).toThrow();
    // Optional field should accept undefined
    expect(() => schema.parse({ required: 'x' })).not.toThrow();
  });

  it('handles enum fields', () => {
    const schema = toZodSchema({
      kind: { type: 'string', required: true, enum: ['a', 'b', 'c'] as const },
    });
    expect(() => schema.parse({ kind: 'a' })).not.toThrow();
    expect(() => schema.parse({ kind: 'invalid' })).toThrow();
  });

  it('handles array fields with items', () => {
    const schema = toZodSchema({
      tags: { type: 'array', required: false, items: { type: 'string', required: true } },
    });
    expect(() => schema.parse({})).not.toThrow();
    expect(() => schema.parse({ tags: ['a', 'b'] })).not.toThrow();
  });

  it('handles nested object fields', () => {
    const schema = toZodSchema({
      candidates: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          required: true,
          properties: {
            title: { type: 'string', required: true },
            tags: { type: 'array', required: false, items: { type: 'string', required: true } },
          },
        },
      },
    });
    expect(() => schema.parse({ candidates: [{ title: 'test' }] })).not.toThrow();
    expect(() => schema.parse({ candidates: [{}] })).toThrow();
  });

  it('knowledge-store schema validates correctly', () => {
    const store = TOOL_DEFINITIONS.find(t => t.name === 'knowledge-store')!;
    const schema = toZodSchema(store.params);
    // Valid input
    expect(() => schema.parse({
      kind: 'decision',
      title: 'Test decision',
      content: 'Some content',
      summary: 'A test',
      guidance: 'Do this',
      project: 'example-project',
    })).not.toThrow();
    // Missing required field
    expect(() => schema.parse({
      kind: 'decision',
      title: 'Test',
    })).toThrow();
  });
});

describe('toTypeBoxSchema', () => {
  it('generates TypeBox schemas for all tools', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const schema = toTypeBoxSchema(tool.params);
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
    }
  });

  it('marks required and optional fields correctly', () => {
    const schema = toTypeBoxSchema({
      required: { type: 'string', required: true },
      optional: { type: 'string', required: false },
    });
    // Required fields appear in schema.required array, optional fields do not
    expect(schema.properties.required).toBeDefined();
    expect(schema.properties.optional).toBeDefined();
    expect(schema.required).toContain('required');
    expect(schema.required ?? []).not.toContain('optional');
  });

  it('handles enum fields', () => {
    const schema = toTypeBoxSchema({
      kind: { type: 'string', required: true, enum: ['a', 'b'] as const },
    });
    expect(schema.properties.kind).toBeDefined();
    // TypeBox enums produce a union type
    expect(schema.properties.kind.anyOf || schema.properties.kind.enum).toBeDefined();
  });
});
