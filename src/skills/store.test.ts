import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { SkillStore } from "./store.js";

const TEST_DB = "/tmp/tars-skill-store-test.sqlite";

describe("SkillStore", () => {
	let store: SkillStore;

	beforeEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		store = new SkillStore(TEST_DB);
	});

	afterEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
	});

	it("creates a skill", async () => {
		const skill = await store.create({
			name: "test-skill",
			description: "A test skill",
			content: "# Test\n\nSteps",
			enabled: true,
		});
		expect(skill.id).toBeDefined();
		expect(skill.name).toBe("test-skill");
		expect(skill.enabled).toBe(true);
	});

	it("gets a skill by id", async () => {
		const created = await store.create({
			name: "get-test",
			description: "Desc",
			content: "Body",
			enabled: false,
		});
		const found = await store.get(created.id);
		expect(found).not.toBeNull();
		expect(found!.name).toBe("get-test");
		expect(found!.enabled).toBe(false);
	});

	it("gets a skill by name", async () => {
		await store.create({
			name: "by-name",
			description: "Desc",
			content: "Body",
			enabled: true,
		});
		const found = await store.getByName("by-name");
		expect(found).not.toBeNull();
		expect(found!.name).toBe("by-name");
	});

	it("returns null for missing skill by name", async () => {
		const found = await store.getByName("does-not-exist");
		expect(found).toBeNull();
	});

	it("updates enabled flag to false", async () => {
		const created = await store.create({ name: "flag", description: "", content: "", enabled: true });
		const updated = await store.update(created.id, { enabled: false });
		expect(updated!.enabled).toBe(false);
	});

	it("lists all skills ordered by updated_at desc", async () => {
		await store.create({ name: "a", description: "A", content: "a", enabled: true });
		await store.create({ name: "b", description: "B", content: "b", enabled: true });
		const list = await store.listAll();
		expect(list.length).toBe(2);
		expect(list[0].name).toBe("b");
		expect(list[1].name).toBe("a");
	});

	it("updates a skill", async () => {
		const created = await store.create({ name: "old", description: "Old", content: "old", enabled: true });
		const updated = await store.update(created.id, { name: "new", description: "New", content: "new" });
		expect(updated).not.toBeNull();
		expect(updated!.name).toBe("new");
		expect(updated!.description).toBe("New");
		expect(updated!.content).toBe("new");
		expect(updated!.enabled).toBe(true);
	});

	it("returns null when updating missing skill", async () => {
		const updated = await store.update("missing", { name: "x" });
		expect(updated).toBeNull();
	});

	it("deletes a skill", async () => {
		const created = await store.create({ name: "del", description: "D", content: "d", enabled: true });
		await store.delete(created.id);
		const found = await store.get(created.id);
		expect(found).toBeNull();
	});
});
