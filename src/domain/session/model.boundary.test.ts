import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const MODEL_RELATIVE = path.join("src", "domain", "session", "model.ts");
const MODEL_ABSOLUTE = path.join(REPO_ROOT, MODEL_RELATIVE);
const MODEL_ABSOLUTE_JS = MODEL_ABSOLUTE.replace(/\.ts$/u, ".js");

/**
 * Persisted-session symbols that live canonically in `src/session/store.ts`.
 * They must not be re-exported from the domain model module, and internal
 * callers must import them from the canonical store module rather than the
 * domain compatibility path.
 */
const PERSISTED_SESSION_SYMBOLS = ["isTerminalStatus", "SessionState", "SessionStatus"] as const;

/**
 * Modules that are permitted to reference the persisted-session symbols by
 * name. The store owns them; the domain model imports them internally to
 * implement derived domain helpers.
 */
const SYMBOL_OWNERS = new Set([
	path.join(REPO_ROOT, "src", "session", "store.ts"),
	path.join(REPO_ROOT, "src", "domain", "session", "model.ts"),
]);

async function listTsFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await listTsFiles(full)));
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("session domain import boundary", () => {
	it("does not re-export persisted-session symbols from domain/session/model.ts", async () => {
		const source = await readFile(MODEL_ABSOLUTE, "utf8");
		for (const symbol of PERSISTED_SESSION_SYMBOLS) {
			// A re-export line looks like `export { isTerminalStatus, ... } from`.
			const reExportPattern = new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from`, "u");
			expect(reExportPattern.test(source)).toBe(false);
		}
	});

	it("internal modules import persisted-session symbols from session/store.js, not domain/session/model.js", async () => {
		const files = await listTsFiles(SRC_DIR);
		const violations: string[] = [];
		for (const file of files) {
			if (SYMBOL_OWNERS.has(file)) continue;
			const source = await readFile(file, "utf8");
			// Match named import blocks and capture both the imported names and the
			// module specifier, then resolve the specifier relative to the file so
			// relative paths like `../session/model.js` are caught too.
			const importBlockPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/gu;
			let match: RegExpExecArray | null;
			while ((match = importBlockPattern.exec(source)) !== null) {
				const imported = match[1]!;
				const specifier = match[2]!;
				if (!specifier.endsWith(".js")) continue;
				const resolved = path.resolve(path.dirname(file), specifier);
				if (resolved !== MODEL_ABSOLUTE_JS) continue;
				for (const symbol of PERSISTED_SESSION_SYMBOLS) {
					const symbolPattern = new RegExp(`\\b${symbol}\\b`, "u");
					if (symbolPattern.test(imported)) {
						const rel = path.relative(REPO_ROOT, file);
						violations.push(`${rel}: imports ${symbol} from domain/session/model.js`);
					}
				}
			}
		}
		expect(violations).toEqual([]);
	});
});