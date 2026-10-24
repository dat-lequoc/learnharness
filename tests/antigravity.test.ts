import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SETTINGS_FILE } from "../config.ts";
import {
	ANTIGRAVITY_CHEAP_MODEL,
	ANTIGRAVITY_DEFAULT_LEVEL,
	ANTIGRAVITY_PROVIDER,
	ANTIGRAVITY_STRONG_MODEL,
	ANTIGRAVITY_VISION_MODEL,
	isChatGPTPlan,
} from "../src/core/index.ts";
import {
	ANTIGRAVITY_DEFAULT_SLOTS,
	antigravityConnected,
	applyAntigravityDefaultSlots,
	modelCatalog,
	validateModelsSettings,
} from "../src/server/index.ts";
import { piEngineForSpec } from "../src/agent/models.ts";

test("ANTIGRAVITY_DEFAULT_SLOTS pins Strong & Vision to gemini-4-argon (high) and Cheap to gemini-3.8-flash-high (high)", () => {
	assert.deepEqual(ANTIGRAVITY_DEFAULT_SLOTS, {
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
	});
	assert.equal(isChatGPTPlan("antigravity:gemini-4-argon"), true);
});

test("connected Antigravity account federates models, validates default slots, and defaults Argon thinkingLevel to high", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-antigravity-test-"));
	const prevDataDir = process.env.LH_DATA_DIR;
	const hadSettings = existsSync(SETTINGS_FILE);
	const prevSettings = hadSettings ? readFileSync(SETTINGS_FILE, "utf-8") : null;
	process.env.LH_DATA_DIR = dir;
	try {
		assert.equal(antigravityConnected(), false);

		writeFileSync(
			path.join(dir, "antigravity-oauth.json"),
			JSON.stringify({
				version: 2,
				revision: 1,
				activeAccountId: "acc-1",
				accounts: [
					{
						id: "acc-1",
						email: "learner@example.com",
						label: "learner@example.com",
						credentials: {
							access: "ya29.test-token",
							refresh: "1//test-refresh",
							expires: Date.now() + 3600_000,
							projectId: "test-project-123",
						},
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				],
			}),
			{ mode: 0o600 },
		);

		assert.equal(antigravityConnected(), true);
		const applied = applyAntigravityDefaultSlots();
		const verdict = validateModelsSettings(applied);
		assert.deepEqual(verdict, { ok: true });

		const catalog = modelCatalog();
		const providerRow = catalog.providers.find((p) => p.id === "antigravity");
		assert.ok(providerRow?.keyPresent, "antigravity provider should report keyPresent when connected");

		const argon = catalog.models.find((m) => m.provider === "antigravity" && m.id === "gemini-4-argon");
		assert.ok(argon, "gemini-4-argon should be present in federated model catalog");
		assert.deepEqual(argon.input, ["text", "image"]);
		assert.deepEqual(argon.supportedLevels, ["low", "medium", "high"]);

		const flash38 = catalog.models.find((m) => m.provider === "antigravity" && m.id === "gemini-3.8-flash-high");
		assert.ok(flash38, "gemini-3.8-flash-high should be present in federated model catalog");

		// Unset thinkingLevel on an Antigravity model resolves to "high"
		const engine = piEngineForSpec({ provider: "antigravity", id: "gemini-4-argon" });
		assert.equal(engine.level, "high");
	} finally {
		if (prevSettings !== null) writeFileSync(SETTINGS_FILE, prevSettings, "utf-8");
		else rmSync(SETTINGS_FILE, { force: true });
		if (prevDataDir === undefined) delete process.env.LH_DATA_DIR;
		else process.env.LH_DATA_DIR = prevDataDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
