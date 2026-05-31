// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RestartBanner } from "./RestartBanner.js";

describe("RestartBanner", () => {
	it("renders the default maintenance message with utility classes", () => {
		render(<RestartBanner />);

		const banner = screen.getByRole("alert");
		expect(screen.getByText("TARS is marked for restart. Maintenance mode active.")).toBeDefined();
		expect(banner.className).toContain("border-yellow");
		expect(banner.className).toContain("bg-[rgba(210,153,34,0.15)]");
		expect(banner.className).not.toContain("restart-banner");
	});

	it("renders custom banner content", () => {
		render(<RestartBanner>Custom restart message.</RestartBanner>);

		expect(screen.getByText("Custom restart message.")).toBeDefined();
	});
});
