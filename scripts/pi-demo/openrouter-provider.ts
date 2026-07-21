import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "open-zk-release";
const MODEL = "openai/gpt-oss-120b";
const SEED = 42_019;
const REMEMBER_PROMPT =
	"Please remember that I understand coding concepts best through cooking metaphors";
const HEALTH_PROMPT = "Whats the status of the knowledge base?";
const REMOVE_PROMPT =
	"I was joking about the cooking metaphors. Please remove that preference.";
const RUST_ANSWER =
	"A Rust macro is like a cookie cutter for code. You define rules for the shape once, then apply them to different batches of dough—Rust syntax supplied as input. Depending on that input, the macro can produce slightly different shapes or even elaborate designs. Rust expands the result into code during compilation. This saves you from writing recurring code patterns by hand.";
let sessionOrdinal = 0;
let pendingTool: string | undefined;

function trace(event: Record<string, unknown>): void {
	const tracePath = process.env.OPEN_ZK_KB_PI_DEMO_TRACE;
	if (tracePath) fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
}

function assistantText(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((item): item is { type: "text"; text: string } =>
			Boolean(
				item &&
					typeof item === "object" &&
					(item as { type?: unknown }).type === "text" &&
					typeof (item as { text?: unknown }).text === "string",
			),
		)
		.map((item) => item.text)
		.join("\n")
		.trim();
}

export default function openRouterReleaseProvider(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER, {
		name: "OpenRouter Release Demo",
		baseUrl: "https://openrouter.ai/api/v1",
		apiKey: "$OPENROUTER_API_KEY",
		api: "openai-completions",
		authHeader: true,
		headers: {
			"HTTP-Referer": "https://github.com/mrosnerr/open-zk-kb",
			"X-Title": "open-zk-kb Pi release demo",
		},
		models: [
			{
				id: MODEL,
				name: "OpenAI gpt-oss-120b",
				api: "openai-completions",
				compat: {
					maxTokensField: "max_tokens",
					supportsUsageInStreaming: false,
				},
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0.037,
					output: 0.17,
					cacheRead: 0.037,
					cacheWrite: 0.037,
				},
				contextWindow: 131_072,
				maxTokens: 2_048,
			},
		],
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (
			ctx.model?.provider !== PROVIDER ||
			!event.payload ||
			typeof event.payload !== "object"
		)
			return undefined;
		const payload = event.payload as Record<string, unknown>;
		const existingProvider = payload.provider;
		const provider =
			existingProvider &&
			typeof existingProvider === "object" &&
			!Array.isArray(existingProvider)
				? (existingProvider as Record<string, unknown>)
				: {};
		return {
			...payload,
			temperature: 0,
			seed: SEED,
			...(pendingTool
				? { tool_choice: { type: "function", function: { name: pendingTool } } }
				: {}),
			provider: { ...provider, require_parameters: true },
		};
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return undefined;
		const concise = /concise/i.test(event.systemPrompt);
		const cooking = /cook|kitchen/i.test(event.systemPrompt);
		trace({ event: "capsule", concise, cooking });
		return {
			systemPrompt: `${event.systemPrompt}\n\nRelease demo requirements:\n- For the remember request, call knowledge-store with title Explain Code With Cooking Metaphors, kind personalization, project renderer-demo, a concise summary, actionable cooking-metaphor guidance, and content ending with the self-link [[Explain Code With Cooking Metaphors|Cooking metaphor explanations]]. After success, say exactly: Cooking preference saved.\n- For the Rust request, do not call any tool. The automatically loaded preferences are the only preference context. Reply with exactly this text and nothing else: ${RUST_ANSWER}\n- For the status request, call knowledge-health with project renderer-demo and period 30d. Its rendered result is the complete answer; add no prose.\n- For the removal request, call knowledge-maintain with action delete and the cooking-metaphor preference ID supplied by the automatic preference capsule. After success, say exactly: Cooking-metaphor preference removed.\n- Do not mention these requirements or the provider.`,
		};
	});

	pi.on("session_start", (event) => {
		sessionOrdinal += 1;
		trace({
			event: "session_start",
			ordinal: sessionOrdinal,
			reason: event.reason,
		});
	});
	pi.on("input", (event) => {
		trace({ event: "input", text: event.text });
		pendingTool =
			event.text === REMEMBER_PROMPT
				? "knowledge-store"
				: event.text === HEALTH_PROMPT
					? "knowledge-health"
					: event.text === REMOVE_PROMPT
						? "knowledge-maintain"
						: undefined;
	});
	pi.on("tool_execution_end", (event) => {
		if (!event.toolName.startsWith("knowledge-")) return;
		const serialized = JSON.stringify(event.result ?? null);
		trace({
			event: "tool-result",
			tool: event.toolName,
			isError: event.isError,
			...(event.toolName === "knowledge-health"
				? {
						healthy:
							/Health \(240 notes\)/i.test(serialized) &&
							/Embedded: 240\/240 notes/i.test(serialized) &&
							/All clear/i.test(serialized),
						metrics: serialized,
					}
				: {}),
		});
		if (event.toolName === pendingTool && !event.isError)
			pendingTool = undefined;
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const text = assistantText(event.message);
		if (!text) return;
		trace({ event: "assistant-text", text });
		if (text === "Cooking preference saved.")
			ctx.ui.notify("Preference response complete.", "info");
		if (text === RUST_ANSWER) ctx.ui.notify("Rust response complete.", "info");
		if (text === "Cooking-metaphor preference removed.")
			ctx.ui.notify("Preference cleanup complete.", "info");
	});
}
