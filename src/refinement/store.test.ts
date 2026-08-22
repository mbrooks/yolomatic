import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RefinementStore } from "./store.js";

describe("RefinementStore", () => {
	let tmpDir: string;
	let store: RefinementStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "refinement-store-"));
		store = new RefinementStore(path.join(tmpDir, "refinement.sqlite"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("creates and retrieves an attempt", () => {
		const attempt = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			requester: "admin",
			originalTitle: "Title",
			originalBody: "Body",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});

		expect(attempt.id).toBeDefined();
		expect(attempt.owner).toBe("mbrooks");
		expect(attempt.issueNumber).toBe(1);
		expect(attempt.state).toBe("running");

		const fetched = store.getAttempt(attempt.id);
		expect(fetched).not.toBeNull();
		expect(fetched!.originalTitle).toBe("Title");
	});

	it("updates an attempt", () => {
		const attempt = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 2,
			requester: "admin",
			originalTitle: "Title",
			originalBody: "Body",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});

		const updated = store.updateAttempt(attempt.id, {
			state: "applied",
			proposedTaskBody: "new body",
		});

		expect(updated.state).toBe("applied");
		expect(updated.proposedTaskBody).toBe("new body");
	});

	it("records and retrieves instruction comments", () => {
		store.recordInstructionComment("mbrooks", "yolomatic", 3, 12345);
		const record = store.getInstructionComment("mbrooks", "yolomatic", 3);
		expect(record).not.toBeNull();
		expect(record!.commentId).toBe(12345);
	});

	it("overwrites instruction comments for the same issue", () => {
		store.recordInstructionComment("mbrooks", "yolomatic", 4, 1);
		store.recordInstructionComment("mbrooks", "yolomatic", 4, 2);
		const record = store.getInstructionComment("mbrooks", "yolomatic", 4);
		expect(record!.commentId).toBe(2);
	});

	it("lists attempts by issue", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
			store.createAttempt({
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 5,
				requester: "admin",
				originalTitle: "A",
				originalBody: "a",
				originalBodyFingerprint: "fp1",
				instructionSource: "prompt-defaults",
				state: "applied",
			});
			vi.setSystemTime(new Date("2026-08-01T12:00:00.001Z"));
			store.createAttempt({
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 5,
				requester: "admin",
				originalTitle: "B",
				originalBody: "b",
				originalBodyFingerprint: "fp2",
				instructionSource: "prompt-defaults",
				state: "failed",
			});

			const attempts = store.listAttemptsByIssue("mbrooks", "yolomatic", 5);
			expect(attempts).toHaveLength(2);
			expect(attempts[0]!.state).toBe("failed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("looks up attempt by delivery id", () => {
		const attempt = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 6,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
			deliveryId: "delivery-1",
		});

		const fetched = store.getAttemptByDeliveryId("delivery-1");
		expect(fetched).not.toBeNull();
		expect(fetched!.id).toBe(attempt.id);
	});

	it("returns null for unknown attempt ids", () => {
		expect(store.getAttempt("unknown-id")).toBeNull();
	});

	it("throws when updating a missing attempt", () => {
		expect(() => store.updateAttempt("missing-id", { state: "applied" })).toThrow("Refinement attempt missing-id not found");
	});

	it("ignores disallowed update keys", () => {
		const attempt = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 7,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});
		const updated = store.updateAttempt(attempt.id, { state: "applied", id: "new-id", createdAt: "2020-01-01" } as any);
		expect(updated.state).toBe("applied");
		expect(updated.id).toBe(attempt.id);
	});

	it("round-trips a steering prompt through createAttempt and getLatestAttempt", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 8,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
			steeringPrompt: "Focus on rollback",
		});
		expect(created.steeringPrompt).toBe("Focus on rollback");

		const latest = store.getLatestAttempt("mbrooks", "yolomatic", 8);
		expect(latest).not.toBeNull();
		expect(latest!.steeringPrompt).toBe("Focus on rollback");

		const byId = store.getAttempt(created.id);
		expect(byId!.steeringPrompt).toBe("Focus on rollback");
	});

	it("round-trips a proposedTitle through createAttempt, updateAttempt, and reads", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 20,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
			proposedTitle: "Clearer Title",
		});
		expect(created.proposedTitle).toBe("Clearer Title");

		const latest = store.getLatestAttempt("mbrooks", "yolomatic", 20);
		expect(latest).not.toBeNull();
		expect(latest!.proposedTitle).toBe("Clearer Title");

		const byId = store.getAttempt(created.id);
		expect(byId!.proposedTitle).toBe("Clearer Title");
	});

	it("updates a proposedTitle via updateAttempt", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 21,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});
		expect(created.proposedTitle).toBeUndefined();

		const updated = store.updateAttempt(created.id, {
			proposedTitle: "New Title",
			state: "applied",
		});
		expect(updated.proposedTitle).toBe("New Title");
		expect(updated.state).toBe("applied");

		expect(store.getAttempt(created.id)!.proposedTitle).toBe("New Title");
	});

	it("defaults proposedTitle to undefined when not supplied", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 22,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});
		expect(created.proposedTitle).toBeUndefined();
		expect(store.getLatestAttempt("mbrooks", "yolomatic", 22)!.proposedTitle).toBeUndefined();
	});

	it("defaults steeringPrompt to undefined when not supplied", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 9,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});
		expect(created.steeringPrompt).toBeUndefined();
		const latest = store.getLatestAttempt("mbrooks", "yolomatic", 9);
		expect(latest!.steeringPrompt).toBeUndefined();
	});

	it("returns null when no instruction comment is recorded", () => {
		expect(store.getInstructionComment("unknown", "repo", 1)).toBeNull();
	});

	it("creates attempts without runtime or token usage", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 30,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});
		expect(created.runtimeMs).toBeUndefined();
		expect(created.tokenUsage).toBeUndefined();
		expect(store.getAttempt(created.id)!.runtimeMs).toBeUndefined();
		expect(store.getAttempt(created.id)!.tokenUsage).toBeUndefined();
	});

	it("round-trips runtime and token usage supplied at create time", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 34,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "applied",
			runtimeMs: 12_000,
			tokenUsage: { available: false, input: 0, output: 0, totalTokens: 0, cost: 0 },
		});
		expect(created.runtimeMs).toBe(12_000);
		expect(created.tokenUsage!.available).toBe(false);

		const fetched = store.getAttempt(created.id)!;
		expect(fetched.runtimeMs).toBe(12_000);
		expect(fetched.tokenUsage).toEqual({ available: false, input: 0, output: 0, totalTokens: 0, cost: 0 });
	});

	it("persists runtimeMs and available token usage through updateAttempt and reads", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 31,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});

		const updated = store.updateAttempt(created.id, {
			runtimeMs: 42_000,
			tokenUsage: { available: true, input: 50, output: 20, totalTokens: 70, cost: 0.4 },
		});

		expect(updated.runtimeMs).toBe(42_000);
		expect(updated.tokenUsage).toEqual({ available: true, input: 50, output: 20, totalTokens: 70, cost: 0.4 });

		expect(store.getAttempt(created.id)!.runtimeMs).toBe(42_000);
		expect(store.getAttempt(created.id)!.tokenUsage).toEqual({ available: true, input: 50, output: 20, totalTokens: 70, cost: 0.4 });
		expect(store.getLatestAttempt("mbrooks", "yolomatic", 31)!.runtimeMs).toBe(42_000);
		expect(store.listAttemptsByIssue("mbrooks", "yolomatic", 31)[0]!.tokenUsage!.totalTokens).toBe(70);
	});

	it("persists unavailable token usage and zero runtime", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 32,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
			deliveryId: "delivery-32",
		});

		store.updateAttempt(created.id, {
			runtimeMs: 0,
			tokenUsage: { available: false, input: 0, output: 0, totalTokens: 0, cost: 0 },
		});

		const byId = store.getAttempt(created.id)!;
		expect(byId.runtimeMs).toBe(0);
		expect(byId.tokenUsage).toEqual({ available: false, input: 0, output: 0, totalTokens: 0, cost: 0 });

		const byDelivery = store.getAttemptByDeliveryId("delivery-32")!;
		expect(byDelivery.tokenUsage!.available).toBe(false);
	});

	it("updates runtimeMs without touching token usage and vice versa", () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 33,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "running",
		});

		store.updateAttempt(created.id, { runtimeMs: 1_000 });
		expect(store.getAttempt(created.id)!.runtimeMs).toBe(1_000);
		expect(store.getAttempt(created.id)!.tokenUsage).toBeUndefined();

		store.updateAttempt(created.id, { tokenUsage: { available: true, input: 1, output: 2, totalTokens: 3, cost: 0 } });
		expect(store.getAttempt(created.id)!.tokenUsage!.totalTokens).toBe(3);
		expect(store.getAttempt(created.id)!.runtimeMs).toBe(1_000);
	});
});
