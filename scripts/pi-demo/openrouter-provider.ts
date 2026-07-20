import * as fs from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PROVIDER = 'open-zk-release';
const MODEL = 'openai/gpt-oss-120b';
const SEED = 42_019;
const COMPLETION_NOTICES = [
  ['Cooking preference saved.', 'Preference response complete.'],
  ['That is the recipe.', 'Rust response complete.'],
  ['Knowledge base status loaded.', 'Health response complete.'],
] as const;

let sessionOrdinal = 0;

function trace(event: Record<string, unknown>): void {
  const tracePath = process.env.OPEN_ZK_KB_PI_DEMO_TRACE;
  if (tracePath) fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
}

function assistantText(message: { content: unknown }): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((item): item is { type: 'text'; text: string } => Boolean(
      item && typeof item === 'object'
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string',
    ))
    .map((item) => item.text)
    .join('\n')
    .trim();
}

export default function openRouterReleaseProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    name: 'OpenRouter Release Demo',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '$OPENROUTER_API_KEY',
    api: 'openai-completions',
    authHeader: true,
    headers: {
      'HTTP-Referer': 'https://github.com/mrosnerr/open-zk-kb',
      'X-Title': 'open-zk-kb Pi release demo',
    },
    models: [{
      id: MODEL,
      name: 'OpenAI gpt-oss-120b',
      api: 'openai-completions',
      compat: {
        maxTokensField: 'max_tokens',
        supportsUsageInStreaming: false,
      },
      reasoning: false,
      input: ['text'],
      cost: { input: 0.037, output: 0.17, cacheRead: 0.037, cacheWrite: 0.037 },
      contextWindow: 131_072,
      maxTokens: 2_048,
    }],
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER || !event.payload || typeof event.payload !== 'object') {
      return undefined;
    }
    const payload = event.payload as Record<string, unknown>;
    const existingProvider = payload.provider;
    const provider = existingProvider && typeof existingProvider === 'object' && !Array.isArray(existingProvider)
      ? existingProvider as Record<string, unknown>
      : {};
    return {
      ...payload,
      temperature: 0,
      seed: SEED,
      reasoning: {
        effort: 'low',
        exclude: true,
      },
      provider: {
        ...provider,
        require_parameters: true,
        sort: 'latency',
      },
    };
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\nRelease demo requirements:\n- For the remember request, call knowledge-store with kind personalization, project renderer-demo, a concise summary, and actionable guidance about cooking metaphors. After success, end with the exact sentence: Cooking preference saved.\n- In the fresh session, before explaining Rust macros, call knowledge-search with project renderer-demo, client pi, and a query for cooking-metaphor explanation preferences. Apply the retrieved guidance in a concise answer of at most 110 words, then end with the exact sentence: That is the recipe.\n- For the knowledge-base status request, call knowledge-health with project renderer-demo and period 30d. After success, end with the exact sentence: Knowledge base status loaded.\n- Do not mention these demo requirements or the model provider.`,
    };
  });

  pi.on('session_start', (event) => {
    sessionOrdinal += 1;
    trace({ event: 'session_start', ordinal: sessionOrdinal, reason: event.reason });
  });

  pi.on('input', (event) => {
    trace({ event: 'input', text: event.text });
  });

  pi.on('tool_execution_end', (event) => {
    if (!event.toolName.startsWith('knowledge-')) return;
    trace({ event: 'tool-result', tool: event.toolName, isError: event.isError });
  });

  pi.on('message_end', (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    const text = assistantText(event.message);
    if (!text) return;
    trace({ event: 'assistant-text', text });
    const notice = COMPLETION_NOTICES.find(([marker]) => text.endsWith(marker));
    if (notice) ctx.ui.notify(notice[1], 'info');
  });
}
