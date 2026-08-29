import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs in the default node environment (no happy-dom pragma) so the `node:`
// built-in imports work; the DOM-oriented settings tests live in
// SettingsScreen.test.tsx.
const STYLES_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../styles.css",
);

describe("settings styles", () => {
	it("styles the Rerun On-Boarding tab like the other neutral settings tabs", async () => {
		const css = await readFile(STYLES_PATH, "utf-8");

		// No rule targeting .settings-rerun-onboarding may reintroduce the red
		// tab styling; the rerun action should inherit the neutral .repo-tab look.
		const rerunBlocks = [
			...css.matchAll(/\.repo-tab\.settings-rerun-onboarding[^{]*\{[^}]*\}/gu),
		].map((match) => match[0]);
		for (const block of rerunBlocks) {
			expect(block).not.toContain("var(--red)");
			expect(block).not.toContain("#fff");
			expect(block).not.toMatch(/background\s*:/u);
			expect(block).not.toMatch(/color\s*:/u);
		}

		// The base .repo-tab rule should still define the neutral styling.
		const baseBlock = css.match(/\.repo-tab\s*\{[^}]*\}/u);
		expect(baseBlock, "expected a base .repo-tab rule to exist").not.toBeNull();
		expect(baseBlock![0]).toContain("background: var(--surface)");
	});
});