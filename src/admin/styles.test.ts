import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.resolve(dirname, "styles.css");

function ruleIn(css: string, selector: string): string | null {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "u"));
	return match ? match[1] : null;
}

function rule(css: string, selector: string): string {
	const body = ruleIn(css, selector);
	expect(body, `expected ${selector} rule`).not.toBeNull();
	return body!;
}

/**
 * Extracts the inner contents of every top-level `@media (max-width: <query>)`
 * block (brace-matched, so nested rules do not terminate the block early).
 */
function mediaBlocks(css: string, query: string): string[] {
	const blocks: string[] = [];
	const needle = `@media (max-width: ${query})`;
	let from = 0;
	while (true) {
		const idx = css.indexOf(needle, from);
		if (idx === -1) break;
		const open = css.indexOf("{", idx);
		if (open === -1) break;
		let depth = 1;
		let i = open + 1;
		while (i < css.length && depth > 0) {
			const ch = css[i];
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			if (depth === 0) break;
			i++;
		}
		blocks.push(css.slice(open + 1, i));
		from = i + 1;
	}
	return blocks;
}

function ruleInMedia(css: string, query: string, selector: string): string {
	for (const block of mediaBlocks(css, query)) {
		const body = ruleIn(block, selector);
		if (body !== null) return body;
	}
	throw new Error(`expected ${selector} rule inside @media (max-width: ${query})`);
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
		expect(body).toContain("margin-right: 0.5rem");
		expect(body).toContain("overflow: visible");
	});
});

describe("settings screen layout", () => {
	it("lets the settings screen scroll the full page instead of clipping content", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = rule(css, ".settings-screen");

		expect(body).toContain("overflow-y: auto");
		expect(body).toContain("min-height: 0");
		expect(body).not.toContain("overflow: hidden");
	});

	it("removes the fixed-height inner scroll pane from the settings list", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = rule(css, ".settings-list");

		expect(body).not.toContain("overflow-y: auto");
		expect(body).not.toContain("flex: 1");
		expect(body).toContain("background: var(--surface)");
		expect(body).toContain("border: 1px solid var(--border)");
	});

	it("keeps the save actions in the natural document flow", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = rule(css, ".settings-actions");

		expect(body).toContain("flex-shrink: 0");
		expect(body).not.toContain("position: fixed");
		expect(body).not.toContain("position: absolute");
	});

	it("wraps settings tabs on narrow screens so they stay reachable", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".repo-tabs");

		expect(body).toContain("flex-wrap: wrap");
	});

	it("keeps setting-row inputs and selects inside the narrow viewport", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const blocks = mediaBlocks(css, "768px");
		const settingsBlock = blocks.find((block) => block.includes(".setting-row input") && block.includes(".setting-row select"));
		expect(settingsBlock).toBeDefined();
		expect(settingsBlock!).toContain("max-width: 100%");
		expect(settingsBlock!).toContain("width: 100%");
	});
});

describe("admin mobile layouts", () => {
	it("shows the session list full-height on mobile when no session is selected", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".session-workspace .list-pane");

		expect(body).toContain("display: flex");
		expect(body).toContain("max-height: none");
	});

	it("hides the session list on mobile when a session is selected", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".session-workspace.has-selected .list-pane");

		expect(body).toContain("display: none");
	});

	it("hides the session detail pane on mobile when no session is selected", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".session-workspace .detail-pane");

		expect(body).toContain("display: none");
	});

	it("shows the session detail pane full-height on mobile when a session is selected", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".session-workspace.has-selected .detail-pane");

		expect(body).toContain("display: block");
		expect(body).toContain("flex: 1");
		expect(body).toContain("max-height: none");
	});

	it("hides the session back button outside the mobile breakpoint", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = rule(css, ".session-back");

		expect(body).toContain("display: none");
	});

	it("shows the session back button inside the mobile breakpoint", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".session-back");

		expect(body).not.toContain("display: none");
		expect(body).toContain("cursor: pointer");
	});

	it("styles the signed-in user label via the header-user class", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = rule(css, ".header-user");

		expect(body).toContain("color: var(--muted)");
		expect(body).toContain("font-size: 0.875rem");
	});

	it("lets header actions wrap on narrow screens instead of overflowing", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".header-actions");

		expect(body).toContain("flex-wrap: wrap");
	});

	it("hides the dashboard activity column header on narrow screens", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".activity-list-header");

		expect(body).toContain("display: none");
	});

	it("reflows dashboard activity rows into a wrapping flex card on narrow screens", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".activity-row");

		expect(body).toContain("display: flex");
		expect(body).toContain("flex-wrap: wrap");
	});

	it("places the dashboard activity repo on its own line on narrow screens", async () => {
		const css = await readFile(stylesPath, "utf-8");
		const body = ruleInMedia(css, "768px", ".activity-repo");

		expect(body).toContain("flex: 1 1 100%");
	});
});
