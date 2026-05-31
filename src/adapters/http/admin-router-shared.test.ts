import { describe, expect, it } from "vitest";
import { mapResultToStatus, mergeRepoAndServerSkills } from "./admin-router-shared.js";

describe("admin-router-shared", () => {
	it("maps unknown result codes to 500", () => {
		expect(mapResultToStatus("unexpected")).toBe(500);
	});

	it("merges repo and server skills with repo overrides", () => {
		const merged = mergeRepoAndServerSkills(
			[
				{
					name: "repo-only",
					description: "repo",
					content: "repo",
					enabled: true,
					updatedAt: "2025-01-01T00:00:00Z",
					source: "repo",
				},
				{
					name: "shared",
					description: "repo override",
					content: "repo content",
					enabled: false,
					updatedAt: "2025-01-02T00:00:00Z",
					source: "repo",
				},
			],
			[
				{
					id: "1",
					name: "shared",
					description: "server",
					content: "server",
					enabled: true,
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
				{
					id: "2",
					name: "inherited",
					description: "server only",
					content: "server only",
					enabled: true,
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
			],
		);

		expect(merged.map((skill) => [skill.name, skill.source])).toEqual([
			["inherited", "inherited"],
			["repo-only", "repo"],
			["shared", "repo"],
		]);
	});
});
