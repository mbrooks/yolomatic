import React from "react";

export function EmptyState({ message, children }: { message: string; children?: React.ReactNode }): React.ReactElement {
	return (
		<div className="empty-state">
			<p>{message}</p>
			{children}
		</div>
	);
}
