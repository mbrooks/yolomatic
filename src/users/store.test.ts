import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { UserStore, hashPassword, verifyPassword } from "./store.js";

async function tmpStore(): Promise<UserStore> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-user-store-"));
	const store = new UserStore(path.join(dir, "users.sqlite"));
	return store;
}

describe("hashPassword / verifyPassword", () => {
	it("hashes a password and verifies it against the plaintext", () => {
		const hash = hashPassword("secret");
		expect(hash).not.toBe("secret");
		expect(hash.startsWith("scrypt:")).toBe(true);
		expect(verifyPassword("secret", hash)).toBe(true);
	});

	it("rejects a wrong password", () => {
		const hash = hashPassword("secret");
		expect(verifyPassword("wrong", hash)).toBe(false);
	});

	it("produces distinct hashes for the same password (random salt)", () => {
		const a = hashPassword("secret");
		const b = hashPassword("secret");
		expect(a).not.toBe(b);
	});

	it("rejects a malformed stored hash", () => {
		expect(verifyPassword("secret", "not-a-hash")).toBe(false);
		expect(verifyPassword("secret", "scrypt:1:2:3")).toBe(false);
		expect(verifyPassword("secret", "scrypt:x:y:z:salt:hash")).toBe(false);
	});

	it("rejects an empty salt", () => {
		expect(verifyPassword("secret", "scrypt:16384:8:1::hash")).toBe(false);
	});
});

describe("UserStore", () => {
	it("creates a user and looks it up by id and username", async () => {
		const store = await tmpStore();
		const user = store.createSync({ fullName: "Admin", username: "admin", password: "secret" });

		expect(user.id).toBeTruthy();
		expect(user.fullName).toBe("Admin");
		expect(user.username).toBe("admin");
		expect(user.passwordHash.startsWith("scrypt:")).toBe(true);

		expect(store.getByIdSync(user.id)?.username).toBe("admin");
		expect(store.getByUsernameSync("admin")?.id).toBe(user.id);
		store.close();
	});

	it("looks up usernames case-insensitively", async () => {
		const store = await tmpStore();
		store.createSync({ fullName: "Admin", username: "admin", password: "secret" });

		expect(store.getByUsernameSync("ADMIN")?.username).toBe("admin");
		store.close();
	});

	it("rejects a duplicate username", async () => {
		const store = await tmpStore();
		store.createSync({ fullName: "Admin", username: "admin", password: "secret" });

		expect(() =>
			store.createSync({ fullName: "Other", username: "admin", password: "pass" }),
		).toThrow(/already taken/);
		store.close();
	});

	it("rejects a duplicate username with different casing", async () => {
		const store = await tmpStore();
		store.createSync({ fullName: "Admin", username: "admin", password: "secret" });

		expect(() =>
			store.createSync({ fullName: "Other", username: "ADMIN", password: "pass" }),
		).toThrow(/already taken/);
		store.close();
	});

	it("validates required fields on create", async () => {
		const store = await tmpStore();
		expect(() => store.createSync({ fullName: "", username: "u", password: "p" })).toThrow(/full_name/);
		expect(() => store.createSync({ fullName: "F", username: "  ", password: "p" })).toThrow(/username/);
		expect(() => store.createSync({ fullName: "F", username: "u", password: "" })).toThrow(/password/);
		store.close();
	});

	it("trims full name and username on create", async () => {
		const store = await tmpStore();
		const user = store.createSync({ fullName: "  Admin  ", username: "  admin  ", password: "p" });
		expect(user.fullName).toBe("Admin");
		expect(user.username).toBe("admin");
		store.close();
	});

	it("lists users ordered by created_at then username", async () => {
		const store = await tmpStore();
		const a = store.createSync({ fullName: "A", username: "aaa", password: "p" });
		const b = store.createSync({ fullName: "B", username: "bbb", password: "p" });

		const list = store.listSync();
		expect(list.map((u) => u.id)).toEqual([a.id, b.id]);
		expect(store.listViews().map((v) => v.id)).toEqual([a.id, b.id]);
		// UserView omits the password hash
		expect("passwordHash" in store.listViews()[0]).toBe(false);
		store.close();
	});

	it("updates a user's full name", async () => {
		const store = await tmpStore();
		const user = store.createSync({ fullName: "Admin", username: "admin", password: "p" });

		const updated = store.updateFullNameSync(user.id, "New Name");
		expect(updated?.fullName).toBe("New Name");
		expect(updated?.updatedAt).not.toBe(user.updatedAt);
		store.close();
	});

	it("returns null when updating full name of a missing user", async () => {
		const store = await tmpStore();
		expect(store.updateFullNameSync("missing", "X")).toBeNull();
		store.close();
	});

	it("rejects an empty full name on update", async () => {
		const store = await tmpStore();
		const user = store.createSync({ fullName: "Admin", username: "admin", password: "p" });

		expect(() => store.updateFullNameSync(user.id, "   ")).toThrow(/full_name/);
		store.close();
	});

	it("updates a user's password and invalidates the old hash", async () => {
		const store = await tmpStore();
		const user = store.createSync({ fullName: "Admin", username: "admin", password: "old" });

		const updated = store.updatePasswordSync(user.id, "new");
		expect(updated?.passwordHash).not.toBe(user.passwordHash);
		expect(verifyPassword("new", updated!.passwordHash)).toBe(true);
		expect(verifyPassword("old", updated!.passwordHash)).toBe(false);
		store.close();
	});

	it("returns null when resetting password of a missing user", async () => {
		const store = await tmpStore();
		expect(store.updatePasswordSync("missing", "p")).toBeNull();
		store.close();
	});

	it("rejects an empty password on reset", async () => {
		const store = await tmpStore();
		const user = store.createSync({ fullName: "Admin", username: "admin", password: "p" });

		expect(() => store.updatePasswordSync(user.id, "")).toThrow(/password/);
		store.close();
	});

	it("deletes an existing user", async () => {
		const store = await tmpStore();
		const user = store.createSync({ fullName: "Admin", username: "admin", password: "p" });

		expect(store.deleteSync(user.id)).toBe(true);
		expect(store.getByIdSync(user.id)).toBeNull();
		store.close();
	});

	it("returns false when deleting a missing user", async () => {
		const store = await tmpStore();
		expect(store.deleteSync("missing")).toBe(false);
		store.close();
	});

	it("reports hasAny correctly", async () => {
		const store = await tmpStore();
		expect(store.hasAnySync()).toBe(false);
		store.createSync({ fullName: "Admin", username: "admin", password: "p" });
		expect(store.hasAnySync()).toBe(true);
		store.close();
	});

	it("returns the first user ordered by created_at", async () => {
		const store = await tmpStore();
		expect(store.firstSync()).toBeNull();
		const a = store.createSync({ fullName: "A", username: "aaa", password: "p" });
		store.createSync({ fullName: "B", username: "bbb", password: "p" });

		expect(store.firstSync()?.id).toBe(a.id);
		store.close();
	});

	it("async wrappers resolve to the same values as sync", async () => {
		const store = await tmpStore();
		const user = await store.create({ fullName: "Admin", username: "admin", password: "p" });

		expect((await store.getById(user.id))?.id).toBe(user.id);
		expect((await store.getByUsername("admin"))?.id).toBe(user.id);
		expect((await store.list()).length).toBe(1);
		expect(await store.hasAny()).toBe(true);
		expect((await store.first())?.id).toBe(user.id);
		expect(await store.delete(user.id)).toBe(true);
		expect(await store.hasAny()).toBe(false);
		store.close();
	});
});