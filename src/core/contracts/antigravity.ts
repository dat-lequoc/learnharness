/**
 * Client-safe contracts for Google Antigravity / Cloud Code Assist OAuth,
 * account management, and quota reporting.
 *
 * Pure types + constants only (no Node builtins, no IO) so both the core
 * barrel (`@/src/core`) and server/agent modules can share them without
 * violating the hexagonal import law.
 */

export const ANTIGRAVITY_PROVIDER = "antigravity" as const;
export const ANTIGRAVITY_STRONG_MODEL = "gemini-4-argon" as const;
export const ANTIGRAVITY_CHEAP_MODEL = "gemini-3.8-flash-high" as const;
export const ANTIGRAVITY_VISION_MODEL = "gemini-4-argon" as const;
export const ANTIGRAVITY_DEFAULT_LEVEL = "high" as const;

export interface AntigravityAccountSummary {
	id: string;
	email: string;
	label: string;
	active: boolean;
	authState: "ready" | "refresh-required";
	expires?: number;
}

export interface AntigravityQuotaBucket {
	id: string;
	label: string;
	window?: string;
	remainingPercent?: number;
	remainingFraction?: number;
	resetLabel?: string;
	resetTime?: string;
	description?: string;
	disabled?: boolean;
}

export interface AntigravityQuotaGroup {
	displayName: string;
	description?: string;
	buckets: AntigravityQuotaBucket[];
}

export interface AntigravityModelQuota {
	id: string;
	name: string;
	remainingPercent?: number;
	remainingFraction?: number;
	resetLabel?: string;
	resetTime?: string;
}

export interface AntigravityQuotaSnapshot {
	accountId?: string;
	planLabel?: string;
	groups: AntigravityQuotaGroup[];
	models: AntigravityModelQuota[];
	fetchedAt: number;
}

export interface AntigravityLoginState {
	status: "idle" | "pending" | "complete" | "canceled" | "error";
	flowId?: string;
	authUrl?: string;
	startedAt?: number;
	completedAt?: number;
	accountId?: string;
	email?: string;
	error?: string;
}

export interface AntigravityStatusResponse {
	authenticated: boolean;
	activeAccountId: string | null;
	accounts: AntigravityAccountSummary[];
	login: AntigravityLoginState;
	quota: AntigravityQuotaSnapshot | null;
	quotaError?: string | null;
	/** True when ~/.dsh/storages/antigravity-oauth.json has importable accounts. */
	dshImportAvailable?: boolean;
}
