/**
 * Server composition seam for Google Antigravity / Cloud Code Assist:
 * re-exports the agent-layer OAuth/quota functions for app/api/antigravity
 * and wires the auto-select hook that pins:
 *   - strong → antigravity / gemini-4-argon (high)
 *   - cheap  → antigravity / gemini-3.8-flash-high (high)
 *   - vision → antigravity / gemini-4-argon (high)
 * whenever a Google account signs in or is activated.
 */

import {
	ANTIGRAVITY_CHEAP_MODEL,
	ANTIGRAVITY_DEFAULT_LEVEL,
	ANTIGRAVITY_PROVIDER,
	ANTIGRAVITY_STRONG_MODEL,
	ANTIGRAVITY_VISION_MODEL,
} from "../core/contracts/antigravity.ts";
import { CURRENT_SETTINGS_VERSION, type ModelsSettings } from "../core/settings.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import {
	antigravityConnected,
	beginAntigravityLogin,
	cancelAntigravityLogin,
	fetchAntigravityQuota,
	getAntigravityStatus,
	importDshAntigravityAccounts,
	onAntigravityLoginSuccess,
	removeAntigravityAccount,
	selectAntigravityAccount,
	submitAntigravityCallbackUrl,
} from "../agent/antigravity.ts";

export const ANTIGRAVITY_DEFAULT_SLOTS: ModelsSettings = {
	strong: {
		model: { provider: ANTIGRAVITY_PROVIDER, id: ANTIGRAVITY_STRONG_MODEL },
		thinkingLevel: ANTIGRAVITY_DEFAULT_LEVEL,
	},
	cheap: {
		model: { provider: ANTIGRAVITY_PROVIDER, id: ANTIGRAVITY_CHEAP_MODEL },
		thinkingLevel: ANTIGRAVITY_DEFAULT_LEVEL,
	},
	vision: {
		model: { provider: ANTIGRAVITY_PROVIDER, id: ANTIGRAVITY_VISION_MODEL },
		thinkingLevel: ANTIGRAVITY_DEFAULT_LEVEL,
	},
};

export function applyAntigravityDefaultSlots(): ModelsSettings {
	const current = readSettings() ?? { version: CURRENT_SETTINGS_VERSION };
	const models: ModelsSettings = { ...ANTIGRAVITY_DEFAULT_SLOTS };
	writeSettings({ ...current, models });
	return models;
}

// Register the login/activation hook so completing Google OAuth in the browser
// automatically configures the Strong, Cheap, and Vision slots.
onAntigravityLoginSuccess(() => {
	applyAntigravityDefaultSlots();
});

export {
	antigravityConnected,
	beginAntigravityLogin,
	cancelAntigravityLogin,
	fetchAntigravityQuota,
	getAntigravityStatus,
	importDshAntigravityAccounts,
	removeAntigravityAccount,
	selectAntigravityAccount,
	submitAntigravityCallbackUrl,
};
