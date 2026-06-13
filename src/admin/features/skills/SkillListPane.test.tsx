// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillListPane } from "./SkillListPane.js";
import type { ServerSkill, RepoSkill } from "../../app/types.js";

const mockServerSkills: ServerSkill[] = [
	{ id: "1", name: "skill-a", description: "Desc A", content: "", updatedAt: "", createdAt: "" },
	{ id: "2", name: "skill-b", description: "", content: "", updatedAt: "", createdAt: "" },
];

const mockRepoSkills: RepoSkill[] = [
	{ name: "repo-skill", description: "Repo desc", content: "", updatedAt: "", source: "repo" },
	{ name: "inherited-skill", description: "Inherited desc", content: "", updatedAt: "", source: "inherited" },
];

describe("SkillListPane", () => {
	it("renders server skill rows with name and description", () => {
		render(
			<SkillListPane
				skills={mockServerSkills}
				selected={null}
				onSelect={vi.fn()}
				onCreate={vi.fn()}
			/>,
		);
		expect(screen.getByText("skill-a")).toBeDefined();
		expect(screen.getByText("Desc A")).toBeDefined();
		expect(screen.getByText("skill-b")).toBeDefined();
		expect(screen.getByText("No description")).toBeDefined();
	});

	it("renders repo skill badges", () => {
		render(
			<SkillListPane
				skills={mockRepoSkills}
				selected={null}
				onSelect={vi.fn()}
				onCreate={vi.fn()}
			/>,
		);
		expect(screen.getByText("repo")).toBeDefined();
		expect(screen.getByText("inherited")).toBeDefined();
	});

	it("calls onSelect when a row is clicked", () => {
		const onSelect = vi.fn();
		render(
			<SkillListPane
				skills={mockServerSkills}
				selected={null}
				onSelect={onSelect}
				onCreate={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByText("skill-a"));
		expect(onSelect).toHaveBeenCalledWith(mockServerSkills[0]);
	});

	it("applies selected class to the selected skill", () => {
		const { container } = render(
			<SkillListPane
				skills={mockServerSkills}
				selected={mockServerSkills[0]}
				onSelect={vi.fn()}
				onCreate={vi.fn()}
			/>,
		);
		const rows = container.querySelectorAll(".list-row");
		expect(rows[0].classList.contains("selected")).toBe(true);
		expect(rows[1].classList.contains("selected")).toBe(false);
	});

	it("calls onSelect on Enter key", () => {
		const onSelect = vi.fn();
		render(
			<SkillListPane
				skills={mockServerSkills}
				selected={null}
				onSelect={onSelect}
				onCreate={vi.fn()}
			/>,
		);
		const row = screen.getByText("skill-a").closest(".list-row");
		fireEvent.keyDown(row!, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith(mockServerSkills[0]);
	});

	it("calls onSelect on Space key", () => {
		const onSelect = vi.fn();
		render(
			<SkillListPane
				skills={mockServerSkills}
				selected={null}
				onSelect={onSelect}
				onCreate={vi.fn()}
			/>,
		);
		const row = screen.getByText("skill-a").closest(".list-row");
		fireEvent.keyDown(row!, { key: " " });
		expect(onSelect).toHaveBeenCalledWith(mockServerSkills[0]);
	});
});
