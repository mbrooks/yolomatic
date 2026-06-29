// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { Modal } from "./Modal.js";

function renderModal(overrides: Partial<React.ComponentProps<typeof Modal>> = {}) {
	const props: React.ComponentProps<typeof Modal> = {
		open: true,
		onClose: vi.fn(),
		title: "Test Modal",
		children: <button type="button">Inside</button>,
		...overrides,
	};
	render(<Modal {...props} />);
	return props;
}

describe("Modal", () => {
	it("is not open when open is false", () => {
		render(<Modal open={false} onClose={vi.fn()} title="Hidden" children={null} />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("renders as a dialog when open", () => {
		renderModal();
		expect(screen.getByRole("dialog")).not.toBeNull();
		expect(screen.getByText("Test Modal")).not.toBeNull();
	});

	it("calls onClose when the close button is clicked", () => {
		const props = renderModal();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(props.onClose).toHaveBeenCalled();
	});

	it("calls onClose when clicking the backdrop", () => {
		const props = renderModal();
		const dialog = screen.getByRole("dialog") as HTMLDialogElement;
		fireEvent.click(dialog, { target: dialog });
		expect(props.onClose).toHaveBeenCalled();
	});

	it("does not call onClose when clicking modal content", () => {
		const props = renderModal({ children: <button type="button">Inside</button> });
		fireEvent.click(screen.getByRole("button", { name: "Inside" }));
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it("traps focus between first and last focusable elements", () => {
		renderModal({
			children: (
				<>
					<input type="text" aria-label="first-input" />
					<input type="text" aria-label="last-input" />
				</>
			),
		});

		const dialog = screen.getByRole("dialog") as HTMLDialogElement;
		const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(
			(el) => !el.hasAttribute("disabled"),
		);
		const first = focusable[0];
		const last = focusable[focusable.length - 1];

		// Forward tab from last should move to first.
		last.focus();
		fireEvent.keyDown(dialog, { key: "Tab" });
		expect(document.activeElement).toBe(first);

		// Backward tab from first should move to last.
		first.focus();
		fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(last);
	});

	it("calls onClose when Escape is pressed", () => {
		const props = renderModal();
		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(props.onClose).toHaveBeenCalled();
	});
});
