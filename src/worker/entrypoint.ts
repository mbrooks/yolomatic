import { runWorkerRuntime } from "./runtime.js";

export async function main(): Promise<void> {
	const wsUrl = process.env.YEETOMATIC_SESSION_WS_URL?.trim();
	const sessionKey = process.env.YEETOMATIC_SESSION_KEY?.trim();
	const soulPath = process.env.YEETOMATIC_SOUL_PATH?.trim() || "/app/SOUL.md";

	if (!wsUrl) {
		throw new Error("YEETOMATIC_SESSION_WS_URL is required");
	}
	if (!sessionKey) {
		throw new Error("YEETOMATIC_SESSION_KEY is required");
	}

	await runWorkerRuntime({
		wsUrl,
		sessionKey,
		soulPath,
		workerVersion: process.env.npm_package_version,
	});
}

/* v8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
}
/* v8 ignore stop */
