// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge.js";

describe("StatusBadge", () => {
	it("renders the online badge with Tailwind utility classes", () => {
		render(<StatusBadge status="online" />);

		const badge = screen.getByText("Online");
		expect(badge.className).toContain("inline-flex");
		expect(badge.className).toContain("rounded-full");
		expect(badge.className).toContain("text-green");
		expect(badge.className).not.toContain("badge");
	});

	it("uses the busy animation utility for the busy state", () => {
		render(<StatusBadge status="busy" />);

		const badge = screen.getByText("Busy");
		expect(badge.className).toContain("animate-pulse");
		expect(badge.className).toContain("text-yellow");
	});
});
