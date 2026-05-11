import React from "react";

export function Breadcrumb({
	label,
	onBack,
}: {
	label: string;
	onBack: () => void;
}): React.ReactElement {
	return (
		<nav className="breadcrumb">
			<button type="button" className="breadcrumb-link" onClick={onBack}>
				Repos
			</button>
			<span className="breadcrumb-separator">→</span>
			<span className="breadcrumb-current">{label}</span>
		</nav>
	);
}
