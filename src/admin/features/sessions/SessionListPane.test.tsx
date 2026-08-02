// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Session } from "../../app/types.js";
import { SessionListPane } from "./SessionListPane.js";

function makeSession(kind: Session["kind"], issueNumber: number): Session {
	return {
		kind,
		owner: "mbrooks",
		repo: "yeetomatic",
		issueNumber,
		status: "working",
		title: "Title",
		body: "Body",
		summary: null,
		workspacePath: `/tmp/issue-${issueNumber}`,
		branch: `yeetomatic/issue-${issueNumber}`,
		lastActivity: "2026-08-01T00:00:00.000Z",
		createdAt: "2026-08-01T00:00:00.000Z",
		prUrl: null,
		prNumber: null,
		risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
		staleDetectedAt: null,
		staleReason: null,
		stale: null,
		taskStartedAt: null,
		taskFinishedAt: null,
		totalExecutionTimeMs: null,
	};
}

describe("SessionListPane", () => {
	it("renders distinct badges for implementation and refinement sessions", () => {
		render(
			<SessionListPane
				sessions={[makeSession("implementation", 1), makeSession("refinement", 2)]}
				selected={null}
				onSelect={vi.fn()}
			/>,
		);

		expect(document.querySelector(".type-badge.implementation")?.textContent).toBe("Issue");
		expect(screen.getByText("Refinement").classList.contains("refinement")).toBe(true);
	});
});
