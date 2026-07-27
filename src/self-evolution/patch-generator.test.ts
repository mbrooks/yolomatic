import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PatchGenerator } from "./patch-generator.js";

describe("PatchGenerator", () => {
	it("returns null when file does not exist", async () => {
		const gen = new PatchGenerator();
		const patch = await gen.generate("/nonexistent/file.ts", "some error");
		expect(patch).toBeNull();
	});

	it("applies optional chaining for undefined property read", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-patch-"));
		const filePath = path.join(dir, "demo.ts");
		await writeFile(filePath, "const x = obj.prop;\n", "utf-8");

		const gen = new PatchGenerator();
		const patch = await gen.generate(filePath, "Cannot read properties of undefined (reading 'prop')");
		expect(patch).not.toBeNull();
		expect(patch!.patchedContent).toBe("const x = obj?.prop;\n");
		expect(patch!.diff).toContain("---");
		expect(patch!.diff).toContain("+const x = obj?.prop;");
	});

	it("returns null when no rule matches", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-patch-"));
		const filePath = path.join(dir, "demo.ts");
		await writeFile(filePath, "const x = 1;\n", "utf-8");

		const gen = new PatchGenerator();
		const patch = await gen.generate(filePath, "some unrelated error");
		expect(patch).toBeNull();
	});

	it("diffs files with extra lines", () => {
		const gen = new PatchGenerator();
		const diff = (gen as any).computeDiff("file.ts", "line1", "line1\nline2");
		expect(diff).toContain("+line2");
	});

	it("diffs files with fewer lines", () => {
		const gen = new PatchGenerator();
		const diff = (gen as any).computeDiff("file.ts", "line1\nline2", "line1");
		expect(diff).toContain("-line2");
	});
});
