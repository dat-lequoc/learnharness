"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	ANTIGRAVITY_PROVIDER,
	type AntigravityQuotaBucket,
	type AntigravityStatusResponse,
} from "@/src/core";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

let cachedStatus: AntigravityStatusResponse | null = null;
const statusListeners = new Set<(s: AntigravityStatusResponse | null) => void>();

function publishAntigravityStatus(next: AntigravityStatusResponse | null) {
	cachedStatus = next;
	for (const listener of statusListeners) listener(next);
}

async function fetchAntigravityStatus(refresh = false): Promise<AntigravityStatusResponse | null> {
	try {
		const res = await fetch(refresh ? "/api/antigravity?refresh=1" : "/api/antigravity");
		if (!res.ok) return cachedStatus;
		const data = (await res.json()) as AntigravityStatusResponse;
		publishAntigravityStatus(data);
		return data;
	} catch {
		return cachedStatus;
	}
}

function useAntigravityStatus() {
	const [status, setStatus] = useState<AntigravityStatusResponse | null>(cachedStatus);
	useEffect(() => {
		statusListeners.add(setStatus);
		if (!cachedStatus) void fetchAntigravityStatus(false);
		return () => {
			statusListeners.delete(setStatus);
		};
	}, []);
	useSettingsSaved((section) => {
		if (section === "keys" || section === "models") {
			void fetchAntigravityStatus(false);
		}
	});
	return status;
}

function GoogleIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
			<path
				fill="#4285F4"
				d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
			/>
			<path
				fill="#34A853"
				d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
			/>
			<path
				fill="#FBBC05"
				d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.13-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
			/>
			<path
				fill="#EA4335"
				d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
			/>
		</svg>
	);
}

function barColorClass(percent: number | undefined, groupName: string): string {
	if (percent === undefined) return "bg-muted-foreground/40";
	if (percent <= 10) return "bg-red-500";
	if (percent <= 25) return "bg-amber-500";
	return /claude|gpt/i.test(groupName) ? "bg-cyan-500" : "bg-emerald-500";
}

function QuotaBucketRow({ bucket, groupName }: { bucket: AntigravityQuotaBucket; groupName: string }) {
	const pct = bucket.disabled ? undefined : bucket.remainingPercent;
	return (
		<div className="flex flex-col gap-1 py-1">
			<div className="flex items-center justify-between text-[11px]">
				<span className="text-foreground/90">
					{bucket.label}
					{bucket.window ? <span className="ml-1 text-muted-foreground">({bucket.window})</span> : null}
				</span>
				<span className="font-mono text-muted-foreground">
					{bucket.disabled
						? "Not enforced"
						: pct !== undefined
							? `${pct}% remaining`
							: "N/A"}
					{bucket.resetLabel && !bucket.disabled ? ` · ${bucket.resetLabel}` : ""}
				</span>
			</div>
			<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full transition-all ${barColorClass(pct, groupName)}`}
					style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
				/>
			</div>
		</div>
	);
}

export function AntigravityConnection({ setup = false }: { setup?: boolean }) {
	const status = useAntigravityStatus();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [callbackInput, setCallbackInput] = useState("");
	const [copied, setCopied] = useState(false);
	const prevLoginStatus = useRef<string | undefined>(undefined);

	const runAction = useCallback(
		async (payload: Record<string, unknown>, notifySlots = false) => {
			setBusy(true);
			setError(null);
			try {
				const res = await fetch("/api/antigravity", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});
				const data = (await res.json().catch(() => ({}))) as AntigravityStatusResponse & { error?: string };
				if (!res.ok) {
					setError(data.error ?? `Request failed (${res.status})`);
					return null;
				}
				publishAntigravityStatus(data);
				notifySettingsSaved("keys");
				if (notifySlots) notifySettingsSaved("models");
				return data;
			} catch {
				setError("Could not reach server.");
				return null;
			} finally {
				setBusy(false);
			}
		},
		[],
	);

	// Poll while OAuth login is pending in the browser
	useEffect(() => {
		const currentLogin = status?.login?.status;
		if (prevLoginStatus.current === "pending" && currentLogin === "complete") {
			notifySettingsSaved("keys");
			notifySettingsSaved("models");
		}
		prevLoginStatus.current = currentLogin;

		if (currentLogin !== "pending") return;
		const timer = setInterval(() => {
			void fetchAntigravityStatus(false);
		}, 1500);
		return () => clearInterval(timer);
	}, [status?.login?.status]);

	const activeAccount = status?.accounts.find((a) => a.id === status.activeAccountId) ?? status?.accounts[0];
	const pending = status?.login?.status === "pending";
	const displayError = error || (status?.login?.status === "error" ? status.login.error : null) || status?.quotaError || null;

	return (
		<div className="flex flex-col gap-2.5" data-testid="antigravity-connection">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap items-center gap-2">
					{activeAccount ? (
						<>
							<span className="flex items-center gap-1.5 font-ui text-xs font-medium text-foreground">
								<GoogleIcon />
								Google
							</span>
							<select
								aria-label="Google account"
								value={activeAccount.id}
								disabled={busy || pending}
								onChange={(e) => void runAction({ action: "select", accountId: e.target.value }, true)}
								className="min-w-0 rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground"
							>
								{status?.accounts.map((a) => (
									<option key={a.id} value={a.id}>
										{a.email || a.label}
									</option>
								))}
							</select>
						</>
					) : (
						<Button
							type="button"
							variant="outline"
							size="sm"
							data-testid="antigravity-login"
							disabled={busy || pending}
							onClick={() => void runAction({ action: "login" })}
							className="cursor-pointer gap-2"
						>
							<GoogleIcon />
							Sign in with Google
						</Button>
					)}

					{status?.dshImportAvailable && !activeAccount && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							data-testid="antigravity-import-dsh"
							disabled={busy || pending}
							onClick={() => void runAction({ action: "import-dsh" }, true)}
							className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
						>
							Import from DSH
						</Button>
					)}
				</div>

				{activeAccount && (
					<div className="flex flex-wrap items-center gap-1.5">
						{!setup && (
							<Button
								type="button"
								variant="ghost"
								size="xs"
								disabled={busy || pending}
								onClick={() => void fetchAntigravityStatus(true)}
								className="cursor-pointer"
							>
								Refresh quota
							</Button>
						)}
						<Button
							type="button"
							variant="ghost"
							size="xs"
							disabled={busy || pending}
							onClick={() => void runAction({ action: "login" })}
							className="cursor-pointer"
						>
							Add account
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="xs"
							disabled={busy || pending}
							onClick={() => void runAction({ action: "remove", accountId: activeAccount.id })}
							className="cursor-pointer text-red-400 hover:bg-red-500/10 hover:text-red-300"
						>
							Disconnect
						</Button>
					</div>
				)}
			</div>

			{pending && (
				<div className="flex flex-col gap-2.5 rounded-sm border border-border/60 bg-muted/30 p-3 text-xs">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="text-muted-foreground">
							Open the Google sign-in URL below (or copy it into your browser):
						</span>
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={() => void runAction({ action: "cancel" })}
						>
							Cancel
						</Button>
					</div>
					{status?.login?.authUrl && (
						<div className="flex flex-wrap items-center gap-2">
							<input
								type="text"
								readOnly
								value={status.login.authUrl}
								onFocus={(e) => e.currentTarget.select()}
								aria-label="Google OAuth sign-in URL"
								className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
							/>
							<Button
								type="button"
								variant="outline"
								size="xs"
								onClick={() => {
									if (!status.login.authUrl) return;
									void navigator.clipboard?.writeText(status.login.authUrl).then(() => {
										setCopied(true);
										setTimeout(() => setCopied(false), 1800);
									});
								}}
								className="cursor-pointer"
							>
								{copied ? "Copied!" : "Copy URL"}
							</Button>
							<a
								href={status.login.authUrl}
								target="_blank"
								rel="noreferrer"
								className="inline-flex h-6 items-center rounded-sm border border-border bg-background px-2.5 font-ui text-xs text-foreground transition-colors hover:bg-muted"
							>
								Open in browser ↗
							</a>
						</div>
					)}
					<div className="flex items-center gap-2 pt-0.5">
						<input
							type="text"
							value={callbackInput}
							onChange={(e) => setCallbackInput(e.target.value)}
							placeholder="Or paste callback URL (http://localhost:51121/oauth-callback?code=...)"
							className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
						/>
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={!callbackInput.trim() || busy}
							onClick={() => {
								void runAction({ action: "callback", callbackUrl: callbackInput }, true);
								setCallbackInput("");
							}}
						>
							Submit callback
						</Button>
					</div>
				</div>
			)}

			{activeAccount && !setup && status?.quota && status.quota.groups.length > 0 && (
				<div className="mt-1 flex flex-col gap-2 rounded-sm border border-border/50 bg-card/40 p-2.5" data-testid="antigravity-quota-groups">
					{status.quota.groups.map((group) => (
						<div key={group.displayName} className="flex flex-col gap-0.5">
							<div className="text-[11px] font-medium text-muted-foreground">{group.displayName}</div>
							{group.buckets.map((bucket) => (
								<QuotaBucketRow key={bucket.id} bucket={bucket} groupName={group.displayName} />
							))}
						</div>
					))}
				</div>
			)}

			{displayError && (
				<p role="alert" className="text-xs text-red-400">
					{displayError}
				</p>
			)}
		</div>
	);
}

/**
 * Compact quota indicator rendered beside ModelControl in the stats/composer
 * bar whenever an Antigravity model is active.
 */
export function AntigravityQuotaPill({
	provider,
	modelId,
}: {
	provider: string | undefined;
	modelId: string | undefined;
}) {
	const status = useAntigravityStatus();

	useEffect(() => {
		if (provider !== ANTIGRAVITY_PROVIDER) return;
		const onFocus = () => void fetchAntigravityStatus(false);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [provider]);

	if (provider !== ANTIGRAVITY_PROVIDER || !status?.authenticated) return null;

	const quota = status.quota;
	const isClaudeOrGpt = modelId ? /^(claude-|gpt-)/i.test(modelId) : false;

	// Prefer 5-hour bucket for the active model's pool, else model-level quota
	const poolGroup = quota?.groups.find((g) =>
		isClaudeOrGpt ? /claude|gpt/i.test(g.displayName) : /gemini/i.test(g.displayName),
	) ?? quota?.groups[0];
	const activeBucket =
		poolGroup?.buckets.find((b) => !b.disabled && /5[- ]*hour|5h/i.test(`${b.id} ${b.label} ${b.window ?? ""}`)) ??
		poolGroup?.buckets.find((b) => !b.disabled);
	const modelEntry = modelId ? quota?.models.find((m) => m.id === modelId) : undefined;

	const pct = activeBucket?.remainingPercent ?? modelEntry?.remainingPercent;
	const resetLabel = activeBucket?.resetLabel ?? modelEntry?.resetLabel;
	if (pct === undefined) return null;

	const rounded = Math.round(pct);
	const hintLabel = `Google quota: ${pct}% remaining${resetLabel ? ` (resets in ${resetLabel})` : ""} — click to refresh`;

	return (
		<Hint label={hintLabel} side="bottom">
			<button
				type="button"
				data-testid="antigravity-quota-pill"
				onClick={() => void fetchAntigravityStatus(true)}
				className="flex items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 text-xs shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted"
			>
				<span className="h-1.5 w-8 overflow-hidden rounded-full bg-muted">
					<span
						className={`block h-full ${barColorClass(pct, isClaudeOrGpt ? "claude" : "gemini")}`}
						style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
					/>
				</span>
				<span className="font-mono text-[11px] text-card-foreground">{rounded}%</span>
			</button>
		</Hint>
	);
}
