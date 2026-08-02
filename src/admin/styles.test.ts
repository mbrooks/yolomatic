import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.resolve(dirname, "styles.css");

function rule(css: string, selector: string): string {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "u"));
	expect(match, `expected ${selector} rule`).not.toBeNull();
	return match![1];
}

describe("admin table layouts", () => {
	it("uses the same fixed grid columns for dashboard headers and activity rows", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const expectedColumns = "minmax(0, 2fr) 3.5rem 5.25rem 7rem minmax(4rem, 1fr)";

		for (const selector of [".activity-list-header", ".activity-row"]) {
			const body = rule(css, selector);
			expect(body).toContain("display: grid");
			expect(body).toContain(`grid-template-columns: ${expectedColumns}`);
		}
	});

	it("reserves enough visible width for the refinement type badge", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = rule(css, ".list-col.type");

		expect(body).toContain("flex: 0 0 5.25rem");
		expect(body).toContain("overflow: visible");
	});
});
