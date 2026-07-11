import { describe, expect, it } from "vitest";
import { mergeRepoAndServerSkills } from "./merge-skills.js";

describe("mergeRepoAndServerSkills", () => {
	it("merges repo and server skills with repo overrides", () => {
		const merged = mergeRepoAndServerSkills(
			[
				{
					name: "repo-only",
					description: "repo",
					content: "repo",
					updatedAt: "2025-01-01T00:00:00Z",
					source: "repo",
				},
				{
					name: "shared",
					description: "repo override",
					content: "repo content",
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
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
				{
					id: "2",
					name: "inherited",
					description: "server only",
					content: "server only",
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

	it("returns repo-only skills sorted by name when there are no server skills", () => {
		const merged = mergeRepoAndServerSkills(
			[
				{
					name: "zeta",
					description: "z",
					content: "z",
					updatedAt: "2025-01-03T00:00:00Z",
					source: "repo",
				},
				{
					name: "alpha",
					description: "a",
					content: "a",
					updatedAt: "2025-01-01T00:00:00Z",
					source: "repo",
				},
			],
			[],
		);

		expect(merged.map((skill) => [skill.name, skill.source])).toEqual([
			["alpha", "repo"],
			["zeta", "repo"],
		]);
	});

	it("inherits all server skills when there are no repo skills", () => {
		const merged = mergeRepoAndServerSkills(
			[],
			[
				{
					id: "1",
					name: "beta",
					description: "b",
					content: "b",
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
				{
					id: "2",
					name: "alpha",
					description: "a",
					content: "a",
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
			],
		);

		expect(merged.map((skill) => [skill.name, skill.source])).toEqual([
			["alpha", "inherited"],
			["beta", "inherited"],
		]);
	});

	it("returns an empty list when both inputs are empty", () => {
		expect(mergeRepoAndServerSkills([], [])).toEqual([]);
	});

	it("uses repo content and tags shared skills as repo", () => {
		const merged = mergeRepoAndServerSkills(
			[
				{
					name: "shared",
					description: "repo desc",
					content: "repo content",
					updatedAt: "2025-02-01T00:00:00Z",
					source: "server",
				},
			],
			[
				{
					id: "1",
					name: "shared",
					description: "server desc",
					content: "server content",
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
			],
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]).toEqual({
			name: "shared",
			description: "repo desc",
			content: "repo content",
			updatedAt: "2025-02-01T00:00:00Z",
			source: "repo",
		});
	});
});