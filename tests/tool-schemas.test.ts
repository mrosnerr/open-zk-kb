import { describe, expect, it } from 'bun:test';
import { TOOL_DEFINITIONS, PUBLISH_GLOBAL_CANDIDATE_PROPERTIES, type ParamDef } from '../src/tool-meta.js';
import { toZodSchema } from '../src/tool-schemas.js';
import { toTypeBoxSchema } from '../src/pi/tool-schemas.js';

const params: Record<string, ParamDef> = {
  name: { type: 'string', required: true, description: 'A name', enum: ['one', 'two'] },
  count: { type: 'number', required: false, description: 'A count' },
  enabled: { type: 'boolean', required: false },
  tags: { type: 'array', required: false, items: { type: 'string', required: true } },
  nested: {
    type: 'object', required: true, description: 'Nested values',
    properties: { value: { type: 'number', required: true } },
  },
};

describe('shared tool schemas', () => {
  it('defines the complete, unique tool contract', () => {
    expect(TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([
      'knowledge-store', 'knowledge-ingest', 'knowledge-search', 'knowledge-context',
      'knowledge-open', 'knowledge-get', 'knowledge-health', 'knowledge-maintain',
      'knowledge-mine', 'knowledge-template',
    ]);
    expect(new Set(TOOL_DEFINITIONS.map(tool => tool.name)).size).toBe(10);
  });

  it('converts metadata to Zod with validation, optionality, and descriptions', () => {
    const schema = toZodSchema(params);
    expect(schema.safeParse({ name: 'one', nested: { value: 1 } }).success).toBe(true);
    expect(schema.safeParse({ name: 'three', nested: { value: 1 } }).success).toBe(false);
    expect(schema.safeParse({ name: 'one', nested: {} }).success).toBe(false);
    expect(schema.shape.name.description).toBe('A name');
    expect(schema.shape.count.isOptional()).toBe(true);
    expect(schema.shape.tags.isOptional()).toBe(true);
  });

  it('converts metadata to TypeBox with required fields, enum, and nested shapes', () => {
    const schema = toTypeBoxSchema(params) as unknown as {
      properties: Record<string, { description?: string; enum?: string[]; properties?: Record<string, unknown>; items?: unknown }>;
      required: string[];
    };
    expect(schema.required).toEqual(['name', 'nested']);
    expect(schema.properties.name.enum).toEqual(['one', 'two']);
    expect(schema.properties.name.description).toBe('A name');
    expect(schema.properties.tags.items).toBeDefined();
    expect(schema.properties.nested.properties?.value).toBeDefined();
  });

  it('requires each knowledge-mine candidate object', () => {
    const mine = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-mine')!;
    const schema = toZodSchema(mine.params);
    expect(schema.safeParse({ candidates: [undefined] }).success).toBe(false);
  });

  it('requires project on knowledge-store', () => {
    const store = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-store')!;
    const schema = toZodSchema(store.params);
    expect(schema.safeParse({ title: 't', content: 'c', kind: 'observation', summary: 's', guidance: 'g' }).success).toBe(false);
    expect(schema.safeParse({ project: 'p', title: 't', content: 'c', kind: 'observation', summary: 's', guidance: 'g' }).success).toBe(true);
  });

  it('includes publish-global, scope-inventory, and assign-project in maintain actions', () => {
    const maintain = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-maintain')!;
    const schema = toZodSchema(maintain.params);
    expect(schema.safeParse({ action: 'publish-global' }).success).toBe(true);
    expect(schema.safeParse({ action: 'scope-inventory' }).success).toBe(true);
    expect(schema.safeParse({ action: 'assign-project' }).success).toBe(true);
    expect(schema.safeParse({ action: 'invalid-action' }).success).toBe(false);
  });

  it('validates publish-global candidate schema', () => {
    const candidate = toZodSchema(PUBLISH_GLOBAL_CANDIDATE_PROPERTIES);
    const valid = candidate.safeParse({
      title: 'Global Note',
      content: 'Global content',
      kind: 'observation',
      summary: 'Summary',
      guidance: 'Guidance',
    });
    expect(valid.success).toBe(true);
    const invalid = candidate.safeParse({
      title: 'Global Note',
      content: 'Global content',
      kind: 'invalid-kind',
      summary: 'Summary',
      guidance: 'Guidance',
    });
    expect(invalid.success).toBe(false);
    expect(candidate.safeParse({
      title: 'Global Domain',
      content: 'Project domain content',
      kind: 'domain',
      summary: 'Summary',
      guidance: 'Guidance',
    }).success).toBe(false);
  });
});
