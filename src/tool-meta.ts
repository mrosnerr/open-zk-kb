// tool-meta.ts — Framework-agnostic tool metadata for open-zk-kb.
// Single source of truth for tool names, descriptions, parameter shapes, and prompt guidance.
// No imports from zod or typebox — pure TypeScript types and plain objects.

// ─── Parameter Definition DSL ─────────────────────────────────────────────────

export interface ParamDef {
	type: "string" | "number" | "boolean" | "array" | "object";
	required: boolean;
	description?: string;
	enum?: readonly string[];
	items?: ParamDef;
	properties?: Record<string, ParamDef>;
}

// ─── Tool Shape ───────────────────────────────────────────────────────────────

export interface ToolMeta {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	executionMode: "sequential" | "parallel";
	params: Record<string, ParamDef>;
}

// ─── Shared Constants ─────────────────────────────────────────────────────────

export const STORABLE_KINDS = [
	"personalization",
	"reference",
	"decision",
	"procedure",
	"resource",
	"observation",
	"domain",
] as const;

export const ALL_KINDS = [...STORABLE_KINDS, "index", "log"] as const;
export const TEMPLATE_KINDS = [...STORABLE_KINDS, "log"] as const;
export const PUBLISHABLE_KINDS = STORABLE_KINDS.filter(kind => kind !== "domain");

export const STATUSES = ["fleeting", "permanent", "archived"] as const;

export const LIFECYCLES = ["living", "snapshot", "append-only"] as const;

export const MAINTAIN_ACTIONS = [
	"promote",
	"archive",
	"delete",
	"rebuild",
	"format",
	"upgrade",
	"upgrade-read",
	"upgrade-apply",
	"review",
	"dedupe",
	"embed",
	"agent-docs",
	"scope-audit",
	"scope-inventory",
	"assign-project",
	"preference-audit",
	"unlinked",
	"broken-links",
	"link-health",
	"migrate-layout",
	"upgrade-vault",
	"full",
	"publish-global",
	"global-reference-audit",
] as const;

export const PUBLISH_GLOBAL_CANDIDATE_PROPERTIES: Record<string, ParamDef> = {
	title: {
		type: "string",
		required: true,
		description: "Distilled global note title — 3-6 word scannable label (max 10 words / 80 chars).",
	},
	content: {
		type: "string",
		required: true,
		description: "Distilled global note content — project-agnostic knowledge",
	},
	kind: {
		type: "string",
		required: true,
		description: "Global note kind — must be storable, non-domain, non-structural",
		enum: PUBLISHABLE_KINDS,
	},
	summary: {
		type: "string",
		required: true,
		description: "One-line present-tense key takeaway for global context",
	},
	guidance: {
		type: "string",
		required: true,
		description: "Imperative actionable instruction for global agent use",
	},
	tags: {
		type: "array",
		required: false,
		description: "Additional topical tags (must not contain project:* or scope:global — added automatically)",
		items: { type: "string", required: true },
	},
};

// ─── Content Structure Hints ──────────────────────────────────────────────────

const CONTENT_STRUCTURE_HINTS =
	"\n\nContent structure by kind:\n" +
	"• decision: context, options, decision, tradeoffs, consequences, reversibility\n" +
	"• procedure: trigger, prerequisites, steps, verification, failures\n" +
	"• observation: what, where, why it matters, implications\n" +
	"• reference: summary, excerpts, content\n" +
	"• domain: agent role, scope, conventions, playbook, boundaries\n" +
	"Use knowledge-template for full structure with examples.";

// ─── Candidate Item Schema (used by knowledge-mine) ───────────────────────────

const CANDIDATE_PROPERTIES: Record<string, ParamDef> = {
	title: {
		type: "string",
		required: true,
		description:
			"Note title — 3-6 word scannable label (max 10 words / 80 chars). Detail belongs in summary.",
	},
	content: {
		type: "string",
		required: true,
		description: "Note content — the extracted knowledge",
	},
	kind: {
		type: "string",
		required: true,
		description: "Note kind",
		enum: STORABLE_KINDS,
	},
	summary: {
		type: "string",
		required: true,
		description: "One-line present-tense key takeaway",
	},
	guidance: {
		type: "string",
		required: true,
		description: "Imperative actionable instruction for agents",
	},
	tags: {
		type: "array",
		required: false,
		description: "Tags for categorization",
		items: { type: "string", required: true },
	},
	source: {
		type: "string",
		required: false,
		description: "Provenance — e.g. session ID where this was found",
	},
	project: {
		type: "string",
		required: false,
		description:
			"Project scope for this candidate — overrides top-level project",
	},
};

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
	{
		name: "knowledge-store",
		label: "Store Knowledge",
		description:
			"Store knowledge in the persistent Zettelkasten knowledge base. One concept per note." +
			CONTENT_STRUCTURE_HINTS,
		promptSnippet:
			"Store or update durable cross-session memory in open-zk-kb.",
		promptGuidelines: [
			"Use knowledge-store immediately when the user asks you to remember a preference, decision, procedure, observation, reference, or useful resource.",
		],
		executionMode: "sequential",
		params: {
			title: {
				type: "string",
				required: true,
				description:
					"Note title — 3-6 word scannable label (max 10 words / 80 chars). Detail belongs in summary.",
			},
			content: {
				type: "string",
				required: true,
				description: "Note content — the knowledge to store",
			},
			kind: {
				type: "string",
				required: true,
				description:
					"Note kind: personalization, reference, decision, procedure, resource, observation, domain",
				enum: STORABLE_KINDS,
			},
			summary: {
				type: "string",
				required: true,
				description: "One-line present-tense key takeaway",
			},
			guidance: {
				type: "string",
				required: true,
				description: "Imperative actionable instruction for agents",
			},
			status: {
				type: "string",
				required: false,
				description: "Override default status (defaults based on kind)",
				enum: STATUSES,
			},
			lifecycle: {
				type: "string",
				required: false,

				description:
					"Note lifecycle: living (mutable), snapshot (immutable), append-only (additive only). Defaults per kind.",
				enum: LIFECYCLES,
			},
			tags: {
				type: "array",
				required: false,
				description: "Tags for categorization",
				items: { type: "string", required: true },
			},
			project: {
				type: "string",
				required: true,
				description: "Current project scope — adds exactly one project:<name> tag",
			},
			client: {
				type: "string",
				required: false,

				description:
					"Client identifier (e.g. claude-code, opencode). Auto-detected from content when omitted.",
			},
			related: {
				type: "array",
				required: false,
				description: "IDs of related notes to link via wikilinks",
				items: { type: "string", required: true },
			},
			model: {
				type: "string",
				required: false,

				description:
					"Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.",
			},
		},
	},

	{
		name: "knowledge-ingest",
		label: "Ingest Knowledge Source",
		description:
			"Extract article content as clean markdown. Returns title, content, word count, and metadata. " +
			"PREFER passing html from your own web tools (Playwright, Exa, web_fetch) — the built-in url fetcher " +
			"is a basic fallback that cannot render JavaScript or bypass bot protection. " +
			"Use the extracted content to create notes via knowledge-store.",
		promptSnippet:
			"Extract URL or HTML content before storing useful resources in open-zk-kb.",
		executionMode: "parallel",
		params: {
			url: {
				type: "string",
				required: false,

				description:
					"URL to fetch and extract. Fallback only — the built-in fetcher cannot handle JavaScript-rendered pages, " +
					"bot protection, or authenticated content. If you have a web tool (Playwright, Exa, web_fetch), fetch with " +
					"that and pass html instead. When passing html, also pass url for relative link resolution.",
			},
			html: {
				type: "string",
				required: false,

				description:
					"Preferred — raw HTML to extract content from. Pass HTML you already fetched via Playwright, Exa, " +
					"web_fetch, or any browser/web tool for best results.",
			},
			model: {
				type: "string",
				required: false,

				description:
					"Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.",
			},
		},
	},

	{
		name: "knowledge-search",
		label: "Search Knowledge",
		description:
			"Search the persistent knowledge base using full-text search and semantic similarity. " +
			"Accepts natural language queries, keywords, or phrases. Returns matching notes with full content.",
		promptSnippet: "Search open-zk-kb for relevant prior context and guidance.",
		promptGuidelines: [
			'Use knowledge-search before work that may benefit from prior cross-session memory; pass client: "pi" for Pi-specific context.',
		],
		executionMode: "parallel",
		params: {
			query: {
				type: "string",
				required: true,
				description:
					"Search query — natural language or keywords. Supports semantic matching when embeddings are enabled.",
			},
			kind: {
				type: "string",
				required: false,
				description: "Filter by note kind",
				enum: ALL_KINDS,
			},
			status: {
				type: "string",
				required: false,
				description: "Filter by status",
				enum: STATUSES,
			},
			lifecycle: {
				type: "string",
				required: false,
				description: "Filter by lifecycle: living, snapshot, append-only",
				enum: LIFECYCLES,
			},
			project: {
				type: "string",
				required: true,
				description: "Current project; searches this project plus explicit global knowledge",
			},
			client: {
				type: "string",
				required: false,

				description:
					"Optional client filter — pass your client name to see only notes visible to your client " +
					"(universal notes always included). Omit to see all notes.",
			},
			tags: {
				type: "array",
				required: false,
				description: "Filter by tags (all must match)",
				items: { type: "string", required: true },
			},
			limit: {
				type: "number",
				required: false,
				description: "Max results (default 10)",
			},
			model: {
				type: "string",
				required: false,

				description:
					"Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.",
			},
		},
	},

	{
		name: "knowledge-context",
		label: "Knowledge Context",
		description:
			"Get context visible to the required current project: its domain note, inventory by kind, recent notes, " +
			"resources, activity log, and automatically visible explicit global knowledge.",
		promptSnippet:
			"Load an open-zk-kb project context at the start of project work.",
		promptGuidelines: [
			"Use knowledge-context at the start of a project session to load prior context, decisions, and recent activity.",
		],
		executionMode: "parallel",
		params: {
			project: {
				type: "string",
				required: true,
				description: "Current project whose visible context is requested",
			},
			logEntries: {
				type: "number",
				required: false,
				description: "Number of recent log entries to show (default: 10)",
			},
			includePreferences: {
				type: "boolean",
				required: false,
				description: "Include a structured capsule of matching permanent preferences",
			},
			client: {
				type: "string",
				required: false,
				description: "Client target used to match scoped preferences",
			},
			model: {
				type: "string",
				required: false,

				description:
					"Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.",
			},
		},
	},

	{
		name: "knowledge-open",
		label: "Open in Obsidian",
		description:
			"Open the knowledge base vault in Obsidian for full-vault human browsing. " +
			"A project focuses its index but does not isolate the vault.",
		promptSnippet:
			"Open open-zk-kb notes in Obsidian for human review when requested.",
		executionMode: "sequential",
		params: {
			project: {
				type: "string",
				required: false,
				description: "Open focused on a specific project's index note",
			},
		},
	},

	{
		name: "knowledge-get",
		label: "Get Knowledge Note",
		description:
			"Retrieve a single note by its exact ID. Faster and more precise than knowledge-search. " +
			"Use when you already know the note ID (e.g. from injected context hints).",
		promptSnippet: "Fetch a specific open-zk-kb note by ID for fast retrieval.",
		executionMode: "parallel",
		params: {
			noteId: {
				type: "string",
				required: true,
				description: "Exact note ID to retrieve",
			},
			project: {
				type: "string",
				required: true,
				description: "Current project used to validate note visibility",
			},
			client: {
				type: "string",
				required: false,
				description: "Optional client applicability filter",
			},
			model: {
				type: "string",
				required: false,

				description:
					"Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.",
			},
		},
	},

	{
		name: "knowledge-health",
		label: "Knowledge Health",
		description:
			"Operational metrics and health indicators: note counts, embedding coverage, link health, " +
			"staleness distribution, growth rate over a configurable period, infrastructure status, and version info.",
		promptSnippet:
			"Check open-zk-kb vault health, staleness, and growth metrics.",
		executionMode: "parallel",
		params: {
			project: {
				type: "string",
				required: true,
				description: "Current project for scoped note metrics",
			},
			period: {
				type: "string",
				required: false,
				description: 'Time window: "7d", "30d", "90d" (default "30d")',
			},
			telemetry: {
				type: "boolean",
				required: false,

				description:
					"Include tool usage and template conformance metrics (requires telemetry.enabled config)",
			},
			model: {
				type: "string",
				required: false,

				description:
					"Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.",
			},
		},
	},

	{
		name: "knowledge-maintain",
		label: "Maintain Knowledge",
		description:
			"Maintain the knowledge base: review (pending notes), dedupe (duplicates), promote, archive, " +
			"delete, rebuild, upgrade, managed agent docs repair, and read-only preference quality evidence.",
		promptSnippet: "Inspect or maintain open-zk-kb health and lifecycle state.",
		executionMode: "sequential",
		params: {
			action: {
				type: "string",
				required: true,
				description:
					"Maintenance action: review (pending notes), dedupe (duplicates), promote, archive, delete, rebuild, " +
					"format (re-serialize all note files with canonical frontmatter and navigation), upgrade, " +
					"embed (backfill embeddings), agent-docs (audit/repair managed agent instruction files), " +
					"scope-audit (detect mis-scoped client tags), scope-inventory (read-only legacy applicability/readiness report), assign-project (confirmed legacy note classification), preference-audit (read-only deterministic evidence for active personalization notes; never changes notes), unlinked (notes with no wikilinks), " +
					"broken-links (wikilinks to non-existent notes), link-health (combined report: unlinked notes + broken links + one-way links), " +
					"migrate-layout (move flat vault to kind-based directory structure), " +
					"upgrade-vault (refresh Obsidian scaffold assets), " +
					"publish-global (project-local → global confirmed publication with preview + token), " +
					"global-reference-audit (read-only explicit-global reference evidence), or " +
					"full (composite: rebuild → migrate-layout → format → dedupe → embed → link-health, in dependency order).",
				enum: MAINTAIN_ACTIONS,
			},
			noteId: {
				type: "string",
				required: false,
				description:
					"Note ID (required for promote/archive/delete/assign-project; source note ID for publish-global; migration ID for upgrade-read)",
			},
			project: {
				type: "string",
				required: false,
				description: "Target project (required for assign-project)",
			},
			filter: {
				type: "string",
				required: false,
				description: "Filter for review action: fleeting or permanent notes",
				enum: ["fleeting", "permanent"] as const,
			},
			days: {
				type: "number",
				required: false,
				description:
					"Days threshold for review (default: from lifecycle.reviewAfterDays config)",
			},
			limit: {
				type: "number",
				required: false,
				description: "Max notes to show (default: 3 for review)",
			},
			dryRun: {
				type: "boolean",
				required: false,
				description: "Preview changes without applying",
			},
			candidate: {
				type: "object",
				required: false,
				description: "Distilled global candidate for publish-global action (required when action is publish-global)",
				properties: PUBLISH_GLOBAL_CANDIDATE_PROPERTIES,
			},
			confirm: {
				type: "boolean",
				required: false,
				description: "Explicit confirmation required for publish-global or assign-project apply",
			},
			token: {
				type: "string",
				required: false,
				description: "Confirmation token from publish-global or assign-project preview (required for apply)",
			},
			model: {
				type: "string",
				required: false,

				description:
					"Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.",
			},
		},
	},

	{
		name: "knowledge-mine",
		label: "Mine Knowledge",
		description:
			"Bulk-screen candidate notes for duplicates and optionally store. Accepts candidates extracted by the agent " +
			"from session history or other sources. Returns each candidate annotated with STORE/SKIP/REVIEW based on " +
			"similarity to existing KB notes. Default is dry-run (preview only).",
		promptSnippet: "Mine previous sessions for candidate open-zk-kb notes.",
		executionMode: "sequential",
		params: {
			candidates: {
				type: "array",
				required: true,
				description: "Array of candidate notes extracted from session history",
				items: {
					type: "object",
					required: true,
					properties: CANDIDATE_PROPERTIES,
				},
			},
			project: {
				type: "string",
				required: true,
				description: "Current project for duplicate screening and stored candidates",
			},
			client: {
				type: "string",
				required: false,
				description: "Optional client applicability filter for duplicate screening",
			},
			dry_run: {
				type: "boolean",
				required: false,
				description: "Preview dedup results without storing (default: true)",
			},
			model: {
				type: "string",
				required: false,
				description: "Your model identifier for richer responses",
			},
		},
	},

	{
		name: "knowledge-template",
		label: "Knowledge Template",
		description:
			"Get the canonical note template for a specific kind. Returns skeleton structure with positive and negative examples. " +
			"Consult before storing structured notes (decision, procedure, domain, reference, observation).",
		promptSnippet:
			"Load an open-zk-kb note template before storing structured knowledge.",
		promptGuidelines: [
			"Use knowledge-template before knowledge-store when creating a structured note kind for the first time in a session.",
		],
		executionMode: "parallel",
		params: {
			kind: {
				type: "string",
				required: true,
				description: "Note kind to get the canonical template for",
				enum: TEMPLATE_KINDS,
			},
			project: {
				type: "string",
				required: false,
				description:
					"Project name — checks for project-specific template overrides",
			},
			model: {
				type: "string",
				required: false,
				description: "Your model identifier",
			},
		},
	},
] as const satisfies readonly ToolMeta[];
