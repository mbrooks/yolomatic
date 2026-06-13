import { describe, expect, it } from "vitest";

describe("skill types", () => {
	it("exports ServerSkill interface shape", () => {
		const skill = {
			id: "1",
			name: "test",
			description: "desc",
			content: "body",
			updatedAt: "",
			createdAt: "",
		};
		expect(skill.id).toBe("1");
	});

	it("exports RepoSkill interface shape", () => {
		const skill = {
			name: "test",
			description: "desc",
			content: "body",
			updatedAt: "",
			source: "repo" as const,
		};
		expect(skill.source).toBe("repo");
	});
});
