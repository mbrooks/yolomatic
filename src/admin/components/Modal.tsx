import React, { useEffect, useRef, useCallback } from "react";

interface ModalProps {
	open: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
}

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children }: ModalProps): React.ReactElement | null {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const previousFocusRef = useRef<HTMLElement | null>(null);
	const ignoreCancelRef = useRef(false);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		if (open) {
			previousFocusRef.current = document.activeElement as HTMLElement | null;
			dialog.showModal();
		} else {
			// Avoid firing a duplicate cancel event while handling an Escape key that
			// already called onClose. Cancelling a closing dialog throws in some UAs.
			ignoreCancelRef.current = true;
			dialog.close();
			ignoreCancelRef.current = false;
		}
	}, [open]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		function handleCancel(event: Event) {
			if (ignoreCancelRef.current) return;
			event.preventDefault();
			onClose();
		}

		function handleClick(event: MouseEvent) {
			// Close when clicking the backdrop (the <dialog> element itself), not the
			// content (which stops propagation from its children).
			if (event.target === dialog) {
				onClose();
			}
		}

		dialog.addEventListener("cancel", handleCancel);
		dialog.addEventListener("click", handleClick);
		return () => {
			dialog.removeEventListener("cancel", handleCancel);
			dialog.removeEventListener("click", handleClick);
		};
	}, [onClose]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		function handleKeyDown(event: KeyboardEvent) {
			const target = dialogRef.current;
			if (!target) return;

			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}

			if (event.key !== "Tab") return;
			const focusable = Array.from(target.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
				(el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"),
			);
			if (focusable.length === 0) return;

			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;

			if (event.shiftKey && active === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && active === last) {
				event.preventDefault();
				first.focus();
			}
		}

		dialog.addEventListener("keydown", handleKeyDown);
		return () => {
			dialog.removeEventListener("keydown", handleKeyDown);
		};
	}, [open]);

	useEffect(() => {
		return () => {
			previousFocusRef.current?.focus();
		};
	}, []);

	const handleCloseClick = useCallback(() => {
		onClose();
	}, [onClose]);

	return (
		<dialog ref={dialogRef} className="modal" aria-labelledby="modal-title" aria-modal="true">
			<div className="modal-content" role="document">
				<div className="modal-header">
					<h2 id="modal-title" className="modal-title">
						{title}
					</h2>
					<button
						type="button"
						className="modal-close"
						onClick={handleCloseClick}
						aria-label="Close"
					>
						×
					</button>
				</div>
				<div className="modal-body">{children}</div>
			</div>
		</dialog>
	);
}
