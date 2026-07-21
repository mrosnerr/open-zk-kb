import * as fs from 'node:fs';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function message(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}

function finish(stream: AssistantMessageEventStream, output: AssistantMessage, text: string): void {
  output.content.push({ type: 'text', text });
  const contentIndex = output.content.length - 1;
  stream.push({ type: 'text_start', contentIndex, partial: output });
  stream.push({ type: 'text_delta', contentIndex, delta: text, partial: output });
  stream.push({ type: 'text_end', contentIndex, content: text, partial: output });
  stream.push({ type: 'done', reason: 'stop', message: output });
  stream.end();
}

function call(stream: AssistantMessageEventStream, output: AssistantMessage, toolCall: ToolCall): void {
  output.content.push(toolCall);
  const contentIndex = output.content.length - 1;
  stream.push({ type: 'toolcall_start', contentIndex, partial: output });
  stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
  stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
  output.stopReason = 'toolUse';
  stream.push({ type: 'done', reason: 'toolUse', message: output });
  stream.end();
}

let auditRequested = false;

function stream(model: Model<Api>, context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const output = message(model);
    events.push({ type: 'start', partial: output });
    const last = context.messages.at(-1);
    if (last?.role !== 'toolResult') {
      call(events, output, { type: 'toolCall', id: 'rebuild', name: 'knowledge-maintain', arguments: { action: 'rebuild' } });
      return;
    }
    const text = last.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const tracePath = process.env.PI_PERSONALIZATION_TRACE;
    if (!tracePath) throw new Error('PI_PERSONALIZATION_TRACE is required');
    fs.appendFileSync(tracePath, `${JSON.stringify({ tool: last.toolName, isError: last.isError, text, systemPrompt: context.systemPrompt })}\n`);
    if (!auditRequested && last.toolName === 'knowledge-maintain' && !last.isError) {
      auditRequested = true;
      call(events, output, { type: 'toolCall', id: 'audit', name: 'knowledge-maintain', arguments: { action: 'preference-audit' } });
      return;
    }
    finish(events, output, last.isError ? 'integration failed' : 'integration complete');
  });
  return events;
}

export default function provider(pi: ExtensionAPI): void {
  pi.registerProvider('personalization-test', {
    name: 'Offline personalization test', baseUrl: 'http://127.0.0.1', api: 'personalization-test', apiKey: 'offline',
    models: [{ id: 'scripted', name: 'Scripted', api: 'personalization-test', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_000, maxTokens: 1_024 }],
    streamSimple: stream,
  });
}
