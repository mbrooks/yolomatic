import { describe, expect, it } from "vitest";
import {
	normalizeRepoGitHubEventMode,
	repoKey,
	repoModeIncludesPolling,
	repoModeIncludesWebhook,
	resolveRepoDefaultBranch,
	resolveRepoGitHubEventMode,
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