import React from "react";

export function Breadcrumb({
	label,
	onBack,
	onBackExtra,
}: {
	label: string;
	onBack: () => void;
	onBackExtra?: { label: string; onClick: () => void };
}): React.ReactElement {
	return (
		<nav className="breadcrumb">
			<button type="button" className="breadcrumb-link" onClick={onBack}>
				Repos
			</button>
			{onBackExtra && (
				<>
					<span className="breadcrumb-separator">/</span>
					<button type="button" className="breadcrumb-link" onClick={onBackExtra.onClick}>
						{onBackExtra.label}
					</button>
				</>
			)}
			<span className="breadcrumb-separator">→</span>
			<span className="breadcrumb-current">{label}</span>
		</nav>
	);
}
