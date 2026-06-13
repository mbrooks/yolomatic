import { describe, expect, it } from "vitest";
import {
	buildConversationPrompt,
	buildConversationSystemPrompt,
	buildSystemPrompt,
	buildUserPrompt,
	type RepoContext,
} from "./issue-prompts.js";

describe("buildSystemPrompt", () => {
	it("contains JSON-only instruction", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("Respond ONLY with valid JSON");
		expect(prompt).toContain("no markdown fences");
	});

	it("instructs reviewing repository code before drafting", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("use the available file tools (ls, find, read, grep)");
		expect(prompt).toContain("review the target repository's code on the main branch");
		expect(prompt).toContain("list key source files");
		expect(prompt).toContain("check recent commits");
	});

	it("instructs thoroughness and detail when drafting issues", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("Be thorough and detailed when drafting");
		expect(prompt).toContain("Include enough context, reproduction steps, and expected behavior");
	});
});

describe("buildUserPrompt", () => {
	it("includes repo and user request", () => {
		const prompt = buildUserPrompt("owner", "repo", "fix the bug");
		expect(prompt).toContain("Repository: owner/repo");
		expect(prompt).toContain("User request: fix the bug");
		expect(prompt).toContain("Generate a GitHub issue");
		expect(prompt).toContain("thorough, detailed description with reproduction steps");
	});

	it("adds privacy warning when privacyMode is true", () => {
		const prompt = buildUserPrompt("o", "r", "crash", undefined, { privacyMode: true });
		expect(prompt).toContain("Privacy mode is enabled");
		expect(prompt).toContain("Do NOT include any code snippets");
	});

	it("omits privacy warning when privacyMode is false", () => {
		const prompt = buildUserPrompt("o", "r", "crash", undefined, { privacyMode: false });
		expect(prompt).not.toContain("Privacy mode is enabled");
	});

	it("includes available labels when context provided", () => {
		const context: RepoContext = {
			labels: ["bug", "enhancement"],
			templates: [],
			recentCommits: [],
			relatedIssues: [],
		};
		const prompt = buildUserPrompt("o", "r", "fix", context);
		expect(prompt).toContain("Available labels in this repository: bug, enhancement");
		expect(prompt).toContain("Choose only from this label set");
	});

	it("includes templates when context provided", () => {
		const context: RepoContext = {
			labels: [],
			templates: [{ name: "Bug Report", body: "## Steps to reproduce\n" }],
			recentCommits: [],
			relatedIssues: [],
		};
		const prompt = buildUserPrompt("o", "r", "fix", context);
		expect(prompt).toContain("Available issue templates:");
		expect(prompt).toContain("Bug Report");
	});

	it("includes selected template body when specified", () => {
		const context: RepoContext = {
			labels: [],
			templates: [{ name: "Bug Report", body: "## Steps to reproduce\n" }],
			recentCommits: [],
			relatedIssues: [],
		};
		const prompt = buildUserPrompt("o", "r", "fix", context, { privacyMode: false, selectedTemplate: "Bug Report" });
		expect(prompt).toContain('Selected template "Bug Report"');
		expect(prompt).toContain("## Steps to reproduce");
	});

	it("includes recent commits when context provided", () => {
		const context: RepoContext = {
			labels: [],
			templates: [],
			recentCommits: ["abc123: fix parser", "def456: update deps"],
			relatedIssues: [],
		};
		const prompt = buildUserPrompt("o", "r", "fix", context);
		expect(prompt).toContain("Recent commits (for context):");
		expect(prompt).toContain("abc123: fix parser");
		expect(prompt).toContain("def456: update deps");
	});

	it("includes related issues when context provided", () => {
		const context: RepoContext = {
			labels: [],
			templates: [],
			recentCommits: [],
			relatedIssues: [{ number: 42, title: "Old bug", state: "closed" }],
		};
		const prompt = buildUserPrompt("o", "r", "fix", context);
		expect(prompt).toContain("Potentially related issues:");
		expect(prompt).toContain("#42 (closed): Old bug");
	});

	it("suppresses context enrichment when privacyMode is true", () => {
		const context: RepoContext = {
			labels: ["bug"],
			templates: [{ name: "T", body: "B" }],
			recentCommits: ["c1"],
			relatedIssues: [{ number: 1, title: "X", state: "open" }],
		};
		const prompt = buildUserPrompt("o", "r", "fix", context, { privacyMode: true });
		expect(prompt).not.toContain("Available labels");
		expect(prompt).not.toContain("Available issue templates");
		expect(prompt).not.toContain("Recent commits");
		expect(prompt).not.toContain("Potentially related issues");
	});

	it("limits recent commits to five entries", () => {
		const context: RepoContext = {
			labels: [],
			templates: [],
			recentCommits: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"],
			relatedIssues: [],
		};
		const prompt = buildUserPrompt("o", "r", "fix", context);
		expect(prompt).toContain("c5");
		expect(prompt).not.toContain("c6");
		expect(prompt).not.toContain("c7");
	});

	it("limits related issues to five entries", () => {
		const context: RepoContext = {
			labels: [],
			templates: [],
			recentCommits: [],
			relatedIssues: [
				{ number: 1, title: "a", state: "open" },
				{ number: 2, title: "b", state: "open" },
				{ number: 3, title: "c", state: "open" },
				{ number: 4, title: "d", state: "open" },
				{ number: 5, title: "e", state: "open" },
				{ number: 6, title: "f", state: "open" },
			],
		};
		const prompt = buildUserPrompt("o", "r", "fix", context);
		expect(prompt).toContain("#5");
		expect(prompt).not.toContain("#6");
	});
});

describe("buildConversationSystemPrompt", () => {
	it("limits the assistant to issue-drafting behavior", () => {
		const prompt = buildConversationSystemPrompt();
		expect(prompt).toContain("GitHub issue");
		expect(prompt).toContain("Set shouldCreate to true only when the user has clearly asked");
	});

	it("instructs reviewing repository code before drafting", () => {
		const prompt = buildConversationSystemPrompt();
		expect(prompt).toContain("use the available file tools (ls, find, read, grep)");
		expect(prompt).toContain("review the target repository's code on the main branch");
		expect(prompt).toContain("list key source files");
		expect(prompt).toContain("check recent commits");
	});

	it("instructs thoroughness in the conversational draft", () => {
		const prompt = buildConversationSystemPrompt();
		expect(prompt).toContain("Be thorough and detailed when drafting");
		expect(prompt).toContain("Include enough context, reproduction steps, and expected behavior");
	});
});

describe("buildConversationPrompt", () => {
	it("includes privacy guidance and conversation transcript", () => {
		const prompt = buildConversationPrompt({
			messages: [
				{ role: "assistant", text: "Which repo?" },
				{ role: "user", text: "mbrooks/tars" },
			],
			options: { privacyMode: true },
		});
		expect(prompt).toContain("Current repository owner: (unknown)");
		expect(prompt).toContain("IMPORTANT: Privacy mode is enabled");
		expect(prompt).toContain("Assistant: Which repo?");
		expect(prompt).toContain("User: mbrooks/tars");
	});

	it("includes full repo context and selected template details when available", () => {
		const prompt = buildConversationPrompt({
			owner: "mbrooks",
			repo: "tars",
			messages: [{ role: "user", text: "create it" }],
			draft: { title: "Draft title", body: "Draft body", labels: ["bug"], assignees: ["mbrooks"] },
			context: {
				labels: ["bug", "enhancement"],
				templates: [{ name: "Bug Report", body: "## Steps" }],
				recentCommits: ["c1", "c2", "c3", "c4", "c5", "c6"],
				relatedIssues: [
					{ number: 1, title: "one", state: "open" },
					{ number: 2, title: "two", state: "closed" },
				],
			},
			options: { privacyMode: false, selectedTemplate: "Bug Report" },
		});
		expect(prompt).toContain("Current repository owner: mbrooks");
		expect(prompt).toContain('"title": "Draft title"');
		expect(prompt).toContain("Available labels in this repository: bug, enhancement");
		expect(prompt).toContain('Selected template "Bug Report". Use this structure:');
		expect(prompt).toContain("Recent commits (for context):");
		expect(prompt).toContain("- c5");
		expect(prompt).not.toContain("- c6");
		expect(prompt).toContain("Potentially related issues:");
		expect(prompt).toContain("- #2 (closed): two");
	});

	it("includes rule to review repository code before drafting", () => {
		const prompt = buildConversationPrompt({
			messages: [{ role: "user", text: "help" }],
		});
		expect(prompt).toContain("review the target repository's main branch code");
		expect(prompt).toContain("draft references existing files");
	});

	it("includes rule to be thorough and detailed in draft body", () => {
		const prompt = buildConversationPrompt({
			messages: [{ role: "user", text: "help" }],
		});
		expect(prompt).toContain("Be thorough and detailed in the draft body");
		expect(prompt).toContain("Include reproduction steps, expected behavior");
	});

	it("mentions template auto-detection when templates exist but none is selected", () => {
		const prompt = buildConversationPrompt({
			messages: [{ role: "user", text: "help" }],
			context: {
				labels: [],
				templates: [{ name: "Bug Report", body: "## Steps" }],
				recentCommits: [],
				relatedIssues: [],
			},
			options: { privacyMode: false },
		});
		expect(prompt).toContain("If one of these templates fits the issue type");
	});
});
