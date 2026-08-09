import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

async function importLoader() {
	vi.resetModules();
	return import("./soul-loader.js");
}

describe("loadSoulContent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("loads and caches SOUL.md content", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-soul-loader-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const { loadSoulContent } = await importLoader();

		await expect(loadSoulContent(soulPath)).resolves.toBe("SOUL content");
		await writeFile(soulPath, "Updated SOUL content", "utf-8");
		await expect(loadSoulContent(soulPath)).resolves.toBe("SOUL content");
	});

	it("returns empty content when SOUL.md cannot be read", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { loadSoulContent } = await importLoader();

		await expect(loadSoulContent("/tmp/missing-yolomatic-soul.md")).resolves.toBe("");
	});
});
