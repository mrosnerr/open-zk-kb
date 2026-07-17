import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import type { AppConfig, NoteKind } from "./types.js";
import {
	KIND_DEFAULT_LIFECYCLE,
	KIND_DEFAULT_STATUS,
	VALID_LIFECYCLES,
} from "./types.js";
import { expandPath } from "./utils/path.js";

const VALID_NOTE_KINDS = new Set<string>(Object.keys(KIND_DEFAULT_STATUS));

function getXdgDataHome(): string {
	return process.env.XDG_DATA_HOME || expandPath("~/.local/share");
}

function getXdgConfigHome(): string {
	return process.env.XDG_CONFIG_HOME || expandPath("~/.config");
}

/** Path to the config YAML file. Re-evaluated from env on each access for testability. */
export function getConfigPath(): string {
	return path.join(getXdgConfigHome(), "open-zk-kb", "config.yaml");
}

/**
 * @deprecated Use getConfigPath() instead. Kept for backward compatibility.
 */
export const CONFIG_PATH = path.join(
	process.env.XDG_CONFIG_HOME || expandPath("~/.config"),
	"open-zk-kb",
	"config.yaml",
);

// ── Raw YAML shape ──

export interface EmbeddingsConfig {
	enabled?: boolean;
	provider?: "local" | "api";
	model?: string;
	dimensions?: number;
	base_url?: string;
	api_key?: string;
}

interface RawConfig {
	vault?: string;
	logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
	lifecycle?: {
		reviewAfterDays?: number;
		promotionThreshold?: number;
		exemptKinds?: NoteKind[];
		autoArchiveFleetingDays?: number;
	};
	lifecycleDefaults?: {
		defaultForKind?: Record<string, string>;
		detectSnapshotFromSlug?: boolean;
	};
	search?: {
		alwaysIncludeDomainNote?: boolean;
		excludeLogFromSearch?: boolean;
	};
	store?: {
		relatedNotes?: {
			enabled?: boolean;
			maxResults?: number;
			minSimilarity?: number;
			excludeKinds?: string[];
		};
	};
	navigation?: {
		enableProjectIndex?: boolean;
		enableProjectLog?: boolean;
		enableGlobalIndex?: boolean;
		enableGlobalLog?: boolean;
		enableReviewMoc?: boolean;
		mocSplitThreshold?: number;
		mocPreviewCount?: number;
		overviewLogEntryLimit?: number;
	};
	telemetry?: {
		enabled?: boolean;
		share?: boolean;
		id?: string;
	};
	obsidian?: {
		scaffold?: boolean;
		autoUpgrade?: boolean;
		readOnly?: boolean;
	};
	versioning?: {
		enabled?: boolean;
		debounceMs?: number;
	};
	server?: {
		port?: number;
		host?: string;
		authToken?: string;
	};
	embeddings?: EmbeddingsConfig;
}

// ── Defaults ──

export const DEFAULT_CONFIG: AppConfig = {
	logLevel: "INFO",
	vault: path.join(getXdgDataHome(), "open-zk-kb"),
	lifecycle: {
		reviewAfterDays: 14,
		promotionThreshold: 2,
		exemptKinds: ["personalization", "decision"],
		autoArchiveFleetingDays: 90,
	},
	lifecycleDefaults: {
		defaultForKind: { ...KIND_DEFAULT_LIFECYCLE },
		detectSnapshotFromSlug: true,
	},
	search: {
		alwaysIncludeDomainNote: true,
		excludeLogFromSearch: true,
	},
	store: {
		relatedNotes: {
			enabled: true,
			maxResults: 5,
			minSimilarity: 0.7,
			excludeKinds: ["domain", "index", "log"],
		},
	},
	navigation: {
		enableProjectIndex: true,
		enableProjectLog: true,
		enableGlobalIndex: true,
		enableGlobalLog: true,
		enableReviewMoc: true,
		mocSplitThreshold: 30,
		mocPreviewCount: 5,
		overviewLogEntryLimit: 10,
	},
	telemetry: {
		enabled: false,
		share: false,
		id: undefined,
	},
	obsidian: {
		scaffold: true,
		autoUpgrade: true,
		readOnly: true,
	},
	versioning: {
		enabled: true,
		debounceMs: 30000,
	},
	server: {
		port: 17244,
		host: "127.0.0.1",
	},
};

// ── Loader ──

let cachedRaw: RawConfig | null | undefined;

/** Reset cached config. Exported for testing only. */
export function _resetConfigCache(): void {
	cachedRaw = undefined;
}

function loadYamlConfig(): RawConfig | null {
	if (cachedRaw !== undefined) return cachedRaw;

	const configPath = getConfigPath();
	if (!fs.existsSync(configPath)) {
		cachedRaw = null;
		return null;
	}

	try {
		const content = fs.readFileSync(configPath, "utf-8");
		const parsed = YAML.parse(content) as RawConfig | null;
		cachedRaw = parsed;
		return parsed;
	} catch {
		cachedRaw = null;
		return null;
	}
}

// ── Public API ──

function positiveInt(value: unknown, fallback: number): number {
	return Number.isInteger(value) && (value as number) > 0
		? (value as number)
		: fallback;
}

function validPort(value: unknown, fallback: number): number {
	return Number.isInteger(value) &&
		(value as number) >= 0 &&
		(value as number) <= 65535
		? (value as number)
		: fallback;
}

export function getConfig(): AppConfig {
	const raw = loadYamlConfig();

	const vault = raw?.vault ? expandPath(raw.vault) : DEFAULT_CONFIG.vault;

	return {
		vault,
		logLevel: raw?.logLevel ?? DEFAULT_CONFIG.logLevel,
		lifecycle: {
			reviewAfterDays:
				raw?.lifecycle?.reviewAfterDays ??
				DEFAULT_CONFIG.lifecycle.reviewAfterDays,
			promotionThreshold:
				raw?.lifecycle?.promotionThreshold ??
				DEFAULT_CONFIG.lifecycle.promotionThreshold,
			exemptKinds:
				raw?.lifecycle?.exemptKinds ?? DEFAULT_CONFIG.lifecycle.exemptKinds,
			autoArchiveFleetingDays:
				raw?.lifecycle?.autoArchiveFleetingDays ??
				DEFAULT_CONFIG.lifecycle.autoArchiveFleetingDays,
		},
		lifecycleDefaults: {
			defaultForKind: {
				...DEFAULT_CONFIG.lifecycleDefaults.defaultForKind,
				...Object.fromEntries(
					Object.entries(raw?.lifecycleDefaults?.defaultForKind || {}).filter(
						([, v]) => typeof v === "string" && VALID_LIFECYCLES.has(v),
					),
				),
			},
			detectSnapshotFromSlug:
				raw?.lifecycleDefaults?.detectSnapshotFromSlug ??
				DEFAULT_CONFIG.lifecycleDefaults.detectSnapshotFromSlug,
		},
		search: {
			alwaysIncludeDomainNote:
				typeof raw?.search?.alwaysIncludeDomainNote === "boolean"
					? raw.search.alwaysIncludeDomainNote
					: DEFAULT_CONFIG.search.alwaysIncludeDomainNote,
			excludeLogFromSearch:
				typeof raw?.search?.excludeLogFromSearch === "boolean"
					? raw.search.excludeLogFromSearch
					: DEFAULT_CONFIG.search.excludeLogFromSearch,
		},
		store: {
			relatedNotes: {
				enabled:
					typeof raw?.store?.relatedNotes?.enabled === "boolean"
						? raw.store.relatedNotes.enabled
						: DEFAULT_CONFIG.store.relatedNotes.enabled,
				maxResults: positiveInt(
					raw?.store?.relatedNotes?.maxResults,
					DEFAULT_CONFIG.store.relatedNotes.maxResults,
				),
				minSimilarity:
					typeof raw?.store?.relatedNotes?.minSimilarity === "number" &&
					Number.isFinite(raw.store.relatedNotes.minSimilarity)
						? Math.max(0, Math.min(1, raw.store.relatedNotes.minSimilarity))
						: DEFAULT_CONFIG.store.relatedNotes.minSimilarity,
				excludeKinds: Array.isArray(raw?.store?.relatedNotes?.excludeKinds)
					? (raw.store.relatedNotes.excludeKinds.filter((k: string) =>
							VALID_NOTE_KINDS.has(k),
						) as NoteKind[])
					: DEFAULT_CONFIG.store.relatedNotes.excludeKinds,
			},
		},
		navigation: {
			enableProjectIndex:
				typeof raw?.navigation?.enableProjectIndex === "boolean"
					? raw.navigation.enableProjectIndex
					: DEFAULT_CONFIG.navigation.enableProjectIndex,
			enableProjectLog:
				typeof raw?.navigation?.enableProjectLog === "boolean"
					? raw.navigation.enableProjectLog
					: DEFAULT_CONFIG.navigation.enableProjectLog,
			enableGlobalIndex:
				typeof raw?.navigation?.enableGlobalIndex === "boolean"
					? raw.navigation.enableGlobalIndex
					: DEFAULT_CONFIG.navigation.enableGlobalIndex,
			enableGlobalLog:
				typeof raw?.navigation?.enableGlobalLog === "boolean"
					? raw.navigation.enableGlobalLog
					: DEFAULT_CONFIG.navigation.enableGlobalLog,
			enableReviewMoc:
				typeof raw?.navigation?.enableReviewMoc === "boolean"
					? raw.navigation.enableReviewMoc
					: DEFAULT_CONFIG.navigation.enableReviewMoc,
			mocSplitThreshold: positiveInt(
				raw?.navigation?.mocSplitThreshold,
				DEFAULT_CONFIG.navigation.mocSplitThreshold,
			),
			mocPreviewCount: positiveInt(
				raw?.navigation?.mocPreviewCount,
				DEFAULT_CONFIG.navigation.mocPreviewCount,
			),
			overviewLogEntryLimit:
				typeof raw?.navigation?.overviewLogEntryLimit === "number"
					? raw.navigation.overviewLogEntryLimit
					: DEFAULT_CONFIG.navigation.overviewLogEntryLimit,
		},
		telemetry: {
			enabled:
				typeof raw?.telemetry?.enabled === "boolean"
					? raw.telemetry.enabled
					: DEFAULT_CONFIG.telemetry.enabled,
			share:
				typeof raw?.telemetry?.share === "boolean"
					? raw.telemetry.share
					: DEFAULT_CONFIG.telemetry.share,
			id:
				typeof raw?.telemetry?.id === "string"
					? raw.telemetry.id
					: DEFAULT_CONFIG.telemetry.id,
		},
		obsidian: {
			scaffold:
				typeof raw?.obsidian?.scaffold === "boolean"
					? raw.obsidian.scaffold
					: DEFAULT_CONFIG.obsidian.scaffold,
			autoUpgrade:
				typeof raw?.obsidian?.autoUpgrade === "boolean"
					? raw.obsidian.autoUpgrade
					: DEFAULT_CONFIG.obsidian.autoUpgrade,
			readOnly:
				typeof raw?.obsidian?.readOnly === "boolean"
					? raw.obsidian.readOnly
					: DEFAULT_CONFIG.obsidian.readOnly,
		},
		versioning: {
			enabled:
				typeof raw?.versioning?.enabled === "boolean"
					? raw.versioning.enabled
					: DEFAULT_CONFIG.versioning.enabled,
			debounceMs: positiveInt(
				raw?.versioning?.debounceMs,
				DEFAULT_CONFIG.versioning.debounceMs,
			),
		},
		server: {
			port: validPort(raw?.server?.port, DEFAULT_CONFIG.server.port),
			host:
				typeof raw?.server?.host === "string" && raw.server.host.length > 0
					? raw.server.host
					: DEFAULT_CONFIG.server.host,
			authToken:
				typeof raw?.server?.authToken === "string" &&
				raw.server.authToken.length > 0
					? raw.server.authToken
					: undefined,
		},
	};
}

/** Check if telemetry.share has been explicitly set in the YAML config (vs defaulting). */
export function isTelemetryShareConfigured(): boolean {
	const raw = loadYamlConfig();
	return typeof raw?.telemetry?.share === "boolean";
}

export function getEmbeddingsConfig(): EmbeddingsConfig | null {
	const raw = loadYamlConfig();

	return raw?.embeddings ?? null;
}
