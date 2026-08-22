import { describe, expect, it } from "vitest";
import {
	normalizeRepoBooleanOverride,
	normalizeRepoGitHubEventMode,
	repoKey,
	repoModeIncludesPolling,
	repoModeIncludesWebhook,
	resolveRepoDefaultBranch,
	resolveRepoGitHubEventMode,
	resolveRepoIssueAdminLinkInCommentsEnabled,
	resolveRepoIssueNewCommentEnabled,
	resolveRepoWorkerTemplate,
	type RepoGitHubEventMode,
} from "./repository.js";

describe("repository helpers", () => {
	describe("repoModeIncludesWebhook / repoModeIncludesPolling", () => {
		it("treats webhook and both as webhook-capable", () => {
			expect(repoModeIncludesWebhook("webhook")).toBe(true);
			expect(repoModeIncludesWebhook("both")).toBe(true);
			expect(repoModeIncludesWebhook("polling")).toBe(false);
		});

		it("treats polling and both as polling-capable", () => {
			expect(repoModeIncludesPolling("polling")).toBe(true);
			expect(repoModeIncludesPolling("both")).toBe(true);
			expect(repoModeIncludesPolling("webhook")).toBe(false);
		});
	});

	describe("resolveRepoGitHubEventMode", () => {
		it("returns the per-repo override when set", () => {
			const repo = {
				id: "mbrooks/yolomatic",
				owner: "mbrooks",
				repo: "yolomatic",
				fullName: null,
				visibility: null,
				githubEventMode: "polling" as RepoGitHubEventMode,
				defaultBranch: null,
				createdAt: "",
				updatedAt: "",
			};
			expect(resolveRepoGitHubEventMode(repo, "webhook")).toBe("polling");
		});

		it("falls back to the global mode when the override is null", () => {
			const repo = {
				id: "mbrooks/yolomatic",
				owner: "mbrooks",
				repo: "yolomatic",
				fullName: null,
				visibility: null,
				githubEventMode: null,
				defaultBranch: null,
				createdAt: "",
				updatedAt: "",
			};
			expect(resolveRepoGitHubEventMode(repo, "both")).toBe("both");
		});

		it("falls back to the global mode when no repository is provided", () => {
			expect(resolveRepoGitHubEventMode(null, "webhook")).toBe("webhook");
			expect(resolveRepoGitHubEventMode(undefined, "polling")).toBe("polling");
		});
	});

	describe("resolveRepoDefaultBranch", () => {
		it("returns the per-repo override when set", () => {
			const repo = {
				id: "mbrooks/yolomatic",
				owner: "mbrooks",
				repo: "yolomatic",
				fullName: null,
				visibility: null,
				githubEventMode: null,
				defaultBranch: "develop",
				createdAt: "",
				updatedAt: "",
			};
			expect(resolveRepoDefaultBranch(repo, "main")).toBe("develop");
		});

		it("falls back to the global default when the override is null", () => {
			const repo = {
				id: "mbrooks/yolomatic",
				owner: "mbrooks",
				repo: "yolomatic",
				fullName: null,
				visibility: null,
				githubEventMode: null,
				defaultBranch: null,
				createdAt: "",
				updatedAt: "",
			};
			expect(resolveRepoDefaultBranch(repo, "main")).toBe("main");
		});

		it("falls back to the global default when no repository is provided", () => {
			expect(resolveRepoDefaultBranch(null, "main")).toBe("main");
			expect(resolveRepoDefaultBranch(undefined, "trunk")).toBe("trunk");
		});
	});

	describe("resolveRepoWorkerTemplate", () => {
		it("returns the per-repository template when configured", () => {
			expect(resolveRepoWorkerTemplate({ workerTemplate: "python" }, "node")).toBe("python");
		});

		it("inherits the default template when the repository has no override", () => {
			expect(resolveRepoWorkerTemplate({ workerTemplate: null }, "rust")).toBe("rust");
			expect(resolveRepoWorkerTemplate(null, "php")).toBe("php");
		});
	});

	describe("resolveRepoIssueNewCommentEnabled", () => {
		it("returns the per-repo override when set, regardless of the global value", () => {
			expect(resolveRepoIssueNewCommentEnabled({ issueNewCommentEnabled: false }, true)).toBe(false);
			expect(resolveRepoIssueNewCommentEnabled({ issueNewCommentEnabled: true }, false)).toBe(true);
		});

		it("inherits the global value when the override is null", () => {
			expect(resolveRepoIssueNewCommentEnabled({ issueNewCommentEnabled: null }, false)).toBe(false);
			expect(resolveRepoIssueNewCommentEnabled({ issueNewCommentEnabled: null }, true)).toBe(true);
		});

		it("inherits the global value when no repository is provided", () => {
			expect(resolveRepoIssueNewCommentEnabled(null, true)).toBe(true);
			expect(resolveRepoIssueNewCommentEnabled(undefined, false)).toBe(false);
		});
	});

	describe("resolveRepoIssueAdminLinkInCommentsEnabled", () => {
		it("returns the per-repo override when set, regardless of the global value", () => {
			expect(resolveRepoIssueAdminLinkInCommentsEnabled({ issueAdminLinkInCommentsEnabled: false }, true)).toBe(false);
			expect(resolveRepoIssueAdminLinkInCommentsEnabled({ issueAdminLinkInCommentsEnabled: true }, false)).toBe(true);
		});

		it("inherits the global value when the override is null", () => {
			expect(resolveRepoIssueAdminLinkInCommentsEnabled({ issueAdminLinkInCommentsEnabled: null }, false)).toBe(false);
			expect(resolveRepoIssueAdminLinkInCommentsEnabled({ issueAdminLinkInCommentsEnabled: null }, true)).toBe(true);
		});

		it("inherits the global value when no repository is provided", () => {
			expect(resolveRepoIssueAdminLinkInCommentsEnabled(null, true)).toBe(true);
			expect(resolveRepoIssueAdminLinkInCommentsEnabled(undefined, false)).toBe(false);
		});
	});

	describe("normalizeRepoBooleanOverride", () => {
		it("maps truthy 'true' strings to true after trimming and lowercasing", () => {
			expect(normalizeRepoBooleanOverride("true")).toBe(true);
			expect(normalizeRepoBooleanOverride("  TRUE  ")).toBe(true);
			expect(normalizeRepoBooleanOverride("True")).toBe(true);
		});

		it("maps 'false' strings to false", () => {
			expect(normalizeRepoBooleanOverride("false")).toBe(false);
			expect(normalizeRepoBooleanOverride(" False ")).toBe(false);
		});

		it("maps empty/whitespace strings to null (inherit)", () => {
			expect(normalizeRepoBooleanOverride("")).toBeNull();
			expect(normalizeRepoBooleanOverride("   ")).toBeNull();
		});

		it("rejects unknown values as null rather than coercing them", () => {
			expect(normalizeRepoBooleanOverride("maybe")).toBeNull();
			expect(normalizeRepoBooleanOverride(undefined)).toBeNull();
			expect(normalizeRepoBooleanOverride(1)).toBeNull();
		});

		it("passes through actual booleans", () => {
			expect(normalizeRepoBooleanOverride(true)).toBe(true);
			expect(normalizeRepoBooleanOverride(false)).toBe(false);
		});
	});

	describe("normalizeRepoGitHubEventMode", () => {
		it("accepts the supported modes case-insensitively after trimming", () => {
			expect(normalizeRepoGitHubEventMode("webhook")).toBe("webhook");
			expect(normalizeRepoGitHubEventMode("  POLLING  ")).toBe("polling");
			expect(normalizeRepoGitHubEventMode("Both")).toBe("both");
		});

		it("returns null for unknown or non-string values", () => {
			expect(normalizeRepoGitHubEventMode("invalid")).toBeNull();
			expect(normalizeRepoGitHubEventMode("")).toBeNull();
			expect(normalizeRepoGitHubEventMode(undefined)).toBeNull();
			expect(normalizeRepoGitHubEventMode(123)).toBeNull();
		});
	});

	describe("repoKey", () => {
		it("lowercases the owner/repo pair for a stable identifier", () => {
			expect(repoKey("Mbrooks", "Yolomatic")).toBe("mbrooks/yolomatic");
			expect(repoKey("mbrooks", "yolomatic")).toBe("mbrooks/yolomatic");
		});
	});
});
