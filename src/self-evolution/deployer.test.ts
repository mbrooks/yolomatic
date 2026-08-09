import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SafeDeployer } from "./deployer.js";

describe("SafeDeployer", () => {
	it("applies a patch and can rollback", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-deploy-"));
		const filePath = path.join(dir, "src.ts");
		await writeFile(filePath, "original", "utf-8");

		const deployer = new SafeDeployer();
		const snapshot = await deployer.applyPatch({
			filePath,
			originalContent: "original",
			patchedContent: "patched",
			diff: "---",
		});

		expect(await readFile(filePath, "utf-8")).toBe("patched");
		expect(snapshot.timestamp).toBeTruthy();

		await deployer.rollback(snapshot);
		expect(await readFile(filePath, "utf-8")).toBe("original");
	});
});
