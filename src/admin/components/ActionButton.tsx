import React, { useCallback, useState } from "react";

export function ActionButton({
	label,
	loadingLabel,
	variant,
	onClick,
	disabled,
	result,
}: {
	label: string;
	loadingLabel: string;
	variant: string;
	onClick: () => void;
	disabled: boolean;
	result: string | null;
}): React.ReactElement {
	return (
		<div className="action-row">
			<button type="button" className={`action-btn ${variant}`} onClick={onClick} disabled={disabled}>
				{disabled ? loadingLabel : label}
			</button>
			{result && <span className="action-result">{result}</span>}
		</div>
	);
}

export function useAction<Args extends unknown[]>(
	handler: (...args: Args) => Promise<{ ok: boolean; message: string }>,
): {
	loading: boolean;
	result: string | null;
	execute: (...args: Args) => void;
} {
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<string | null>(null);

	const execute = useCallback(
		async (...args: Args) => {
			setLoading(true);
			setResult(null);
			try {
				const res = await handler(...args);
				setResult(res.ok ? res.message : `Error: ${res.message}`);
			} catch (error) {
				setResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				setLoading(false);
			}
		},
		[handler],
	);

	return { loading, result, execute };
}
