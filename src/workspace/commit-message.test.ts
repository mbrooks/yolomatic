import { describe, expect, it } from "vitest";
import { generateCommitMessage } from "./commit-message.js";

describe("generateCommitMessage", () => {
	it("uses TARS: prefix when no labels match", () => {
		const msg = generateCommitMessage(undefined, 42, "Add widget support");
		expect(msg).toBe("TARS: Add widget support");
	});

	it("infers feat: from enhancement label", () => {
		const msg = generateCommitMessage(["enhancement"], 42, "Add dark mode");
		expect(msg).toBe("feat: Add dark mode");
	});

	it("infers fix: from bug label", () => {
		const msg = generateCommitMessage(["bug"], 42, "Resolve race condition");
		expect(msg).toBe("fix: Resolve race condition");
	});

	it("infers test: from test label", () => {
		const msg = generateCommitMessage(["test"], 42, "Cover edge cases");
		expect(msg).toBe("test: Cover edge cases");
	});

	it("falls back to generic message without summary", () => {
		const msg = generateCommitMessage(["chore"], 7, undefined);
		expect(msg).toBe("chore: Changes for issue #7");
	});

	it("truncates at word boundary to stay under 50 chars", () => {
		const long =
			"This is an extraordinarily long summary that definitely exceeds the fifty character soft limit";
		const msg = generateCommitMessage(["bug"], 99, long);
		expect(msg.length).toBeLessThanOrEqual(50);
		expect(msg.startsWith("fix: ")).toBe(true);
	});

	it("hard truncates at 72 chars when word boundary not found", () => {
		const long = "A".repeat(100);
		const msg = generateCommitMessage(undefined, 1, long);
		expect(msg.length).toBeLessThanOrEqual(72);
		expect(msg.startsWith("TARS: ")).toBe(true);
	});

	it("uses first line as subject and rest as body", () => {
		const msg = generateCommitMessage(["docs"], 5, "Update README\n\nMore details here");
		expect(msg).toBe("docs: Update README\n\nMore details here");
	});

	it("is case-insensitive for label matching", () => {
		const msg = generateCommitMessage(["BUG", "Enhancement"], 3, "Something");
		expect(msg).toBe("fix: Something");
	});

	it("prefers first matching prefix", () => {
		const msg = generateCommitMessage(["bug", "enhancement"], 2, "Something");
		expect(msg).toBe("fix: Something");
	});

	it("converts past tense to imperative mood", () => {
		const msg = generateCommitMessage(["enhancement"], 1, "Implemented the silent flag");
		expect(msg).toBe("feat: Implement the silent flag");
	});

	it("preserves case when converting to imperative", () => {
		const msg = generateCommitMessage(["enhancement"], 1, "implemented the silent flag");
		expect(msg).toBe("feat: implement the silent flag");
	});

	it("strips trailing period from subject", () => {
		const msg = generateCommitMessage(["bug"], 1, "Fixed a bug.");
		expect(msg).toBe("fix: Fix a bug");
	});

	it("wraps body at 72 characters", () => {
		const body = Array.from({ length: 50 }, () => "word").join(" ");
		const summary = `Subject\n\n${body}`;
		const msg = generateCommitMessage(["feat"], 1, summary);
		const lines = msg.split("\n");
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(72);
		}
	});

	it("preserves list items when wrapping body", () => {
		const summary =
			"Subject\n\n- First item that is very long and should definitely be wrapped correctly because it exceeds seventy-two characters\n- Second item";
		const msg = generateCommitMessage(["feat"], 1, summary);
		expect(msg).toContain("- First item");
		expect(msg).toContain("- Second item");
	});

	it("strips markdown headings from subject", () => {
		const msg = generateCommitMessage(["bug"], 1, "### Fix parser crash");
		expect(msg).toBe("fix: Fix parser crash");
	});

	it("strips bold and inline code from subject", () => {
		const msg = generateCommitMessage(["feature"], 1, "**Add** `widget` support");
		expect(msg).toBe("feat: Add widget support");
	});

	it("strips links from subject", () => {
		const msg = generateCommitMessage(["docs"], 1, "Update [guide](https://example.com)");
		expect(msg).toBe("docs: Update guide");
	});

	it("strips markdown from body while preserving structure", () => {
		const summary = "Subject\n\n**Bold** and `code` and [link](url)\n\n### Heading\n\n- list item";
		const msg = generateCommitMessage(["feat"], 1, summary);
		expect(msg).toContain("Bold and code and link");
		expect(msg).toContain("Heading");
		expect(msg).toContain("- list item");
	});

	it("strips fenced code blocks from body", () => {
		const summary = "Subject\n\n```ts\nconst x = 1;\n```\n\nAfter code";
		const msg = generateCommitMessage(["feat"], 1, summary);
		expect(msg).not.toContain("```");
		expect(msg).toContain("After code");
	});

	it("falls back to default subject when first line is empty after stripping", () => {
		const msg = generateCommitMessage(["bug"], 42, "```\n```\n\nActual summary");
		expect(msg).toBe("fix: Actual summary");
	});
});
