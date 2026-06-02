import { readFile } from "node:fs/promises";

let soulContentCache: string | null = null;

export async function loadSoulContent(soulPath: string): Promise<string> {
	if (soulContentCache !== null) {
		return soulContentCache;
	}
	try {
		const content = await readFile(soulPath, "utf-8");
		soulContentCache = content;
		process.stdout.write(`Loaded SOUL.md from ${soulPath}\n`);
		return content;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Warning: Failed to load SOUL.md from ${soulPath}: ${message}\n`);
		soulContentCache = "";
		return "";
	}
}
