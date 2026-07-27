import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { RepositoryStore } from "./repository-store.js";

const TEST_DB = "/tmp/yeetomatic-repository-store-test.sqlite";

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
		const repo = await store.upsert({ owner: "mbrooks", repo: "tars" });
		expect(repo.owner).toBe("mbrooks");
		expect(repo.repo).toBe("tars");
		expect(repo.id).toBe("mbrooks/tars");
		expect(repo.createdAt).toBe(repo.updatedAt);
		expect(repo.githubEventMode).toBeNull();
		expect(repo.visibility).toBeNull();

		const found = await store.get("mbrooks", "tars");
		expect(found).not.toBeNull();
		expect(found!.id).toBe(repo.id);
	});

	it("upsert updates an existing repository, preserving the id and bumping updated_at", async () => {
		const original = await store.upsert({
			owner: "mbrooks",
			repo: "tars",
			fullName: "mbrooks/tars",
			visibility: "private",
		});
		// Ensure updatedAt differs from createdAt on the second write.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const updated = await store.upsert({
			owner: "mbrooks",
			repo: "tars",
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
			repo: "Tars",
			fullName: "mbrooks/tars",
		});
		expect(await store.get("mbrooks", "tars")).not.toBeNull();
		const updated = await store.upsert({ owner: "MBROOKS", repo: "TARS", githubEventMode: "both" });
		expect(updated.owner).toBe("Mbrooks");
		expect(updated.githubEventMode).toBe("both");
		expect(await store.list()).toHaveLength(1);
		expect(await store.remove("mbrooks", "tars")).toBe(true);
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
		await store.upsert({ owner: "mbrooks", repo: "tars" });
		const list = await store.list();
		expect(list.map((r) => `${r.owner}/${r.repo}`)).toEqual([
			"mbrooks/tars",
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
			repo: "tars",
			fullName: "mbrooks/tars",
			visibility: "internal",
			githubEventMode: "both",
			defaultBranch: "main",
		});
		const found = await store.get("mbrooks", "tars");
		expect(found).toEqual(repo);
		expect(found!.visibility).toBe("internal");
		expect(found!.fullName).toBe("mbrooks/tars");
	});

	it("throws when upserting without owner or repo", async () => {
		await expect(store.upsert({ owner: "", repo: "x" })).rejects.toThrow();
		await expect(store.upsert({ owner: "x", repo: "" })).rejects.toThrow();
	});
});