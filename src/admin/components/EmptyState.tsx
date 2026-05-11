import React from "react";

export function EmptyState({ message }: { message: string }): React.ReactElement {
	return (
		<div className="empty-state">
			<p>{message}</p>
		</div>
	);
}
