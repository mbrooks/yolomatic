import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { RepositoryStore } from "./repository-store.js";

const TEST_DB = "/tmp/yolomatic-repository-store-test.sqlite";

describe("RepositoryStore", () => {
	let store: RepositoryStore;

	beforeEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		store = new RepositoryStore(TEST_DB);
	});

	afterEach(() => {
		try {
			store.close();
		} catch {
			// ignore
		}
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${TEST_DB}-wal`);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${TEST_DB}-shm`);
		} catch {
			// ignore
		}
	});

	it("starts with an empty table", async () => {
		expect(await store.list()).toEqual([]);
		expect(await store.listForPolling()).toEqual([]);
	});

	it("upserts and retrieves a repository", async () => {
		const repo = await store.upsert({ owner: "mbrooks", repo: "yolomatic" });
		expect(repo.owner).toBe("mbrooks");
		expect(repo.repo).toBe("yolomatic");
		expect(repo.id).toBe("mbrooks/yolomatic");
		expect(repo.createdAt).toBe(repo.updatedAt);
		expect(repo.githubEventMode).toBeNull();
		expect(repo.visibility).toBeNull();

		const found = await store.get("mbrooks", "yolomatic");
		expect(found).not.toBeNull();
		expect(found!.id).toBe(repo.id);
	});

	it("upsert updates an existing repository, preserving the id and bumping updated_at", async () => {
		const original = await store.upsert({
			owner: "mbrooks",
			repo: "yolomatic",
			fullName: "mbrooks/yolomatic",
			visibility: "private",
		});
		// Ensure updatedAt differs from createdAt on the second write.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const updated = await store.upsert({
			owner: "mbrooks",
			repo: "yolomatic",
			githubEventMode: "polling",
			defaultBranch: "develop",
		});
		expect(updated.id).toBe(original.id);
		expect(updated.githubEventMode).toBe("polling");
		expect(updated.defaultBranch).toBe("develop");
		expect(updated.updatedAt).not.toBe(original.updatedAt);
		expect(updated.createdAt).toBe(original.createdAt);
		expect(await store.list()).toHaveLength(1);
	});

	it("matches owner and repo case-insensitively on get, upsert, and remove", async () => {
		await store.upsert({
			owner: "Mbrooks",
			repo: "Yolomatic",
			fullName: "mbrooks/yolomatic",
		});
		expect(await store.get("mbrooks", "yolomatic")).not.toBeNull();
		const updated = await store.upsert({ owner: "MBROOKS", repo: "YOLOMATIC", githubEventMode: "both" });
		expect(updated.owner).toBe("Mbrooks");
		expect(updated.githubEventMode).toBe("both");
		expect(await store.list()).toHaveLength(1);
		expect(await store.remove("mbrooks", "yolomatic")).toBe(true);
		expect(await store.list()).toHaveLength(0);
	});

	it("returns null from get for unknown repositories", async () => {
		expect(await store.get("nobody", "here")).toBeNull();
	});

	it("returns false from remove when the repository does not exist", async () => {
		expect(await store.remove("nobody", "here")).toBe(false);
	});

	it("lists repositories ordered by owner then repo", async () => {
		await store.upsert({ owner: "octocat", repo: "zebra" });
		await store.upsert({ owner: "octocat", repo: "apple" });
		await store.upsert({ owner: "mbrooks", repo: "yolomatic" });
		const list = await store.list();
		expect(list.map((r) => `${r.owner}/${r.repo}`)).toEqual([
			"mbrooks/yolomatic",
			"octocat/apple",
			"octocat/zebra",
		]);
	});

	it("listForPolling includes inherited repos and polling/both overrides, excludes webhook-only", async () => {
		await store.upsert({ owner: "inherited", repo: "repo" });
		await store.upsert({ owner: "polling", repo: "repo", githubEventMode: "polling" });
		await store.upsert({ owner: "both", repo: "repo", githubEventMode: "both" });
		await store.upsert({ owner: "webhook", repo: "only", githubEventMode: "webhook" });
		const polling = await store.listForPolling();
		expect(polling.map((r) => `${r.owner}/${r.repo}`).sort()).toEqual([
			"both/repo",
			"inherited/repo",
			"polling/repo",
		]);
	});

	it("persists nullable fields and visibility", async () => {
		const repo = await store.upsert({
			owner: "mbrooks",
			repo: "yolomatic",
			fullName: "mbrooks/yolomatic",
			visibility: "internal",
			githubEventMode: "both",
			defaultBranch: "main",
			workerTemplate: "python",
		});
		const found = await store.get("mbrooks", "yolomatic");
		expect(found).toEqual(repo);
		expect(found!.visibility).toBe("internal");
		expect(found!.fullName).toBe("mbrooks/yolomatic");
		expect(found!.workerTemplate).toBe("python");
	});

	it("round-trips the comment-setting boolean overrides", async () => {
		const repo = await store.upsert({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNewCommentEnabled: false,
			issueAdminLinkInCommentsEnabled: true,
		});
		expect(repo.issueNewCommentEnabled).toBe(false);
		expect(repo.issueAdminLinkInCommentsEnabled).toBe(true);

		const found = await store.get("mbrooks", "yolomatic");
		expect(found!.issueNewCommentEnabled).toBe(false);
		expect(found!.issueAdminLinkInCommentsEnabled).toBe(true);
	});

	it("defaults the comment-setting overrides to null when not provided", async () => {
		await store.upsert({ owner: "mbrooks", repo: "yolomatic" });
		const found = await store.get("mbrooks", "yolomatic");
		expect(found!.issueNewCommentEnabled).toBeNull();
		expect(found!.issueAdminLinkInCommentsEnabled).toBeNull();
	});

	it("clears a comment-setting override back to null on a subsequent upsert", async () => {
		await store.upsert({
			owner: "mbrooks", repo: "yolomatic", issueNewCommentEnabled: false });
		await store.upsert({ owner: "mbrooks", repo: "yolomatic", issueNewCommentEnabled: null });
		const found = await store.get("mbrooks", "yolomatic");
		expect(found!.issueNewCommentEnabled).toBeNull();
	});

	it("round-trips the per-repository build-model override", async () => {
		const repo = await store.upsert({
			owner: "mbrooks",
			repo: "yolomatic",
			piAgentBuildModel: "openai/gpt-4.1",
		});
		expect(repo.piAgentBuildModel).toBe("openai/gpt-4.1");

		const found = await store.get("mbrooks", "yolomatic");
		expect(found!.piAgentBuildModel).toBe("openai/gpt-4.1");
	});

	it("clears the build-model override when it is omitted by a later upsert", async () => {
		await store.upsert({ owner: "mbrooks", repo: "yolomatic", piAgentBuildModel: "ollama/qwen3:30b" });
		await store.upsert({ owner: "mbrooks", repo: "yolomatic", defaultBranch: "develop" });
		const found = await store.get("mbrooks", "yolomatic");
		expect(found!.piAgentBuildModel).toBeNull();
		expect(found!.defaultBranch).toBe("develop");
	});

	it("defaults the build-model override to null when not provided", async () => {
		await store.upsert({ owner: "mbrooks", repo: "yolomatic" });
		const found = await store.get("mbrooks", "yolomatic");
		expect(found!.piAgentBuildModel).toBeNull();
	});

	it("persists an existing build-model override across an unrelated upsert when the field is passed", async () => {
		await store.upsert({ owner: "mbrooks", repo: "yolomatic", piAgentBuildModel: "openai/gpt-4.1" });
		// PATCH-style upsert re-resolves every field; unrelated fields change but
		// the model must survive a read-modify-write that keeps the value.
		await store.upsert({ owner: "mbrooks", repo: "yolomatic", piAgentBuildModel: "openai/gpt-4.1", workerTemplate: "python" });
		const found = await store.get("mbrooks", "yolomatic");
		expect(found!.piAgentBuildModel).toBe("openai/gpt-4.1");
		expect(found!.workerTemplate).toBe("python");
	});

	it("throws when upserting without owner or repo", async () => {
		await expect(store.upsert({ owner: "", repo: "x" })).rejects.toThrow();
		await expect(store.upsert({ owner: "x", repo: "" })).rejects.toThrow();
	});
});
