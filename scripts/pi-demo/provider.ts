import * as fs from 'node:fs';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

let toolCallCounter = 0;

function trace(event: Record<string, unknown>): void {
  const tracePath = process.env.OPEN_ZK_KB_PI_DEMO_TRACE;
  if (tracePath) fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
}

function assistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function lastUserText(context: Context): string {
  const message = [...context.messages].reverse().find((item) => item.role === 'user');
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function scriptedTool(prompt: string): ToolCall {
  const id = `pi-demo-${++toolCallCounter}`;
  let toolCall: ToolCall;
  if (/remember|store|save/i.test(prompt)) {
    toolCall = {
      type: 'toolCall',
      id,
      name: 'knowledge-store',
      arguments: {
        title: 'Explain Code With Cooking Metaphors',
        kind: 'personalization',
        summary: 'Technical explanations use cooking and kitchen metaphors.',
        guidance: 'Explain technical concepts with cooking and kitchen metaphors.',
        content: 'Functions are recipes, variables are ingredients, loops are repeated stirring, conditionals are taste-testing, caches are spice racks, and errors are burnt dishes.',
        project: 'renderer-demo',
        tags: ['explanations', 'cooking', 'preference'],
        model: 'scripted-demo',
      },
    };
  } else if (/health|status|stale|links/i.test(prompt)) {
    toolCall = {
      type: 'toolCall',
      id,
      name: 'knowledge-health',
      arguments: { project: 'renderer-demo', period: '30d', model: 'scripted-demo' },
    };
  } else if (/context|inventory|recent activity/i.test(prompt)) {
    toolCall = {
      type: 'toolCall',
      id,
      name: 'knowledge-context',
      arguments: { project: 'renderer-demo', logEntries: 5, model: 'scripted-demo' },
    };
  } else {
    toolCall = {
      type: 'toolCall',
      id,
      name: 'knowledge-search',
      arguments: {
        query: 'cooking metaphors technical explanations',
        project: 'renderer-demo',
        client: 'pi',
        limit: 3,
        model: 'scripted-demo',
      },
    };
  }
  trace({ event: 'tool-call', id, tool: toolCall.name });
  return toolCall;
}

function finishWithText(stream: AssistantMessageEventStream, output: AssistantMessage, text: string): void {
  output.content.push({ type: 'text', text });
  const contentIndex = output.content.length - 1;
  stream.push({ type: 'text_start', contentIndex, partial: output });
  stream.push({ type: 'text_delta', contentIndex, delta: text, partial: output });
  stream.push({ type: 'text_end', contentIndex, content: text, partial: output });
  output.stopReason = 'stop';
  stream.push({ type: 'done', reason: 'stop', message: output });
  stream.end();
}

function streamScripted(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const output = assistantMessage(model);
    stream.push({ type: 'start', partial: output });

    if (options?.signal?.aborted) {
      output.stopReason = 'aborted';
      output.errorMessage = 'The scripted demo request was cancelled.';
      stream.push({ type: 'error', reason: 'aborted', error: output });
      stream.end();
      return;
    }

    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') {
      trace({ event: 'tool-result', tool: last.toolName, isError: last.isError });
      if (last.isError) {
        finishWithText(stream, output, 'The knowledge tool failed; the error is shown above.');
        return;
      }
      const textByTool: Record<string, string> = {
        'knowledge-search': 'Found the saved cooking-metaphor preference.',
        'knowledge-store': 'The cooking-metaphor preference is now stored.',
        'knowledge-context': 'The renderer demo context is loaded.',
        'knowledge-health': 'The isolated demo vault health is shown above.',
      };
      finishWithText(stream, output, textByTool[last.toolName] ?? 'The knowledge tool completed.');
      return;
    }

    const toolCall = scriptedTool(lastUserText(context));
    output.content.push(toolCall);
    const contentIndex = output.content.length - 1;
    stream.push({ type: 'toolcall_start', contentIndex, partial: output });
    stream.push({
      type: 'toolcall_delta',
      contentIndex,
      delta: JSON.stringify(toolCall.arguments),
      partial: output,
    });
    stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
    output.stopReason = 'toolUse';
    stream.push({ type: 'done', reason: 'toolUse', message: output });
    stream.end();
  });
  return stream;
}

export default function scriptedProvider(pi: ExtensionAPI): void {
  pi.registerProvider('open-zk-demo', {
    name: 'Open ZK Demo',
    baseUrl: 'http://127.0.0.1',
    api: 'open-zk-demo',
    apiKey: 'demo',
    models: [{
      id: 'scripted',
      name: 'Scripted Demo',
      api: 'open-zk-demo',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 2_048,
    }],
    streamSimple: streamScripted,
  });
}
