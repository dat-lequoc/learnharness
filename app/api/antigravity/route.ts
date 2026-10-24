import {
	applyAntigravityDefaultSlots,
	beginAntigravityLogin,
	cancelAntigravityLogin,
	getAntigravityStatus,
	importDshAntigravityAccounts,
	removeAntigravityAccount,
	selectAntigravityAccount,
	submitAntigravityCallbackUrl,
} from "@/src/server";

export async function GET(request: Request) {
	const url = new URL(request.url);
	const refreshQuota = url.searchParams.get("refresh") === "1";
	const status = await getAntigravityStatus({ refreshQuota });
	return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid JSON body." }, { status: 400 });
	}

	const action = body.action;
	try {
		switch (action) {
			case "login": {
				await beginAntigravityLogin({
					openBrowser: body.openBrowser === true,
					accountId: typeof body.accountId === "string" ? body.accountId : undefined,
				});
				break;
			}
			case "cancel": {
				await cancelAntigravityLogin();
				break;
			}
			case "callback": {
				if (typeof body.callbackUrl !== "string" || !body.callbackUrl.trim()) {
					return Response.json({ error: "Missing callback URL." }, { status: 400 });
				}
				submitAntigravityCallbackUrl(body.callbackUrl);
				break;
			}
			case "select": {
				if (typeof body.accountId !== "string" || !body.accountId.trim()) {
					return Response.json({ error: "Missing accountId." }, { status: 400 });
				}
				selectAntigravityAccount(body.accountId);
				break;
			}
			case "remove": {
				if (typeof body.accountId !== "string" || !body.accountId.trim()) {
					return Response.json({ error: "Missing accountId." }, { status: 400 });
				}
				removeAntigravityAccount(body.accountId);
				break;
			}
			case "import-dsh": {
				importDshAntigravityAccounts();
				break;
			}
			case "apply-defaults": {
				applyAntigravityDefaultSlots();
				break;
			}
			default:
				return Response.json({ error: `Unknown action "${String(action)}".` }, { status: 400 });
		}
		const status = await getAntigravityStatus({ refreshQuota: action === "import-dsh" || action === "select" });
		return Response.json(status, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 400 });
	}
}
