/**
 * Google Antigravity / Cloud Code Assist OAuth, quota, catalog, and pi-ai
 * stream adapter for LearnHarness.
 *
 * Self-contained in src/agent/antigravity.ts to keep upstream merges clean.
 * Obeys the hexagonal import law: never imports from src/server or src/store.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type {
	Api,
	AssistantMessage,
	JsonObject,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	ThinkingLevel,
	ThinkingLevelMap,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage, withoutInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { PATHS } from "../../config.ts";
import {
	ANTIGRAVITY_PROVIDER,
	type AntigravityAccountSummary,
	type AntigravityLoginState,
	type AntigravityModelQuota,
	type AntigravityQuotaBucket,
	type AntigravityQuotaGroup,
	type AntigravityQuotaSnapshot,
	type AntigravityStatusResponse,
} from "../core/contracts/antigravity.ts";

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const DAILY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ENDPOINT_FALLBACKS = [DEFAULT_ENDPOINT, DAILY_ENDPOINT];
const QUOTA_ENDPOINTS = [DAILY_ENDPOINT, DEFAULT_ENDPOINT];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const REDIRECT_PATH = "/oauth-callback";
const SCOPES = [
	"https://www.googleapis.com/auth/aicode",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const DEFAULT_CLIENT_ID = [
	"1071006060591",
	"-tmhssin2h21lcre235vtolojh4g403ep",
	".apps.googleusercontent",
	".com",
].join("");
const DEFAULT_CLIENT_SECRET = ["GOC", "SPX", "-K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("");

const ANTIGRAVITY_CLIENT_VERSION = "1.3.4";
const ANTIGRAVITY_CLIENT_BUILD = "998275202";
const PLATFORM = process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
	"You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
	"CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.";

interface AntigravityModelSpec {
	id: string;
	name: string;
	inputModalities: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	reasoningEfforts: ("low" | "medium" | "high")[];
}

const BUILTIN_MODELS: AntigravityModelSpec[] = [
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "gemini-3.8-flash-high",
		name: "Gemini 3.8 Flash (High)",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "gemini-3.8-flash-medium",
		name: "Gemini 3.8 Flash (Medium)",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "gemini-3.8-flash-low",
		name: "Gemini 3.8 Flash (Low)",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "gemini-3.8-flash-tiered",
		name: "Gemini 3.8 Flash Tiered",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65535,
		reasoningEfforts: ["low", "high"],
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "high"],
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "claude-opus-5.5",
		name: "Claude Opus 5.5",
		inputModalities: ["text", "image"],
		contextWindow: 250000,
		maxTokens: 64000,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "claude-sonnet-5.5",
		name: "Claude Sonnet 5.5",
		inputModalities: ["text", "image"],
		contextWindow: 200000,
		maxTokens: 64000,
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		inputModalities: ["text", "image"],
		contextWindow: 250000,
		maxTokens: 64000,
		reasoningEfforts: ["high"],
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		inputModalities: ["text", "image"],
		contextWindow: 200000,
		maxTokens: 64000,
		reasoningEfforts: ["high"],
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		inputModalities: ["text"],
		contextWindow: 131072,
		maxTokens: 32768,
		reasoningEfforts: ["medium"],
	},
];

const ROUTING: Record<string, { off: string; routing: Record<string, string>; defaultRequestId: string }> = {
	"gemini-4-argon": {
		off: "gemini-4-argon-low",
		routing: {
			minimal: "gemini-4-argon-low",
			low: "gemini-4-argon-low",
			medium: "gemini-4-argon-medium",
			high: "gemini-4-argon-high",
			xhigh: "gemini-4-argon-high",
		},
		defaultRequestId: "gemini-4-argon-high",
	},
	"gemini-3.8-flash": {
		off: "gemini-3.8-flash-low",
		routing: {
			minimal: "gemini-3.8-flash-low",
			low: "gemini-3.8-flash-low",
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
			xhigh: "gemini-3.8-flash-high",
		},
		defaultRequestId: "gemini-3.8-flash-high",
	},
	"gemini-3.7-flash": {
		off: "gemini-3.7-flash-tiered",
		routing: {
			minimal: "gemini-3.7-flash-tiered",
			low: "gemini-3.7-flash-tiered",
			medium: "gemini-3.7-flash-tiered",
			high: "gemini-3.7-flash-tiered",
			xhigh: "gemini-3.7-flash-tiered",
		},
		defaultRequestId: "gemini-3.7-flash-tiered",
	},
	"gemini-3.6-flash": {
		off: "gemini-3.6-flash-low",
		routing: {
			minimal: "gemini-3.6-flash-low",
			low: "gemini-3.6-flash-low",
			medium: "gemini-3.6-flash-medium",
			high: "gemini-3.6-flash-high",
			xhigh: "gemini-3.6-flash-high",
		},
		defaultRequestId: "gemini-3.6-flash-high",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash-extra-low",
		routing: {
			minimal: "gemini-3.5-flash-extra-low",
			low: "gemini-3.5-flash-low",
			medium: "gemini-3.5-flash-low",
			high: "gemini-3-flash-agent",
			xhigh: "gemini-3-flash-agent",
		},
		defaultRequestId: "gemini-3-flash-agent",
	},
	"gemini-3.1-pro": {
		off: "gemini-3.1-pro-low",
		routing: {
			minimal: "gemini-3.1-pro-low",
			low: "gemini-3.1-pro-low",
			medium: "gemini-pro-agent",
			high: "gemini-pro-agent",
			xhigh: "gemini-pro-agent",
		},
		defaultRequestId: "gemini-pro-agent",
	},
	"claude-opus-5.5": {
		off: "claude-opus-5-5-high",
		routing: {
			minimal: "claude-opus-5-5-low",
			low: "claude-opus-5-5-low",
			medium: "claude-opus-5-5-medium",
			high: "claude-opus-5-5-high",
			xhigh: "claude-opus-5-5-high",
		},
		defaultRequestId: "claude-opus-5-5-high",
	},
	"claude-sonnet-5.5": {
		off: "claude-sonnet-5-5-high",
		routing: {
			minimal: "claude-sonnet-5-5-low",
			low: "claude-sonnet-5-5-low",
			medium: "claude-sonnet-5-5-medium",
			high: "claude-sonnet-5-5-high",
			xhigh: "claude-sonnet-5-5-high",
		},
		defaultRequestId: "claude-sonnet-5-5-high",
	},
	"claude-opus-4-6": {
		off: "claude-opus-4-6-thinking",
		routing: {
			minimal: "claude-opus-4-6-thinking",
			low: "claude-opus-4-6-thinking",
			medium: "claude-opus-4-6-thinking",
			high: "claude-opus-4-6-thinking",
			xhigh: "claude-opus-4-6-thinking",
		},
		defaultRequestId: "claude-opus-4-6-thinking",
	},
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6-thinking",
		routing: {
			minimal: "claude-sonnet-4-6-thinking",
			low: "claude-sonnet-4-6-thinking",
			medium: "claude-sonnet-4-6-thinking",
			high: "claude-sonnet-4-6-thinking",
			xhigh: "claude-sonnet-4-6-thinking",
		},
		defaultRequestId: "claude-sonnet-4-6-thinking",
	},
	"gpt-oss-120b": {
		off: "gpt-oss-120b-medium",
		routing: {
			minimal: "gpt-oss-120b-medium",
			low: "gpt-oss-120b-medium",
			medium: "gpt-oss-120b-medium",
			high: "gpt-oss-120b-medium",
			xhigh: "gpt-oss-120b-medium",
		},
		defaultRequestId: "gpt-oss-120b-medium",
	},
};

export interface StoredAccountRecord {
	id: string;
	email: string;
	label: string;
	providerSubject?: string;
	credentials: {
		access: string;
		refresh: string;
		expires: number;
		projectId?: string;
	};
	createdAt: number;
	updatedAt: number;
}

interface StoredAccountDocument {
	version: 2;
	revision: number;
	activeAccountId: string | null;
	accounts: StoredAccountRecord[];
}

interface ActiveLoginFlow extends AntigravityLoginState {
	cancel?: () => void;
	acceptCallback?: (url: string) => void;
	done?: Promise<void>;
}

interface AntigravityRuntimeState {
	loginFlow: ActiveLoginFlow | null;
	quotaByAccount: Map<string, AntigravityQuotaSnapshot>;
	quotaErrorByAccount: Map<string, string>;
	catalogSpecs: AntigravityModelSpec[];
	onLoginSuccess?: (accountId: string) => void;
}

const STATE_KEY = Symbol.for("lh.antigravity.runtime");

function runtimeState(): AntigravityRuntimeState {
	const g = globalThis as Record<symbol, AntigravityRuntimeState | undefined>;
	if (!g[STATE_KEY]) {
		g[STATE_KEY] = {
			loginFlow: null,
			quotaByAccount: new Map(),
			quotaErrorByAccount: new Map(),
			catalogSpecs: [...BUILTIN_MODELS],
		};
	}
	return g[STATE_KEY]!;
}

export function onAntigravityLoginSuccess(hook: (accountId: string) => void): void {
	runtimeState().onLoginSuccess = hook;
}

function storeFilePath(): string {
	const dataDir = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : PATHS.data;
	return path.join(dataDir, "antigravity-oauth.json");
}

function dshStoreFilePath(): string {
	return path.join(homedir(), ".dsh", "storages", "antigravity-oauth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAccountDocument(file = storeFilePath()): StoredAccountDocument {
	if (!existsSync(file)) {
		return { version: 2, revision: 0, activeAccountId: null, accounts: [] };
	}
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (!isRecord(raw) || !Array.isArray(raw.accounts)) {
			return { version: 2, revision: 0, activeAccountId: null, accounts: [] };
		}
		const accounts: StoredAccountRecord[] = [];
		for (const item of raw.accounts) {
			if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.credentials)) continue;
			const creds = item.credentials;
			if (typeof creds.access !== "string" || typeof creds.refresh !== "string") continue;
			accounts.push({
				id: item.id,
				email: typeof item.email === "string" ? item.email : "",
				label: typeof item.label === "string" ? item.label : typeof item.email === "string" ? item.email : "Google account",
				...(typeof item.providerSubject === "string" ? { providerSubject: item.providerSubject } : {}),
				credentials: {
					access: creds.access,
					refresh: creds.refresh,
					expires: typeof creds.expires === "number" ? creds.expires : 0,
					...(typeof creds.projectId === "string" ? { projectId: creds.projectId } : {}),
				},
				createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
				updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
			});
		}
		const activeAccountId =
			typeof raw.activeAccountId === "string" && accounts.some((a) => a.id === raw.activeAccountId)
				? raw.activeAccountId
				: accounts[0]?.id ?? null;
		return {
			version: 2,
			revision: typeof raw.revision === "number" ? raw.revision : 0,
			activeAccountId,
			accounts,
		};
	} catch {
		return { version: 2, revision: 0, activeAccountId: null, accounts: [] };
	}
}

function writeAccountDocument(doc: StoredAccountDocument, file = storeFilePath()): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${randomUUID()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

export function dshImportAvailable(): boolean {
	const dshDoc = readAccountDocument(dshStoreFilePath());
	return dshDoc.accounts.length > 0;
}

export function importDshAntigravityAccounts(): { imported: number; activeAccountId: string | null } {
	const dshDoc = readAccountDocument(dshStoreFilePath());
	if (!dshDoc.accounts.length) {
		throw new Error("No saved Antigravity accounts found in ~/.dsh/storages/antigravity-oauth.json.");
	}
	const local = readAccountDocument();
	let imported = 0;
	for (const incoming of dshDoc.accounts) {
		const existing = local.accounts.find(
			(a) =>
				(incoming.providerSubject && a.providerSubject === incoming.providerSubject) ||
				(incoming.email && a.email === incoming.email),
		);
		if (existing) {
			existing.credentials = { ...incoming.credentials };
			existing.updatedAt = Date.now();
		} else {
			local.accounts.push({ ...incoming, id: incoming.id || randomUUID() });
			imported++;
		}
	}
	if (!local.activeAccountId && local.accounts.length > 0) {
		const preferred = dshDoc.activeAccountId
			? local.accounts.find((a) => a.id === dshDoc.activeAccountId || a.email === dshDoc.accounts.find((d) => d.id === dshDoc.activeAccountId)?.email)
			: undefined;
		local.activeAccountId = preferred?.id ?? local.accounts[0]!.id;
	}
	local.revision += 1;
	writeAccountDocument(local);
	if (local.activeAccountId) {
		runtimeState().onLoginSuccess?.(local.activeAccountId);
	}
	return { imported, activeAccountId: local.activeAccountId };
}

export function antigravityConnected(): boolean {
	const doc = readAccountDocument();
	return Boolean(doc.activeAccountId && doc.accounts.some((a) => a.id === doc.activeAccountId));
}

function toThinkingLevelMap(efforts: ("low" | "medium" | "high")[]): ThinkingLevelMap {
	const hasLow = efforts.includes("low");
	const hasMedium = efforts.includes("medium");
	const hasHigh = efforts.includes("high");
	return {
		off: null,
		minimal: null,
		low: hasLow ? "low" : null,
		medium: hasMedium ? "medium" : null,
		high: hasHigh ? "high" : null,
	};
}

function specToPiModel(spec: AntigravityModelSpec): Model<Api> {
	return {
		id: spec.id,
		name: spec.name,
		api: "google-generative-ai",
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: spec.reasoningEfforts.length > 0,
		input: [...spec.inputModalities],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
		thinkingLevelMap: toThinkingLevelMap(spec.reasoningEfforts),
	};
}

export function antigravityModels(): Model<Api>[] {
	if (!antigravityConnected()) return [];
	const specs = runtimeState().catalogSpecs;
	const seen = new Set<string>();
	const merged: AntigravityModelSpec[] = [];
	for (const s of [...specs, ...BUILTIN_MODELS]) {
		if (seen.has(s.id)) continue;
		seen.add(s.id);
		merged.push(s);
	}
	return merged.map(specToPiModel);
}

export function antigravityModel(id: string): Model<Api> | undefined {
	const found = antigravityModels().find((m) => m.id === id);
	if (found) return found;
	if (!antigravityConnected()) return undefined;
	const builtin = BUILTIN_MODELS.find((m) => m.id === id);
	if (builtin) return specToPiModel(builtin);
	if (/^(gemini-|claude-|gpt-oss-)/i.test(id)) {
		return specToPiModel({
			id,
			name: id,
			inputModalities: id.startsWith("gpt-oss-") ? ["text"] : ["text", "image"],
			contextWindow: id.startsWith("claude-") ? 200000 : id.startsWith("gpt-oss-") ? 131072 : 1048576,
			maxTokens: id.startsWith("claude-") ? 64000 : id.startsWith("gpt-oss-") ? 32768 : 65536,
			reasoningEfforts: ["low", "medium", "high"],
		});
	}
	return undefined;
}

function defaultUserAgent(): string {
	const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	return (
		process.env.ANTIGRAVITY_USER_AGENT ||
		`antigravity/cli/${ANTIGRAVITY_CLIENT_VERSION} (aidev_client; os_type=${os}; arch=${arch}; cl=${ANTIGRAVITY_CLIENT_BUILD}; auth_method=consumer)`
	);
}

function antigravityHeaders(token: string, accept = "text/event-stream"): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: accept,
		"User-Agent": defaultUserAgent(),
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform: PLATFORM,
			pluginType: "GEMINI",
		}),
	};
}

function stableProjectId(seed: string): string {
	const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function extractProjectId(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;
	const direct =
		data.antigravityProjectId ??
		data.projectId ??
		data.backendProjectId ??
		data.userDefinedCloudaicompanionProject ??
		data.cloudaicompanionProject ??
		data.project;
	if (typeof direct === "string" && direct.length > 0) return direct;
	if (isRecord(direct) && typeof direct.id === "string" && direct.id.length > 0) return direct.id;
	for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
		const value = data[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				const nested = extractProjectId(item);
				if (nested) return nested;
				if (typeof item === "string" && item.length > 0) return item;
			}
		}
	}
	return undefined;
}

async function discoverProjectId(token: string): Promise<string | undefined> {
	const body = JSON.stringify({
		metadata: {
			ideType: "ANTIGRAVITY",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		},
	});
	for (const endpoint of ENDPOINT_FALLBACKS) {
		try {
			const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: antigravityHeaders(token, "application/json"),
				body,
				signal: AbortSignal.timeout(8000),
			});
			if (!res.ok) continue;
			const project = extractProjectId(await res.json());
			if (project) return project;
		} catch {
			// Try next endpoint
		}
	}
	return undefined;
}

async function refreshAccountCredentials(account: StoredAccountRecord): Promise<StoredAccountRecord["credentials"]> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: process.env.ANTIGRAVITY_CLIENT_ID || DEFAULT_CLIENT_ID,
			client_secret: process.env.ANTIGRAVITY_CLIENT_SECRET || DEFAULT_CLIENT_SECRET,
			refresh_token: account.credentials.refresh,
			grant_type: "refresh_token",
		}).toString(),
		signal: AbortSignal.timeout(30_000),
	});
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !data || typeof data.access_token !== "string") {
		throw new Error("Google session expired or could not be refreshed. Sign in again in Settings → Providers.");
	}
	const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
	const projectId = account.credentials.projectId || (await discoverProjectId(data.access_token));
	return {
		access: data.access_token,
		refresh: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : account.credentials.refresh,
		expires: Date.now() + expiresIn * 1000 - 60_000,
		...(projectId ? { projectId } : {}),
	};
}

async function ensureActiveCredentials(accountId?: string): Promise<{
	account: StoredAccountRecord;
	token: string;
	projectId: string;
}> {
	const doc = readAccountDocument();
	const targetId = accountId ?? doc.activeAccountId;
	const account = doc.accounts.find((a) => a.id === targetId);
	if (!account) {
		throw new Error("No active Google Antigravity account. Sign in under Settings → Providers.");
	}
	if (!account.credentials.access || account.credentials.expires <= Date.now() + 60_000) {
		const refreshed = await refreshAccountCredentials(account);
		account.credentials = refreshed;
		account.updatedAt = Date.now();
		doc.revision += 1;
		writeAccountDocument(doc);
	} else if (!account.credentials.projectId) {
		const discovered = await discoverProjectId(account.credentials.access);
		if (discovered) {
			account.credentials.projectId = discovered;
			account.updatedAt = Date.now();
			doc.revision += 1;
			writeAccountDocument(doc);
		}
	}
	const projectId =
		process.env.ANTIGRAVITY_PROJECT_ID?.trim() ||
		account.credentials.projectId ||
		stableProjectId(account.email || account.id);
	return { account, token: account.credentials.access, projectId };
}

function clampFraction(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

function remainingPercent(remaining: number | undefined): number | undefined {
	if (remaining === undefined) return undefined;
	return Math.round(remaining * 1000) / 10;
}

function formatReset(resetTime: string | number | undefined): string | undefined {
	if (!resetTime) return undefined;
	const numeric = typeof resetTime === "number" ? resetTime : /^\d+$/.test(String(resetTime)) ? Number(resetTime) : NaN;
	const timestamp = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(String(resetTime));
	if (!Number.isFinite(timestamp)) return String(resetTime);
	const delta = timestamp - Date.now();
	if (delta <= 0) return "now";
	const totalMinutes = Math.max(1, Math.ceil(delta / 60000));
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function parseQuotaGroups(data: unknown): AntigravityQuotaGroup[] {
	let summary: Record<string, unknown> = isRecord(data) ? data : {};
	for (let depth = 0; depth < 3; depth++) {
		if (Array.isArray(summary.groups) || Array.isArray(summary.buckets)) break;
		const nested = summary.response ?? summary.result ?? summary.data;
		if (!isRecord(nested)) break;
		summary = nested;
	}
	const hasGroups =
		Array.isArray(summary.groups) &&
		summary.groups.some((g) => isRecord(g) && Array.isArray(g.buckets) && g.buckets.length > 0);
	const rawGroups = hasGroups
		? (summary.groups as unknown[])
		: Array.isArray(summary.buckets)
			? [{ displayName: "Quota", buckets: summary.buckets }]
			: [];

	const groups: AntigravityQuotaGroup[] = [];
	for (const rawGroup of rawGroups) {
		if (!isRecord(rawGroup)) continue;
		const buckets: AntigravityQuotaBucket[] = [];
		for (const rawBucket of Array.isArray(rawGroup.buckets) ? rawGroup.buckets : []) {
			if (!isRecord(rawBucket)) continue;
			const remainingFraction = clampFraction(
				rawBucket.remainingFraction ??
					rawBucket.remaining_fraction ??
					(isRecord(rawBucket.remaining) ? rawBucket.remaining.remainingFraction : undefined),
			);
			const bucketId = rawBucket.bucketId ?? rawBucket.bucket_id ?? rawBucket.modelId ?? rawBucket.model_id;
			if (remainingFraction === undefined && !bucketId) continue;
			const rawReset = rawBucket.resetTime ?? rawBucket.reset_time;
			const resetTime = typeof rawReset === "string" ? rawReset : typeof rawReset === "number" ? String(rawReset) : undefined;
			buckets.push({
				id: String(bucketId || rawBucket.displayName || "limit"),
				label: String(rawBucket.displayName || bucketId || "Limit"),
				window: rawBucket.window || rawBucket.windowName ? String(rawBucket.window || rawBucket.windowName) : undefined,
				remainingFraction,
				remainingPercent: remainingPercent(remainingFraction),
				resetTime,
				resetLabel: formatReset(resetTime),
				description: typeof rawBucket.description === "string" ? rawBucket.description : undefined,
				...(rawBucket.disabled === true ? { disabled: true } : {}),
			});
		}
		// Sort 5h window before weekly window (matching dsh-antigravity)
		buckets.sort((a, b) => {
			const a5h = /5[- ]*hour|5h/i.test(`${a.id} ${a.label} ${a.window ?? ""}`);
			const b5h = /5[- ]*hour|5h/i.test(`${b.id} ${b.label} ${b.window ?? ""}`);
			if (a5h !== b5h) return a5h ? -1 : 1;
			return 0;
		});
		if (buckets.length > 0) {
			groups.push({
				displayName: String(rawGroup.displayName || "Quota"),
				description: typeof rawGroup.description === "string" ? rawGroup.description : undefined,
				buckets,
			});
		}
	}
	return groups;
}

export async function fetchAntigravityQuota(options: { accountId?: string; force?: boolean } = {}): Promise<AntigravityQuotaSnapshot | null> {
	const state = runtimeState();
	const doc = readAccountDocument();
	const targetId = options.accountId ?? doc.activeAccountId;
	if (!targetId) return null;
	if (!options.force) {
		const cached = state.quotaByAccount.get(targetId);
		if (cached && Date.now() - cached.fetchedAt < 60_000) return cached;
	}
	try {
		const { account, token, projectId } = await ensureActiveCredentials(targetId);
		let summaryData: unknown = null;
		for (const endpoint of QUOTA_ENDPOINTS) {
			try {
				const res = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
					method: "POST",
					headers: antigravityHeaders(token, "application/json"),
					body: JSON.stringify({ project: projectId }),
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					summaryData = await res.json();
					break;
				}
			} catch {
				// try next endpoint
			}
		}

		// Also fetch available models to populate per-model remaining fractions and dynamic catalog
		const mergedModels: Record<string, unknown> = {};
		for (const endpoint of ENDPOINT_FALLBACKS) {
			try {
				const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
					method: "POST",
					headers: antigravityHeaders(token, "application/json"),
					body: JSON.stringify({ project: projectId }),
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					const data = (await res.json()) as Record<string, unknown>;
					if (isRecord(data.models)) {
						Object.assign(mergedModels, data.models);
					}
					break;
				}
			} catch {
				// continue
			}
		}

		const groups = parseQuotaGroups(summaryData);
		const modelQuotas: AntigravityModelQuota[] = [];
		const discoveredSpecs: AntigravityModelSpec[] = [...BUILTIN_MODELS];
		const seenIds = new Set(BUILTIN_MODELS.map((m) => m.id));

		for (const [modelId, info] of Object.entries(mergedModels)) {
			if (!isRecord(info) || info.isInternal || modelId.startsWith("chat_") || modelId.startsWith("tab_")) continue;
			const quotaInfo = isRecord(info.quotaInfo) ? info.quotaInfo : {};
			const rem = clampFraction(quotaInfo.remainingFraction);
			const rawReset = quotaInfo.resetTime ?? quotaInfo.reset_time;
			const resetTime = typeof rawReset === "string" ? rawReset : undefined;
			const name =
				typeof info.displayName === "string"
					? info.displayName
					: typeof info.label === "string"
						? info.label
						: modelId;
			modelQuotas.push({
				id: modelId,
				name,
				remainingFraction: rem,
				remainingPercent: remainingPercent(rem),
				resetTime,
				resetLabel: formatReset(resetTime),
			});
			if (!seenIds.has(modelId) && /^(gemini-|claude-|gpt-oss-)/i.test(modelId) && !/\s/.test(modelId)) {
				seenIds.add(modelId);
				discoveredSpecs.push({
					id: modelId,
					name,
					inputModalities: modelId.startsWith("gpt-oss-") ? ["text"] : ["text", "image"],
					contextWindow: modelId.startsWith("claude-") ? 200000 : modelId.startsWith("gpt-oss-") ? 131072 : 1048576,
					maxTokens: modelId.startsWith("claude-") ? 64000 : modelId.startsWith("gpt-oss-") ? 32768 : 65536,
					reasoningEfforts: modelId.startsWith("gpt-oss-") ? ["medium"] : ["low", "medium", "high"],
				});
			}
		}

		// Map Gemini / Claude pool quota onto built-in logical models (`gemini-4-argon`, etc.)
		for (const builtin of BUILTIN_MODELS) {
			if (modelQuotas.some((m) => m.id === builtin.id && m.remainingPercent !== undefined)) continue;
			const familyMatch = modelQuotas.find((m) =>
				builtin.id.startsWith("gemini-")
					? m.id.startsWith("gemini-") && m.remainingPercent !== undefined
					: (m.id.startsWith("claude-") || m.id.startsWith("gpt-")) && m.remainingPercent !== undefined,
			);
			if (familyMatch) {
				modelQuotas.push({
					id: builtin.id,
					name: builtin.name,
					remainingFraction: familyMatch.remainingFraction,
					remainingPercent: familyMatch.remainingPercent,
					resetTime: familyMatch.resetTime,
					resetLabel: familyMatch.resetLabel,
				});
			}
		}

		state.catalogSpecs = discoveredSpecs;
		const snapshot: AntigravityQuotaSnapshot = {
			accountId: account.id,
			groups,
			models: modelQuotas,
			fetchedAt: Date.now(),
		};
		state.quotaByAccount.set(account.id, snapshot);
		state.quotaErrorByAccount.delete(account.id);
		return snapshot;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		state.quotaErrorByAccount.set(targetId, message);
		return state.quotaByAccount.get(targetId) ?? null;
	}
}

function openExternalBrowser(url: string): void {
	try {
		if (process.platform === "darwin") {
			spawn("open", [url], { stdio: "ignore", detached: true }).unref();
		} else if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
		} else {
			spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
		}
	} catch {
		// Best effort
	}
}

export async function beginAntigravityLogin(options: { openBrowser?: boolean; accountId?: string } = {}): Promise<AntigravityLoginState> {
	const state = runtimeState();
	if (state.loginFlow?.status === "pending") {
		if (options.openBrowser === true && state.loginFlow.authUrl) {
			openExternalBrowser(state.loginFlow.authUrl);
		}
		return {
			status: state.loginFlow.status,
			flowId: state.loginFlow.flowId,
			authUrl: state.loginFlow.authUrl,
			startedAt: state.loginFlow.startedAt,
		};
	}

	const port = Number(process.env.ANTIGRAVITY_CALLBACK_PORT || 51121);
	const callbackUrl = `http://localhost:${port}${REDIRECT_PATH}`;
	const oauthState = randomBytes(32).toString("base64url");
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const flowId = randomBytes(16).toString("hex");
	const controller = new AbortController();

	let resolveCode!: (code: string) => void;
	let rejectCode!: (err: Error) => void;
	const codePromise = new Promise<string>((res, rej) => {
		resolveCode = res;
		rejectCode = rej;
	});
	void codePromise.catch(() => {});

	let accepted = false;
	const acceptCallback = (rawUrl: string) => {
		let parsed: URL;
		try {
			parsed = new URL(rawUrl, callbackUrl);
		} catch {
			throw new Error("Invalid OAuth callback URL.");
		}
		if (parsed.pathname !== REDIRECT_PATH || parsed.searchParams.get("state") !== oauthState) {
			throw new Error("Invalid OAuth callback state.");
		}
		if (accepted) throw new Error("Callback already accepted.");
		if (parsed.searchParams.has("error")) {
			accepted = true;
			rejectCode(new Error("Google sign-in was canceled or denied."));
			return;
		}
		const code = parsed.searchParams.get("code");
		if (!code) throw new Error("Missing authorization code in callback.");
		accepted = true;
		resolveCode(code);
	};

	const server: Server = createServer((req, res) => {
		const send = (status: number, text: string) => {
			res.writeHead(status, {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
			});
			res.end(text);
		};
		if (req.method !== "GET") return send(405, "Method not allowed.");
		try {
			const url = new URL(req.url || "", callbackUrl);
			if (url.pathname !== REDIRECT_PATH) return send(404, "Not found.");
			acceptCallback(url.href);
			send(200, "Google authorization received! You can close this tab and return to LearnHarness.");
		} catch (err) {
			send(400, err instanceof Error ? err.message : "Invalid callback.");
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", () => reject(new Error(`Cannot bind OAuth callback port ${port}. Close any other pending login and retry.`)));
		server.listen(port, "127.0.0.1", () => resolve());
	});

	const timer = setTimeout(() => controller.abort(), 5 * 60_000);
	const onAbort = () => {
		rejectCode(new Error("OAuth login canceled or timed out."));
		server.close();
	};
	controller.signal.addEventListener("abort", onAbort, { once: true });

	const params = new URLSearchParams({
		client_id: process.env.ANTIGRAVITY_CLIENT_ID || DEFAULT_CLIENT_ID,
		response_type: "code",
		redirect_uri: callbackUrl,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: oauthState,
		access_type: "offline",
		prompt: "consent select_account",
	});
	const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

	const flow: ActiveLoginFlow = {
		status: "pending",
		flowId,
		authUrl,
		startedAt: Date.now(),
		cancel: () => controller.abort(),
		acceptCallback,
	};
	state.loginFlow = flow;

	flow.done = (async () => {
		try {
			const code = await codePromise;
			controller.signal.throwIfAborted();
			const tokenRes = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: process.env.ANTIGRAVITY_CLIENT_ID || DEFAULT_CLIENT_ID,
					client_secret: process.env.ANTIGRAVITY_CLIENT_SECRET || DEFAULT_CLIENT_SECRET,
					code,
					grant_type: "authorization_code",
					redirect_uri: callbackUrl,
					code_verifier: verifier,
				}).toString(),
				signal: AbortSignal.timeout(30_000),
			});
			const tokenData = (await tokenRes.json().catch(() => null)) as Record<string, unknown> | null;
			if (!tokenRes.ok || !tokenData || typeof tokenData.access_token !== "string") {
				throw new Error(`OAuth token exchange failed (HTTP ${tokenRes.status}).`);
			}
			if (typeof tokenData.refresh_token !== "string" || !tokenData.refresh_token) {
				throw new Error("No refresh token received from Google. Please allow offline access and sign in again.");
			}
			const infoRes = await fetch(USERINFO_URL, {
				headers: { Authorization: `Bearer ${tokenData.access_token}` },
				signal: AbortSignal.timeout(15_000),
			});
			if (!infoRes.ok) throw new Error("Unable to verify Google account identity.");
			const identity = (await infoRes.json().catch(() => null)) as Record<string, unknown> | null;
			if (!identity || typeof identity.id !== "string") {
				throw new Error("Google account identity response is missing id.");
			}
			const email = identity.verified_email === true && typeof identity.email === "string" ? identity.email : "";
			const projectId = await discoverProjectId(tokenData.access_token);
			const expiresIn = typeof tokenData.expires_in === "number" && tokenData.expires_in > 0 ? tokenData.expires_in : 3600;

			const doc = readAccountDocument();
			const now = Date.now();
			let record =
				(options.accountId ? doc.accounts.find((a) => a.id === options.accountId) : undefined) ??
				doc.accounts.find((a) => a.providerSubject === identity.id || (email && a.email === email));
			if (!record) {
				record = {
					id: randomUUID(),
					email,
					label: email || "Google account",
					providerSubject: identity.id,
					credentials: {
						access: tokenData.access_token,
						refresh: tokenData.refresh_token,
						expires: now + expiresIn * 1000 - 60_000,
						...(projectId ? { projectId } : {}),
					},
					createdAt: now,
					updatedAt: now,
				};
				doc.accounts.push(record);
			} else {
				record.email = email || record.email;
				record.label = email || record.label;
				record.providerSubject = identity.id;
				record.credentials = {
					access: tokenData.access_token,
					refresh: tokenData.refresh_token,
					expires: now + expiresIn * 1000 - 60_000,
					...(projectId ? { projectId } : {}),
				};
				record.updatedAt = now;
			}
			doc.activeAccountId = record.id;
			doc.revision += 1;
			writeAccountDocument(doc);

			flow.accountId = record.id;
			flow.email = record.email;
			flow.status = "complete";
			flow.completedAt = Date.now();

			runtimeState().onLoginSuccess?.(record.id);
			void fetchAntigravityQuota({ accountId: record.id, force: true });
		} catch (err) {
			if (flow.status === "pending") {
				flow.status = controller.signal.aborted ? "canceled" : "error";
				flow.error = err instanceof Error ? err.message : String(err);
				flow.completedAt = Date.now();
			}
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort);
			server.close();
		}
	})();

	if (options.openBrowser === true) {
		openExternalBrowser(authUrl);
	}
	return {
		status: flow.status,
		flowId: flow.flowId,
		authUrl: flow.authUrl,
		startedAt: flow.startedAt,
	};
}

export function submitAntigravityCallbackUrl(callbackUrl: string): void {
	const flow = runtimeState().loginFlow;
	if (!flow || flow.status !== "pending" || !flow.acceptCallback) {
		throw new Error("No pending Google sign-in flow.");
	}
	flow.acceptCallback(callbackUrl.trim());
}

export async function cancelAntigravityLogin(): Promise<void> {
	const flow = runtimeState().loginFlow;
	if (flow && flow.status === "pending") {
		flow.status = "canceled";
		flow.cancel?.();
		await flow.done;
	}
}

export function selectAntigravityAccount(accountId: string): void {
	const doc = readAccountDocument();
	if (!doc.accounts.some((a) => a.id === accountId)) {
		throw new Error("Account not found.");
	}
	doc.activeAccountId = accountId;
	doc.revision += 1;
	writeAccountDocument(doc);
	runtimeState().onLoginSuccess?.(accountId);
}

export function removeAntigravityAccount(accountId: string): void {
	const doc = readAccountDocument();
	doc.accounts = doc.accounts.filter((a) => a.id !== accountId);
	if (doc.activeAccountId === accountId) {
		doc.activeAccountId = doc.accounts[0]?.id ?? null;
	}
	doc.revision += 1;
	writeAccountDocument(doc);
	runtimeState().quotaByAccount.delete(accountId);
	runtimeState().quotaErrorByAccount.delete(accountId);
}

export async function getAntigravityStatus(options: { refreshQuota?: boolean } = {}): Promise<AntigravityStatusResponse> {
	const state = runtimeState();
	const doc = readAccountDocument();
	const accounts: AntigravityAccountSummary[] = doc.accounts.map((a) => ({
		id: a.id,
		email: a.email,
		label: a.label || a.email || "Google account",
		active: a.id === doc.activeAccountId,
		authState: a.credentials.expires > Date.now() ? "ready" : "refresh-required",
		expires: a.credentials.expires,
	}));
	const login: AntigravityLoginState = state.loginFlow
		? {
				status: state.loginFlow.status,
				flowId: state.loginFlow.flowId,
				authUrl: state.loginFlow.authUrl,
				startedAt: state.loginFlow.startedAt,
				completedAt: state.loginFlow.completedAt,
				accountId: state.loginFlow.accountId,
				email: state.loginFlow.email,
				error: state.loginFlow.error,
			}
		: { status: "idle" };

	let quota: AntigravityQuotaSnapshot | null = null;
	if (doc.activeAccountId) {
		if (options.refreshQuota || !state.quotaByAccount.has(doc.activeAccountId)) {
			quota = await fetchAntigravityQuota({ accountId: doc.activeAccountId, force: options.refreshQuota });
		} else {
			quota = state.quotaByAccount.get(doc.activeAccountId) ?? null;
		}
	}

	return {
		authenticated: Boolean(doc.activeAccountId && accounts.length > 0),
		activeAccountId: doc.activeAccountId,
		accounts,
		login,
		quota,
		quotaError: doc.activeAccountId ? state.quotaErrorByAccount.get(doc.activeAccountId) ?? null : null,
		dshImportAvailable: dshImportAvailable(),
	};
}

// ─── Cloud Code Assist Stream Adapter for pi-ai ──────────────────────────────

function resolveRuntimeModelId(modelId: string, reasoning: ThinkingLevel | "off" | undefined): string {
	const route = ROUTING[modelId];
	if (!route) return modelId;
	const level = reasoning ?? "high";
	if (level === "off") return route.off;
	return route.routing[level] ?? route.defaultRequestId;
}

function requiresToolCallId(modelId: string, runtimeModel: string): boolean {
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		runtimeModel.startsWith("claude-") ||
		runtimeModel.startsWith("gpt-oss-")
	);
}

let toolCallCounter = 0;

function sanitizeToolCallId(id: string, fallbackName: string): string {
	const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return cleaned || `${fallbackName || "tool"}_${Date.now()}_${++toolCallCounter}`;
}

function stripMetaSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const omit = new Set(["$schema", "$id", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions"]);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
		if (!omit.has(k)) out[k] = stripMetaSchema(v);
	}
	return out;
}

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set(["type", "description", "properties", "required", "items", "enum"]);

function normalizeCustomToolSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
		if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(k)) continue;
		if (k === "type") {
			if (typeof v === "string") out.type = v;
			else if (Array.isArray(v)) {
				const found = v.find((e) => typeof e === "string" && e !== "null");
				if (found !== undefined) out.type = found;
			}
			continue;
		}
		if (k === "properties" && isRecord(v)) {
			const props: Record<string, unknown> = {};
			for (const [pk, pv] of Object.entries(v)) props[pk] = normalizeCustomToolSchema(pv);
			out.properties = props;
			continue;
		}
		out[k] = normalizeCustomToolSchema(v);
	}
	return out;
}

function buildAntigravityPayload(
	logicalModel: Model<Api>,
	runtimeModel: string,
	context: TranscriptContext,
	reasoning: ThinkingLevel | undefined,
	projectId: string,
	options?: SimpleStreamOptions,
): Record<string, unknown> {
	const collapsed = collapseSystemMessages(context);
	const initialSystem = getInitialSystemMessage(collapsed.messages);
	const systemText = initialSystem ? getSystemMessageText(initialSystem) : "";
	const currentTools = getCurrentTools(collapsed.messages);
	const conversation = withoutInitialSystemMessage(collapsed.messages);
	const needIds = requiresToolCallId(logicalModel.id, runtimeModel);
	const transformed = transformMessages(conversation, logicalModel, (id) =>
		needIds ? sanitizeToolCallId(id, "tool") : id,
	);

	const contents: { role: "user" | "model"; parts: Record<string, unknown>[] }[] = [];
	const toolNames = new Map<string, string>();

	for (const msg of transformed) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					contents.push({ role: "user", parts: [{ text: sanitizeSurrogates(msg.content) }] });
				}
			} else if (Array.isArray(msg.content)) {
				const parts: Record<string, unknown>[] = [];
				for (const item of msg.content) {
					if (item.type === "text" && item.text.trim()) {
						parts.push({ text: sanitizeSurrogates(item.text) });
					} else if (item.type === "image") {
						parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
					}
				}
				if (parts.length > 0) contents.push({ role: "user", parts });
			}
		} else if (msg.role === "assistant") {
			const parts: Record<string, unknown>[] = [];
			const isSameModel = msg.provider === logicalModel.provider && msg.model === logicalModel.id;
			for (const block of msg.content) {
				if (block.type === "text") {
					if (!block.text?.trim() && !(isSameModel && block.textSignature)) continue;
					parts.push({
						text: sanitizeSurrogates(block.text || ""),
						...(isSameModel && block.textSignature ? { thoughtSignature: block.textSignature } : {}),
					});
				} else if (block.type === "thinking") {
					if (!block.thinking?.trim() && !(isSameModel && block.thinkingSignature)) continue;
					if (isSameModel && block.thinkingSignature) {
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking || ""),
							thoughtSignature: block.thinkingSignature,
						});
					} else if (block.thinking?.trim()) {
						parts.push({ text: sanitizeSurrogates(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					toolNames.set(block.id, block.name);
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(needIds ? { id: sanitizeToolCallId(block.id, block.name) } : {}),
						},
						...(isSameModel && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
					});
				}
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
		} else if (msg.role === "toolResult") {
			const toolName = msg.toolName || toolNames.get(msg.toolCallId) || "unknown";
			const textContent = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => sanitizeSurrogates(c.text))
				.join("\n");
			const responseValue = msg.isError
				? { error: textContent || "Tool execution failed" }
				: { output: textContent };
			const part: Record<string, unknown> = {
				functionResponse: {
					name: toolName,
					response: responseValue,
					...(needIds ? { id: sanitizeToolCallId(msg.toolCallId, toolName) } : {}),
				},
			};
			const last = contents[contents.length - 1];
			if (last?.role === "user" && last.parts.some((p) => "functionResponse" in p)) {
				last.parts.push(part);
			} else {
				contents.push({ role: "user", parts: [part] });
			}
			const imageParts = msg.content
				.filter((c): c is { type: "image"; mimeType: string; data: string } => c.type === "image")
				.map((c) => ({ inlineData: { mimeType: c.mimeType, data: c.data } }));
			if (imageParts.length > 0) {
				contents[contents.length - 1]!.parts.push(...imageParts);
			}
		}
	}

	if (contents.length === 0 || contents[contents.length - 1]!.role !== "user") {
		contents.push({ role: "user", parts: [{ text: "Continue." }] });
	}

	const generationConfig: Record<string, unknown> = {
		maxOutputTokens: options?.maxTokens ?? logicalModel.maxTokens ?? 65536,
	};
	if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (runtimeModel.endsWith("-tiered")) {
		const level = reasoning ?? "high";
		generationConfig.thinkingConfig = {
			thinkingLevel: level === "high" || level === "xhigh" ? "HIGH" : level === "medium" ? "MEDIUM" : "LOW",
		};
	}

	const usesLegacySchema = logicalModel.id.startsWith("claude-") || logicalModel.id.startsWith("gpt-oss-");
	const tools =
		currentTools.length > 0
			? [
					{
						functionDeclarations: currentTools.map((t) => {
							const rawSchema = stripMetaSchema(t.parameters);
							return {
								name: t.name,
								description: t.description,
								...(usesLegacySchema
									? { parameters: normalizeCustomToolSchema(rawSchema) }
									: { parametersJsonSchema: rawSchema }),
							};
						}),
					},
				]
			: undefined;

	const request: Record<string, unknown> = {
		contents,
		systemInstruction: {
			role: "user",
			parts: [
				{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
				{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
				{ text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION },
				...(systemText ? [{ text: sanitizeSurrogates(systemText) }] : []),
			],
		},
		generationConfig,
		...(tools ? { tools } : {}),
	};

	if (tools) {
		const mode =
			options?.toolChoice === "none"
				? "NONE"
				: logicalModel.id.startsWith("claude-")
					? "VALIDATED"
					: "AUTO";
		request.toolConfig = { functionCallingConfig: { mode } };
	}

	return {
		project: projectId,
		model: runtimeModel,
		request,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `antigravity-${Date.now()}-${randomBytes(6).toString("hex")}`,
	};
}

export const antigravityStream: StreamFunction<Api, SimpleStreamOptions> = (logicalModel, context, options) => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: logicalModel.api,
			provider: ANTIGRAVITY_PROVIDER,
			model: logicalModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const { token, projectId } = await ensureActiveCredentials();
			const runtimeModel = resolveRuntimeModelId(logicalModel.id, options?.reasoning);
			const payload = buildAntigravityPayload(logicalModel, runtimeModel, context, options?.reasoning, projectId, options);
			const headers: Record<string, string> = {
				...antigravityHeaders(token, "text/event-stream"),
				...(logicalModel.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
			};

			let response: Response | undefined;
			let lastErrorText = "";
			for (const endpoint of ENDPOINT_FALLBACKS) {
				if (options?.signal?.aborted) throw new Error("Request aborted");
				try {
					response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
						method: "POST",
						headers,
						body: JSON.stringify(payload),
						signal: options?.signal,
					});
					if (response.ok) break;
					lastErrorText = await response.text();
					if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
				} catch (err) {
					if (options?.signal?.aborted) throw err;
					lastErrorText = err instanceof Error ? err.message : String(err);
				}
			}

			if (!response || !response.ok || !response.body) {
				throw new Error(
					`Antigravity error (${response?.status ?? "network"}): ${lastErrorText.slice(0, 300) || "request failed"}`,
				);
			}

			stream.push({ type: "start", partial: output });

			let currentBlock:
				| { type: "text"; text: string; textSignature?: string }
				| { type: "thinking"; thinking: string; thinkingSignature?: string }
				| null = null;
			const blockIndex = () => output.content.length - 1;

			const closeCurrentBlock = () => {
				if (!currentBlock) return;
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
				currentBlock = null;
			};

			const processLine = (line: string) => {
				if (!line.startsWith("data:")) return;
				const rawJson = line.slice(5).trim();
				if (!rawJson || rawJson === "[DONE]") return;
				let chunk: Record<string, unknown>;
				try {
					chunk = JSON.parse(rawJson) as Record<string, unknown>;
				} catch {
					return;
				}
				if (isRecord(chunk.error)) {
					throw new Error(typeof chunk.error.message === "string" ? chunk.error.message : JSON.stringify(chunk.error));
				}
				const responseData = isRecord(chunk.response) ? chunk.response : chunk;
				const candidate = Array.isArray(responseData.candidates) ? (responseData.candidates[0] as Record<string, unknown> | undefined) : undefined;
				const content = isRecord(candidate?.content) ? candidate.content : undefined;
				const parts = Array.isArray(content?.parts) ? content.parts : [];

				for (const part of parts) {
					if (!isRecord(part)) continue;
					if (typeof part.text === "string") {
						const isThinking = part.thought === true;
						if (
							!currentBlock ||
							(isThinking && currentBlock.type !== "thinking") ||
							(!isThinking && currentBlock.type !== "text")
						) {
							closeCurrentBlock();
							if (isThinking) {
								currentBlock = { type: "thinking", thinking: "" };
								output.content.push(currentBlock);
								stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
							} else {
								currentBlock = { type: "text", text: "" };
								output.content.push(currentBlock);
								stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
							}
						}
						const sig = typeof part.thoughtSignature === "string" && part.thoughtSignature ? part.thoughtSignature : undefined;
						if (currentBlock.type === "thinking") {
							currentBlock.thinking += part.text;
							if (sig) currentBlock.thinkingSignature = sig;
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: part.text,
								partial: output,
							});
						} else {
							currentBlock.text += part.text;
							if (sig) currentBlock.textSignature = sig;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta: part.text,
								partial: output,
							});
						}
					}
					if (isRecord(part.functionCall)) {
						closeCurrentBlock();
						const fnName = typeof part.functionCall.name === "string" ? part.functionCall.name : "";
						const rawId = typeof part.functionCall.id === "string" ? part.functionCall.id : "";
						const callId = rawId || `${fnName}_${Date.now()}_${++toolCallCounter}`;
						const args = (isRecord(part.functionCall.args) ? part.functionCall.args : {}) as JsonObject;
						const sig = typeof part.thoughtSignature === "string" && part.thoughtSignature ? part.thoughtSignature : undefined;
						const toolCall: ToolCall = {
							type: "toolCall",
							id: callId,
							name: fnName,
							arguments: args,
							...(sig ? { thoughtSignature: sig } : {}),
						};
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta: JSON.stringify(args),
							partial: output,
						});
						stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
					}
				}

				if (typeof candidate?.finishReason === "string") {
					output.rawStopReason = candidate.finishReason;
					output.stopReason =
						candidate.finishReason === "MAX_TOKENS"
							? "length"
							: output.content.some((b) => b.type === "toolCall")
								? "toolUse"
								: "stop";
				}
				if (isRecord(responseData.usageMetadata)) {
					const u = responseData.usageMetadata;
					const promptTokens = typeof u.promptTokenCount === "number" ? u.promptTokenCount : 0;
					const cachedTokens = typeof u.cachedContentTokenCount === "number" ? u.cachedContentTokenCount : 0;
					const candidateTokens = typeof u.candidatesTokenCount === "number" ? u.candidatesTokenCount : 0;
					const thoughtTokens = typeof u.thoughtsTokenCount === "number" ? u.thoughtsTokenCount : 0;
					const totalTokens = typeof u.totalTokenCount === "number" ? u.totalTokenCount : promptTokens + candidateTokens + thoughtTokens;
					output.usage = {
						input: Math.max(0, promptTokens - cachedTokens),
						output: candidateTokens + thoughtTokens,
						cacheRead: cachedTokens,
						cacheWrite: 0,
						reasoning: thoughtTokens,
						totalTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
				}
			};

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				buffer += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, idx).replace(/\r$/, "");
					buffer = buffer.slice(idx + 1);
					processLine(line);
				}
			}
			buffer += decoder.decode();
			if (buffer.trim()) processLine(buffer.trimEnd());
			closeCurrentBlock();

			if (
				output.stopReason !== "stop" &&
				output.stopReason !== "length" &&
				output.stopReason !== "toolUse" &&
				output.stopReason !== "deferred"
			) {
				output.stopReason = output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (err) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};
