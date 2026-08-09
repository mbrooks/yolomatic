import { describe, expect, it, vi } from "vitest";

import type { SessionRepository } from "./session-repository.js";

describe("SessionRepository", () => {
	it("accepts explicit session kinds on kind-scoped operations", async () => {
		const repository = {
			get: vi.fn(async () => null),
			delete: vi.fn(async () => undefined),
			createSession: vi.fn(async () => ({ kind: "refinement" })),
			updateStatus: vi.fn(async () => ({ kind: "refinement" })),
		} as unknown as SessionRepository;

		await repository.get("mbrooks", "yolomatic", 534, "refinement");
		await repository.delete("mbrooks", "yolomatic", 534, "refinement");
		await repository.createSession("mbrooks", "yolomatic", 534, "Title", "Body", "/tmp/worktree", "refinement", []);
		await repository.updateStatus("mbrooks", "yolomatic", 534, "working", undefined, "refinement");

		expect(repository.get).toHaveBeenCalledWith("mbrooks", "yolomatic", 534, "refinement");
		expect(repository.delete).toHaveBeenCalledWith("mbrooks", "yolomatic", 534, "refinement");
		expect(repository.createSession).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			534,
			"Title",
			"Body",
			"/tmp/worktree",
			"refinement",
			[],
		);
		expect(repository.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			534,
			"working",
			undefined,
			"refinement",
		);
	});
});
