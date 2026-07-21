import * as fs from "node:fs";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REMEMBER_PROMPT =
	"Please remember that I understand coding concepts best through cooking metaphors";
const RUST_PROMPT = "Please explain how macros in rust work";
const REMOVE_PROMPT =
	"I was joking about the cooking metaphors. Please remove that preference.";
const RUST_ANSWER =
	"A Rust macro is like a cookie cutter for code. You define rules for the shape once, then apply them to different batches of dough—Rust syntax supplied as input. Depending on that input, the macro can produce slightly different shapes or even elaborate designs. Rust expands the result into code during compilation. This saves you from writing recurring code patterns by hand.";
let toolCallCounter = 0;
let cookingPreferenceId: string | undefined;

function trace(event: Record<string, unknown>): void {
	const tracePath = process.env.OPEN_ZK_KB_PI_DEMO_TRACE;
	if (tracePath) fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
}

function assistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function lastUserText(context: Context): string {
	const message = [...context.messages]
		.reverse()
		.find((item) => item.role === "user");
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function scriptedTool(prompt: string): ToolCall {
	const id = `pi-demo-${++toolCallCounter}`;
	const toolCall: ToolCall =
		prompt === REMEMBER_PROMPT
			? {
					type: "toolCall",
					id,
					name: "knowledge-store",
					arguments: {
						title: "Explain Code With Cooking Metaphors",
						kind: "personalization",
						summary: "Technical explanations use cooking metaphors.",
						guidance:
							"Explain technical concepts with cooking and kitchen metaphors.",
						content:
							"Use cooking and kitchen metaphors when explaining technical concepts. Related preference: [[Explain Code With Cooking Metaphors|Cooking metaphor explanations]].",
						project: "renderer-demo",
						tags: ["explanations", "cooking", "preference"],
						model: "scripted-demo",
					},
				}
			: prompt === REMOVE_PROMPT
				? {
						type: "toolCall",
						id,
						name: "knowledge-maintain",
						arguments: {
							action: "delete",
							noteId: cookingPreferenceId,
							model: "scripted-demo",
						},
					}
				: {
					type: "toolCall",
					id,
					name: "knowledge-health",
					arguments: {
						project: "renderer-demo",
						period: "30d",
						model: "scripted-demo",
					},
				};
	trace({ event: "tool-call", id, tool: toolCall.name });
	return toolCall;
}

function finishWithText(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	text: string,
): void {
	output.content.push({ type: "text", text });
	const contentIndex = output.content.length - 1;
	stream.push({ type: "text_start", contentIndex, partial: output });
	stream.push({
		type: "text_delta",
		contentIndex,
		delta: text,
		partial: output,
	});
	stream.push({
		type: "text_end",
		contentIndex,
		content: text,
		partial: output,
	});
	output.stopReason = "stop";
	stream.push({ type: "done", reason: "stop", message: output });
	stream.end();
}

function finishWithError(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	message: string,
): void {
	output.stopReason = "error";
	output.errorMessage = message;
	stream.push({ type: "error", reason: "error", error: output });
	stream.end();
}

function streamScripted(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(async () => {
		await new Promise(resolve => setTimeout(resolve, 2_000));
		const output = assistantMessage(model);
		stream.push({ type: "start", partial: output });
		if (options?.signal?.aborted) {
			output.stopReason = "aborted";
			output.errorMessage = "The scripted demo request was cancelled.";
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") {
			const serialized = JSON.stringify(last.content);
			if (last.toolName === "knowledge-store" && !last.isError) {
				cookingPreferenceId = serialized.match(/→\s*(\d{16})/)?.[1]
					?? serialized.match(/(\d{16})/)?.[1];
			}
			trace({
				event: "tool-result",
				tool: last.toolName,
				isError: last.isError,
				...(last.toolName === "knowledge-health"
					? {
							healthy:
								/Health \(240 notes\)/i.test(serialized) &&
								/Embedded: 240\/240 notes/i.test(serialized) &&
								/All clear/i.test(serialized),
							metrics: serialized,
						}
					: {}),
			});
			finishWithText(
				stream,
				output,
				last.isError
					? "The knowledge tool failed; the error is shown above."
					: last.toolName === "knowledge-store"
						? "Cooking preference saved."
						: last.toolName === "knowledge-maintain"
							? "Cooking-metaphor preference removed."
							: "",
			);
			return;
		}
		const prompt = lastUserText(context);
		if (prompt === REMOVE_PROMPT && !cookingPreferenceId) {
			finishWithError(stream, output, "Stored cooking preference ID was not captured");
			return;
		}
		if (prompt === RUST_PROMPT) {
			const systemPrompt = context.systemPrompt ?? "";
			const concise = /concise/i.test(systemPrompt);
			const cooking = /cook|kitchen/i.test(systemPrompt);
			trace({ event: "capsule", concise, cooking });
			if (!concise || !cooking) {
				finishWithError(
					stream,
					output,
					"Fresh-session system prompt did not contain both preferences",
				);
				return;
			}
			finishWithText(stream, output, RUST_ANSWER);
			return;
		}
		const toolCall = scriptedTool(prompt);
		output.content.push(toolCall);
		const contentIndex = output.content.length - 1;
		stream.push({ type: "toolcall_start", contentIndex, partial: output });
		stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: JSON.stringify(toolCall.arguments),
			partial: output,
		});
		stream.push({
			type: "toolcall_end",
			contentIndex,
			toolCall,
			partial: output,
		});
		output.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message: output });
		stream.end();
	});
	return stream;
}

export default function scriptedProvider(pi: ExtensionAPI): void {
	pi.on("session_start", (event) =>
		trace({ event: "session_start", reason: event.reason }),
	);
	pi.on("input", (event) => trace({ event: "input", text: event.text }));
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const text = event.message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (text) trace({ event: "assistant-text", text });
	});
	pi.registerProvider("open-zk-demo", {
		name: "Open ZK Demo",
		baseUrl: "http://127.0.0.1",
		api: "open-zk-demo",
		apiKey: "demo",
		models: [
			{
				id: "scripted",
				name: "Scripted Demo",
				api: "open-zk-demo",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 2_048,
			},
		],
		streamSimple: streamScripted,
	});
}
